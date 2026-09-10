import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Algebra, applyGate, applyOp, colourDeterministic, simulate } from '../src/aut-gates.js';
import { reduce } from '../src/aut-reduce.js';
import { ANY } from '../src/aut-lsta.js';
import { LSTA } from '../src/aut-lsta.js';
import { GATES } from '../src/gates.js';
import { parseQasm } from '../src/qasm.js';
import { parseHsl, toVector } from '../src/aut-hsl.js';
import { SPECIALS } from '../src/aut-examples.js';
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
    const ta = new LSTA(ring, n);
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
  const ta = new LSTA(ring, n);
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
  const ta = new LSTA(ring, 3);
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
  const ta = new LSTA(ring, 2);
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
  const ta = new LSTA(ring, 3);
  const alg = new Algebra(ta);
  const { root } = ta.fromVectors([basis(3, 0), basis(3, 4)]);
  const after = applyOp(alg, root, { name: 'h', qubits: [2] });
  const [a, b] = ta.transitionsOf(after);
  // |000> keeps its content under q0 = 0 and is zero under q0 = 1; |100> is the mirror.
  // So the four children of the two transitions are two distinct states, not four: the
  // transformed subtree is built once and the all-zero subtree is the one both share.
  assert.deepEqual([a[0], a[1]], [b[1], b[0]], 'the two members are mirror images');
  assert.equal(new Set([a[0], a[1], b[0], b[1]]).size, 2, 'built from two subtrees between them');
  const alone = ta.size(ta.state(0, [a]));
  assert.ok(ta.size(after) < 2 * alone,
    `${ta.size(after)} states for both, against ${alone} for one`);
});

test('the cofactor of a perfect tree is still perfect, and no longer depends on the qubit', () => {
  const ta = new LSTA(ring, 3);
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
  const ta = new LSTA(ring, 1);
  const alg = new Algebra(ta);
  const a = P.variable('a');
  const b = P.variable('b');
  const { root } = ta.fromVectors([[a, b]]);
  const after = applyGate(alg, root, [0], GATES.x.matrix);
  const [got] = ta.language(after);
  assert.ok(ring.eq(got[0], b) && ring.eq(got[1], a), `${P.format(got[0], 'exact')}`);
});

test('a mixing gate is applied to the whole set at once, without taking it apart', () => {
  // The thing a plain tree automaton could not do. Two sibling subtrees of a TA are read
  // independently, so the two halves of a node H transforms could not agree on which
  // choice the other made and the only exact answer was to enumerate the members. Here
  // the colours make them agree, and the check is the dense oracle on every member.
  const n = 3;
  const ta = new LSTA(ring, n);
  const spec = parseHsl(SPECIALS.basis.spec(n), n);
  const { root } = ta.fromVectors(spec.vectors.map((v) => toVector(v, ring)));
  const small = reduce(ta, root);
  assert.equal(ta.size(small), 2 * n + 1, 'the compact automaton, before the gate');

  const alg = new Algebra(ta);
  const after = reduce(ta, applyOp(alg, small, { name: 'h', qubits: [0] }));
  const dense = ta.language(small)
    .map((v) => applyGateDense(v.map(asComplex), n, [0], GATES.h.matrix));
  assert.deepEqual(asFloats(ta.language(after)), asText(dense));
  assert.ok(ta.size(after) < 3 * ta.size(small),
    `${ta.size(after)} states from ${ta.size(small)}: the set was expanded after all`);
});

test('the colours have to pick out a run, and a gate says so when they do not', () => {
  // The invariant the construction rests on: under one colouring each state takes one
  // step, so adding two cofactors adds two halves of the *same* tree. Nothing the page
  // builds breaks it — this is a state made by hand to show what the check is for.
  const ta = new LSTA(ring, 2);
  const alg = new Algebra(ta);
  const zero = ta.leaf(P.zero);
  const one = ta.leaf(P.one);
  const loose = ta.state(1, [[one, zero, [0]], [zero, one, [0]]]);   // one colour, two steps
  const tight = ta.state(1, [[one, zero, [0]], [zero, one, [1]]]);   // one colour each
  assert.ok(colourDeterministic(ta, loose), 'the hand-made one is loose');
  assert.equal(colourDeterministic(ta, tight), null, 'and the coloured one is not');

  assert.throws(() => applyGate(alg, ta.state(0, [[loose, loose]]), [0], GATES.h.matrix),
    /two steps under one colour/);
  assert.doesNotThrow(() => applyGate(alg, ta.state(0, [[tight, tight]]), [0], GATES.h.matrix));
});

test('an ordinary automaton is a level-synchronized one that never uses a colour', () => {
  // Nothing was taken away. A transition admitted under any colour constrains no run, so
  // an automaton built without colours behaves exactly as it did before there were any.
  const ta = new LSTA(ring, 2);
  const { root } = ta.fromVectors([basis(2, 0)]);
  for (const id of ta.reachable(root)) {
    for (const [, , choice] of ta.transitionsOf(id)) {
      assert.ok(choice === ANY || choice.length === 1, 'a set of one names one member');
    }
  }
  const alg = new Algebra(ta);
  const after = applyGate(alg, root, [0], GATES.h.matrix);
  const [got] = ta.language(after);
  assertClose(asComplex(got[0]), { re: Math.SQRT1_2, im: 0 }, '|00>');
  assertClose(asComplex(got[2]), { re: Math.SQRT1_2, im: 0 }, '|10>');
});

