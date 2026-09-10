import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMDD } from '../src/limdd.js';
import { NORMALISERS, unitNormaliser } from '../src/evdd.js';
import { MTBDD } from '../src/dd.js';
import * as P from '../src/poly.js';
import * as Z from '../src/zomega.js';
import { parseQasm } from '../src/qasm.js';
import { parseState, buildState } from '../src/state.js';
import { simulate } from '../src/sim.js';
import { allInstances } from '../src/examples.js';
import { rng, randInt } from './helpers.js';
import { pauliClassCount } from './oracle.js';
import { layoutEdgeValuedTree } from '../src/layout.js';

const allBits = (n) => Array.from({ length: 1 << n }, (_, i) => i.toString(2).padStart(n, '0'));
const make = (n, kind = 'low') => new LIMDD(P.Ring, n, unitNormaliser(P, Z, kind));

/** Final state of a circuit, as an MTBDD and as a LIMDD. */
function build(qasm, state, kind = 'low') {
  const circuit = parseQasm(qasm);
  const n = circuit.nqubits;
  const dd = new MTBDD(P.Ring, n);
  const frames = simulate(dd, buildState(dd, parseState(state, n).entries), circuit);
  const root = frames[frames.length - 1].root;
  const li = make(n, kind);
  return { dd, root, li, edge: li.fromMTBDD(dd, root), n };
}

// ---- circuits whose output is a stabilizer state --------------------------

const header = (n) => `OPENQASM 2.0;\ninclude "qelib1.inc";\nqreg q[${n}];\n`;
const zeros = (n) => `|${'0'.repeat(n)}> : 1`;

const ghz = (n) => header(n) + 'h q[0];\n'
  + Array.from({ length: n - 1 }, (_, i) => `cx q[${i}],q[${i + 1}];`).join('\n');

const graphState = (n, edges) => header(n)
  + Array.from({ length: n }, (_, i) => `h q[${i}];`).join('\n') + '\n'
  + edges.map(([a, b]) => `cz q[${a}],q[${b}];`).join('\n');

const line = (n) => graphState(n, Array.from({ length: n - 1 }, (_, i) => [i, i + 1]));
const star = (n) => graphState(n, Array.from({ length: n - 1 }, (_, i) => [0, i + 1]));
const complete = (n) => {
  const edges = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) edges.push([i, j]);
  return graphState(n, edges);
};

// ---- tests ---------------------------------------------------------------

test('moving the amplitudes onto the edges as LIMs changes no amplitude', () => {
  for (const example of allInstances()) {
    const circuit = parseQasm(example.qasm);
    if (circuit.nqubits > 8) continue;
    const { dd, root, li, edge, n } = build(example.qasm, example.state);
    for (const bits of allBits(n)) {
      assert.equal(P.key(li.evaluate(edge, bits)), P.key(dd.evaluate(root, bits)),
        `${example.name} disagrees at |${bits}>`);
    }
  }
});

test('every scalar rule preserves every amplitude', () => {
  for (const kind of Object.keys(NORMALISERS)) {
    for (const example of allInstances()) {
      const circuit = parseQasm(example.qasm);
      if (circuit.nqubits > 6) continue;
      const { dd, root, li, edge, n } = build(example.qasm, example.state, kind);
      for (const bits of allBits(n)) {
        assert.equal(P.key(li.evaluate(edge, bits)), P.key(dd.evaluate(root, bits)),
          `${kind} on ${example.name} disagrees at |${bits}>`);
      }
    }
  }
});

test('random states survive the round trip too', () => {
  const r = rng(71);
  for (let iter = 0; iter < 40; iter++) {
    const n = randInt(r, 1, 5);
    const dd = new MTBDD(P.Ring, n);
    const root = dd.fromAmplitudes(allBits(n)
      .filter(() => r() < 0.6)
      .map((b) => [b, P.fromZ(Z.zo(randInt(r, -3, 3), randInt(r, -3, 3), 0, 0, randInt(r, 0, 3)))]));
    const li = make(n);
    const edge = li.fromMTBDD(dd, root);
    for (const bits of allBits(n)) {
      assert.equal(P.key(li.evaluate(edge, bits)), P.key(dd.evaluate(root, bits)));
    }
  }
});

test('a symbolic weight is left alone rather than guessed at', () => {
  const n = 2;
  const dd = new MTBDD(P.Ring, n);
  const root = dd.fromAmplitudes([['00', P.variable('a')], ['11', P.variable('b')]]);
  const li = make(n);
  const edge = li.fromMTBDD(dd, root);
  for (const bits of allBits(n)) {
    assert.equal(P.key(li.evaluate(edge, bits)), P.key(dd.evaluate(root, bits)));
  }
});

