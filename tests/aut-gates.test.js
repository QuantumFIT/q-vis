import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Algebra, applyGate, applyOp, simulate } from '../src/aut-gates.js';
import { TA } from '../src/aut-ta.js';
import { GATES } from '../src/gates.js';
import { parseQasm } from '../src/qasm.js';
import * as P from '../src/poly.js';
import * as Z from '../src/zomega.js';
import { applyGateDense } from './oracle.js';
import { rng, randInt, assertClose } from './helpers.js';

const ring = P.Ring;
const basis = (n, index) => Array.from({ length: 2 ** n },
  (_, i) => (i === index ? P.one : P.zero));

/** An exact amplitude as a floating-point complex, so it can meet the dense oracle. */
const asComplex = (v) => Z.toComplex(P.asScalar(v));

/**
 * A set of complex vectors as comparable text, sorted, so two sets can be compared.
 *
 * `-0` is written `0`: the dense oracle produces it wherever a term cancels, and it is
 * the same amplitude. Rounding to nine places at the same time is deliberate — the
 * automaton's side is exact and the oracle's is not, so the comparison has to be.
 */
const round = (x) => (Math.abs(x) < 1e-9 ? 0 : x).toFixed(9);
const asText = (vectors) => vectors
  .map((v) => v.map(({ re, im }) => `${round(re)},${round(im)}`).join(' '))
  .sort();

/** A language of the automaton, in that form. */
const asFloats = (vectors) => asText(vectors.map((v) => v.map(asComplex)));

test('a gate moves every state in the set, and moves it the way the matrix says', () => {
  // The differential oracle, and the one that matters. The automaton's language after a
  // gate must be the gate applied — by a dense simulator that shares no code with any of
  // this — to every member of its language before. Swept over random sets, random gates
  // and random qubits, so the check is on the construction and not on one example.
  const r = rng(20260914);
  const names = ['x', 'y', 'z', 'h', 's', 'sdg', 't', 'tdg', 'cx', 'cz', 'swap', 'ccx'];
  let gatesChecked = 0;
  for (let iter = 0; iter < 60; iter++) {
    const n = randInt(r, 1, 4);
    const ta = new TA(ring, n);
    const alg = new Algebra(ta);

    // A set of one to three basis states, which keeps the language small enough to
    // enumerate while still exercising the nondeterminism at the root.
    const picks = [];
    for (let k = 0; k < randInt(r, 1, 3); k++) {
      const b = randInt(r, 0, 2 ** n - 1);
      if (!picks.includes(b)) picks.push(b);
    }
    let { root } = ta.fromVectors(picks.map((b) => basis(n, b)));
    let dense = picks.map((b) => Array.from({ length: 2 ** n },
      (_, i) => ({ re: i === b ? 1 : 0, im: 0 })));

    for (let step = 0; step < 6; step++) {
      const name = names[randInt(r, 0, names.length - 1)];
      const arity = GATES[name].arity;
      if (arity > n) continue;
      const qubits = [];
      while (qubits.length < arity) {
        const q = randInt(r, 0, n - 1);
        if (!qubits.includes(q)) qubits.push(q);
      }
      root = applyOp(alg, root, { name, qubits });
      dense = dense.map((v) => applyGateDense(v, n, qubits, GATES[name].matrix));
      gatesChecked += 1;

      const got = asFloats(ta.language(root));
      assert.deepEqual(got, asText(dense),
        `${n} qubits, ${picks.length} states, after ${name} on ${qubits.join(',')}`);
    }
  }
  assert.ok(gatesChecked > 200, `only ${gatesChecked} gates checked`);
});

test('a whole circuit, gate by gate, against a dense simulator run beside it', () => {
  const qasm = 'OPENQASM 2.0;\ninclude "qelib1.inc";\nqreg q[3];\n\n'
    + 'h q[0];\ncx q[0],q[1];\nt q[2];\nccx q[0],q[1],q[2];\nswap q[0],q[2];\nh q[1];\ns q[0];\n';
  const circuit = parseQasm(qasm);
  const n = circuit.nqubits;
  const ta = new TA(ring, n);
  const start = [0, 5];
  const { root } = ta.fromVectors(start.map((b) => basis(n, b)));
  const frames = simulate(ta, root, circuit);

  assert.equal(frames.length, circuit.gates.length + 1);
  let dense = start.map((b) => Array.from({ length: 2 ** n },
    (_, i) => ({ re: i === b ? 1 : 0, im: 0 })));
  for (const frame of frames) {
    if (frame.gate) dense = dense.map((v) => applyGateDense(v, n, frame.gate.qubits, frame.gate.matrix
      || GATES[frame.gate.name].matrix));
    assert.deepEqual(asFloats(ta.language(frame.root)), asText(dense),
      `after frame ${frame.index}`);
    assert.equal(frame.members, start.length, 'a unitary maps a set of two onto a set of two');
  }
});

test('a frame knows what it gained and lost, and nothing is lost that was not there', () => {
  const circuit = parseQasm('OPENQASM 2.0;\ninclude "qelib1.inc";\nqreg q[3];\n\n'
    + 'h q[0];\ncx q[0],q[1];\ncx q[1],q[2];\n');
  const ta = new TA(ring, 3);
  const { root } = ta.fromVectors([basis(3, 0)]);
  const frames = simulate(ta, root, circuit);
  for (let i = 1; i < frames.length; i++) {
    const before = new Set(ta.reachable(frames[i - 1].root));
    const now = new Set(ta.reachable(frames[i].root));
    assert.deepEqual(frames[i].added.slice().sort((a, b) => a - b),
      [...now].filter((s) => !before.has(s)).sort((a, b) => a - b));
    assert.deepEqual(frames[i].removed.slice().sort((a, b) => a - b),
      [...before].filter((s) => !now.has(s)).sort((a, b) => a - b));
    assert.equal(frames[i].size, now.size);
  }
  // Frame 0 has no predecessor, so everything in it is new and nothing is gone.
  assert.equal(frames[0].removed.length, 0);
  assert.equal(frames[0].added.length, frames[0].size);
});

