import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVDD, unitNormaliser, NORMALISERS } from '../src/evdd.js';
import { MTBDD } from '../src/dd.js';
import * as P from '../src/poly.js';
import * as Z from '../src/zomega.js';
import { parseQasm } from '../src/qasm.js';
import { parseState, buildState } from '../src/state.js';
import { simulate } from '../src/sim.js';
import { treeEdgeWeights } from '../src/layout.js';
import { allInstances } from '../src/examples.js';
import { rng, randInt } from './helpers.js';

const allBits = (n) => Array.from({ length: 1 << n }, (_, i) => i.toString(2).padStart(n, '0'));
const make = (n) => new EVDD(P.Ring, n, unitNormaliser(P, Z));

/** Run an example and hand back both representations of its final state. */
function bothWays(example) {
  const circuit = parseQasm(example.qasm);
  const dd = new MTBDD(P.Ring, circuit.nqubits);
  const frames = simulate(dd, buildState(dd, parseState(example.state, circuit.nqubits).entries), circuit);
  const last = frames[frames.length - 1];
  const ev = make(circuit.nqubits);
  return { dd, ev, mtbdd: last.root, edge: ev.fromMTBDD(dd, last.root), n: circuit.nqubits };
}

test('moving the amplitudes onto the edges changes no amplitude', () => {
  for (const example of allInstances()) {
    const { dd, ev, mtbdd, edge, n } = bothWays(example);
    if (n > 8) continue;
    for (const bits of allBits(n)) {
      assert.equal(P.key(ev.evaluate(edge, bits)), P.key(dd.evaluate(mtbdd, bits)),
        `${example.name} disagrees at |${bits}>`);
    }
  }
});

test('random states survive the round trip too', () => {
  const r = rng(55);
  for (let iter = 0; iter < 40; iter++) {
    const n = randInt(r, 1, 5);
    const dd = new MTBDD(P.Ring, n);
    const root = dd.fromAmplitudes(allBits(n)
      .filter(() => r() < 0.6)
      .map((b) => [b, P.fromZ(Z.zo(randInt(r, -3, 3), randInt(r, -3, 3), 0, 0, randInt(r, 0, 3)))]));
    const ev = make(n);
    const edge = ev.fromMTBDD(dd, root);
    for (const bits of allBits(n)) {
      assert.equal(P.key(ev.evaluate(edge, bits)), P.key(dd.evaluate(root, bits)));
    }
  }
});

test('edge weights buy exactly the sharing they are meant to', () => {
  // The QFT is the case the terminal-valued diagram handles worst: every amplitude has a
  // different phase, so nothing can be shared. Those phases are units, and the amplitudes
  // factor over the bits, so with weights on the edges it is one node per level.
  const qft = allInstances().find((e) => e.name === 'QFT' && e.size === 3);
  const { dd, ev, mtbdd, edge } = bothWays(qft);
  assert.equal(dd.size(mtbdd), 15, '7 internal nodes and 8 distinct amplitudes');
  assert.equal(ev.size(edge), 4, 'one node per level and the single terminal');

  // The two effects are separable. Moving the amplitudes onto the edges collapses the
  // terminals on its own, because there is only ever one; normalising is what then
  // collapses the internal nodes, by making subfunctions that differ by a phase equal.
  const unnormalised = new EVDD(P.Ring, 3);
  assert.equal(unnormalised.size(unnormalised.fromMTBDD(dd, mtbdd)), 8,
    '8 distinct terminals become 1, but the 7 internal nodes remain distinct');
});

test('states equal up to a scalar share every node below the root', () => {
  const n = 3;
  const dd = new MTBDD(P.Ring, n);
  const state = dd.fromAmplitudes([['000', P.fromZ(Z.INV_SQRT2)], ['101', P.fromZ(Z.neg(Z.INV_SQRT2))]]);
  const scaled = dd.scale(P.fromZ(Z.OMEGA), state);
  assert.notEqual(state, scaled, 'they are different states');

  const ev = make(n);
  const a = ev.fromMTBDD(dd, state);
  const b = ev.fromMTBDD(dd, scaled);
  assert.equal(a.node, b.node, 'the same node, reached by edges of different weight');
  assert.notEqual(P.key(a.w), P.key(b.w));
  // And the scalar really is the difference between them.
  for (const bits of allBits(n)) {
    assert.equal(P.key(ev.evaluate(b, bits)),
      P.key(P.mul(P.fromZ(Z.OMEGA), ev.evaluate(a, bits))));
  }
});

