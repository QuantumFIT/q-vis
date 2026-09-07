import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Pauli from '../src/pauli.js';
import * as P from '../src/poly.js';
import * as Z from '../src/zomega.js';
import { rng, randInt } from './helpers.js';

const R = P.Ring;
const tryInvert = (w) => {
  const s = P.asScalar(w);
  if (s === null) return null;
  const inv = Z.tryInvert(s);
  return inv === null ? null : P.fromZ(inv);
};

const randomLim = (r, n) => ({
  w: P.fromZ(Z.omegaPow(randInt(r, 0, 7))),
  x: randInt(r, 0, (1 << n) - 1),
  z: randInt(r, 0, (1 << n) - 1),
});

// ---- an independent reference: the actual matrices ------------------------

const MAT = {
  I: [[Z.ONE, Z.ZERO], [Z.ZERO, Z.ONE]],
  X: [[Z.ZERO, Z.ONE], [Z.ONE, Z.ZERO]],
  Z: [[Z.ONE, Z.ZERO], [Z.ZERO, Z.MINUS_ONE]],
  XZ: [[Z.ZERO, Z.MINUS_ONE], [Z.ONE, Z.ZERO]],   // X*Z, which is -i*Y
};

/** The dense matrix of a LIM, built qubit by qubit — index bit j is qubit j. */
function dense(a, n) {
  let m = [[a.w]];
  for (let q = n - 1; q >= 0; q--) {
    const x = (a.x >> q) & 1;
    const z = (a.z >> q) & 1;
    const f = [MAT.I, MAT.Z, MAT.X, MAT.XZ][x * 2 + z];
    const out = Array.from({ length: m.length * 2 }, () => new Array(m.length * 2));
    for (let i = 0; i < m.length; i++) {
      for (let j = 0; j < m.length; j++) {
        for (let p = 0; p < 2; p++) {
          for (let q2 = 0; q2 < 2; q2++) {
            out[i * 2 + p][j * 2 + q2] = P.mul(m[i][j], P.fromZ(f[p][q2]));
          }
        }
      }
    }
    m = out;
  }
  return m;
}

const timesVector = (m, v) => m.map((row) => row.reduce((acc, e, j) => P.add(acc, P.mul(e, v[j])), P.zero));

const randomVector = (r, n) => Array.from({ length: 1 << n },
  () => P.fromZ(Z.zo(randInt(r, -2, 2), randInt(r, -2, 2), randInt(r, -2, 2), 0)));

const sameVector = (u, v) => u.every((e, i) => P.eq(e, v[i]));

// ---- tests ---------------------------------------------------------------

test('the mask form acts exactly as the matrix it stands for', () => {
  const r = rng(11);
  for (let iter = 0; iter < 60; iter++) {
    const n = randInt(r, 1, 4);
    const a = randomLim(r, n);
    const v = randomVector(r, n);
    assert.ok(sameVector(Pauli.apply(R, a, v), timesVector(dense(a, n), v)),
      `apply disagrees with the matrix for ${Pauli.formatString(a, n)}`);
  }
});

test('multiplication is the matrix product, signs included', () => {
  const r = rng(12);
  for (let iter = 0; iter < 60; iter++) {
    const n = randInt(r, 1, 4);
    const a = randomLim(r, n);
    const b = randomLim(r, n);
    const v = randomVector(r, n);
    // (AB)v = A(Bv)
    assert.ok(sameVector(Pauli.apply(R, Pauli.mul(R, a, b), v),
      Pauli.apply(R, a, Pauli.apply(R, b, v))),
      'the product does not act as the composition');
  }
});

test('a Pauli string inverts over the ring whatever its weight cannot do', () => {
  const r = rng(13);
  for (let iter = 0; iter < 60; iter++) {
    const n = randInt(r, 1, 4);
    const a = randomLim(r, n);
    const inv = Pauli.inverse(R, a, tryInvert);
    assert.ok(inv !== null, 'a unit weight inverts');
    const one = Pauli.mul(R, a, inv);
    assert.ok(Pauli.isIdentityString(one) && P.eq(one.w, P.one), 'A * A^-1 is the identity');
  }

  // The string part comes out even when the weight has no inverse at all: 3 does not,
  // and that is the whole reason the diagram treats the two halves differently.
  const three = { w: P.fromInt(3), x: 0b101, z: 0b110 };
  assert.equal(Pauli.inverse(R, three, tryInvert), null, 'the weight blocks the inverse');
  const stringOnly = { w: P.one, x: three.x, z: three.z };
  assert.ok(Pauli.inverse(R, stringOnly, tryInvert) !== null, 'the string alone still inverts');
});

test('the adjoint is the inverse for a unit-weight string', () => {
  const r = rng(14);
  for (let iter = 0; iter < 40; iter++) {
    const n = randInt(r, 1, 4);
    const a = randomLim(r, n);
    const conj = (w) => P.fromZ(Z.conj(P.asScalar(w)));
    const d = Pauli.dagger(R, conj, a);
    const one = Pauli.mul(R, a, d);
    assert.ok(Pauli.isIdentityString(one) && P.eq(one.w, P.one), 'A A* = 1 for a unitary LIM');
  }
});

test('commutation is decided by the symplectic form', () => {
  const r = rng(15);
  for (let iter = 0; iter < 60; iter++) {
    const n = randInt(r, 1, 3);
    const a = { ...randomLim(r, n), w: P.one };
    const b = { ...randomLim(r, n), w: P.one };
    const ab = Pauli.mul(R, a, b);
    const ba = Pauli.mul(R, b, a);
    assert.equal(P.eq(ab.w, ba.w), Pauli.commute(a, b),
      `${Pauli.formatString(a, n)} and ${Pauli.formatString(b, n)}`);
  }
});

test('the order puts the identity first and is total', () => {
  const r = rng(16);
  const n = 3;
  const lims = Array.from({ length: 30 }, () => randomLim(r, n));
  const id = { w: P.one, x: 0, z: 0 };
  for (const a of lims) {
    if (Pauli.isIdentityString(a)) continue;
    assert.equal(Pauli.compare(R, id, a), -1, 'the identity string is the least');
  }
  for (const a of lims) {
    for (const b of lims) {
      assert.equal(Pauli.compare(R, a, b), -Pauli.compare(R, b, a) || 0, 'antisymmetric');
      assert.equal(Pauli.compare(R, a, b) === 0, Pauli.key(R, a) === Pauli.key(R, b));
    }
  }
});

test('a string prints as a tensor product, with Y where X and Z meet', () => {
  assert.equal(Pauli.formatString({ x: 0b011, z: 0b110 }, 3), 'X⊗Y⊗Z');
  assert.equal(Pauli.formatString({ x: 0, z: 0 }, 4), 'I⊗I⊗I⊗I');
  assert.equal(Pauli.formatString({ x: 1, z: 0 }, 1), 'X', 'one qubit needs no operator');
  // XZ is -i*Y, so printing that Y owes the weight a factor of -i.
  assert.equal(Pauli.phaseShift({ x: 0b011, z: 0b110 }), 1);
  assert.equal(Pauli.phaseShift({ x: 0b011, z: 0b011 }), 2);
});
