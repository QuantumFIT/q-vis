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
  assert.equal(P.format(P.mul(P.fromZ(Z.I), a)), 'ia');
});

test('asScalar recognises constants only', () => {
  assert.ok(Z.eq(P.asScalar(P.fromInt(3)), Z.fromInt(3)));
  assert.equal(P.asScalar(P.variable('a')), null);
  assert.ok(Z.isZero(P.asScalar(P.zero)));
});
