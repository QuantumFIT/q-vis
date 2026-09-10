// Random circuits, for poking at the tool with something you did not choose.
//
// The gate set is drawn first and the gates only then, because the set is the interesting
// variable. A Clifford circuit and a Clifford+T circuit of the same length give diagrams
// of quite different character — one is a tower, the other is not — and the point of the
// button is to land on one of those characters at random, rather than on a uniform soup
// of every gate the parser happens to know.
//
// Everything here is a pure function of a seed, and the seed is written into the circuit
// it produced, so a circuit that turns up something interesting can be got back.

import { GATES } from './gates.js';

/** mulberry32: small, and good enough that the circuits do not come out patterned. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (r, xs) => xs[Math.floor(r() * xs.length)];
const between = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

/**
 * Angles the generator draws from. Stopping at pi/8 is deliberate: the ring climbs a
 * level for every halving, and `unitPart` is cubic in the level, so a random circuit full
 * of pi/256 would be exact but would take the edge-valued views out of interactive range
 * for no gain in what it shows. See docs/EVDD.md.
 */
const ANGLES = ['pi/4', 'pi/2', '3*pi/4', 'pi', '-pi/4', '-pi/2', 'pi/8', '-3*pi/8'];

/** Parametrised gates by qubit count, since they are not in the fixed gate table. */
const PARAM_ARITY = {
  p: 1, u1: 1, rx: 1, ry: 1, rz: 1, u2: 1, u3: 1,
  cp: 2, cu1: 2, crx: 2, cry: 2, crz: 2, cu3: 2, rxx: 2, rzz: 2,
};

/** How many angles each parametrised gate takes; one unless it says otherwise. */
const PARAM_ANGLES = { u2: 2, u3: 3, cu3: 3 };

function arityOf(name) {
  if (name in PARAM_ARITY) return PARAM_ARITY[name];
  if (!Object.hasOwn(GATES, name)) throw new Error(`no such gate '${name}' to draw from`);
  return GATES[name].arity;
}

/**
 * The sets worth drawing from. Each is a class a reader might recognise, not an arbitrary
 * slice of the table, and each says what its diagrams are supposed to show — that line is
 * written into the circuit, so the reader knows what they are looking at.
 *
 * `prelude` runs before the random gates. A diagonal circuit on |0...0> would do nothing
 * but multiply one amplitude by a phase, so that set spreads the state first.
 */
export const GATE_SETS = {
  clifford: {
    label: 'Clifford',
    watch: 'a stabilizer state, so the Pauli-LIMDD should be a tower — one node per qubit',
    pool: ['h', 's', 'sdg', 'x', 'y', 'z', 'sx', 'cx', 'cy', 'cz', 'swap', 'iswap'],
  },
  cliffordT: {
    label: 'Clifford+T',
    watch: 'universal, and the T gates are what take the amplitude ring past level 4',
    pool: ['h', 's', 'sdg', 't', 'tdg', 'x', 'z', 'cx', 'cz', 'ch'],
  },
  toffoli: {
    label: 'Toffoli–Hadamard',
    // A picker is only as narrow as its widest option, and this is the only name long
    // enough to squeeze the panel's own heading. The full one still goes in the circuit.
    short: 'Toffoli',
    watch: 'real amplitudes throughout: every one is an integer over a power of sqrt(2)',
    pool: ['h', 'x', 'cx', 'ccx', 'ccz', 'c3x'],
  },
  diagonal: {
    label: 'diagonal',
    watch: 'nothing moves between basis states — only the phases change, so the MTBDD '
      + 'keeps its shape and the terminals do all the work',
    prelude: ['h q;'],
    pool: ['z', 's', 'sdg', 't', 'tdg', 'p', 'cz', 'cs', 'ct', 'cp', 'ccz'],
  },
  rotations: {
    label: 'rotations',
    watch: 'the parametrised gates, at angles the exact ring still holds',
    pool: ['rx', 'ry', 'rz', 'u3', 'crz', 'rxx', 'rzz', 'cx'],
  },
  mixed: {
    label: 'mixed',
    watch: 'no class in particular — whatever the gate table can do, at once',
    pool: ['h', 't', 'sx', 'y', 'cx', 'ch', 'cs', 'swap', 'rz', 'cu1', 'ccx', 'cswap'],
  },
};

/** A gate on `k` distinct qubits, drawn without replacement. */
function distinct(r, n, k) {
  const pool = Array.from({ length: n }, (_, i) => i);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(r() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, k);
}

function line(r, name, n) {
  const k = arityOf(name);
  const count = PARAM_ANGLES[name] ?? (name in PARAM_ARITY ? 1 : 0);
  const angles = count
    ? `(${Array.from({ length: count }, () => pick(r, ANGLES)).join(',')})`
    : '';
  const args = distinct(r, n, k).map((q) => `q[${q}]`).join(',');
  return `${name}${angles} ${args};`;
}

const HEADER = 'OPENQASM 2.0;\ninclude "qelib1.inc";';

/**
 * A random circuit, as the text a reader could have typed.
 *
 * Returned as source rather than as a parsed circuit so that it lands in the box the same
 * way an example does: editable, shareable in a link, and with nothing behind it that the
 * text does not say.
 *
 * @param {number} seed
 * @param {{set?: string, qubits?: number, gates?: number}} [want] pin any part of it
 */
export function randomCircuit(seed, want = {}) {
  const r = rng(seed);
  const keys = Object.keys(GATE_SETS);
  const key = want.set && GATE_SETS[want.set] ? want.set : pick(r, keys);
  const set = GATE_SETS[key];

  // Small enough to draw and read. The widest gate in a set sets the floor, since a
  // three-qubit gate needs three qubits to act on.
  const widest = Math.max(...set.pool.map(arityOf));
  const n = want.qubits ?? between(r, Math.max(3, widest), 6);
  const depth = want.gates ?? between(r, 2 * n, 4 * n);

  const body = [];
  for (let i = 0; i < depth; i++) {
    // Only gates that fit: a c3x needs four qubits and the circuit may have three.
    const fits = set.pool.filter((name) => arityOf(name) <= n);
    body.push(line(r, pick(r, fits), n));
  }

  const stamp = (seed >>> 0).toString(36);
  const qasm = `${HEADER}
qreg q[${n}];

// Random circuit — ${set.label}, ${n} qubits, ${depth} gates. Seed ${stamp}.
// ${set.watch}.
${(set.prelude ?? []).join('\n')}${set.prelude ? '\n' : ''}
${body.join('\n')}
`;
  return { qasm, state: `|${'0'.repeat(n)}> : 1`, set: key, label: set.label, seed, n, depth };
}
