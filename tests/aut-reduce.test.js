import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduce } from '../src/aut-reduce.js';
import { ANY } from '../src/aut-lsta.js';
import { LSTA } from '../src/aut-lsta.js';
import { parseHsl, toVector } from '../src/aut-hsl.js';
import { SPECIALS } from '../src/aut-examples.js';
import * as P from '../src/poly.js';
import * as Z from '../src/zomega.js';
import { rng, randInt } from './helpers.js';

const ring = P.Ring;
const basis = (n, index) => Array.from({ length: 2 ** n },
  (_, i) => (i === index ? P.one : P.zero));
const half = P.fromZ(Z.zo(1, 0, 0, 0, 2));
const inv2 = P.fromZ(Z.INV_SQRT2);

/** A language as a set of comparable keys, so order does not matter. */
const asSet = (vs) => new Set(vs.map((v) => v.map((x) => ring.key(x)).join('|')));

test('reducing keeps the language exactly — over random sets of random states', () => {
  // The only thing that has to be true. Everything else here is about size; this is
  // about meaning, and it is checked by enumerating both languages and comparing them.
  const r = rng(20260915);
  for (let iter = 0; iter < 120; iter++) {
    const n = randInt(r, 1, 4);
    const vectors = [];
    for (let k = 0; k < randInt(r, 1, 5); k++) {
      const v = Array.from({ length: 2 ** n },
        () => [P.zero, P.one, half, inv2][randInt(r, 0, 3)]);
      if (!vectors.some((u) => u.every((x, i) => ring.eq(x, v[i])))) vectors.push(v);
    }
    const ta = new LSTA(ring, n);
    const { root } = ta.fromVectors(vectors);
    const small = reduce(ta, root);
    assert.deepEqual(asSet(ta.language(small)), asSet(ta.language(root)),
      `${n} qubits, ${vectors.length} states: the language changed`);
    assert.ok(ta.size(small) <= ta.size(root), 'and it never grew');
  }
});

test('every computational basis state costs 2n+1 states, not 2^n trees', () => {
  // What the reduction is for, on the set that shows it best. Unreduced, each of the 2^n
  // members is its own transition of the root; reduced, the automaton says the one thing
  // that is true of all of them — the 1 is somewhere below, and everything else is zero.
  for (const n of [1, 2, 3, 4, 5, 6]) {
    const ta = new LSTA(ring, n);
    const spec = parseHsl(SPECIALS.basis.spec(n), n);
    const { root } = ta.fromVectors(spec.vectors.map((v) => toVector(v, ring)));
    const small = reduce(ta, root);
    assert.equal(ta.size(small), 2 * n + 1, `${n} qubits`);
    assert.equal(ta.transitionsOf(small).length, Math.min(2, 2 ** n),
      `${n} qubits: the root chooses which half holds the 1`);
    assert.equal(ta.language(small).length, 2 ** n, 'and it still accepts every one of them');
  }
});

test('a set of one is already as small as it goes, and comes out uncoloured', () => {
  // Nothing to merge, because interning had already done it. What does change is the
  // colours: one member is painted colour 0 everywhere, and a colour every transition on
  // its level admits tells nothing apart, so the reduction takes it off again.
  for (const n of [1, 2, 3, 4]) {
    const ta = new LSTA(ring, n);
    const spec = parseHsl(SPECIALS.zero.spec(n), n);
    const { root } = ta.fromVectors(spec.vectors.map((v) => toVector(v, ring)));
    const small = reduce(ta, root);
    assert.equal(ta.size(small), ta.size(root), `${n} qubits: nothing to merge`);
    assert.deepEqual(asSet(ta.language(small)), asSet(ta.language(root)));
    for (const id of ta.reachable(small)) {
      for (const [, , choice] of ta.transitionsOf(id)) {
        assert.equal(choice, ANY, `${n} qubits: a set of one needs no colour`);
      }
    }
  }
});

test('reducing twice is reducing once', () => {
  const r = rng(20260916);
  for (let iter = 0; iter < 40; iter++) {
    const n = randInt(r, 2, 4);
    const ta = new LSTA(ring, n);
    const picks = [];
    for (let k = 0; k < randInt(r, 2, 6); k++) {
      const b = randInt(r, 0, 2 ** n - 1);
      if (!picks.includes(b)) picks.push(b);
    }
    const { root } = ta.fromVectors(picks.map((b) => basis(n, b)));
    const once = reduce(ta, root);
    assert.equal(reduce(ta, once), once, `${n} qubits, ${picks.length} states`);
  }
});

test('transitions that agree on neither side are left alone', () => {
  // The rule is exact because one side is *identical*. Merging (A,C) with (B,D) would
  // add (A,D) and (B,C), which were never in the language — so it must not happen, and
  // this is the smallest automaton where the difference shows.
  const ta = new LSTA(ring, 2);
  const l0 = ta.leaf(P.zero);
  const l1 = ta.leaf(P.one);
  const A = ta.state(1, [[l1, l0]]);
  const B = ta.state(1, [[l0, l1]]);
  const C = ta.state(1, [[l1, l1]]);
  const D = ta.state(1, [[l0, l0]]);
  const root = ta.state(0, [[A, C], [B, D]]);
  const small = reduce(ta, root);
  assert.equal(ta.language(small).length, 2, 'still two trees, not four');
  assert.deepEqual(asSet(ta.language(small)), asSet(ta.language(root)));

  // and the case that *does* merge, beside it, so the pair reads as a contrast. A and B
  // have to be told apart by colour for the merge to be allowed: united under one colour
  // they would offer two steps at once, and a gate needs a colouring to pick out a run.
  const shared = ta.state(0, [[ta.state(1, [[l1, l0, [0]]]), C],
    [ta.state(1, [[l0, l1, [1]]]), C]]);
  const merged = reduce(ta, shared);
  assert.equal(ta.transitionsOf(merged).length, 1, 'a shared high child merges the lows');
  assert.deepEqual(asSet(ta.language(merged)), asSet(ta.language(shared)));

  // Without the colours the same merge is refused, because it would make a state that
  // takes two steps under one colour — correct for the language, useless for a gate.
  const blind = ta.state(0, [[A, C], [B, C]]);
  assert.equal(ta.transitionsOf(reduce(ta, blind)).length, 2, 'nothing to tell A from B');
});

test('a leaf is not a state that can be united, and is not pretended to be', () => {
  // At the last level the children are amplitudes. A 0 and a 1 are two different things
  // and no merge can make them one, so the transitions stay as they are.
  const ta = new LSTA(ring, 1);
  const l0 = ta.leaf(P.zero);
  const l1 = ta.leaf(P.one);
  const root = ta.state(0, [[l1, l0], [l0, l1]]);
  const small = reduce(ta, root);
  assert.equal(ta.transitionsOf(small).length, 2);
  assert.deepEqual(asSet(ta.language(small)), asSet(ta.language(root)));
});
