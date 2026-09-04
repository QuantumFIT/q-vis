import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Z from '../src/zomega.js';
import * as P from '../src/poly.js';
import { rng, randInt, assertClose, cx } from './helpers.js';

const NAMES = ['a', 'b', 'c'];

function randPoly(r) {
  let p = P.zero;
  const n = randInt(r, 0, 3);
  for (let i = 0; i < n; i++) {
    let term = P.fromZ(Z.zo(randInt(r, -3, 3), randInt(r, -3, 3), 0, 0, randInt(r, 0, 3)));
    const deg = randInt(r, 0, 2);
    for (let d = 0; d < deg; d++) term = P.mul(term, P.variable(NAMES[randInt(r, 0, 2)]));
    p = P.add(p, term);
  }
  return p;
}

test('ring laws over polynomials', () => {
  const r = rng(11);
  for (let i = 0; i < 300; i++) {
    const [p, q, s] = [randPoly(r), randPoly(r), randPoly(r)];
    assert.ok(P.eq(P.add(p, q), P.add(q, p)), 'add commutes');
    assert.ok(P.eq(P.mul(p, q), P.mul(q, p)), 'mul commutes');
    assert.ok(P.eq(P.mul(P.mul(p, q), s), P.mul(p, P.mul(q, s))), 'mul associates');
    assert.ok(P.eq(P.mul(P.add(p, q), s), P.add(P.mul(p, s), P.mul(q, s))), 'distributes');
    assert.ok(P.isZero(P.sub(p, p)), 'p - p = 0');
    assert.ok(P.eq(P.mul(p, P.one), p), 'unit');
    assert.ok(P.isZero(P.mul(p, P.zero)), 'annihilator');
  }
});

test('the key is a canonical form', () => {
  const a = P.variable('a'), b = P.variable('b');
  assert.equal(P.key(P.add(a, b)), P.key(P.add(b, a)));
  assert.equal(P.key(P.mul(a, b)), P.key(P.mul(b, a)));
  assert.equal(P.key(P.sub(a, a)), P.key(P.zero));
  // Cancellation must actually delete the term, not leave a zero coefficient behind.
  assert.equal(P.add(a, P.neg(a)).t.size, 0);
  assert.notEqual(P.key(a), P.key(b));
});

test('evaluation agrees with the symbolic algebra', () => {
  const r = rng(12);
  const env = { a: { re: 0.3, im: -0.7 }, b: { re: -0.2, im: 0.5 }, c: { re: 1.1, im: 0.25 } };
  for (let i = 0; i < 300; i++) {
    const [p, q] = [randPoly(r), randPoly(r)];
    assertClose(P.evaluate(P.add(p, q), env), cx.add(P.evaluate(p, env), P.evaluate(q, env)), 'add');
    assertClose(P.evaluate(P.mul(p, q), env), cx.mul(P.evaluate(p, env), P.evaluate(q, env)), 'mul');
  }
});

test('symbolic amplitudes format readably', () => {
  const a = P.variable('a'), b = P.variable('b');
  assert.equal(P.format(P.mul(P.fromZ(Z.INV_SQRT2), P.add(a, b))), 'a/√2 + b/√2');
  assert.equal(P.format(P.sub(a, b)), 'a - b');
  assert.equal(P.format(P.zero), '0');
  assert.equal(P.format(P.mul(P.fromZ(Z.I), a)), 'i·a');
});

test('asScalar recognises constants only', () => {
  assert.ok(Z.eq(P.asScalar(P.fromInt(3)), Z.fromInt(3)));
  assert.equal(P.asScalar(P.variable('a')), null);
  assert.ok(Z.isZero(P.asScalar(P.zero)));
});

test('amplitudes can be printed as floating point, rectangular or polar', () => {
  const half = Z.zo(1, 0, 0, 0, 2);
  const cases = [
    [P.one, '1', '1∠0°'],
    [P.fromZ(Z.INV_SQRT2), '0.7071', '0.7071∠0°'],
    [P.fromZ(Z.MINUS_I), '-i', '1∠-90°'],
    [P.fromZ(Z.OMEGA), '0.7071+0.7071i', '1∠45°'],
    [P.fromZ(Z.mul(Z.INV_SQRT2, Z.mul(Z.INV_SQRT2, Z.sub(Z.ONE, Z.I)))), '0.5-0.5i', '0.7071∠-45°'],
    [P.fromZ(Z.neg(half)), '-0.5', '0.5∠180°'],
    [P.zero, '0', '0'],
  ];
  for (const [v, rect, polar] of cases) {
    assert.equal(P.format(v, 'rect'), rect, `rect of ${P.format(v)}`);
    assert.equal(P.format(v, 'polar'), polar, `polar of ${P.format(v)}`);
  }
});

