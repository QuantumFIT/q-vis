// Worked examples. Each one is chosen to show something about the *diagram*, not just
// about the circuit — the note on each says what to watch.
//
// An example is either fixed or a family. A family lists the qubit counts it can be built
// at in `sizes`, and its `qasm`, `state` and `note` are functions of that count; a fixed
// example gives them as strings. `instantiate` flattens either into the same four fields,
// so nothing downstream has to know which it was handed.
//
// The sizes are explicit lists rather than a range with a validator, because the limits
// are not arbitrary: a W state needs a power of two or its amplitude leaves the ring, and
// an n-qubit QFT needs a phase of pi/2^(n-1), which leaves the ring at n = 4. What cannot
// be built is simply not offered.

const HEADER = 'OPENQASM 2.0;\ninclude "qelib1.inc";';
const range = (lo, hi) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
const zeros = (n) => `|${'0'.repeat(n)}> : 1`;
const each = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join('\n');

/** How many Grover iterations are the optimum for an n-qubit search. */
const groverIterations = (n) => Math.floor((Math.PI / 4) * Math.sqrt(2 ** n));

/**
 * Working qubits a Z controlled on n-1 others needs. None up to four qubits, where the
 * gate set has cz, ccz and c3z; beyond that, one per Toffoli in the chain below.
 */
const workspace = (n) => (n <= 4 ? 0 : n - 3);

/**
 * A gate that flips the sign of |1...1>. Up to four qubits the gate set has one; beyond
 * that it is a chain of Toffolis over `workspace(n)` working qubits, which accumulate the
 * AND of the controls and are put back to |0> by the mirror image of the chain — the same
 * trick as the Toffoli example, one level up.
 */
function markGate(n) {
  const w = workspace(n);
  const params = [...range(0, n - 1).map((i) => `q${i}`), ...range(0, w - 1).map((i) => `w${i}`)];
  let body;
  if (n === 2) body = ['cz q0,q1;'];
  else if (n === 3) body = ['ccz q0,q1,q2;'];
  else if (n === 4) body = ['c3z q0,q1,q2,q3;'];
  else {
    const up = ['ccx q0,q1,w0;',
      ...range(1, w - 1).map((k) => `ccx q${k + 1},w${k - 1},w${k};`)];
    body = [...up, `ccz q${n - 2},w${w - 1},q${n - 1};`, ...[...up].reverse()];
  }
  return `gate mark ${params.join(',')} {\n${body.map((l) => `  ${l}`).join('\n')}\n}`;
}

