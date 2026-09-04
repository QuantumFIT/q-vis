import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MTBDD } from '../src/dd.js';
import * as P from '../src/poly.js';
import * as Z from '../src/zomega.js';
import { applyGate, applyNamed, simulate } from '../src/sim.js';
import { GATES, dagger, matMul, identity } from '../src/gates.js';
import { applyNamedDense, basisString } from './oracle.js';
import { rng, randInt, assertClose } from './helpers.js';

const NAMES = Object.keys(GATES);
const allBits = (n) => Array.from({ length: 1 << n }, (_, i) => basisString(i, n));

function randomCircuit(r, n, len) {
  const gates = [];
  for (let i = 0; i < len; i++) {
    const candidates = NAMES.filter((g) => GATES[g].arity <= n);
    const name = candidates[randInt(r, 0, candidates.length - 1)];
    const pool = [...Array(n).keys()];
    const qubits = [];
    for (let j = 0; j < GATES[name].arity; j++) qubits.push(...pool.splice(randInt(r, 0, pool.length - 1), 1));
    gates.push({ name, qubits });
  }
  return { nqubits: n, gates };
}

/** Compare a diagram against a dense state vector, amplitude by amplitude. */
function assertMatches(m, root, vec, env, where) {
  for (const b of allBits(m.nvars)) {
    assertClose(P.evaluate(m.evaluate(root, b), env), vec[parseInt(b, 2)], `${where} at |${b}>`);
  }
}

test('differential oracle: random circuits match a dense state-vector simulator', () => {
  const r = rng(31);
  for (let iter = 0; iter < 25; iter++) {
    const n = randInt(r, 1, 5);
    const circuit = randomCircuit(r, n, 15);
    const m = new MTBDD(P.Ring, n);
    const start = basisString(randInt(r, 0, (1 << n) - 1), n);

    let root = m.basisState(start, P.one);
    let vec = allBits(n).map((b) => (b === start ? { re: 1, im: 0 } : { re: 0, im: 0 }));
    assertMatches(m, root, vec, {}, 'input');

    circuit.gates.forEach((g, i) => {
      root = applyNamed(m, root, g.name, g.qubits);
      vec = applyNamedDense(vec, n, g.name, g.qubits);
      assertMatches(m, root, vec, {}, `after gate ${i} (${g.name} on ${g.qubits})`);
    });
  }
});

test('differential oracle: symbolic amplitudes, checked at random assignments', () => {
  const r = rng(32);
  const env = { a: { re: 0.31, im: -0.62 }, b: { re: 0.5, im: 0.17 }, c: { re: -0.44, im: 0.28 } };
  for (let iter = 0; iter < 15; iter++) {
    const n = randInt(r, 2, 4);
    const m = new MTBDD(P.Ring, n);
    const syms = ['a', 'b', 'c'];
    const chosen = new Set();
    while (chosen.size < 3) chosen.add(basisString(randInt(r, 0, (1 << n) - 1), n));
    const entries = [...chosen].map((b, i) => [b, P.variable(syms[i])]);

    let root = m.fromAmplitudes(entries);
    let vec = allBits(n).map((b) => {
      const hit = entries.find(([bb]) => bb === b);
      return hit ? env[[...hit[1].t.values()][0].mono[0][0]] : { re: 0, im: 0 };
    });
    assertMatches(m, root, vec, env, 'symbolic input');

    const circuit = randomCircuit(r, n, 10);
    circuit.gates.forEach((g, i) => {
      root = applyNamed(m, root, g.name, g.qubits);
      vec = applyNamedDense(vec, n, g.name, g.qubits);
      assertMatches(m, root, vec, env, `symbolic, after gate ${i} (${g.name})`);
    });
  }
});

