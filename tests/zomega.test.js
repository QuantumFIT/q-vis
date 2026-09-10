import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Z from '../src/zomega.js';
import { rng, randInt, assertClose, cx } from './helpers.js';

function randZ(r) {
  return Z.zo(randInt(r, -4, 4), randInt(r, -4, 4), randInt(r, -4, 4), randInt(r, -4, 4), randInt(r, 0, 4));
}

test('the defining identities of the ring hold exactly', () => {
  assert.ok(Z.eq(Z.mul(Z.OMEGA, Z.OMEGA), Z.I), 'w^2 = i');
  assert.ok(Z.eq(Z.mul(Z.I, Z.I), Z.MINUS_ONE), 'i^2 = -1');
  let w8 = Z.ONE;
  for (let i = 0; i < 8; i++) w8 = Z.mul(w8, Z.OMEGA);
  assert.ok(Z.eq(w8, Z.ONE), 'w^8 = 1');
  assert.ok(Z.eq(Z.mul(Z.SQRT2, Z.SQRT2), Z.fromInt(2)), 'sqrt(2)^2 = 2');
  assert.ok(Z.eq(Z.mul(Z.SQRT2, Z.INV_SQRT2), Z.ONE), 'sqrt(2) * 1/sqrt(2) = 1');
  assert.ok(Z.eq(Z.mul(Z.OMEGA, Z.OMEGA_INV), Z.ONE), 'w * w^-1 = 1');
  assert.ok(Z.eq(Z.add(Z.INV_SQRT2, Z.INV_SQRT2), Z.SQRT2), '2/sqrt(2) = sqrt(2)');
});

test('canonical form: equal values have identical keys, whatever route built them', () => {
  const r = rng(1);
  // Multiplying by sqrt(2) and back must land on the very same representation.
  for (let i = 0; i < 500; i++) {
    const a = randZ(r);
    const round = Z.mul(Z.INV_SQRT2, Z.mul(Z.SQRT2, a));
    assert.equal(Z.key(round), Z.key(a));
  }
  // Distributivity is a canonicity test too: two different expression trees, one key.
  for (let i = 0; i < 500; i++) {
    const [a, b, c] = [randZ(r), randZ(r), randZ(r)];
    assert.equal(Z.key(Z.mul(Z.add(a, b), c)), Z.key(Z.add(Z.mul(a, c), Z.mul(b, c))));
  }
  // k is always minimal and non-negative.
  for (let i = 0; i < 500; i++) {
    const a = randZ(r);
    assert.ok(a.k >= 0);
    if (a.k > 0) {
      const scaled = Z.mul(a, Z.SQRT2);
      assert.equal(scaled.k, a.k - 1, 'multiplying by sqrt(2) must reduce k when k>0');
    }
  }
});

test('ring laws', () => {
  const r = rng(2);
  for (let i = 0; i < 400; i++) {
    const [a, b, c] = [randZ(r), randZ(r), randZ(r)];
    assert.ok(Z.eq(Z.add(a, b), Z.add(b, a)), 'add commutes');
    assert.ok(Z.eq(Z.add(Z.add(a, b), c), Z.add(a, Z.add(b, c))), 'add associates');
    assert.ok(Z.eq(Z.mul(a, b), Z.mul(b, a)), 'mul commutes');
    assert.ok(Z.eq(Z.mul(Z.mul(a, b), c), Z.mul(a, Z.mul(b, c))), 'mul associates');
    assert.ok(Z.eq(Z.add(a, Z.ZERO), a) && Z.eq(Z.mul(a, Z.ONE), a), 'units');
    assert.ok(Z.isZero(Z.sub(a, a)), 'a - a = 0');
    assert.ok(Z.eq(Z.conj(Z.conj(a)), a), 'conjugation is an involution');
  }
});

test('toComplex is a ring homomorphism', () => {
  const r = rng(3);
  for (let i = 0; i < 400; i++) {
    const [a, b] = [randZ(r), randZ(r)];
    assertClose({ ...Z.toComplex(Z.add(a, b)) }, cx.add(Z.toComplex(a), Z.toComplex(b)), 'add');
    assertClose({ ...Z.toComplex(Z.mul(a, b)) }, cx.mul(Z.toComplex(a), Z.toComplex(b)), 'mul');
    const ca = Z.toComplex(a), cc = Z.toComplex(Z.conj(a));
    assertClose(cc, { re: ca.re, im: -ca.im }, 'conj');
  }
});