test('numeric formatting agrees with the exact value it replaces', () => {
  const r = rng(77);
  for (let i = 0; i < 200; i++) {
    const p = randPoly(r);
    if (P.symbols(p).size) continue;
    const want = P.evaluate(p, {});
    const rect = P.format(p, 'rect');
    // Parse the printed rectangular form back and check it is the same number.
    const m = rect.match(/^(-?[\d.]+)?(?:([+-]?)([\d.]*)i)?$/);
    assert.ok(m, `unparsable rectangular form: ${rect}`);
    const re = m[1] ? parseFloat(m[1]) : 0;
    const im = m[3] === undefined ? 0 : (m[2] === '-' ? -1 : 1) * (m[3] === '' ? 1 : parseFloat(m[3]));
    assert.ok(Math.abs(re - want.re) < 1e-3 && Math.abs(im - want.im) < 1e-3,
      `${P.format(p)} printed as ${rect}, but is ${want.re}+${want.im}i`);
    // Polar must agree on magnitude.
    const polar = P.format(p, 'polar');
    const mag = polar === '0' ? 0 : parseFloat(polar);
    assert.ok(Math.abs(mag - Math.hypot(want.re, want.im)) < 1e-3, `${polar} vs |${P.format(p)}|`);
  }
});

test('symbolic terms keep their monomials in every format', () => {
  const a = P.variable('a');
  // A plain number runs straight into the monomial; anything else is bracketed when it
  // already holds an operator, and separated otherwise. "-ω³a111" would be ambiguous.
  assert.equal(P.format(P.mul(P.fromZ(Z.INV_SQRT2), a), 'rect'), '0.7071a');
  assert.equal(P.format(P.mul(P.fromZ(Z.I), a), 'rect'), 'i·a');
  assert.equal(P.format(P.mul(P.fromZ(Z.zo(0, 0, 0, -1)), P.variable('a111'))), '-ω³·a111');
  assert.equal(P.format(P.mul(P.fromZ(Z.fromInt(3)), P.variable('a111'))), '3a111');
  assert.equal(P.format(P.mul(P.fromZ(Z.I), a), 'polar'), '(1∠90°)a');
  assert.equal(P.format(P.mul(P.fromZ(Z.mul(Z.INV_SQRT2, Z.mul(Z.INV_SQRT2, Z.sub(Z.ONE, Z.I)))), a), 'rect'),
    '(0.5-0.5i)a');
  // An already-bracketed coefficient is not bracketed twice.
  assert.equal(P.format(P.mul(P.fromZ(Z.MINUS_I), a), 'tuple', { k: 0 }), '(0,-1,0,0)a');
});

test('polar angles can be shown in degrees, radians or multiples of pi', () => {
  const cases = [
    [Z.ONE, '1∠0°', '1∠0', '1∠0'],
    [Z.OMEGA, '1∠45°', '1∠0.7854', '1∠π/4'],
    [Z.I, '1∠90°', '1∠1.5708', '1∠π/2'],
    [Z.zo(0, 0, 0, 1), '1∠135°', '1∠2.3562', '1∠3π/4'],
    [Z.MINUS_ONE, '1∠180°', '1∠3.1416', '1∠π'],
    [Z.MINUS_I, '1∠-90°', '1∠-1.5708', '1∠-π/2'],
    [Z.INV_SQRT2, '0.7071∠0°', '0.7071∠0', '0.7071∠0'],
    [Z.ZERO, '0', '0', '0'],
  ];
  for (const [z, deg, rad, pi] of cases) {
    const v = P.fromZ(z);
    assert.equal(P.format(v, 'polar-deg'), deg);
    assert.equal(P.format(v, 'polar-rad'), rad);
    assert.equal(P.format(v, 'polar-pi'), pi);
  }
  // Links and settings written before the angle unit existed still mean degrees.
  assert.equal(P.format(P.fromZ(Z.OMEGA), 'polar'), '1∠45°');
});

test('the pi form is exact for every angle the ring can produce', () => {
  // Every element of Z[1/sqrt2, i] has an argument that is a multiple of pi/4.
  for (let k = 0; k < 8; k++) {
    const printed = P.format(P.fromZ(Z.omegaPow(k)), 'polar-pi');
    assert.doesNotMatch(printed, /\d\.\d/, `w^${k} printed with a decimal angle: ${printed}`);
    assert.match(printed, /^1∠(0|-?\d*π(\/\d)?)$/, `unexpected form for w^${k}: ${printed}`);
  }
});

test('a state is written over one common denominator', () => {
  // The eight QFT amplitudes share sqrt(2)^3 and become the signed unit tuples.
  const k = 3;
  const eighth = Z.zo(1, 0, 0, 0, k);
  const seen = [];
  for (let j = 0; j < 8; j++) {
    seen.push(P.format(P.fromZ(Z.mul(eighth, Z.omegaPow(j))), 'tuple', { k }));
  }
  assert.deepEqual(seen, [
    '(0,0,0,1)', '(0,0,1,0)', '(0,1,0,0)', '(1,0,0,0)',
    '(0,0,0,-1)', '(0,0,-1,0)', '(0,-1,0,0)', '(-1,0,0,0)',
  ]);
  // Zero still prints as a tuple rather than as "0", so a column of them lines up.
  assert.equal(P.format(P.zero, 'tuple', { k }), '(0,0,0,0)');
  assert.equal(P.denominatorPower(P.fromZ(eighth)), 3);
  // Symbolic terms keep their monomial here too.
  assert.equal(P.format(P.mul(P.fromZ(Z.INV_SQRT2), P.variable('a')), 'tuple', { k: 1 }), '(0,0,0,1)a');
});