test('a circuit followed by its inverse returns to the very same node', () => {
  const r = rng(33);
  for (let iter = 0; iter < 20; iter++) {
    const n = randInt(r, 1, 4);
    const m = new MTBDD(P.Ring, n);
    const start = m.basisState(basisString(randInt(r, 0, (1 << n) - 1), n), P.one);
    const circuit = randomCircuit(r, n, 12);

    let root = start;
    for (const g of circuit.gates) root = applyNamed(m, root, g.name, g.qubits);
    for (const g of [...circuit.gates].reverse()) root = applyGate(m, root, g.qubits, dagger(GATES[g.name].matrix));
    // Exact arithmetic plus canonicity means this is node *identity*, not approximation.
    assert.equal(root, start, 'U† U |psi> must be the original diagram');
  }
});

test('known circuits produce the states they should', () => {
  const m = new MTBDD(P.Ring, 3);
  const h = P.fromZ(Z.INV_SQRT2);

  // Bell pair on qubits 0,1 with qubit 2 idle.
  let s = m.basisState('000', P.one);
  s = applyNamed(m, s, 'h', [0]);
  s = applyNamed(m, s, 'cx', [0, 1]);
  assert.equal(s, m.fromAmplitudes([['000', h], ['110', h]]));

  // Extending to GHZ.
  s = applyNamed(m, s, 'cx', [1, 2]);
  assert.equal(s, m.fromAmplitudes([['000', h], ['111', h]]));
  assert.equal(m.size(s), 7);

  // X on the top qubit flips the ket labels.
  const flipped = applyNamed(m, s, 'x', [0]);
  assert.equal(flipped, m.fromAmplitudes([['100', h], ['011', h]]));

  // Z on a uniform superposition of one qubit gives |->.
  const m1 = new MTBDD(P.Ring, 1);
  const plus = applyNamed(m1, m1.basisState('0', P.one), 'h', [0]);
  const minus = applyNamed(m1, plus, 'z', [0]);
  assert.equal(minus, m1.fromAmplitudes([['0', h], ['1', P.fromZ(Z.neg(Z.INV_SQRT2))]]));
  assert.equal(applyNamed(m1, plus, 'h', [0]), m1.basisState('0', P.one), 'H is an involution');
});

test('the qubit order convention holds: qubit 0 is the leftmost ket bit', () => {
  const m = new MTBDD(P.Ring, 3);
  const s = applyNamed(m, m.basisState('000', P.one), 'x', [0]);
  assert.equal(P.key(m.evaluate(s, '100')), P.key(P.one));
  assert.equal(P.key(m.evaluate(s, '001')), P.key(P.zero));
  // H on qubit 1 gives (|000> + |010>)/√2, in which q1 has become a don't-care:
  // its level vanishes from the diagram, while q0 and q2 still pin the state to 0.
  const root = applyNamed(m, m.basisState('000', P.one), 'h', [1]);
  const levels = m.reachable(root).filter((id) => !m.isTerminal(id)).map((id) => m.levelOf(id));
  assert.deepEqual(levels.sort(), [0, 2]);
  assert.equal(P.format(m.evaluate(root, '010')), '1/√2');
  assert.equal(P.format(m.evaluate(root, '000')), '1/√2');
  assert.equal(P.format(m.evaluate(root, '110')), '0');
  assert.deepEqual([...m.paths(root)].map((p) => p.path), ['0-0']);
});

test('symbolic state through H,CX is the textbook result', () => {
  const m = new MTBDD(P.Ring, 2);
  const a = P.variable('a'), b = P.variable('b');
  const h = P.fromZ(Z.INV_SQRT2);
  let s = m.fromAmplitudes([['00', a], ['10', b]]);
  s = applyNamed(m, s, 'h', [0]);
  s = applyNamed(m, s, 'cx', [0, 1]);
  assert.equal(P.format(m.evaluate(s, '00')), 'a/√2 + b/√2');
  assert.equal(P.format(m.evaluate(s, '11')), 'a/√2 - b/√2');
  assert.equal(s, m.fromAmplitudes([['00', P.mul(h, P.add(a, b))], ['11', P.mul(h, P.sub(a, b))]]));
});