test('a symbolic weight is left alone rather than guessed at', () => {
  const n = 2;
  const dd = new MTBDD(P.Ring, n);
  const root = dd.fromAmplitudes([['00', P.variable('a')], ['11', P.variable('b')]]);
  const ev = make(n);
  const edge = ev.fromMTBDD(dd, root);
  for (const bits of allBits(n)) {
    assert.equal(P.key(ev.evaluate(edge, bits)), P.key(dd.evaluate(root, bits)));
  }
});

test('the unreduced tree carries weights that multiply back to the amplitudes', () => {
  // Same normalisation as the shared diagram, but with nothing shared, so the tree keeps
  // its shape. The weights along a path, times the root weight, must be the amplitude.
  for (const example of allInstances()) {
    const circuit = parseQasm(example.qasm);
    const n = circuit.nqubits;
    if (n > 5) continue;
    const dd = new MTBDD(P.Ring, n);
    const frames = simulate(dd, buildState(dd, parseState(example.state, n).entries), circuit);
    const root = frames[frames.length - 1].root;

    const values = allBits(n).map((b) => dd.evaluate(root, b));
    const { weightOf, rootWeight } = treeEdgeWeights(dd, values,
      { ring: P.Ring, normalise: unitNormaliser(P, Z) });

    allBits(n).forEach((bits, index) => {
      let product = rootWeight;
      let path = 0;
      for (let level = 0; level < n; level++) {
        const bit = bits[level] === '1' ? 1 : 0;
        product = P.mul(product, weightOf.get(2 ** level - 1 + path)[bit]);
        path = path * 2 + bit;
      }
      assert.equal(P.key(product), P.key(values[index]),
        `${example.name} at |${bits}>: weights multiply to ${P.format(product)}, not ${P.format(values[index])}`);
    });
  }
});

test('an all-zero subtree is reached by a zero edge, not by a weight of 1', () => {
  const n = 2;
  const dd = new MTBDD(P.Ring, n);
  // Only |00> is occupied, so everything under q0 = 1 is zero.
  const root = dd.basisState('00', P.one);
  const values = allBits(n).map((b) => dd.evaluate(root, b));
  const { weightOf } = treeEdgeWeights(dd, values, { ring: P.Ring, normalise: unitNormaliser(P, Z) });
  const [low, high] = weightOf.get(0);
  assert.ok(!P.isZero(low), 'the occupied side carries a weight');
  assert.ok(P.isZero(high), 'the empty side is a zero edge, so hiding zeros takes the subtree with it');
});

test('every canonisation rule preserves every amplitude', () => {
  for (const kind of Object.keys(NORMALISERS)) {
    for (const example of allInstances()) {
      const circuit = parseQasm(example.qasm);
      const n = circuit.nqubits;
      if (n > 6) continue;
      const dd = new MTBDD(P.Ring, n);
      const frames = simulate(dd, buildState(dd, parseState(example.state, n).entries), circuit);
      const root = frames[frames.length - 1].root;
      const ev = new EVDD(P.Ring, n, unitNormaliser(P, Z, kind));
      const edge = ev.fromMTBDD(dd, root);
      for (const bits of allBits(n)) {
        assert.equal(P.key(ev.evaluate(edge, bits)), P.key(dd.evaluate(root, bits)),
          `${kind} on ${example.name} disagrees at |${bits}>`);
      }
    }
  }
});