test('every frame is reduced, so the next gate starts from the small form', () => {
  // What the pipeline promises: expand to push a gate through, reduce what comes out,
  // and carry *that* forward. If a frame were not already reduced, the next gate would
  // be paying again for sharing that had been found once.
  const n = 4;
  const ta = new LSTA(ring, n);
  const spec = parseHsl(SPECIALS.basis.spec(n), n);
  const { root } = ta.fromVectors(spec.vectors.map((v) => toVector(v, ring)));
  const circuit = parseQasm('OPENQASM 2.0;\ninclude "qelib1.inc";\nqreg q[4];\n\n'
    + 'h q[0];\ncx q[0],q[1];\nt q[2];\nx q[3];\n');
  const frames = simulate(ta, root, circuit);
  for (const frame of frames) {
    assert.equal(reduce(ta, frame.root), frame.root, `frame ${frame.index} is not reduced`);
    assert.equal(frame.members, 2 ** n, 'and a unitary keeps the set the size it was');
    assert.ok(frame.expanded >= frame.size, 'the expansion is never smaller than what it reduced to');
  }
  assert.equal(frames[0].size, 2 * n + 1, 'the input set is the compact automaton');
  assert.ok(frames[0].expanded > frames[0].size, 'and it did not start that way');
});

test('a rotation stays in the ring, so the amplitude is exact and not rounded', () => {
  const circuit = parseQasm('OPENQASM 2.0;\ninclude "qelib1.inc";\nqreg q[1];\n\nrx(pi/4) q[0];\n');
  const ta = new LSTA(ring, 1);
  const { root } = ta.fromVectors([basis(1, 0)]);
  const frames = simulate(ta, root, circuit);
  const [got] = ta.language(frames.at(-1).root);
  assertClose(asComplex(got[0]), { re: Math.cos(Math.PI / 8), im: 0 }, 'cos(pi/8)');
  assertClose(asComplex(got[1]), { re: 0, im: -Math.sin(Math.PI / 8) }, '-i sin(pi/8)');
});

test('every basis state at once goes through a circuit, all of them at once', () => {
  // The precondition behind "and it does the right thing on every input". Every member
  // is a transition of the root, so the gates reach all of them, and the check is the
  // same dense oracle applied to each — which is what verifying a circuit over all
  // inputs means in the first place.
  for (const n of [1, 2, 3]) {
    const ta = new LSTA(ring, n);
    const spec = parseHsl(SPECIALS.basis.spec(n), n);
    assert.equal(spec.vectors.length, 2 ** n);
    const { root } = ta.fromVectors(spec.vectors.map((v) => toVector(v, ring)));

    const gates = n === 1 ? 'h q[0];\nt q[0];\n'
      : `h q[0];\ncx q[0],q[${n - 1}];\nz q[${n - 1}];\n`;
    const circuit = parseQasm(`OPENQASM 2.0;\ninclude "qelib1.inc";\nqreg q[${n}];\n\n${gates}`);
    const frames = simulate(ta, root, circuit);

    let dense = [...Array(2 ** n).keys()].map((b) => Array.from({ length: 2 ** n },
      (_, i) => ({ re: i === b ? 1 : 0, im: 0 })));
    for (const frame of frames) {
      if (frame.gate) {
        dense = dense.map((v) => applyGateDense(v, n, frame.gate.qubits,
          frame.gate.matrix || GATES[frame.gate.name].matrix));
      }
      assert.equal(frame.members, 2 ** n, `${n} qubits: a unitary is a bijection on the set`);
      assert.deepEqual(asFloats(ta.language(frame.root)), asText(dense),
        `${n} qubits, frame ${frame.index}`);
    }
  }
});

test('the zero state is a set of one, and stays one all the way through', () => {
  const n = 3;
  const ta = new LSTA(ring, n);
  const spec = parseHsl(SPECIALS.zero.spec(n), n);
  const { root } = ta.fromVectors(spec.vectors.map((v) => toVector(v, ring)));
  const circuit = parseQasm('OPENQASM 2.0;\ninclude "qelib1.inc";\nqreg q[3];\n\n'
    + 'h q[0];\ncx q[0],q[1];\ncx q[1],q[2];\n');
  const frames = simulate(ta, root, circuit);
  assert.ok(frames.every((f) => f.members === 1), 'one state in, one state out');
  const [ghz] = ta.language(frames.at(-1).root);
  const half = Math.SQRT1_2;
  assertClose(asComplex(ghz[0]), { re: half, im: 0 }, '|000>');
  assertClose(asComplex(ghz[7]), { re: half, im: 0 }, '|111>');
  assert.ok(ghz.filter((x) => !ring.isZero(x)).length === 2, 'and nothing else');
});
