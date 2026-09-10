import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fanAngles, layoutAutomaton, spread } from '../src/aut-layout.js';
import { TA } from '../src/aut-ta.js';
import * as P from '../src/poly.js';
import { rng, randInt, CLOSE } from './helpers.js';

const ring = P.Ring;
const basis = (n, index) => Array.from({ length: 2 ** n },
  (_, i) => (i === index ? P.one : P.zero));
const laid = (ta, root, prevRank) => layoutAutomaton(ta, root, {
  formatValue: (v) => P.format(v, 'exact'),
  prevRank,
});

test('every edge leaving a state leaves at its own angle', () => {
  // The complaint this answers: two edges from one point are one line as far as the eye
  // is concerned. Swept over shapes rather than checked on one, because the fan narrows
  // as the number of edges grows and that is exactly where a collision would hide.
  const r = rng(20260911);
  for (let iter = 0; iter < 200; iter++) {
    const groups = Array.from({ length: randInt(r, 1, 5) },
      () => [r() * 180 - 90, r() * 180 - 90]);
    const given = fanAngles(groups);
    const flat = given.flat().sort((a, b) => a - b);
    for (let i = 1; i < flat.length; i++) {
      assert.ok(flat[i] - flat[i - 1] > 1, `${groups.length} transitions: ${flat.join(', ')}`);
    }
    assert.ok(Math.abs(flat[0]) <= 72 + CLOSE && Math.abs(flat.at(-1)) <= 72 + CLOSE,
      `the fan stays under the state: ${flat.join(', ')}`);
  }
});

test('a transition owns a contiguous sector, so its arc spans it and nothing else', () => {
  // What makes the arc readable. If two transitions interleaved, one arc would cross the
  // other's edges and the reader could not tell which pair either belonged to.
  const r = rng(20260912);
  for (let iter = 0; iter < 200; iter++) {
    const groups = Array.from({ length: randInt(r, 2, 5) },
      () => [r() * 180 - 90, r() * 180 - 90]);
    const given = fanAngles(groups);
    given.forEach((pair, g) => {
      const lo = Math.min(...pair);
      const hi = Math.max(...pair);
      given.forEach((other, h) => {
        if (h === g) return;
        for (const angle of other) {
          assert.ok(angle < lo || angle > hi,
            `transition ${h} at ${angle} sits inside transition ${g}'s ${lo}..${hi}`);
        }
      });
    });
  }
});

test('a fan that is wanted symmetric comes out symmetric', () => {
  const [pair] = fanAngles([[-40, 40]]);
  assert.ok(Math.abs(pair[0] + pair[1]) < CLOSE, `${pair.join(', ')}`);
  assert.ok(pair[0] < 0 && pair[1] > 0, 'and the left-hand child stays on the left');

  // Both children in the same place — the all-zero subtree, which is everywhere — still
  // gets two distinct exits rather than one line drawn twice.
  const [same] = fanAngles([[12, 12]]);
  assert.notEqual(same[0], same[1]);
});

test('an edge says which transition it belongs to, and each has one low and one high', () => {
  const ta = new TA(ring, 2);
  const zeroLeaf = ta.leaf(P.zero);
  const oneLeaf = ta.leaf(P.one);
  const l0 = ta.state(1, [[oneLeaf, zeroLeaf]]);
  const l1 = ta.state(1, [[zeroLeaf, oneLeaf]]);
  const root = ta.state(0, [[l0, l0], [l1, l1]]);
  const layout = laid(ta, root);

  const out = layout.edges.filter((e) => e.from === root);
  assert.equal(out.length, 4, 'two transitions, two edges each');
  for (const t of [0, 1]) {
    const pair = out.filter((e) => e.transition === t);
    assert.equal(pair.length, 2);
    assert.deepEqual(pair.map((e) => e.high).sort(), [false, true]);
  }
  assert.deepEqual([...new Set(layout.nodes.map((n) => n.kind))].sort(), ['leaf', 'state'],
    'the junction is gone: a node is a state or a leaf');
});