test('the rule chosen decides which edge keeps the weight', () => {
  // A node whose two edges have different magnitudes, so low and max genuinely differ.
  const dd = new MTBDD(P.Ring, 1);
  const root = dd.fromAmplitudes([['0', P.fromZ(Z.OMEGA)], ['1', P.fromZ(Z.fromInt(2))]]);
  const weights = (kind) => {
    const ev = new EVDD(P.Ring, 1, unitNormaliser(P, Z, kind));
    const edge = ev.fromMTBDD(dd, root);
    return [P.format(ev.lowOf(edge.node).w), P.format(ev.highOf(edge.node).w)];
  };
  // 2/ω is (1-i)√2, which is how the formatter writes it.
  assert.deepEqual(weights('low'), ['1', '(1-i)√2'], 'the low edge is divided out');
  assert.deepEqual(weights('max'), ['ω/2', '1'], '2 has the larger magnitude, so it goes up');
  assert.deepEqual(weights('min'), ['1', '(1-i)√2'], 'ω is the smaller, so this agrees with low here');
  assert.deepEqual(weights('none'), ['ω', '2'], 'nothing is factored out');
});

test('ties are broken deterministically, not by whichever edge came first', () => {
  // Equal magnitudes: the rule must still pick the same edge every time.
  const dd = new MTBDD(P.Ring, 2);
  const root = dd.fromAmplitudes([['00', P.fromZ(Z.OMEGA)], ['10', P.fromZ(Z.I)]]);
  const once = () => {
    const ev = new EVDD(P.Ring, 2, unitNormaliser(P, Z, 'max'));
    const edge = ev.fromMTBDD(dd, root);
    return `${P.format(edge.w)}|${P.format(ev.lowOf(edge.node).w)}|${P.format(ev.highOf(edge.node).w)}`;
  };
  assert.equal(once(), once());
});

/** A random state, built the way the round-trip test above builds one. */
function randomState(dd, n, r) {
  return dd.fromAmplitudes(allBits(n)
    .filter(() => r() < 0.6)
    .map((b) => [b, P.fromZ(Z.zo(randInt(r, -3, 3), randInt(r, -3, 3), 0, 0, randInt(r, 0, 3)))]));
}

test('the canonical form is a function of the state, not of what was built before it', () => {
  // It used to break ties on hash-cons node ids, which are creation order: the same state
  // came out with different weights depending on what the manager had converted earlier,
  // so the "canonical" form was not canonical. Converting something else first must not
  // change the answer.
  const r = rng(90210);
  for (const kind of Object.keys(NORMALISERS)) {
    for (let iter = 0; iter < 40; iter++) {
      const n = randInt(r, 1, 4);
      const dd = new MTBDD(P.Ring, n);
      const other = randomState(dd, n, r);
      const target = randomState(dd, n, r);

      const alone = new EVDD(P.Ring, n, unitNormaliser(P, Z, kind));
      const a = alone.fromMTBDD(dd, target);

      const warm = new EVDD(P.Ring, n, unitNormaliser(P, Z, kind));
      const memo = new Map();
      warm.fromMTBDD(dd, other, memo);
      const b = warm.fromMTBDD(dd, target, memo);

      assert.equal(P.Ring.key(a.w), P.Ring.key(b.w),
        `${kind}: root weight depends on build history`);
      assert.equal(alone.size(a), warm.size(b), `${kind}: size depends on build history`);
    }
  }
});