test('frames record a consistent diff of the diagram', () => {
  const r = rng(34);
  const n = 4;
  const m = new MTBDD(P.Ring, n);
  const circuit = randomCircuit(r, n, 20);
  const frames = simulate(m, m.basisState('0000', P.one), circuit);

  assert.equal(frames.length, circuit.gates.length + 1);
  assert.equal(frames[0].gate, null);
  for (let i = 0; i < frames.length; i++) {
    const now = new Set(m.reachable(frames[i].root));
    assert.equal(frames[i].size, now.size);
    const before = i === 0 ? new Set() : new Set(m.reachable(frames[i - 1].root));
    assert.deepEqual(new Set(frames[i].added), new Set([...now].filter((x) => !before.has(x))));
    assert.deepEqual(new Set(frames[i].removed), new Set([...before].filter((x) => !now.has(x))));
    // Nodes shared with the previous frame are literally the same objects: that is what
    // makes the animation a morph rather than a redraw.
    if (i > 0) {
      const kept = [...now].filter((x) => before.has(x));
      for (const id of kept) assert.equal(m.nodes[id], m.nodes[id]);
    }
  }
});

test('gate application rejects malformed input', () => {
  const m = new MTBDD(P.Ring, 3);
  const s = m.basisState('000', P.one);
  assert.throws(() => applyNamed(m, s, 'nope', [0]), /unknown gate/);
  assert.throws(() => applyNamed(m, s, 'cx', [0]), /takes 2 qubit/);
  assert.throws(() => applyNamed(m, s, 'cx', [1, 1]), /repeated qubit/);
  assert.throws(() => applyNamed(m, s, 'h', [5]), /out of range/);
});

test('the Clifford+T decomposition of Toffoli really is a Toffoli', () => {
  // The textbook 7-T decomposition. Worth testing by node identity rather than by
  // comparing amplitudes: exact arithmetic plus canonicity means the diagrams are equal
  // only if the unitaries agree on that input exactly, phases included.
  const decomposition = [
    ['h', [2]], ['cx', [1, 2]], ['tdg', [2]], ['cx', [0, 2]], ['t', [2]], ['cx', [1, 2]],
    ['tdg', [2]], ['cx', [0, 2]], ['t', [1]], ['t', [2]], ['h', [2]], ['cx', [0, 1]],
    ['t', [0]], ['tdg', [1]], ['cx', [0, 1]],
  ];
  assert.equal(decomposition.filter(([g]) => g === 't' || g === 'tdg').length, 7);

  const m = new MTBDD(P.Ring, 3);
  for (const bits of allBits(3)) {
    const start = m.basisState(bits, P.one);
    let viaDecomposition = start;
    for (const [name, qubits] of decomposition) {
      viaDecomposition = applyNamed(m, viaDecomposition, name, qubits);
    }
    assert.equal(viaDecomposition, applyNamed(m, start, 'ccx', [0, 1, 2]),
      `decomposition differs from ccx on |${bits}>`);
  }

  // ... and on a superposition, where a wrong phase would survive rather than cancel.
  let s = m.fromAmplitudes(allBits(3).map((b) => [b, P.fromZ(Z.zo(1, 0, 0, 0, 3))]));
  const want = applyNamed(m, s, 'ccx', [0, 1, 2]);
  for (const [name, qubits] of decomposition) s = applyNamed(m, s, name, qubits);
  assert.equal(s, want, 'decomposition differs from ccx on a uniform superposition');
});

test('every gate in the table is exactly unitary', () => {
  // Checked over the ring rather than with a floating-point tolerance: U†U must be the
  // identity element for element. This is the invariant the whole gate table rests on,
  // and it had been checked only by hand until now.
  for (const [name, gate] of Object.entries(GATES)) {
    const product = matMul(gate.matrix, dagger(gate.matrix));
    const id = identity(gate.matrix.length);
    product.forEach((row, i) => row.forEach((v, j) => {
      assert.ok(Z.eq(v, id[i][j]), `${name}: U†U differs from the identity at ${i},${j}`);
    }));
    assert.equal(gate.matrix.length, 2 ** gate.arity, `${name}: matrix size and arity disagree`);
    assert.ok(gate.doc && gate.draw, `${name}: missing its description or drawing hint`);
  }
});