test('zero is unique and normalised', () => {
  const r = rng(4);
  for (let i = 0; i < 200; i++) {
    const a = randZ(r);
    const z = Z.sub(a, a);
    assert.equal(Z.key(z), Z.key(Z.ZERO));
    assert.equal(z.k, 0);
  }
});

test('formatting round-trips to the right number', () => {
  const cases = [[Z.ONE, '1'], [Z.INV_SQRT2, '1/√2'], [Z.MINUS_I, '-i'], [Z.OMEGA, 'ω'],
    [Z.zo(1, 0, 0, 0, 4), '1/4'], [Z.add(Z.ONE, Z.I), '1+i'], [Z.ZERO, '0'],
    [Z.mul(Z.INV_SQRT2, Z.mul(Z.INV_SQRT2, Z.sub(Z.ONE, Z.I))), '(1-i)/2']];
  for (const [v, want] of cases) assert.equal(Z.format(v), want);
});

test('the algebraic tuple form reconstructs the value it stands for', () => {
  const r = rng(91);
  for (let i = 0; i < 300; i++) {
    const z = randZ(r);
    // A state is written over one common denominator, so the tuple must survive being
    // scaled up to any k at least as large as the element's own.
    const k = z.k + randInt(r, 0, 4);
    const tuple = Z.formatTuple(z, k);
    const [a, b, c, d] = tuple.slice(1, -1).split(',').map((n) => BigInt(n));
    const rebuilt = Z.zo(d, c, b, a, k);
    assert.ok(Z.eq(rebuilt, z),
      `${Z.format(z)} written as ${tuple} over √2^${k} rebuilds as ${Z.format(rebuilt)}`);
  }
});

test('the tuple is ordered by descending power of omega, as in the literature', () => {
  // (a,b,c,d) means a*w^3 + b*w^2 + c*w + d.
  assert.equal(Z.formatTuple(Z.ONE), '(0,0,0,1)');
  assert.equal(Z.formatTuple(Z.OMEGA), '(0,0,1,0)');
  assert.equal(Z.formatTuple(Z.I), '(0,1,0,0)');
  assert.equal(Z.formatTuple(Z.zo(0, 0, 0, 1)), '(1,0,0,0)');
  assert.equal(Z.formatTuple(Z.ZERO), '(0,0,0,0)');
  // 1/sqrt(2) is (0,0,0,1) over sqrt(2)^1, and scaling it to sqrt(2)^3 multiplies by 2.
  assert.equal(Z.formatTuple(Z.INV_SQRT2), '(0,0,0,1)');
  assert.equal(Z.formatTuple(Z.INV_SQRT2, 3), '(0,0,0,2)');
  assert.equal(Z.denominatorPower(Z.INV_SQRT2), 1);
});

test('the unit part factors exactly, and a unit reduces to 1', () => {
  const r = rng(101);
  for (let i = 0; i < 400; i++) {
    const a = randZ(r);
    const { unit, rest } = Z.unitPart(a);
    assert.ok(Z.eq(Z.mul(unit, rest), a), `${Z.format(a)} = ${Z.format(unit)} * ${Z.format(rest)}`);
  }
  // Every unit a circuit can produce collapses to 1, which is what lets an edge-valued
  // diagram share subfunctions differing only by a phase or a normalisation factor.
  const units = [Z.ONE, Z.MINUS_ONE, Z.I, Z.MINUS_I, Z.SQRT2, Z.INV_SQRT2,
    Z.add(Z.ONE, Z.I), Z.zo(1, 0, 0, 0, 5)];
  for (let j = 0; j < 8; j++) units.push(Z.omegaPow(j));
  for (const u of units) {
    assert.ok(Z.eq(Z.unitPart(u).rest, Z.ONE),
      `${Z.format(u)} is a unit but left ${Z.format(Z.unitPart(u).rest)}`);
  }
  // A non-unit keeps its essential part.
  assert.ok(Z.eq(Z.unitPart(Z.fromInt(3)).rest, Z.fromInt(3)));
  assert.ok(Z.eq(Z.unitPart(Z.fromInt(-3)).rest, Z.fromInt(3)));

  // Two elements differing by a unit must land on the same rest — the property the
  // diagram relies on.
  for (let i = 0; i < 200; i++) {
    const a = randZ(r);
    if (Z.isZero(a)) continue;
    const scaled = Z.mul(a, Z.mul(Z.omegaPow(randInt(r, 0, 7)), Z.zo(1, 0, 0, 0, randInt(r, 0, 3))));
    assert.equal(Z.key(Z.unitPart(a).rest), Z.key(Z.unitPart(scaled).rest));
  }
});

