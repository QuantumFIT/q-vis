import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQasm, QasmError } from '../src/qasm.js';
import { MTBDD } from '../src/dd.js';
import * as P from '../src/poly.js';
import * as Z from '../src/zomega.js';
import { assertClose } from './helpers.js';
import { simulate } from '../src/sim.js';
import { GATES, omegaPow, matMul, dagger } from '../src/gates.js';

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

test('phases by a dyadic multiple of pi are exact; other angles are refused', () => {
  const c = parseQasm(`${HEAD}qreg q[2];\nu1(pi/4) q[0];\np(pi) q[1];\ncu1(pi/2) q[0],q[1];\ncp(-pi/4) q[1],q[0];\n`);
  assert.deepEqual(c.gates.map((g) => g.label), ['T', 'Z', 'CS', 'CT†']);
  // cu1(pi/2) must be exactly the tabulated CS gate.
  const cs = GATES.cs.matrix;
  assert.ok(c.gates[2].matrix.every((row, i) => row.every((v, j) => Z.eq(v, cs[i][j]))));
  assert.ok(Z.eq(c.gates[0].matrix[1][1], omegaPow(1)));

  // Past pi/4 the ring goes up a level rather than giving up. The named gates keep their
  // names — a phase of 4*pi/8 is the S gate, however it was written.
  const fine = parseQasm(`${HEAD}qreg q[2];\nu1(pi/8) q[0];\nu1(pi/2) q[1];\nu1(4*pi/8) q[1];\ncu1(pi/16) q[0],q[1];\n`);
  assert.deepEqual(fine.gates.map((g) => g.label), ['P(π/8)', 'S', 'S', 'CP(π/16)']);
  assert.equal(Z.levelOf(fine.gates[0].matrix[1][1]), 8, 'pi/8 needs the level above');
  assert.equal(Z.levelOf(fine.gates[1].matrix[1][1]), 4, 'pi/2 does not');
  assertClose(Z.toComplex(fine.gates[0].matrix[1][1]),
    { re: Math.cos(Math.PI / 8), im: Math.sin(Math.PI / 8) });

  // Two eighth turns are a quarter turn, exactly, whatever level each was written at.
  const eighth = fine.gates[0].matrix[1][1];
  assert.ok(Z.eq(Z.mul(eighth, eighth), omegaPow(1)));

  assert.throws(() => parseQasm(`${HEAD}qreg q[1];\nu1(pi/3) q[0];\n`), /dyadic rational/);

  // A large angle must be judged on the same grid as a small one. The tolerance used to
  // be a fraction of the angle, so past about 5e8 it exceeded half a grid step and every
  // value looked like an integer: u1(1000000000*pi/3) was accepted as P(5pi/4), an
  // amplitude wrong by 0.26, from a parser whose whole promise is exactness.
  for (const bad of ['1000000000*pi/3', '1000000000*pi/7', '2027395*pi/3', '100000000.05*pi/4']) {
    assert.throws(() => parseQasm(`${HEAD}qreg q[1];\nu1(${bad}) q[0];\n`), /not expressible exactly/,
      `${bad} is not pi times a dyadic rational, however large it is`);
  }
  // And a large angle that *is* on the grid still lands on the right phase, reduced mod
  // 2pi: 12345678901 = 53 (mod 1024), and 100000000 is a multiple of 8 quarter-turns.
  const huge = parseQasm(`${HEAD}qreg q[1];\nu1(12345678901*pi/512) q[0];\nu1(100000000*pi/4) q[0];\nu1(4*pi) q[0];\n`);
  assert.deepEqual(huge.gates.map((g) => g.label), ['P(53π/512)', 'I', 'I']);
  assertClose(Z.toComplex(huge.gates[0].matrix[1][1]),
    { re: Math.cos(53 * Math.PI / 512), im: Math.sin(53 * Math.PI / 512) });
  assert.throws(() => parseQasm(`${HEAD}qreg q[1];\nu1(pi/1024) q[0];\n`), /dyadic rational/,
    'finer than the tool is willing to go is still refused');

  // rx(pi) used to be refused here, on the claim that its entries "leave the ring
  // whatever its level". They do not: it is exactly -i X. See the rotation test below.
  const flip = parseQasm(`${HEAD}qreg q[1];\nrx(pi) q[0];\n`).gates[0].matrix;
  assert.ok(Z.isZero(flip[0][0]) && Z.eq(flip[0][1], Z.MINUS_I), 'rx(pi) is -i X');
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

test('rotations are exact at a dyadic angle, and refused off the grid', () => {
  // A rotation turns through *half* its angle, so its entries are a cosine and a sine
  // rather than a root of unity. They are still in the ring — halving is two factors of
  // 1/sqrt(2) — which is why these gates exist at all; the parser used to reject them
  // with the claim that they "leave the ring whatever its level", which was false.
  const c = Math.cos, s = Math.sin;
  const cases = [
    ['rx(pi/2) q[0];', (t) => [[[c(t / 2), 0], [0, -s(t / 2)]], [[0, -s(t / 2)], [c(t / 2), 0]]]],
    ['ry(pi/4) q[0];', (t) => [[[c(t / 2), 0], [-s(t / 2), 0]], [[s(t / 2), 0], [c(t / 2), 0]]]],
    ['rz(3*pi/4) q[0];', (t) => [[[c(t / 2), -s(t / 2)], [0, 0]], [[0, 0], [c(t / 2), s(t / 2)]]]],
    ['rx(-pi/8) q[0];', (t) => [[[c(t / 2), 0], [0, -s(t / 2)]], [[0, -s(t / 2)], [c(t / 2), 0]]]],
  ];
  const angleOf = { 'rx(pi/2) q[0];': Math.PI / 2, 'ry(pi/4) q[0];': Math.PI / 4,
    'rz(3*pi/4) q[0];': 3 * Math.PI / 4, 'rx(-pi/8) q[0];': -Math.PI / 8 };
  for (const [line, want] of cases) {
    const m = parseQasm(`${HEAD}qreg q[1];\n${line}`).gates[0].matrix;
    want(angleOf[line]).forEach((row, r) => row.forEach(([re, im], k) => {
      assertClose(Z.toComplex(m[r][k]), { re, im }, `${line} entry ${r}${k}`);
    }));
  }

  // Exactness is the point, so check it as an identity in the ring rather than in floats:
  // M* M is the identity on the nose, with no tolerance anywhere.
  for (const line of ['rx(pi/8) q[0];', 'ry(3*pi/16) q[0];', 'rz(pi/4) q[0];',
    'u3(pi/2,pi/4,pi) q[0];', 'u2(pi/4,pi/2) q[0];']) {
    const m = parseQasm(`${HEAD}qreg q[1];\n${line}`).gates[0].matrix;
    const id = matMul(dagger(m), m);
    assert.ok(Z.eq(id[0][0], Z.ONE) && Z.eq(id[1][1], Z.ONE)
      && Z.isZero(id[0][1]) && Z.isZero(id[1][0]), `${line} is exactly unitary`);
  }

  // u3 spells out every gate it generalises, exactly.
  const named = [['u3(pi/2,0,pi) q[0];', GATES.h], ['u3(pi,0,pi) q[0];', GATES.x],
    ['u3(pi,pi/2,pi/2) q[0];', GATES.y], ['u2(0,pi) q[0];', GATES.h]];
  for (const [line, gate] of named) {
    const m = parseQasm(`${HEAD}qreg q[1];\n${line}`).gates[0].matrix;
    for (let r = 0; r < 2; r++) {
      for (let k = 0; k < 2; k++) assert.ok(Z.eq(m[r][k], gate.matrix[r][k]), line);
    }
  }

  // rz is the rotation, not qelib1's alias for u1: they differ by e^{-i*theta/2}, a global
  // phase this tool draws. Asserted so the choice cannot drift silently.
  const rz = parseQasm(`${HEAD}qreg q[1];\nrz(pi/2) q[0];\n`).gates[0].matrix;
  const u1 = parseQasm(`${HEAD}qreg q[1];\nu1(pi/2) q[0];\n`).gates[0].matrix;
  assert.ok(!Z.eq(rz[0][0], u1[0][0]), 'rz is not u1');
  assert.ok(Z.eq(Z.mul(rz[0][0], u1[1][1]), rz[1][1]), 'rz = u1 times e^{-i*theta/2}');

  // A rotation needs the ring one level finer than its angle, so it stops one level short
  // of where a phase does. Both limits are real and both are stated in the message.
  assert.throws(() => parseQasm(`${HEAD}qreg q[1];\nrx(pi/512) q[0];\n`), /pi\/256/);
  assert.doesNotThrow(() => parseQasm(`${HEAD}qreg q[1];\nrx(pi/256) q[0];\n`));
  assert.doesNotThrow(() => parseQasm(`${HEAD}qreg q[1];\nu1(pi/512) q[0];\n`));
  assert.throws(() => parseQasm(`${HEAD}qreg q[1];\nrz(pi/3) q[0];\n`), /dyadic rational/);
  assert.throws(() => parseQasm(`${HEAD}qreg q[1];\nrx q[0];\n`), /takes 1 angle/);
  assert.throws(() => parseQasm(`${HEAD}qreg q[2];\nrx(pi/2) q[0],q[1];\n`), /takes 1 qubit/);
});
