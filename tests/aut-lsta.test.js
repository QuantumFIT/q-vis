import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANY, LSTA } from '../src/aut-lsta.js';
import { reduce } from '../src/aut-reduce.js';
import { simulate } from '../src/aut-gates.js';
import { parseHsl, toVector } from '../src/aut-hsl.js';
import { SPECIALS } from '../src/aut-examples.js';
import { parseQasm } from '../src/qasm.js';
import * as P from '../src/poly.js';
import * as Z from '../src/zomega.js';
import { rng, randInt } from './helpers.js';

const ring = P.Ring;
const one = P.one;
const zero = P.zero;
const half = P.fromZ(Z.zo(1, 0, 0, 0, 2));          // 1/2
const inv2 = P.fromZ(Z.INV_SQRT2);                  // 1/√2

/** A basis state as an amplitude vector: 1 at `index`, 0 elsewhere. */
const basis = (n, index) => Array.from({ length: 2 ** n }, (_, i) => (i === index ? one : zero));

/** Two vectors are the same state. */
const same = (a, b) => a.length === b.length && a.every((x, i) => ring.eq(x, b[i]));

/** A language as a set of comparable keys, so order does not matter. */
const asSet = (vs) => new Set(vs.map((v) => v.map((x) => ring.key(x)).join('|')));

test('the language of an automaton built from vectors is exactly those vectors', () => {
  // The differential check, and the one that matters: the encoding is only right if what
  // goes in comes back out. Taken from the language by naive expansion, which shares no
  // code with the construction.
  const cases = [
    [1, [basis(1, 0)]],
    [2, [basis(2, 0)]],
    [2, [basis(2, 0), basis(2, 3)]],
    [3, [basis(3, 1), basis(3, 2), basis(3, 4)]],
    [2, [[half, half, half, half]]],
    [2, [[inv2, zero, zero, inv2], [inv2, zero, zero, P.neg(inv2)]]],
    [3, [basis(3, 0), basis(3, 7), [half, zero, zero, half, half, zero, zero, half]]],
  ];
  for (const [n, vectors] of cases) {
    const ta = new LSTA(ring, n);
    const { root } = ta.fromVectors(vectors);
    const got = ta.language(root);
    assert.equal(got.length, vectors.length, `${n} qubits, ${vectors.length} states: count`);
    assert.deepEqual(asSet(got), asSet(vectors), `${n} qubits, ${vectors.length} states`);
  }
});

test('a state is its transitions, so the same set built two ways is one state', () => {
  // Interning is the whole design: identity has to be semantic, or nothing downstream —
  // minimality, frame diffing, comparing two automata — works.
  const ta = new LSTA(ring, 2);
  const a = ta.leaf(one);
  const b = ta.leaf(zero);
  assert.equal(ta.leaf(one), a, 'the same amplitude is the same leaf');
  assert.notEqual(a, b);

  const x = ta.state(1, [[a, b], [b, a]]);
  const y = ta.state(1, [[b, a], [a, b]]);
  assert.equal(x, y, 'the order the transitions were given in is not part of the state');
  assert.equal(ta.state(1, [[a, b], [b, a], [a, b]]), x, 'nor is a repeat');
  assert.notEqual(ta.state(1, [[a, b]]), x, 'but a different set is a different state');
});

test('two vectors that agree on a subtree share it', () => {
  // What the automaton is for. |000> and |100> differ only in the first qubit, so
  // everything below the root is common and must be built once.
  const ta = new LSTA(ring, 3);
  const separate = new LSTA(ring, 3);
  const shared = ta.fromVectors([basis(3, 0), basis(3, 4)]);
  const alone = separate.fromVectors([basis(3, 0)]);
  assert.ok(ta.size(shared.root) < 2 * separate.size(alone.root),
    'the two trees are not built side by side');
  // and the root really is one state with two transitions
  assert.equal(ta.transitionsOf(shared.root).length, 2);
});

test('a set of one is deterministic, and costs two states a level, not one', () => {
  // With one transition everywhere an automaton *is* a deterministic decision diagram —
  // that much the two encodings share, and this pins it.
  //
  // What they do not share is the count, and the reason is worth keeping. An MTBDD of
  // |0...0> is a tower, because a subtree of nothing but zeros collapses into the zero
  // terminal. Here the trees are *perfect*: every branch is exactly n long, so an
  // all-zero subtree at level i is a tree of depth n-i and cannot be a leaf. So there is
  // an on-path state at every level and an all-zero state at every level below the root,
  // and 2n + 1 states in total rather than n + 2.
  for (const n of [1, 2, 3, 4, 5, 6]) {
    const ta = new LSTA(ring, n);
    const { root } = ta.fromVectors([basis(n, 0)]);
    for (const id of ta.reachable(root)) {
      if (!ta.isLeaf(id)) assert.equal(ta.transitionsOf(id).length, 1, `${n} qubits`);
    }
    assert.equal(ta.size(root), 2 * n + 1, `${n} qubits`);
  }
});

