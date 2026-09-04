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
