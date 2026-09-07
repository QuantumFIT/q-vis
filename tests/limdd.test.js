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
import { EXAMPLES } from '../src/examples.js';
import { rng, randInt } from './helpers.js';
import { pauliClassCount } from './oracle.js';

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
  for (const example of EXAMPLES) {
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
    for (const example of EXAMPLES) {
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
  for (const example of EXAMPLES) {
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