test('malformed automata are refused rather than built', () => {
  const ta = new LSTA(ring, 2);
  const leaf = ta.leaf(one);
  assert.throws(() => ta.state(2, [[leaf, leaf]]), /not one of the 2 variables/);
  assert.throws(() => ta.state(-1, [[leaf, leaf]]), /not one of the 2 variables/);
  assert.throws(() => ta.state(0, []), /accepts nothing/);
  assert.throws(() => ta.state(0, [[leaf, leaf]]), /must be at level 1/,
    'a level-0 state cannot reach the leaves directly when there are two qubits');
  assert.throws(() => ta.state(1, [[leaf, 999]]), /no such state/);
  assert.throws(() => ta.fromVectors([[one, zero]]), /has 4 amplitudes/);
});

test('what it accepts, it says it accepts — over random sets of random states', () => {
  // The property, swept: build an automaton from vectors drawn at random, and check both
  // directions — every vector is accepted, and nothing else is in the language.
  const r = rng(20260910);
  for (let iter = 0; iter < 40; iter++) {
    const n = randInt(r, 1, 4);
    const count = randInt(r, 1, 3);
    const vectors = [];
    for (let k = 0; k < count; k++) {
      const v = Array.from({ length: 2 ** n }, () => {
        const pick = randInt(r, 0, 3);
        return [zero, one, half, inv2][pick];
      });
      if (!vectors.some((u) => same(u, v))) vectors.push(v);
    }
    const ta = new LSTA(ring, n);
    const { root } = ta.fromVectors(vectors);
    for (const v of vectors) assert.ok(ta.accepts(root, v), `${n} qubits: a vector went missing`);
    assert.deepEqual(asSet(ta.language(root)), asSet(vectors),
      `${n} qubits, ${vectors.length} vectors: the language gained something`);
  }
});

test('nondeterminism can accept more than it was built from, and that is the point', () => {
  // Sharing a subtree between two *transitions of one state* is what makes an automaton
  // compact and what makes it able to say more than a list. Built deliberately here so
  // the behaviour is pinned rather than discovered later: a root with transitions
  // (a,b) and (c,d) accepts four trees when a,b,c,d each accept one and are combined.
  const ta = new LSTA(ring, 2);
  const zeroLeaf = ta.leaf(zero);
  const oneLeaf = ta.leaf(one);
  const l0 = ta.state(1, [[oneLeaf, zeroLeaf]]);      // |0>
  const l1 = ta.state(1, [[zeroLeaf, oneLeaf]]);      // |1>
  const both = ta.state(0, [[l0, l0], [l0, l1], [l1, l0], [l1, l1]]);
  assert.equal(ta.language(both).length, 4, 'all four basis states of two qubits');
  assert.equal(ta.size(both), 5, 'from five states: a root, two at level 1, two leaves');
});

test('the language of a very nondeterministic automaton is capped, not run away with', () => {
  const ta = new LSTA(ring, 3);
  const zeroLeaf = ta.leaf(zero);
  const oneLeaf = ta.leaf(one);
  let low = ta.state(2, [[oneLeaf, zeroLeaf], [zeroLeaf, oneLeaf]]);
  for (let level = 1; level >= 0; level--) low = ta.state(level, [[low, low]]);
  assert.throws(() => ta.language(low, 3), /more than 3 (states|runs)/);
  // Two choices at level 2, and every level above chooses for its halves independently:
  // 2 becomes 2x2 at level 1 and 4x4 at the root. Sixteen quantum states of three qubits
  // from an automaton of five — which is the compactness the encoding exists for, and
  // why the language is capped rather than assumed small.
  assert.equal(ta.language(low, 4096).length, 16, 'and with room, it answers');
  assert.equal(ta.size(low), 5, 'two leaves and one state per level');
});

test('a colour is a choice the whole level makes, not one each node makes', () => {
  // The one thing this automaton says that an ordinary one cannot. Two states offering
  // the same two alternatives, under the same two colours, cannot disagree about which
  // they took — so the four combinations an ordinary automaton would accept are two.
  const ta = new LSTA(ring, 2);
  const l0 = ta.leaf(zero);
  const l1 = ta.leaf(one);
  const either = ta.state(1, [[l1, l0, [0]], [l0, l1, [1]]]);
  const both = ta.state(0, [[either, either]]);
  assert.deepEqual(asSet(ta.language(both)),
    asSet([[one, zero, one, zero], [zero, one, zero, one]]),
    'the halves agree, so |00>+|10> and |01>+|11> patterns and nothing crossed');

  // The same shape with the colours taken off is the ordinary automaton, and it accepts
  // all four — which is exactly the imprecision level-synchronization exists to remove.
  const loose = ta.state(1, [[l1, l0], [l0, l1]]);
  assert.equal(ta.language(ta.state(0, [[loose, loose]])).length, 4);
});