test('states related by a Pauli share every node', () => {
  // The whole point of the diagram: |v> and (X (x) X) |v> are different states, and one
  // node, reached by edges whose labels differ.
  const n = 3;
  const dd = new MTBDD(P.Ring, n);
  const a = dd.fromAmplitudes([['000', P.fromZ(Z.INV_SQRT2)], ['011', P.fromZ(Z.INV_SQRT2)]]);
  const b = dd.fromAmplitudes([['010', P.fromZ(Z.INV_SQRT2)], ['001', P.fromZ(Z.INV_SQRT2)]]);
  assert.notEqual(a, b, 'they are different states');

  const li = make(n);
  const ea = li.fromMTBDD(dd, a);
  const eb = li.fromMTBDD(dd, b);
  assert.equal(ea.node, eb.node, 'the same node, reached by edges with different Paulis');
  assert.notEqual(`${ea.x}.${ea.z}`, `${eb.x}.${eb.z}`);
});

test('GHZ collapses to a tower', () => {
  // |0...0> and |1...1> are related by X^n, so the two branches of every level are one
  // node. The edge-valued diagram keeps them apart and needs about twice as many.
  for (const n of [3, 4, 5, 6]) {
    const { li, edge } = build(ghz(n), zeros(n));
    assert.equal(li.size(edge), n + 1, `GHZ on ${n} qubits: one node per level, plus the terminal`);
  }
});

test('every stabilizer state is a tower', () => {
  // The paper's headline: Pauli-LIMDDs represent stabilizer states in linear size. Graph
  // states are stabilizer states, so each of these must come out as n + 1 nodes.
  for (const n of [3, 4, 5, 6]) {
    for (const [name, qasm] of [['line', line(n)], ['star', star(n)], ['complete', complete(n)]]) {
      const { li, edge } = build(qasm, zeros(n));
      assert.equal(li.size(edge), n + 1, `${name} graph state on ${n} qubits`);
    }
  }
});

test('the diagram is as small as a Pauli-LIMDD can be', () => {
  // The diagram's own merging, against a brute-force count of the equivalence classes it
  // is meant to find. Anything less than canonical shows up here as a node too many.
  for (const example of allInstances()) {
    const circuit = parseQasm(example.qasm);
    if (circuit.nqubits > 5) continue;
    const { dd, root, li, edge, n } = build(example.qasm, example.state);
    assert.equal(li.size(edge), pauliClassCount(dd, root, n, P.Ring),
      `${example.name} could be smaller`);
  }
  for (const n of [3, 4, 5]) {
    for (const [name, qasm] of [['GHZ', ghz(n)], ['line', line(n)], ['complete', complete(n)]]) {
      const { dd, root, li, edge } = build(qasm, zeros(n));
      assert.equal(li.size(edge), pauliClassCount(dd, root, n, P.Ring), `${name} on ${n} qubits`);
    }
  }
});

test('random states are reduced as far as they can be', () => {
  const r = rng(83);
  for (let iter = 0; iter < 25; iter++) {
    const n = randInt(r, 2, 4);
    const dd = new MTBDD(P.Ring, n);
    const root = dd.fromAmplitudes(allBits(n)
      .filter(() => r() < 0.7)
      .map((b) => [b, P.fromZ(Z.omegaPow(randInt(r, 0, 7)))]));
    const li = make(n);
    const edge = li.fromMTBDD(dd, root);
    assert.equal(li.size(edge), pauliClassCount(dd, root, n, P.Ring),
      `iteration ${iter} on ${n} qubits`);
  }
});

test('the diagram built twice is the same diagram', () => {
  // A tie broken by visit order rather than by the values would show up here.
  const once = (kind) => {
    const { li, edge } = build(line(4), zeros(4), kind);
    return li.reachable(edge).map((id) => (li.isTerminal(id) ? '1'
      : `${li.levelOf(id)}:${li.edgeKey(li.lowOf(id))}:${li.edgeKey(li.highOf(id))}`)).join(' ');
  };
  for (const kind of Object.keys(NORMALISERS)) assert.equal(once(kind), once(kind));
});

