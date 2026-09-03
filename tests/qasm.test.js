import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQasm, QasmError } from '../src/qasm.js';
import { MTBDD } from '../src/dd.js';
import * as P from '../src/poly.js';
import * as Z from '../src/zomega.js';
import { simulate } from '../src/sim.js';
import { GATES, omegaPow } from '../src/gates.js';

const HEAD = 'OPENQASM 2.0;\ninclude "qelib1.inc";\n';

test('registers are flattened in declaration order', () => {
  const c = parseQasm(`${HEAD}qreg a[2];\nqreg b[3];\ncreg c[2];\nx b[1];\n`);
  assert.equal(c.nqubits, 5);
  assert.deepEqual(c.qubits.map((q) => q.label), ['a[0]', 'a[1]', 'b[0]', 'b[1]', 'b[2]']);
  assert.deepEqual(c.gates[0].qubits, [3], 'b[1] is global qubit 3');
});

test('comments and whitespace are ignored', () => {
  const c = parseQasm(`${HEAD}// leading\nqreg q[1]; /* block\ncomment */ h q[0]; // trailing\n`);
  assert.equal(c.gates.length, 1);
  assert.equal(c.gates[0].name, 'h');
});

test('a whole-register argument broadcasts over single-qubit gates', () => {
  const c = parseQasm(`${HEAD}qreg q[3];\nh q;\n`);
  assert.deepEqual(c.gates.map((g) => g.qubits), [[0], [1], [2]]);
  assert.throws(() => parseQasm(`${HEAD}qreg q[2];\ncx q,q;\n`), /only supported for single-qubit/);
});

test('user-defined gates are inlined', () => {
  const c = parseQasm(`${HEAD}qreg q[3];\ngate bell a,b { h a; cx a,b; }\ngate two a,b,cc { bell a,b; bell b,cc; }\ntwo q[0],q[1],q[2];\n`);
  assert.deepEqual(c.gates.map((g) => `${g.name}${JSON.stringify(g.qubits)}`),
    ['h[0]', 'cx[0,1]', 'h[1]', 'cx[1,2]']);
  assert.throws(() => parseQasm(`${HEAD}qreg q[1];\ngate loop a { loop a; }\nloop q[0];\n`), /expands recursively/);
  assert.throws(() => parseQasm(`${HEAD}qreg q[2];\ngate g a { h b; }\n`), /not a parameter of gate 'g'/);
});

test('barriers are recorded as dividers, not as gates', () => {
  const c = parseQasm(`${HEAD}qreg q[2];\nh q[0];\nbarrier q;\nh q[1];\nbarrier q[0],q[1];\n`);
  assert.equal(c.gates.length, 2);
  assert.deepEqual(c.barriers, [1, 2]);
});

test('phases by a multiple of pi/4 are exact; other angles are refused', () => {
  const c = parseQasm(`${HEAD}qreg q[2];\nu1(pi/4) q[0];\np(pi) q[1];\ncu1(pi/2) q[0],q[1];\ncp(-pi/4) q[1],q[0];\n`);
  assert.deepEqual(c.gates.map((g) => g.label), ['T', 'Z', 'CS', 'CT†']);
  // cu1(pi/2) must be exactly the tabulated CS gate.
  const cs = GATES.cs.matrix;
  assert.ok(c.gates[2].matrix.every((row, i) => row.every((v, j) => Z.eq(v, cs[i][j]))));
  assert.ok(Z.eq(c.gates[0].matrix[1][1], omegaPow(1)));

  assert.throws(() => parseQasm(`${HEAD}qreg q[1];\nu1(pi/3) q[0];\n`), /multiple of pi\/4/);
  assert.throws(() => parseQasm(`${HEAD}qreg q[1];\nrz(pi/2) q[0];\n`), /parametrised rotation/);
  assert.throws(() => parseQasm(`${HEAD}qreg q[1];\nrx(pi) q[0];\n`), /leave\s+Z\[1\/sqrt\(2\), i\]/);
});

test('non-unitary and unsupported constructs are refused with a reason', () => {
  const cases = [
    ['measure q -> c;', /measurement is not a unitary gate/],
    ['reset q[0];', /reset is not a unitary gate/],
    ['if (c==1) x q[0];', /classical control/],
    ['opaque foo a;', /opaque/],
    ['nope q[0];', /unknown gate 'nope'/],
    ['x q[9];', /out of range/],
  ];
  for (const [line, re] of cases) {
    assert.throws(() => parseQasm(`${HEAD}qreg q[2];\ncreg c[2];\n${line}\n`), re, line);
  }
});

test('errors carry a line number', () => {
  try {
    parseQasm(`${HEAD}qreg q[2];\nh q[0];\nnope q[1];\n`);
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof QasmError);
    assert.equal(e.line, 5);
    assert.match(e.message, /^line 5:/);
  }
});

test('structural errors are caught', () => {
  assert.throws(() => parseQasm(`${HEAD}h q[0];\n`), /unknown register 'q'/);
  assert.throws(() => parseQasm(HEAD), /no qreg declared/);
  assert.throws(() => parseQasm(`${HEAD}qreg q[2];\nqreg q[2];\n`), /redeclared/);
  assert.throws(() => parseQasm(`${HEAD}qreg q[0];\n`), /positive size/);
  assert.throws(() => parseQasm(`${HEAD}qreg q[2];\ncreg c[2];\nx c[0];\n`), /classical register/);
  assert.throws(() => parseQasm(`${HEAD}qreg q[2];\ncx q[0],q[0];\n`), /repeated qubit/);
  assert.throws(() => parseQasm(`${HEAD}qreg q[2];\nh q[0]\n`), /expected ';'/);
  assert.throws(() => parseQasm('OPENQASM 3.0;\nqreg q[1];\n'), /OpenQASM 2\.0/);
  assert.throws(() => parseQasm(`${HEAD}qreg q[1];\nh q[0] $;\n`), /unexpected character/);
});

test('the parsed QFT circuit produces the exact discrete Fourier amplitudes', () => {
  const src = `${HEAD}qreg q[3];
h q[0];
cu1(pi/2) q[1],q[0];
cu1(pi/4) q[2],q[0];
h q[1];
cu1(pi/2) q[2],q[1];
h q[2];
swap q[0],q[2];
`;
  const c = parseQasm(src);
  const n = 3;
  for (let x = 0; x < 8; x++) {
    const m = new MTBDD(P.Ring, n);
    const frames = simulate(m, m.basisState(x.toString(2).padStart(n, '0'), P.one), c);
    const root = frames[frames.length - 1].root;
    for (let y = 0; y < 8; y++) {
      // QFT|x> = (1/sqrt(8)) sum_y w^{x*y} |y>, with w = e^{2*pi*i/8} the ring's generator.
      const want = Z.mul(Z.zo(1, 0, 0, 0, n), omegaPow(x * y));
      const got = P.asScalar(m.evaluate(root, y.toString(2).padStart(n, '0')));
      assert.ok(Z.eq(got, want), `QFT|${x}> at |${y}>: got ${Z.format(got)}, want ${Z.format(want)}`);
    }
    assert.equal(frames.length, c.gates.length + 1);
  }
});