// ---- the tower of levels -------------------------------------------------

const LEVELS = [4, 8, 16];

const randAt = (r, d) => Z.zeta(Array.from({ length: d }, () => randInt(r, -3, 3)), randInt(r, 0, 3));

test('each level is the ring it claims to be', () => {
  for (const d of LEVELS) {
    const z = Z.rootPow(1, d);
    assertClose(Z.toComplex(z), { re: Math.cos(Math.PI / d), im: Math.sin(Math.PI / d) },
      `the root at level ${d} is e^(i pi/${d})`);

    // z^d = -1 and z^2d = 1, which is what makes x^d + 1 the right modulus.
    let acc = Z.ONE;
    for (let i = 0; i < d; i++) acc = Z.mul(acc, z);
    assert.ok(Z.eq(acc, Z.MINUS_ONE), `z^${d} = -1 at level ${d}`);
    assert.ok(Z.eq(Z.mul(acc, acc), Z.ONE), `z^${2 * d} = 1 at level ${d}`);

    // sqrt(2) is the same element at every level, and still squares to 2.
    assert.ok(Z.eq(Z.mul(Z.SQRT2, Z.SQRT2), Z.fromInt(2)));
    assert.ok(Z.eq(Z.mul(Z.rootPow(d / 4, d), Z.OMEGA_INV), Z.ONE),
      `the quarter turn at level ${d} is the base level's omega`);
  }
});

test('a value keeps its key whatever level it is written at', () => {
  // This is what hash-consing rests on: the same amplitude reached through a pi/16 phase
  // and through a T gate has to be the same terminal.
  const r = rng(77);
  for (let i = 0; i < 200; i++) {
    const low = randAt(r, 4);
    let raised = low;
    for (const d of [8, 16, 32]) {
      // Multiplying by 1 written at level d promotes and then demotes again.
      raised = Z.mul(raised, Z.rootPow(0, d));
      assert.equal(Z.key(raised), Z.key(low), `level ${d} did not come back down`);
      assert.equal(Z.levelOf(raised), Z.levelOf(low));
    }
  }
});

test('a value that needs a finer phase stays up, and says so', () => {
  const eighth = Z.rootPow(1, 8);                       // e^(i pi/8)
  assert.equal(Z.levelOf(eighth), 8);
  assert.equal(Z.levelOf(Z.mul(eighth, eighth)), 4, 'two eighth turns make a quarter');
  assert.ok(Z.eq(Z.mul(eighth, eighth), Z.OMEGA));

  // And it is a genuinely new number: not expressible at the base level.
  assert.notEqual(Z.key(eighth), Z.key(Z.OMEGA));
  assert.equal(Z.levelOf(Z.add(eighth, Z.ONE)), 8, 'a sum that needs the level keeps it');
  assert.equal(Z.levelOf(Z.sub(eighth, eighth)), 4, 'zero is at the floor');
});

test('ring laws hold at every level, and across levels', () => {
  const r = rng(78);
  for (const d of LEVELS) {
    for (let i = 0; i < 60; i++) {
      const a = randAt(r, d);
      const b = randAt(r, d);
      // Mixed levels on purpose: the promotion has to be a ring homomorphism.
      const c = randAt(r, LEVELS[randInt(r, 0, LEVELS.length - 1)]);
      assert.ok(Z.eq(Z.mul(Z.mul(a, b), c), Z.mul(a, Z.mul(b, c))), 'associative');
      assert.ok(Z.eq(Z.mul(a, b), Z.mul(b, a)), 'commutative');
      assert.ok(Z.eq(Z.mul(a, Z.add(b, c)), Z.add(Z.mul(a, b), Z.mul(a, c))), 'distributive');
      assert.ok(Z.eq(Z.add(a, Z.neg(a)), Z.ZERO), 'additive inverse');
      assertClose(Z.toComplex(Z.mul(a, b)), cx.mul(Z.toComplex(a), Z.toComplex(b)),
        'the numeric value follows the algebra');
    }
  }
});