test('the unfolded tree is the diagram, with every shared node copied out', () => {
  // A tower has no skipped levels, so the tree slot at (level, path) must hold exactly
  // the edge the diagram reaches by taking the same low/high steps from the root.
  const n = 4;
  const { li, edge } = build(ghz(n), zeros(n));
  const [frame] = layoutEdgeValuedTree(li, [{ index: 0, gate: null, edge }],
    Array.from({ length: n }, (_, q) => `q${q}`), (e) => li.edgeKey(e)).frames;

  const labelOf = new Map(frame.edges.map((e) => [e.to, e.label]));
  for (let path = 0; path < 2 ** n; path++) {
    let e = edge;
    let dead = false;
    for (let level = 0; level < n; level++) {
      const high = (path >> (n - 1 - level)) & 1;
      if (dead) {
        // Past a zero edge the diagram may point anywhere, since nothing is there to
        // find; the tree fills the space with the zero edge instead of following it.
        e = li.zeroEdge;
      } else {
        e = high ? li.highOf(e.node) : li.lowOf(e.node);
        dead = li.ring.isZero(e.w);
      }
      const slot = 2 ** (level + 1) - 1 + (path >> (n - 1 - level));
      const shown = li.edgeKey(e);
      assert.equal(labelOf.get(slot), shown === '1' ? '' : shown,
        `slot ${slot} on path ${path.toString(2).padStart(n, '0')}`);
    }
  }
  assert.equal(frame.nodes.length, 2 ** (n + 1) - 1, 'a complete tree');
});

test('the tree stays complete where the diagram takes shortcuts', () => {
  // Two shortcuts the reduced diagram takes and a tree cannot: a level it skips because
  // nothing depends on it, and a zero edge, which it points wherever it likes.
  const n = 3;
  const dd = new MTBDD(P.Ring, n);
  // |000> + |010>: q1 is a don't-care, and everything under q0 = 1 is zero.
  const root = dd.fromAmplitudes([['000', P.fromZ(Z.INV_SQRT2)], ['010', P.fromZ(Z.INV_SQRT2)]]);
  const li = make(n);
  const edge = li.fromMTBDD(dd, root);
  assert.ok(li.size(edge) < n + 1, 'the diagram really does take a shortcut');

  const [frame] = layoutEdgeValuedTree(li, [{ index: 0, gate: null, edge }],
    ['q0', 'q1', 'q2'], (e) => (li.ring.isZero(e.w) ? '0' : li.edgeKey(e))).frames;
  assert.equal(frame.nodes.length, 2 ** (n + 1) - 1, 'the tree is complete anyway');
  assert.equal(frame.edges.length, 2 ** (n + 1) - 2);

  // The skipped level says nothing on either side, and says the same thing on both.
  const out = (id) => frame.edges.filter((e) => e.from === id);
  const [low, high] = out(1);                       // the q1 node under q0 = 0
  assert.ok(low.label.startsWith(`${P.key(P.one)}.0.0@`),
    'a skipped level carries weight 1 and the identity Pauli');
  assert.deepEqual([low.label, low.toZero], [high.label, high.toZero],
    'both sides of a skipped level lead to the same thing');

  // Everything under the zero edge is zero, rather than whatever the diagram pointed at.
  // Edges come out level by level, so one pass marks the whole subtree.
  const dead = new Set([2]);                        // the q1 node under q0 = 1
  for (const e of frame.edges) if (dead.has(e.from)) dead.add(e.to);
  assert.equal(dead.size, 2 ** n - 1, 'half the tree hangs off the dead edge');
  assert.ok(frame.edges.filter((e) => dead.has(e.from)).every((e) => e.toZero),
    'the dead branch is dead all the way down');
});

test('the diagram is a function of the state, not of what was built before it', () => {
  // Low precedence used to be settled by comparing hash-cons node ids — creation order —
  // so converting an unrelated state first could change which branch became low, and with
  // it every label above. A node is compared by what it contains now.
  const r = rng(31337);
  const random = (dd, n) => dd.fromAmplitudes(allBits(n)
    .filter(() => r() < 0.6)
    .map((b) => [b, P.fromZ(Z.zo(randInt(r, -3, 3), randInt(r, -3, 3), 0, 0, randInt(r, 0, 3)))]));

  for (const kind of ['low', 'max', 'min', 'none']) {
    for (let iter = 0; iter < 30; iter++) {
      const n = randInt(r, 1, 5);
      const dd = new MTBDD(P.Ring, n);
      const other = random(dd, n);
      const target = random(dd, n);

      const alone = make(n, kind);
      const a = alone.fromMTBDD(dd, target);

      const warm = make(n, kind);
      const memo = new Map();
      warm.fromMTBDD(dd, other, memo);
      const b = warm.fromMTBDD(dd, target, memo);

      assert.equal(alone.size(a), warm.size(b), `${kind}: size depends on build history`);
      // The labels have to match too, not merely the shape.
      assert.equal(P.Ring.key(a.w), P.Ring.key(b.w), `${kind}: root weight depends on history`);
      assert.equal(`${a.x}.${a.z}`, `${b.x}.${b.z}`, `${kind}: root Pauli depends on history`);
    }
  }
});