function grover(n) {
  const w = workspace(n);
  const args = [...range(0, n - 1).map((i) => `q[${i}]`), ...range(0, w - 1).map((i) => `a[${i}]`)];
  // A gate body takes qubits, not registers, so the reflection stays at the top level
  // where `h q;` can say "every search qubit" and leave the working ones alone.
  const step = [`mark ${args.join(',')};`, 'h q; x q;', `mark ${args.join(',')};`, 'x q; h q;'];
  return `${HEADER}
qreg q[${n}];${w ? `\nqreg a[${w}];   // working qubits, borrowed and given back` : ''}

// Flip the sign of |1...1>. The oracle marks the answer with it, and the diffuser uses
// the same gate to reflect about the mean, once the x gates have moved |0...0> there.
${markGate(n)}

h q;

${each(groverIterations(n), () => step.join('\n')).split('\n').join('\n')}
`;
}

/**
 * The textbook QFT: a Hadamard on each qubit, then a controlled phase from every qubit
 * below it, halving each step, and a reversal at the end.
 *
 * The halving is what sets the level. Qubit j takes a phase of pi/2^(k-j) from qubit k,
 * so the finest angle an n-qubit transform needs is pi/2^(n-1), and the ring climbs a
 * level for every qubit: pi/8 at four, pi/16 at five. Still exact, still canonical — see
 * zomega.js. What stops it now is speed, not arithmetic: the edge-valued conversion is
 * where the cost lands, and past seven qubits it stops being interactive.
 */
function qft(n) {
  const body = [];
  for (let j = 0; j < n; j++) {
    body.push(`h q[${j}];`);
    for (let k = j + 1; k < n; k++) body.push(`cu1(pi/${2 ** (k - j)}) q[${k}],q[${j}];`);
  }
  for (let i = 0; i < Math.floor(n / 2); i++) body.push(`swap q[${i}],q[${n - 1 - i}];`);
  return `${HEADER}
qreg q[${n}];

${body.join('\n')}
`;
}

const HALVINGS = [null, 'once', 'twice', 'three times'];

function wState(n) {
  const splits = [];
  for (let stride = n / 2; stride >= 1; stride /= 2) {
    const round = [];
    for (let i = 0; i < n; i += stride * 2) {
      round.push(`ch q[${i}],q[${i + stride}];`, `cx q[${i + stride}],q[${i}];`);
    }
    splits.push(round.join('\n'));
  }
  return `${HEADER}
qreg q[${n}];

// One excitation, then split it evenly ${HALVINGS[Math.log2(n)]}. Each ch/cx pair is a 50/50 splitter:
// it sends |1 0> to (|1 0> + |0 1>)/sqrt(2) and leaves |0 0> alone.
x q[0];

${splits.join('\n\n')}
`;
}

export const EXAMPLES = [
  {
    name: 'Bell pair',
    note: 'Two amplitudes, one shared terminal: the diagram splits only where the state does.',
    qasm: `${HEADER}
qreg q[2];

h q[0];
cx q[0],q[1];
`,
    state: '|00> : 1',
  },
  {
    name: 'GHZ',
    // From three: GHZ on two qubits is the Bell pair, which is the example above.
    sizes: range(3, 12),
    defaultSize: 5,
    note: 'The diagram grows by two nodes per qubit, never exponentially.',
    qasm: (n) => `${HEADER}
qreg q[${n}];

h q[0];
${each(n - 1, (i) => `cx q[${i}],q[${i + 1}];`)}
`,
    state: zeros,
  },
  {
    name: 'Cluster state',
    sizes: range(2, 12),
    defaultSize: 5,
    note: 'A stabilizer state. In the LIMDD view it is a tower of one node per qubit, '
      + 'whatever the graph — the edge-valued diagram needs nearly twice as many.',
    qasm: (n) => `${HEADER}
qreg q[${n}];

// |+> everywhere, then a controlled-Z along a line: the graph state of a path.
${each(n, (i) => `h q[${i}];`)}

${each(n - 1, (i) => `cz q[${i}],q[${i + 1}];`)}
`,
    state: zeros,
  },
  {
    name: 'W state',
    // Halving only lands on every qubit when there are a power of two of them. W on three
    // would need an amplitude of 1/sqrt(3), which this ring does not contain at all.
    sizes: [2, 4, 8],
    defaultSize: 4,
    note: (n) => 'Each splitter sends one excitation half onward, half sideways. '
      + `${n} qubits give amplitude 1/${n === 2 ? '√2' : (n === 4 ? '2' : '(2√2)')}, which `
      + 'the exact ring holds; W on three needs 1/√3, which it cannot.',
    qasm: wState,
    state: zeros,
  },
  {
    name: 'Uniform superposition',
    sizes: range(1, 12),
    defaultSize: 8,
    note: (n) => `${2 ** n} equal amplitudes collapse to a single terminal — every level `
      + 'becomes a don\'t-care.',
    qasm: (n) => `${HEADER}
qreg q[${n}];

h q;
`,
    state: zeros,
  },
  {
    name: 'Symbolic input',
    note: 'Amplitudes are the symbols a and b: watch the terminals become sums.',
    qasm: `${HEADER}
qreg q[2];

h q[0];
cx q[0],q[1];
h q[1];
`,
    state: `|00> : a
|10> : b`,
  },
  {
    name: 'QFT',
    // Seven is where the edge-valued conversion stops being interactive; see qft() above.
    sizes: range(1, 7),
    defaultSize: 3,
    note: (n) => 'Every amplitude differs by a phase, so nothing can be shared: the worst '
      + `case for a diagram, and here the whole state vector — ${2 ** (n + 1) - 1} nodes. `
      + `The edge-valued view collapses it to ${n + 1}, because a phase is exactly what an `
      + 'edge weight holds.'
      + (n >= 4
        ? ` Each qubit needs a phase twice as fine as the last, so ω is e^(iπ/${2 ** (n - 1)}) `
          + 'here rather than the π/4 of Clifford+T — a level further up the same exact ring.'
        : ''),
    qasm: qft,
    // |1>, |01>, |101>: an odd number at every size, so it shares no factor with 2^n and
    // every one of the 2^n phases comes out different — which is the case worth showing.
    state: (n) => `|${'01'.repeat(n).slice(-n)}> : 1`,
  },
  {
    name: 'Toffoli in Clifford+T',
    note: 'Seven T gates and eight Clifford gates for one Toffoli. Every intermediate '
      + 'phase is kept exactly, and they all cancel: the last diagram is the very node '
      + 'ccx would have produced.',
    qasm: `${HEADER}
qreg q[3];

// The textbook decomposition: q[0] and q[1] control, q[2] is the target. Seven T gates
// is the known minimum for a Toffoli.
h q[2];
cx q[1],q[2];
tdg q[2];
cx q[0],q[2];
t q[2];
cx q[1],q[2];
tdg q[2];
cx q[0],q[2];
t q[1];
t q[2];
h q[2];
cx q[0],q[1];
t q[0];
tdg q[1];
cx q[0],q[1];
`,
    state: '|110> : 1',
  },
  {
    name: 'Grover',
    sizes: range(2, 6),
    defaultSize: 3,
    note: (n) => {
      const iterations = groverIterations(n);
      const shape = `${iterations} iteration${iterations === 1 ? '' : 's'} over `
        + `${2 ** n} basis states: watch |${'1'.repeat(n)}> grow while the rest shrink and `
        + 'turn negative.';
      return workspace(n)
        ? `${shape} The oracle needs a Z controlled on every qubit, which the gate set `
          + `stops short of, so it is built from Toffolis over ${workspace(n)} working `
          + `qubits — the bottom ${workspace(n)} rows, which start and end at |0>.`
        : shape;
    },
    qasm: grover,
    state: (n) => zeros(n + workspace(n)),
  },
  {
    name: 'Don\'t-care patterns',
    note: 'A dash matches either value of that qubit — the input itself is written as a diagram.',
    qasm: `${HEADER}
qreg q[4];

cx q[0],q[3];
h q[1];
`,
    state: `0--0 : 1/(2*sqrt2)
1--1 : 1/(2*sqrt2)`,
  },
];

/**
 * One concrete example: a family built at `size`, or a fixed example as it stands. An
 * unknown or missing size falls back to the family's default, so a stale link cannot
 * produce a circuit that does not exist.
 */
export function instantiate(example, size) {
  const n = example.sizes?.includes(size) ? size : example.defaultSize;
  const at = (v) => (typeof v === 'function' ? v(n) : v);
  return {
    name: example.name,
    size: n ?? null,
    note: at(example.note),
    qasm: at(example.qasm),
    state: at(example.state),
  };
}

/** Every example at every size it offers — what the tests sweep over. */
export function allInstances() {
  return EXAMPLES.flatMap((ex) => (ex.sizes ?? [undefined]).map((n) => instantiate(ex, n)));
}

/** Which example and size produced this text, or null; used to restore a saved view. */
export function identify(qasm, state) {
  for (const example of EXAMPLES) {
    for (const size of example.sizes ?? [undefined]) {
      const made = instantiate(example, size);
      if (made.qasm === qasm && made.state === state) return { example, ...made };
    }
  }
  return null;
}