test('conjugation and inversion work at every level', () => {
  const r = rng(79);
  for (const d of LEVELS) {
    for (let i = 0; i < 40; i++) {
      const a = randAt(r, d);
      assert.ok(Z.eq(Z.conj(Z.conj(a)), a), 'conjugation is an involution');
      const sq = Z.mul(a, Z.conj(a));
      const { im } = Z.toComplex(sq);
      assert.ok(Math.abs(im) < 1e-9, 'a times its conjugate is real');
      assert.ok(Z.toComplex(sq).re > -1e-9, 'and not negative');

      const inv = Z.tryInvert(a);
      if (inv !== null) assert.ok(Z.eq(Z.mul(a, inv), Z.ONE), `1/a at level ${d}`);
    }
    // The root itself is a unit at every level, and 3 is invertible at none of them.
    assert.ok(Z.eq(Z.mul(Z.rootPow(1, d), Z.tryInvert(Z.rootPow(1, d))), Z.ONE));
  }
  assert.equal(Z.tryInvert(Z.fromInt(3)), null, '3 has no inverse anywhere in the tower');
  assert.equal(Z.tryInvert(Z.add(Z.rootPow(1, 8), Z.fromInt(3))), null);
});

test('the unit part factors exactly at every level', () => {
  const r = rng(80);
  for (const d of LEVELS) {
    for (let i = 0; i < 40; i++) {
      const a = randAt(r, d);
      const { unit, rest } = Z.unitPart(a);
      assert.ok(Z.eq(Z.mul(unit, rest), a), `unit * rest = a at level ${d}`);
      if (Z.isZero(a)) continue;
      // A rotation at this level is a unit, so it must leave the rest alone.
      const turned = Z.mul(a, Z.rootPow(randInt(r, 1, 2 * d - 1), d));
      assert.equal(Z.key(Z.unitPart(turned).rest), Z.key(rest),
        `a rotation at level ${d} changes the unit, not the rest`);
    }
    assert.ok(Z.eq(Z.unitPart(Z.rootPow(3, d)).rest, Z.ONE), 'a unit reduces to 1');
  }
});

test('formatting names the root of the level it is at', () => {
  assert.equal(Z.format(Z.OMEGA), 'ω');
  assert.equal(Z.format(Z.rootPow(1, 8)), 'ω');
  assert.equal(Z.format(Z.rootPow(3, 8)), 'ω³');
  assert.equal(Z.format(Z.rootPow(4, 8)), 'i', 'the quarter turn is still i');
  assert.equal(Z.format(Z.rootPow(9, 16)), 'ω⁹');
  // The value is what the string says, whatever the level.
  for (const d of LEVELS) {
    for (let j = 0; j < 2 * d; j++) {
      const z = Z.rootPow(j, d);
      assertClose(Z.toComplex(z), { re: Math.cos((Math.PI * j) / d), im: Math.sin((Math.PI * j) / d) },
        `level ${d}, power ${j}`);
    }
  }
});

test('a formatter writes the value it was given, or says it cannot', () => {
  // A tuple can always be *rewritten* upward: more halvings, or a finer level. Downward
  // it cannot, since that needs a division that is not generally exact — so asking for
  // fewer halvings used to print the tuple of a different number, silently.
  assert.equal(Z.formatTuple(Z.INV_SQRT2, 3), '(0,0,0,2)', 'raising k rewrites the same value');
  assert.equal(Z.formatTuple(Z.ONE, 0, 8), '(0,0,0,0,0,0,0,1)', 'so does raising the level');
  assert.throws(() => Z.formatTuple(Z.INV_SQRT2, 0), /1 halvings at 0/);
  assert.throws(() => Z.formatTuple(Z.rootPow(1, 16), 0, 4), /level-16 value at level 4/);

  // Polar-pi names an exact fraction of pi when there is one. It stopped looking at pi/64,
  // so the finest phases the parser accepts — and every half angle a rotation makes — came
  // out as a decimal, which reads as though the angle were not exact.
  for (const [j, d, want] of [[1, 64, 'π/64'], [1, 128, 'π/128'], [1, 256, 'π/256'],
    [1, 512, 'π/512'], [53, 512, '53π/512'], [3, 8, '3π/8']]) {
    assert.equal(Z.formatPolar(Z.rootPow(j, d), 'pi'), `1∠${want}`);
  }
});
