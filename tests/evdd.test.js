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
import { EXAMPLES } from '../src/examples.js';
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
  for (const example of EXAMPLES) {
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
  const qft = EXAMPLES.find((e) => e.name === 'QFT, 3 qubits');
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
  for (const example of EXAMPLES) {
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
    for (const example of EXAMPLES) {
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
