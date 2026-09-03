import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MTBDD } from '../src/dd.js';
import * as P from '../src/poly.js';
import * as Z from '../src/zomega.js';
import { rng, randInt } from './helpers.js';

const mgr = (n) => new MTBDD(P.Ring, n);
const allBits = (n) => Array.from({ length: 1 << n }, (_, i) => i.toString(2).padStart(n, '0'));

/** Brute-force truth table of a diagram. */
function table(m, root) { return allBits(m.nvars).map((b) => P.key(m.evaluate(root, b))); }

test('reduction: a don\'t-care variable is skipped, equal nodes are shared', () => {
  const m = mgr(3);
  const t = m.terminal(P.fromInt(5));
  assert.equal(m.mk(0, t, t), t, 'identical children must not create a node');
  assert.equal(m.terminal(P.fromInt(5)), t, 'terminals are hash-consed');
  const a = m.mk(2, m.zero, t);
  assert.equal(m.mk(2, m.zero, t), a, 'internal nodes are hash-consed');
  assert.equal(m.mk(1, a, m.zero), m.mk(1, a, m.zero));
  // A uniform superposition depends on no variable at all: one terminal, nothing else.
  const uni = m.fromAmplitudes(allBits(3).map((b) => [b, P.fromZ(Z.zo(1, 0, 0, 0, 3))]));
  assert.equal(m.size(uni), 1);
  assert.ok(m.isTerminal(uni));
});

test('mk rejects a child that does not live below the node', () => {
  const m = mgr(3);
  const deep = m.mk(2, m.zero, m.one);
  assert.throws(() => m.mk(2, deep, m.zero), /must live below/);
  assert.throws(() => m.mk(3, m.zero, m.one), /must live below/);
});

test('basis states and evaluation round-trip', () => {
  const m = mgr(4);
  for (const b of allBits(4)) {
    const s = m.basisState(b, P.fromInt(7));
    for (const c of allBits(4)) {
      const want = c === b ? P.fromInt(7) : P.zero;
      assert.equal(P.key(m.evaluate(s, c)), P.key(want), `state ${b} evaluated at ${c}`);
    }
  }
  assert.throws(() => m.basisState('01', P.one), /expected 4 bits/);
});

test('canonicity: equal functions are the same node id, whatever route built them', () => {
  const m = mgr(3);
  const amps = [['000', P.fromInt(1)], ['011', P.fromInt(2)], ['110', P.fromInt(3)]];
  const a = m.fromAmplitudes(amps);
  const b = m.fromAmplitudes([...amps].reverse());
  assert.equal(a, b);
  // Same function assembled by summing single basis states in a third order.
  let c = m.zero;
  for (const i of [1, 2, 0]) c = m.add(c, m.basisState(amps[i][0], amps[i][1]));
  assert.equal(a, c);
  // ... and by scaling: (1*x) must be the same node as x.
  assert.equal(m.scale(P.one, a), a);
  assert.equal(m.add(a, m.zero), a);
  assert.equal(m.mul(a, m.zero), m.zero);
});

test('add and mul are pointwise', () => {
  const r = rng(21);
  const n = 3;
  const m = mgr(n);
  for (let iter = 0; iter < 60; iter++) {
    const mk = () => m.fromAmplitudes(allBits(n)
      .filter(() => r() < 0.5)
      .map((b) => [b, P.fromInt(randInt(r, -3, 3))]));
    const [x, y] = [mk(), mk()];
    const sum = m.add(x, y), prod = m.mul(x, y);
    for (const b of allBits(n)) {
      assert.equal(P.key(m.evaluate(sum, b)), P.key(P.add(m.evaluate(x, b), m.evaluate(y, b))));
      assert.equal(P.key(m.evaluate(prod, b)), P.key(P.mul(m.evaluate(x, b), m.evaluate(y, b))));
    }
  }
});

test('restrict fixes one variable and drops the dependence', () => {
  const r = rng(22);
  const n = 4;
  const m = mgr(n);
  for (let iter = 0; iter < 40; iter++) {
    const x = m.fromAmplitudes(allBits(n).filter(() => r() < 0.4).map((b) => [b, P.fromInt(randInt(r, 1, 5))]));
    const lev = randInt(r, 0, n - 1);
    for (const bit of [0, 1]) {
      const rx = m.restrict(x, lev, bit);
      for (const b of allBits(n)) {
        const forced = b.slice(0, lev) + bit + b.slice(lev + 1);
        assert.equal(P.key(m.evaluate(rx, b)), P.key(m.evaluate(x, forced)));
      }
      assert.ok(!m.reachable(rx).some((id) => m.levelOf(id) === lev), 'no node left at the fixed level');
    }
  }
});

test('cube is the indicator of a partial assignment', () => {
  const m = mgr(4);
  const c = m.cube([1, 3], [1, 0]);
  for (const b of allBits(4)) {
    const want = b[1] === '1' && b[3] === '0' ? P.one : P.zero;
    assert.equal(P.key(m.evaluate(c, b)), P.key(want));
  }
});

test('paths compress and amplitudes expand to the same function', () => {
  const r = rng(23);
  const n = 4;
  const m = mgr(n);
  for (let iter = 0; iter < 30; iter++) {
    const x = m.fromAmplitudes(allBits(n).filter(() => r() < 0.5).map((b) => [b, P.fromInt(randInt(r, 1, 4))]));
    const seen = new Map();
    for (const { bits, value } of m.amplitudes(x)) {
      assert.ok(!seen.has(bits), `basis state ${bits} enumerated twice`);
      seen.set(bits, value);
    }
    for (const b of allBits(n)) {
      const got = seen.has(b) ? seen.get(b) : P.zero;
      assert.equal(P.key(got), P.key(m.evaluate(x, b)), `at ${b}`);
    }
    // Every '-' in a path really is a don't-care.
    for (const { path } of m.paths(x)) {
      assert.ok(!/^-+$/.test(path) || m.isTerminal(x));
    }
  }
});

test('the diagram is exponentially smaller when it should be', () => {
  const m = mgr(10);
  const uniform = P.fromZ(Z.zo(1, 0, 0, 0, 10));
  const uni = m.fromAmplitudes(Array.from({ length: 1 << 10 }, (_, i) => [i.toString(2).padStart(10, '0'), uniform]));
  assert.equal(m.size(uni), 1, '1024 equal amplitudes collapse to one terminal');
  const ghz = m.fromAmplitudes([['0'.repeat(10), P.fromZ(Z.INV_SQRT2)], ['1'.repeat(10), P.fromZ(Z.INV_SQRT2)]]);
  // One node at level 0, two at each of levels 1..n-1, plus the 1/√2 and 0 terminals.
  assert.equal(m.size(ghz), 2 * 10 + 1, 'GHZ is linear in the number of qubits');
});

test('dot output mentions every reachable node exactly once', () => {
  const m = mgr(3);
  const s = m.fromAmplitudes([['000', P.fromZ(Z.INV_SQRT2)], ['111', P.fromZ(Z.INV_SQRT2)]]);
  const dot = m.toDot(s);
  for (const id of m.reachable(s)) {
    const decls = dot.match(new RegExp(`^  n${id} \\[`, 'gm')) || [];
    assert.equal(decls.length, 1, `node ${id} declared once`);
  }
  assert.match(dot, /style=dashed/);
});