test('the same circuit run twice lands on the same states, not merely equal ones', () => {
  // Interning is what makes a frame diff a set difference over ids; if a rerun built
  // fresh states the picture would redraw itself from scratch every time.
  const circuit = parseQasm('OPENQASM 2.0;\ninclude "qelib1.inc";\nqreg q[2];\n\nh q[0];\ncx q[0],q[1];\n');
  const ta = new TA(ring, 2);
  const { root } = ta.fromVectors([basis(2, 0)]);
  const first = simulate(ta, root, circuit);
  const built = ta.states.length;
  const again = simulate(ta, root, circuit);
  assert.deepEqual(again.map((f) => f.root), first.map((f) => f.root));
  assert.equal(ta.states.length, built, 'and the second run builds no state the first had not');
});

test('two states that agree below a gate go on sharing what they agree on', () => {
  // The reason this is an automaton and not a list. |000> and |100> differ only in the
  // top qubit; a gate on the bottom one must not fork the subtree they have in common.
  const ta = new TA(ring, 3);
  const alg = new Algebra(ta);
  const { root } = ta.fromVectors([basis(3, 0), basis(3, 4)]);
  const after = applyOp(alg, root, { name: 'h', qubits: [2] });
  const [a, b] = ta.transitionsOf(after);
  // |000> keeps its content under q0 = 0 and is zero under q0 = 1; |100> is the mirror.
  // So the four children of the two transitions are two distinct states, not four: the
  // transformed subtree is built once and the all-zero subtree is the one both share.
  assert.deepEqual(a, [...b].reverse(), 'the two members are mirror images');
  assert.equal(new Set([...a, ...b]).size, 2, 'built from two subtrees between them');
  const alone = ta.size(ta.state(0, [a]));
  assert.ok(ta.size(after) < 2 * alone,
    `${ta.size(after)} states for both, against ${alone} for one`);
});

test('the cofactor of a perfect tree is still perfect, and no longer depends on the qubit', () => {
  const ta = new TA(ring, 3);
  const alg = new Algebra(ta);
  const { root } = ta.fromVectors([[...Array(8)].map((_, i) => P.fromInt(i))]);
  for (const q of [0, 1, 2]) {
    for (const bit of [0, 1]) {
      const cut = alg.restrict(root, q, bit);
      for (const id of ta.reachable(cut)) {
        if (ta.isLeaf(id)) continue;
        assert.equal(ta.transitionsOf(id).length, 1, 'still deterministic');
        if (ta.levelOf(id) === q) {
          const [lo, hi] = ta.transitionsOf(id)[0];
          assert.equal(lo, hi, `qubit ${q} still matters after fixing it`);
        }
      }
      const want = [...Array(8).keys()].filter((i) => ((i >> (2 - q)) & 1) === bit);
      assert.equal(ta.language(cut).length, 1);
      const got = ta.language(cut)[0];
      for (const i of want) {
        assert.ok(ring.eq(got[i], P.fromInt(i)), `the kept half is untouched at ${i}`);
      }
    }
  }
});

test('a symbolic amplitude goes through a gate as an amplitude, not as a number', () => {
  // What the other page cannot do at all and this one inherits for free: HSL names its
  // amplitudes, and a gate has to carry the names through.
  const ta = new TA(ring, 1);
  const alg = new Algebra(ta);
  const a = P.variable('a');
  const b = P.variable('b');
  const { root } = ta.fromVectors([[a, b]]);
  const after = applyGate(alg, root, [0], GATES.x.matrix);
  const [got] = ta.language(after);
  assert.ok(ring.eq(got[0], b) && ring.eq(got[1], a), `${P.format(got[0], 'exact')}`);
});

test('a choice below the root is refused by name, not quietly approximated', () => {
  // The boundary of a plain tree automaton. Two sibling subtrees of the transformed node
  // would each have to know which choice the other took, and a TA cannot say that.
  const ta = new TA(ring, 2);
  const alg = new Algebra(ta);
  const zero = ta.leaf(P.zero);
  const one = ta.leaf(P.one);
  const l0 = ta.state(1, [[one, zero]]);
  const l1 = ta.state(1, [[zero, one]]);
  const branchy = ta.state(1, [[one, zero], [zero, one]]);   // a real choice, at level 1
  const root = ta.state(0, [[branchy, l0]]);
  assert.throws(() => applyGate(alg, root, [0], GATES.h.matrix),
    /more than one transition|level-synchronized/);
  // and the same automaton without the choice goes through
  assert.doesNotThrow(() => applyGate(alg, ta.state(0, [[l1, l0]]), [0], GATES.h.matrix));
});

test('a rotation stays in the ring, so the amplitude is exact and not rounded', () => {
  const circuit = parseQasm('OPENQASM 2.0;\ninclude "qelib1.inc";\nqreg q[1];\n\nrx(pi/4) q[0];\n');
  const ta = new TA(ring, 1);
  const { root } = ta.fromVectors([basis(1, 0)]);
  const frames = simulate(ta, root, circuit);
  const [got] = ta.language(frames.at(-1).root);
  assertClose(asComplex(got[0]), { re: Math.cos(Math.PI / 8), im: 0 }, 'cos(pi/8)');
  assertClose(asComplex(got[1]), { re: 0, im: -Math.sin(Math.PI / 8) }, '-i sin(pi/8)');
});
