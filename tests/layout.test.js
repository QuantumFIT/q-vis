import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MTBDD } from '../src/dd.js';
import * as P from '../src/poly.js';
import * as Z from '../src/zomega.js';
import { simulate } from '../src/sim.js';
import { scanOrder, stableOrder, layoutFrames } from '../src/layout.js';
import { rng, randInt } from './helpers.js';

test('scan order follows low before high', () => {
  const m = new MTBDD(P.Ring, 2);
  // |01> + 2|10>: at level 0 the low branch leads to |01>, the high branch to |10>.
  const root = m.fromAmplitudes([['01', P.fromInt(1)], ['10', P.fromInt(2)]]);
  const order = scanOrder(m, root);
  const lowChild = m.lowOf(root), highChild = m.highOf(root);
  assert.ok(order.get(lowChild) < order.get(highChild), 'the low subtree is scanned first');
  assert.equal(order.get(root), 0);
  assert.equal(order.size, m.size(root));
});

test('stableOrder keeps persistent nodes in their previous relative order', () => {
  const prev = new Map([[10, 0], [20, 1], [30, 2]]);
  assert.deepEqual(stableOrder([30, 10, 20], prev), [10, 20, 30], 'scan order does not disturb survivors');
  // A newcomer lands where the scan puts it, between its placed neighbours.
  assert.deepEqual(stableOrder([10, 99, 20, 30], prev), [10, 99, 20, 30]);
  assert.deepEqual(stableOrder([99, 10, 20], prev), [99, 10, 20], 'a newcomer before everything stays first');
  assert.deepEqual(stableOrder([10, 20, 99], prev), [10, 20, 99], 'and after everything stays last');
  // With nothing remembered, the scan order is used as-is.
  assert.deepEqual(stableOrder([5, 6, 7], new Map()), [5, 6, 7]);
});

test('a surviving node never jumps across its neighbours between frames', () => {
  const r = rng(41);
  const n = 4;
  const m = new MTBDD(P.Ring, n);
  const names = ['h', 'x', 'z', 't', 's', 'cx', 'cz', 'ccx'];
  const gates = [];
  for (let i = 0; i < 25; i++) {
    const name = names[randInt(r, 0, names.length - 1)];
    const arity = { h: 1, x: 1, z: 1, t: 1, s: 1, cx: 2, cz: 2, ccx: 3 }[name];
    const pool = [...Array(n).keys()];
    const qubits = [];
    for (let j = 0; j < arity; j++) qubits.push(...pool.splice(randInt(r, 0, pool.length - 1), 1));
    gates.push({ name, qubits });
  }
  const frames = simulate(m, m.basisState('0000', P.one), { nqubits: n, gates });
  const laid = layoutFrames(m, frames);

  for (let i = 1; i < laid.frames.length; i++) {
    const prev = new Map(laid.frames[i - 1].nodes.map((nd) => [nd.id, nd]));
    const byLevel = new Map();
    for (const nd of laid.frames[i].nodes) {
      if (!prev.has(nd.id)) continue;
      if (!byLevel.has(nd.level)) byLevel.set(nd.level, []);
      byLevel.get(nd.level).push(nd);
    }
    for (const group of byLevel.values()) {
      const nowOrder = [...group].sort((a, b) => a.x - b.x).map((nd) => nd.id);
      const thenOrder = [...group].sort((a, b) => prev.get(a.id).x - prev.get(b.id).x).map((nd) => nd.id);
      assert.deepEqual(nowOrder, thenOrder, `frame ${i}: survivors reordered`);
    }
  }
});

test('layout is a function of the diagrams alone', () => {
  const build = () => {
    const m = new MTBDD(P.Ring, 3);
    const frames = simulate(m, m.basisState('000', P.one),
      { nqubits: 3, gates: [{ name: 'h', qubits: [0] }, { name: 'cx', qubits: [0, 1] }, { name: 't', qubits: [2] }] });
    return layoutFrames(m, frames);
  };
  const a = JSON.stringify(build()), b = JSON.stringify(build());
  assert.equal(a, b, 'the same input must lay out identically');
});

test('no two nodes share a slot, and terminals sit on the bottom row', () => {
  const m = new MTBDD(P.Ring, 3);
  const frames = simulate(m, m.basisState('000', P.one),
    { nqubits: 3, gates: [{ name: 'h', qubits: [0] }, { name: 'cx', qubits: [0, 1] }, { name: 'cx', qubits: [1, 2] }] });
  const laid = layoutFrames(m, frames, { qubitLabels: ['q[0]', 'q[1]', 'q[2]'] });
  for (const f of laid.frames) {
    const seen = new Set();
    for (const nd of f.nodes) {
      const slot = `${nd.level}@${nd.x}`;
      assert.ok(!seen.has(slot), `two nodes at ${slot}`);
      seen.add(slot);
      assert.equal(nd.terminal, nd.level === 3);
      if (!nd.terminal) assert.equal(nd.label, `q[${nd.level}]`);
    }
    assert.equal(f.nodes.length, f.size);
  }
  // Amplitudes are what terminals are labelled with.
  const last = laid.frames[laid.frames.length - 1];
  assert.deepEqual(last.nodes.filter((nd) => nd.terminal).map((nd) => nd.label).sort(), ['0', '1/√2']);
});

test('the zero terminal is pinned to the right of the terminal row', () => {
  const m = new MTBDD(P.Ring, 2);
  const frames = simulate(m, m.basisState('00', P.one),
    { nqubits: 2, gates: [{ name: 'h', qubits: [0] }, { name: 'cx', qubits: [0, 1] }] });
  const laid = layoutFrames(m, frames);
  for (const f of laid.frames) {
    const terminals = f.nodes.filter((nd) => nd.terminal);
    if (terminals.length < 2) continue;
    const zero = terminals.find((nd) => nd.label === '0');
    assert.ok(zero && terminals.every((nd) => nd.x <= zero.x), 'the 0 terminal is rightmost');
  }
});

test('freshly created nodes are flagged for highlighting', () => {
  const m = new MTBDD(P.Ring, 2);
  const frames = simulate(m, m.basisState('00', P.one), { nqubits: 2, gates: [{ name: 'h', qubits: [0] }] });
  const laid = layoutFrames(m, frames);
  assert.ok(laid.frames[0].nodes.every((nd) => nd.fresh), 'everything in the first frame is new');
  const after = laid.frames[1];
  assert.deepEqual(after.nodes.filter((nd) => nd.fresh).map((nd) => nd.id).sort(),
    [...frames[1].added].sort(), 'later frames flag exactly the added nodes');
});