test('the two edge-valued views agree on the weight they show', () => {
  // The shared diagram and the unfolded tree normalise the same state with the same rule,
  // so they must put the same factor on the root. They did not: the tree numbers its
  // positions rather than its nodes, and the tie-break read those numbers, so the tree's
  // 'max' was the diagram's 'min'.
  //
  // Only where the diagram skips a level does a difference remain, and that one is
  // structural: the tree has to expand a level the diagram drops, so the two factor
  // across different shapes. Those frames are excluded here and checked by amplitude.
  const skipsALevel = (dd, root) => dd.reachable(root).some((id) => !dd.isTerminal(id)
    && [dd.lowOf(id), dd.highOf(id)].some((c) => dd.levelOf(c) > dd.levelOf(id) + 1));

  const r = rng(4711);
  for (const kind of ['low', 'max', 'min']) {
    for (let iter = 0; iter < 40; iter++) {
      const n = randInt(r, 1, 4);
      const dd = new MTBDD(P.Ring, n);
      const root = randomState(dd, n, r);
      if (skipsALevel(dd, root)) continue;
      const normalise = unitNormaliser(P, Z, kind);
      const ev = new EVDD(P.Ring, n, normalise);
      const shared = ev.fromMTBDD(dd, root);
      const values = Array.from({ length: 1 << n },
        (_, b) => dd.evaluate(root, b.toString(2).padStart(n, '0')));
      const tree = treeEdgeWeights(dd, values, { ring: P.Ring, normalise });
      assert.equal(P.Ring.key(shared.w), P.Ring.key(tree.rootWeight),
        `${kind}: the shared diagram and the tree disagree on the root weight`);

      // The root weight alone is one number out of the whole diagram, and it was the only
      // thing compared. Every edge is compared now: with no level skipped, the tree
      // position reached by a prefix and the diagram node reached by the same prefix carry
      // the same subfunction, so they must have been normalised to the same pair of
      // weights. That is the assertion the tie-break bug would have failed everywhere.
      const walk = (level, path, edge) => {
        if (P.Ring.isZero(edge.w) || level === n) return;
        assert.equal(ev.levelOf(edge.node), level,
          `${kind}: the diagram skips level ${level} where the tree cannot`);
        const [t0, t1] = tree.weightOf.get(2 ** level - 1 + path);
        const e0 = ev.lowOf(edge.node);
        const e1 = ev.highOf(edge.node);
        assert.equal(P.Ring.key(t0), P.Ring.key(e0.w),
          `${kind}: low weight at level ${level}, path ${path}`);
        assert.equal(P.Ring.key(t1), P.Ring.key(e1.w),
          `${kind}: high weight at level ${level}, path ${path}`);
        walk(level + 1, path * 2, e0);
        walk(level + 1, path * 2 + 1, e1);
      };
      walk(0, 0, shared);
    }
  }
});

test('the two edge-valued views agree over the examples, not just over small noise', () => {
  // The random-state test above is where this was pinned, and it turns out not to bite:
  // reintroducing the creation-order tie-break leaves it passing, because states of four
  // qubits drawn at random never make the tree and the diagram number their nodes
  // differently enough to matter. The audit measured the disagreement over the *examples*
  // — real circuits at real widths — and that is where it has to be measured here.
  //
  // Restoring the tie-break fails this on the first example it reaches. Over the whole
  // example set the disagreement was 443 frames out of 2058 before the fix and one after,
  // and that one is the level-skipping case excluded below — structural, not a tie going
  // the wrong way, since the tree must expand a level the diagram drops.
  const skipsALevel = (dd, root) => dd.reachable(root).some((id) => !dd.isTerminal(id)
    && [dd.lowOf(id), dd.highOf(id)].some((c) => dd.levelOf(c) > dd.levelOf(id) + 1));

  let compared = 0;
  for (const instance of allInstances()) {
    const circuit = parseQasm(instance.qasm);
    const n = circuit.nqubits;
    if (n > 6) continue;                                  // the tree is 2^n wide
    const dd = new MTBDD(P.Ring, n);
    const root = buildState(dd, parseState(instance.state, n).entries);
    const where = `${instance.name}${instance.size ? ` on ${instance.size}` : ''}`;
    for (const frame of simulate(dd, root, circuit)) {
      if (skipsALevel(dd, frame.root)) continue;
      const values = allBits(n).map((b) => dd.evaluate(frame.root, b));
      for (const kind of ['low', 'max', 'min']) {
        const normalise = unitNormaliser(P, Z, kind);
        const shared = new EVDD(P.Ring, n, normalise).fromMTBDD(dd, frame.root);
        const tree = treeEdgeWeights(dd, values, { ring: P.Ring, normalise });
        compared++;
        assert.equal(P.Ring.key(shared.w), P.Ring.key(tree.rootWeight),
          `${where}, step ${frame.index}, ${kind}: the tree and the diagram disagree`);
      }
    }
  }
  // A test that compares nothing passes too. This is the whole point of the section it
  // came from, so it says out loud how much it looked at.
  assert.ok(compared > 300, `only ${compared} frames compared`);
});
