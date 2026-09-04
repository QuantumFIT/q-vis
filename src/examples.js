// Worked examples. Each one is chosen to show something about the *diagram*, not just
// about the circuit — the comment on each says what to watch.

export const EXAMPLES = [
  {
    name: 'Bell pair',
    note: 'Two amplitudes, one shared terminal: the diagram splits only where the state does.',
    qasm: `OPENQASM 2.0;
include "qelib1.inc";
qreg q[2];

h q[0];
cx q[0],q[1];
`,
    state: '|00> : 1',
  },
  {
    name: 'GHZ, 5 qubits',
    note: 'The diagram grows by two nodes per qubit, never exponentially.',
    qasm: `OPENQASM 2.0;
include "qelib1.inc";
qreg q[5];

h q[0];
cx q[0],q[1];
cx q[1],q[2];
cx q[2],q[3];
cx q[3],q[4];
`,
    state: '|00000> : 1',
  },
  {
    name: 'W state, 4 qubits',
    note: 'Each splitter sends one excitation half onward, half sideways. Four qubits give '
      + 'amplitude 1/2, which the exact ring holds; W on three needs 1/√3, which it cannot.',
    qasm: `OPENQASM 2.0;
include "qelib1.inc";
qreg q[4];

// One excitation, then split it evenly twice. Each ch/cx pair is a 50/50 splitter:
// it sends |1 0> to (|1 0> + |0 1>)/sqrt(2) and leaves |0 0> alone.
x q[0];

ch q[0],q[2];
cx q[2],q[0];

ch q[0],q[1];
cx q[1],q[0];
ch q[2],q[3];
cx q[3],q[2];
`,
    state: '|0000> : 1',
  },
  {
    name: 'Uniform superposition, 8 qubits',
    note: '256 equal amplitudes collapse to a single terminal — every level becomes a don\'t-care.',
    qasm: `OPENQASM 2.0;
include "qelib1.inc";
qreg q[8];

h q;
`,
    state: '|00000000> : 1',
  },
  {
    name: 'Symbolic input',
    note: 'Amplitudes are the symbols a and b: watch the terminals become sums.',
    qasm: `OPENQASM 2.0;
include "qelib1.inc";
qreg q[2];

h q[0];
cx q[0],q[1];
h q[1];
`,
    state: `|00> : a
|10> : b`,
  },
  {
    name: 'QFT, 3 qubits',
    note: 'Every amplitude differs by a phase, so nothing can be shared: the worst case for a diagram.',
    qasm: `OPENQASM 2.0;
include "qelib1.inc";
qreg q[3];

h q[0];
cu1(pi/2) q[1],q[0];
cu1(pi/4) q[2],q[0];
h q[1];
cu1(pi/2) q[2],q[1];
h q[2];
swap q[0],q[2];
`,
    state: '|101> : 1',
  },
  {
    name: 'Grover, 2 qubits',
    note: 'One iteration is enough here: the state collapses onto |11> and the diagram with it.',
    qasm: `OPENQASM 2.0;
include "qelib1.inc";
qreg q[2];

h q[0];
h q[1];
cz q[0],q[1];
h q[0];
h q[1];
x q[0];
x q[1];
cz q[0],q[1];
x q[0];
x q[1];
h q[0];
h q[1];
`,
    state: '|00> : 1',
  },
  {
    name: 'Grover, 3 qubits',
    note: 'Two iterations is the optimum for eight basis states: watch |111> grow while '
      + 'the rest shrink and turn negative.',
    qasm: `OPENQASM 2.0;
include "qelib1.inc";
qreg q[3];

// Mark |111>, then reflect about the mean. ccz does both jobs: as the oracle it flips
// the sign of |111>, and inside the diffuser it flips the sign of |000> once the x gates
// have moved it there.
gate diffuse a,b,c {
  h a; h b; h c;
  x a; x b; x c;
  ccz a,b,c;
  x a; x b; x c;
  h a; h b; h c;
}
gate step a,b,c { ccz a,b,c; diffuse a,b,c; }

h q;
step q[0],q[1],q[2];
step q[0],q[1],q[2];
`,
    state: '|000> : 1',
  },
  {
    name: 'Grover, 4 qubits',
    note: 'Three iterations over sixteen basis states. The diagram stays small throughout: '
      + 'the state is symmetric in the unmarked qubits, and sharing captures exactly that.',
    qasm: `OPENQASM 2.0;
include "qelib1.inc";
qreg q[4];

gate diffuse a,b,c,d {
  h a; h b; h c; h d;
  x a; x b; x c; x d;
  c3z a,b,c,d;
  x a; x b; x c; x d;
  h a; h b; h c; h d;
}
gate step a,b,c,d { c3z a,b,c,d; diffuse a,b,c,d; }

h q;
step q[0],q[1],q[2],q[3];
step q[0],q[1],q[2],q[3];
step q[0],q[1],q[2],q[3];
`,
    state: '|0000> : 1',
  },
  {
    name: 'Don\'t-care patterns',
    note: 'A dash matches either value of that qubit — the input itself is written as a diagram.',
    qasm: `OPENQASM 2.0;
include "qelib1.inc";
qreg q[4];

cx q[0],q[3];
h q[1];
`,
    state: `0--0 : 1/(2*sqrt2)
1--1 : 1/(2*sqrt2)`,
  },
];
