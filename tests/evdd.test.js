import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVDD, unitNormaliser } from '../src/evdd.js';
import { MTBDD } from '../src/dd.js';
import * as P from '../src/poly.js';
import * as Z from '../src/zomega.js';
import { parseQasm } from '../src/qasm.js';
import { parseState, buildState } from '../src/state.js';
import { simulate } from '../src/sim.js';
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