test('the root is marked, and it is the only one', () => {
  // Without the mark the picture does not say what the automaton accepts: a run accepts
  // the tree it read when it ends in a root state, and the top of the drawing is
  // otherwise only the top of the drawing.
  const ta = new TA(ring, 3);
  const { root } = ta.fromVectors([basis(3, 0), basis(3, 5)]);
  const layout = laid(ta, root);
  const marked = layout.nodes.filter((n) => n.root);
  assert.equal(marked.length, 1);
  assert.equal(marked[0].id, root);
  assert.equal(marked[0].y, 0, 'and it is on the top row');
  assert.ok(layout.nodes.every((n) => n.root || n.id !== root), 'nothing else claims it');
});

test('a deterministic automaton lays out as the diagram it is', () => {
  for (const n of [1, 2, 3, 4]) {
    const ta = new TA(ring, n);
    const { root } = ta.fromVectors([basis(n, 0)]);
    const layout = laid(ta, root);
    assert.equal(layout.nodes.length, ta.size(root), 'one node per reachable state');
    assert.ok(layout.edges.every((e) => e.transition === 0), `${n} qubits: one choice only`);
    assert.equal(layout.height, n);
    for (const node of layout.nodes) {
      assert.equal(node.y, ta.levelOf(node.id), 'a state sits on the row of its variable');
    }
  }
});

test('a state that survives stays where it was', () => {
  // The reason `stableOrder` is shared with the other page: a picture that re-sorted
  // itself every frame would be unreadable however pretty each frame was.
  const ta = new TA(ring, 3);
  const first = laid(ta, ta.fromVectors([basis(3, 0), basis(3, 7)]).root);
  const second = laid(ta, ta.fromVectors([basis(3, 0), basis(3, 7), basis(3, 3)]).root,
    first.rank);
  for (const [id, x] of first.rank) {
    if (!second.rank.has(id)) continue;
    const before = [...first.rank].filter(([o, ox]) => ox < x
      && first.nodes.find((n) => n.id === o)?.y === first.nodes.find((n) => n.id === id)?.y);
    const after = before.filter(([o]) => second.rank.has(o)
      && second.rank.get(o) < second.rank.get(id));
    assert.equal(after.length, before.filter(([o]) => second.rank.has(o)).length,
      `state ${id} was overtaken by something that was to its left`);
  }
  assert.ok(second.nodes.some((n) => n.fresh), 'and what is new is marked as new');
});

test('edges arriving at one node arrive apart, in the order they came from', () => {
  // The other half of the same complaint. Every edge used to end at the one point on top
  // of its target, so several arriving at one state landed on each other; and one coming
  // from the side grazed the circle instead of entering it.
  const r = rng(20260913);
  for (let iter = 0; iter < 300; iter++) {
    const limit = [15, 66][randInt(r, 0, 1)];
    const gap = limit === 15 ? 9 : 30;
    const wanted = Array.from({ length: randInt(r, 1, 6) }, () => r() * 260 - 130);
    const given = spread(wanted, { limit, gap });

    assert.equal(given.length, wanted.length);
    for (const at of given) assert.ok(Math.abs(at) <= limit + CLOSE, `${at} is outside ±${limit}`);

    const step = Math.min(gap, (2 * limit) / Math.max(1, wanted.length - 1));
    const sorted = [...given].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      assert.ok(sorted[i] - sorted[i - 1] > step - CLOSE,
        `${sorted[i - 1]} and ${sorted[i]} are closer than ${step}`);
    }
    // Order preserved, so no edge crosses another on the way in.
    const byWant = wanted.map((w, i) => i).sort((a, b) => wanted[a] - wanted[b] || a - b);
    for (let i = 1; i < byWant.length; i++) {
      assert.ok(given[byWant[i]] >= given[byWant[i - 1]],
        `${wanted[byWant[i - 1]]} < ${wanted[byWant[i]]} but they arrived the other way round`);
    }
  }
});

test('one edge arriving arrives where it wanted, and a crowd stays centred', () => {
  assert.deepEqual(spread([12], { limit: 66, gap: 30 }), [12], 'nothing to make room for');
  assert.deepEqual(spread([200], { limit: 66, gap: 30 }), [66], 'but the rim is the rim');
  assert.deepEqual(spread([], { limit: 66, gap: 30 }), []);

  // Everything wanting the same place is the case that used to draw one point.
  const crowd = spread([0, 0, 0, 0], { limit: 66, gap: 30 });
  assert.ok(Math.abs(crowd[0] + crowd[3]) < CLOSE, `not centred: ${crowd.join(', ')}`);
  assert.equal(new Set(crowd).size, 4, 'and four distinct places');
});