test('a colour no transition names tells nothing apart, and is not offered', () => {
  const ta = new LSTA(ring, 2);
  const l0 = ta.leaf(zero);
  const l1 = ta.leaf(one);
  const plain = ta.state(1, [[l1, l0]]);
  const root = ta.state(0, [[plain, plain]]);
  assert.deepEqual(ta.palette(root), [[null], [null]], 'nothing named, so one nominal colour');

  const picky = ta.state(1, [[l1, l0, [3]], [l0, l1, [7]]]);
  assert.deepEqual(ta.palette(ta.state(0, [[picky, picky]])), [[null], [3, 7]]);
});

test('a step admitted under no colour at all is not a step', () => {
  const ta = new LSTA(ring, 1);
  const l0 = ta.leaf(zero);
  const l1 = ta.leaf(one);
  assert.equal(ta.transitionsOf(ta.state(0, [[l1, l0, [0]], [l0, l1, []]])).length, 1);
  assert.throws(() => ta.state(0, [[l1, l0, []]]), /accepts nothing/);
  // Two steps to the same pair are one step, under the colours of both.
  assert.deepEqual(ta.transitionsOf(ta.state(0, [[l1, l0, [0]], [l1, l0, [2]]])),
    [[l1, l0, [0, 2]]]);
});

test('every basis state is 2n+1 states, and a Hadamard does not undo that', () => {
  // The claim the whole level-synchronized construction is for, as a number. An ordinary
  // tree automaton holds this set in 2n+1 states too — and then loses it at the first
  // mixing gate, because the two halves of a transformed node cannot agree on which
  // choice the other made and the only exact answer was to enumerate all 2^n members.
  // Here they agree, so the automaton stays the size it was.
  for (const n of [3, 4, 5, 6]) {
    const ta = new LSTA(ring, n);
    const vs = parseHsl(SPECIALS.basis.spec(n), n).vectors.map((v) => toVector(v, ring));
    const { root } = ta.fromVectors(vs);
    const start = reduce(ta, root);
    assert.equal(ta.size(start), 2 * n + 1, `${n} qubits: the compact automaton`);

    const circuit = parseQasm(`OPENQASM 2.0;\ninclude "qelib1.inc";\nqreg q[${n}];\n\n`
      + `x q[0];\ncx q[0],q[1];\nh q[0];\n`);
    const frames = simulate(ta, root, circuit);
    assert.equal(frames[1].size, 2 * n + 1, `${n} qubits: X only permutes, and costs nothing`);
    // The bound that matters is that it stays *linear*. An ordinary tree automaton had
    // to enumerate the 2^n members to push H through: at five qubits that was 67 states
    // where this is 16, and the gap is 2^n against n.
    assert.ok(frames.at(-1).size <= 4 * n,
      `${n} qubits: ${frames.at(-1).size} states after H, against ${2 * n + 1} before it`);
    assert.ok(frames.every((f) => f.members === 2 ** n), 'and the set is the size it was');
  }
});

test('the colours are quotiented to the fewest a level can tell apart', () => {
  // A set of sixty-four arrives painted with sixty-four colours, one per member. Nearly
  // all of them are indistinguishable by the time the merge is done, and a picture with
  // sixty-four dots on a transition would be no picture at all.
  const n = 6;
  const ta = new LSTA(ring, n);
  const vs = parseHsl(SPECIALS.basis.spec(n), n).vectors.map((v) => toVector(v, ring));
  const { root } = ta.fromVectors(vs);
  assert.equal(ta.palette(root)[1].length, 2 ** n, 'before: one colour per member');
  assert.deepEqual(ta.palette(reduce(ta, root)).map((at) => at.length),
    Array.from({ length: n }, () => 2), 'after: two, at every level');
});

test('a plain tree automaton is the same automaton with no colour on it', () => {
  // The other model the page offers, and the whole of what makes it the other one. Same
  // encoding of a state, same interning, same set denoted — the transitions simply carry
  // nothing, so no choice is synchronized with any other and the picture has no dots.
  for (const n of [1, 2, 3, 4]) {
    const vectors = [basis(n, 0), basis(n, 2 ** n - 1)];
    const plain = new LSTA(ring, n, { colours: false });
    const { root } = plain.fromVectors(vectors);
    assert.equal(plain.colours, false, 'and it says so, because everything downstream asks');

    for (const id of plain.reachable(root)) {
      if (plain.isLeaf(id)) continue;
      for (const [, , choice] of plain.transitionsOf(id)) {
        assert.equal(choice, ANY, `${n} qubits: a plain automaton names no colour`);
      }
    }
    assert.deepEqual(plain.palette(root), Array.from({ length: n }, () => [ANY]),
      `${n} qubits: nothing to tell apart on any level`);

    // And it accepts exactly what the level-synchronized one does. Colours constrain the
    // runs; with two members that share nothing there is nothing for them to constrain.
    const painted = new LSTA(ring, n);
    const asSet = (ta, r) => new Set(ta.language(r)
      .map((v) => v.map((x) => ring.key(x)).join('|')));
    assert.deepEqual(asSet(plain, root), asSet(painted, painted.fromVectors(vectors).root),
      `${n} qubits: the two models denote the same set`);
  }
});
