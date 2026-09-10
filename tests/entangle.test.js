import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Ent from '../src/entangle.js';
import { parseQasm } from '../src/qasm.js';
import { parseState, buildState } from '../src/state.js';
import { MTBDD } from '../src/dd.js';
import { simulate } from '../src/sim.js';
import { randomCircuit, GATE_SETS } from '../src/random.js';
import * as P from '../src/poly.js';

const HEAD = 'OPENQASM 2.0;\ninclude "qelib1.inc";\n';
const zeros = (n) => `|${'0'.repeat(n)}> : 1`;

/** The state a circuit leaves, as amplitudes both exact and numeric. */
function evolve(qasm, n, initial = zeros(n)) {
  const circuit = parseQasm(qasm);
  const dd = new MTBDD(P.Ring, n);
  const frames = simulate(dd, buildState(dd, parseState(initial, n).entries), circuit);
  const amps = Ent.amplitudes(dd, frames[frames.length - 1].root, n);
  return { amps, numeric: amps.map((a) => P.evaluate(a, {})), n };
}

const CASES = [
  ['a product state', `${HEAD}qreg q[4];\nx q[1];\nh q[3];\n`, 4, 1, [[0], [1], [2], [3]]],
  ['a Bell pair', `${HEAD}qreg q[2];\nh q[0];\ncx q[0],q[1];\n`, 2, 2, [[0, 1]]],
  ['GHZ on four', `${HEAD}qreg q[4];\nh q[0];\ncx q[0],q[1];\ncx q[1],q[2];\ncx q[2],q[3];\n`, 4, 4, [[0, 1, 2, 3]]],
  ['two Bell pairs', `${HEAD}qreg q[4];\nh q[0];\ncx q[0],q[1];\nh q[2];\ncx q[2],q[3];\n`, 4, 2, [[0, 1], [2, 3]]],
  // The blocks need not be runs of adjacent qubits, and this is the case that says so.
  ['nested Bell pairs', `${HEAD}qreg q[4];\nh q[0];\ncx q[0],q[3];\nh q[1];\ncx q[1],q[2];\n`, 4, 2, [[0, 3], [1, 2]]],
  ['GHZ on three beside a spare',
    `${HEAD}qreg q[4];\nh q[0];\ncx q[0],q[1];\ncx q[1],q[2];\nh q[3];\n`, 4, 3, [[0, 1, 2], [3]]],
  ['a five-qubit cluster state',
    `${HEAD}qreg q[5];\n${[0, 1, 2, 3, 4].map((i) => `h q[${i}];`).join('\n')}\n${[0, 1, 2, 3].map((i) => `cz q[${i}],q[${i + 1}];`).join('\n')}\n`,
    5, 5, [[0, 1, 2, 3, 4]]],
];

test('the finest product partition, and the depth that follows from it', () => {
  for (const [name, qasm, n, depth, blocks] of CASES) {
    const { amps, numeric } = evolve(qasm, n);
    const got = Ent.productPartition(P.Ring, amps, n, { numeric });
    assert.equal(got.exhausted, false, name);
    assert.deepEqual(got.blocks, blocks, name);
    assert.equal(got.depth, depth, name);
  }
});

test('the blocks partition the qubits, and each is a smallest factor', () => {
  // What makes it *the finest* partition rather than merely one the state factors over.
  for (const [name, qasm, n] of CASES) {
    const { amps, numeric } = evolve(qasm, n);
    const { blocks } = Ent.productPartition(P.Ring, amps, n, { numeric });
    assert.deepEqual(blocks.flat().sort((a, b) => a - b),
      Array.from({ length: n }, (_, i) => i), `${name}: the blocks cover each qubit once`);
    for (const b of blocks) {
      if (b.length < n) {
        assert.ok(Ent.isProduct(P.Ring, Ent.splitMatrix(amps, n, b)), `${name}: ${b} factors`);
      }
      // and nothing smaller does, which is what "finest" means
      for (let m = 1; m < b.length; m++) {
        for (const sub of subsets(b, m)) {
          assert.ok(!Ent.isProduct(P.Ring, Ent.splitMatrix(amps, n, sub)),
            `${name}: ${sub} factors, so ${b} was not a smallest block`);
        }
      }
    }
  }
});

function* subsets(xs, k) {
  if (k === 0) { yield []; return; }
  for (let i = 0; i <= xs.length - k; i++) {
    for (const rest of subsets(xs.slice(i + 1), k - 1)) yield [xs[i], ...rest];
  }
}

test('pairwise correlation is not enough, which is why the search is exhaustive', () => {
  // q2 = q0 XOR q1 on three uniform qubits. Every *pair* of its qubits is completely
  // uncorrelated — each two-qubit marginal is the maximally mixed state — and yet no
  // qubit factors out of it and its depth is three. Any shortcut that decided the blocks
  // from pairs would call this a product of three singletons.
  const qasm = `${HEAD}qreg q[3];\nh q[0];\nh q[1];\ncx q[0],q[2];\ncx q[1],q[2];\n`;
  const { amps, numeric, n } = evolve(qasm, 3);
  const got = Ent.productPartition(P.Ring, amps, n, { numeric });
  assert.deepEqual(got.blocks, [[0, 1, 2]]);
  assert.equal(got.depth, 3);
  for (const pair of [[0, 1], [0, 2], [1, 2]]) {
    assert.equal(Ent.schmidt(numeric, 3, pair).rank, 2, `${pair} is entangled with the rest`);
  }
});

test('Schmidt rank, coefficients and entropy', () => {
  const bell = evolve(CASES[1][1], 2);
  const ghz = evolve(CASES[2][1], 4);
  const pairs = evolve(CASES[3][1], 4);
  const prod = evolve(CASES[0][1], 4);
  const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

  let s = Ent.schmidt(bell.numeric, 2, [0]);
  assert.equal(s.rank, 2);
  near(s.entropy, 1, 'a Bell pair is one ebit');
  s.coefficients.forEach((c) => near(c, Math.SQRT1_2, 'Bell coefficient'));

  // GHZ has rank two across *every* split, however the qubits are cut.
  for (const part of [[0], [1], [0, 1], [0, 2], [1, 3], [0, 1, 2]]) {
    const g = Ent.schmidt(ghz.numeric, 4, part);
    assert.equal(g.rank, 2, `GHZ across ${part}`);
    near(g.entropy, 1, `GHZ across ${part}`);
  }

  // A split that cuts both pairs carries two ebits; one that cuts neither carries none.
  near(Ent.schmidt(pairs.numeric, 4, [0, 2]).entropy, 2, 'both pairs cut');
  assert.equal(Ent.schmidt(pairs.numeric, 4, [0, 1]).rank, 1, 'a split along a factor');
  near(Ent.schmidt(pairs.numeric, 4, [0, 1]).entropy, 0, 'a factor carries no entanglement');
  assert.equal(Ent.schmidt(prod.numeric, 4, [1, 3]).rank, 1, 'a product state');

  // The probabilities are a distribution, and the two sides agree.
  for (const part of [[0], [0, 1], [2, 3], [1]]) {
    const a = Ent.schmidt(pairs.numeric, 4, part);
    const other = [0, 1, 2, 3].filter((q) => !part.includes(q));
    const b = Ent.schmidt(pairs.numeric, 4, other);
    near(a.probabilities.reduce((x, y) => x + y, 0), 1, `probabilities sum, ${part}`);
    assert.equal(a.rank, b.rank, `a split and its complement, ${part}`);
    near(a.entropy, b.entropy, `entropy is symmetric, ${part}`);
  }
});

test('the numeric rank and the exact product test agree on rank one', () => {
  // The two halves use different arithmetic, so where they overlap they must not differ:
  // Schmidt rank 1 is exactly the case the ring can decide, and it is the case that
  // matters — it is what "these qubits are not entangled with those" means.
  for (const [name, qasm, n] of CASES) {
    const { amps, numeric } = evolve(qasm, n);
    for (let mask = 1; mask < (1 << n) - 1; mask++) {
      const part = [];
      for (let q = 0; q < n; q++) if (mask & (1 << q)) part.push(q);
      const exact = Ent.isProduct(P.Ring, Ent.splitMatrix(amps, n, part));
      assert.equal(Ent.schmidt(numeric, n, part).rank === 1, exact, `${name}, split ${part}`);
    }
  }
});

test('the analysis holds up on circuits nobody chose', () => {
  // Random circuits, over every gate set: the blocks must still partition the qubits and
  // each must still factor exactly, and the Schmidt rank across a block must be one.
  for (const set of Object.keys(GATE_SETS)) {
    for (let i = 1; i <= 6; i++) {
      const made = randomCircuit(i * 6151, { set, qubits: 5 });
      const { amps, numeric, n } = evolve(made.qasm, 5, made.state);
      const where = `${set} at seed ${made.seed}`;
      const got = Ent.productPartition(P.Ring, amps, n, { numeric });
      assert.equal(got.exhausted, false, where);
      assert.deepEqual(got.blocks.flat().sort((a, b) => a - b), [0, 1, 2, 3, 4], where);
      assert.ok(got.depth >= 1 && got.depth <= n, where);
      for (const b of got.blocks) {
        if (b.length === n) continue;
        assert.equal(Ent.schmidt(numeric, n, b).rank, 1, `${where}: block ${b} is a factor`);
      }
    }
  }
});

test('a state too wide to search says so rather than hanging', () => {
  const n = 14;
  const qasm = `${HEAD}qreg q[${n}];\nh q[0];\n`
    + Array.from({ length: n - 1 }, (_, i) => `cx q[${i}],q[${i + 1}];\n`).join('');
  const { amps, numeric } = evolve(qasm, n);
  const got = Ent.productPartition(P.Ring, amps, n, { numeric });
  assert.equal(got.exhausted, true, 'GHZ on 14 is past the budget');
  assert.equal(got.depth, null);
});

test('a bipartition can be written the way qubits are named', () => {
  const labels = ['q[0]', 'q[1]', 'a[0]', 'a[1]'];
  assert.deepEqual(Ent.parseSubset('q[0] a[1]', labels).part, [0, 3]);
  assert.deepEqual(Ent.parseSubset('a[1],q[0]', labels).part, [0, 3], 'order and commas do not matter');
  assert.deepEqual(Ent.parseSubset('0 3', labels).part, [0, 3], 'bare indices too');
  assert.match(Ent.parseSubset('q[9]', labels).error, /not a qubit/);
  assert.match(Ent.parseSubset('q[0] q[0]', labels).error, /twice/);
  assert.match(Ent.parseSubset('', labels).error, /name at least one/);
  assert.match(Ent.parseSubset('q[0] q[1] a[0] a[1]', labels).error, /cannot be every qubit/);
});

test('the Schmidt rank of the state is the largest over every bipartition', () => {
  // A Schmidt rank belongs to a split, so the state's own is the worst case over all of
  // them. Checked against the ranks taken one split at a time, by a different route:
  // the sweep uses elimination, the per-split figure comes from eigenvalues.
  for (const [name, qasm, n] of CASES) {
    const { numeric } = evolve(qasm, n);
    let brute = 0;
    for (let mask = 1; mask < (1 << n) - 1; mask++) {
      const part = [];
      for (let q = 0; q < n; q++) if (mask & (1 << q)) part.push(q);
      brute = Math.max(brute, Ent.schmidt(numeric, n, part).rank);
    }
    const got = Ent.maxSchmidtRank(numeric, n);
    assert.equal(got.exhausted, false, name);
    assert.equal(got.rank, brute, `${name}: elimination and eigenvalues agree`);
    assert.ok(got.rank <= got.ceiling, `${name}: within 2^floor(n/2)`);
    if (got.rank > 1) {
      assert.equal(Ent.schmidt(numeric, n, got.part).rank, got.rank,
        `${name}: the split it names really does reach it`);
    }
  }
});

test('a fully product state has Schmidt rank one, and only such a state does', () => {
  const product = evolve(CASES[0][1], 4);
  assert.equal(Ent.maxSchmidtRank(product.numeric, 4).rank, 1);
  assert.equal(Ent.productPartition(P.Ring, product.amps, 4, { numeric: product.numeric }).depth, 1);
  for (const [name, qasm, n, depth] of CASES.slice(1)) {
    const { numeric } = evolve(qasm, n);
    assert.ok(Ent.maxSchmidtRank(numeric, n).rank > 1, `${name} is entangled, so rank > 1`);
    assert.ok(depth > 1, name);
  }
});

test('the cut profile follows the qubit order, and bounds nothing it should not', () => {
  // Nested Bell pairs are the example the ordering control exists for: written in order
  // the middle cut has to carry every pair at once, and pairing the qubits up makes each
  // cut carry one. The numbers say exactly that.
  const n = 8;
  const qasm = `${HEAD}qreg q[${n}];\n`
    + Array.from({ length: n / 2 }, (_, i) => `h q[${i}];\ncx q[${i}],q[${n - 1 - i}];`).join('\n');
  const { numeric } = evolve(qasm, n);
  const written = Ent.cutProfile(numeric, n, Array.from({ length: n }, (_, i) => i));
  const paired = Ent.cutProfile(numeric, n, [0, 7, 1, 6, 2, 5, 3, 4]);
  assert.deepEqual(written.map((c) => c.rank), [2, 4, 8, 16, 8, 4, 2]);
  assert.deepEqual(paired.map((c) => c.rank), [2, 1, 2, 1, 2, 1, 2]);

  // Every cut is a bipartition, so none of them can beat the state's own rank.
  const worst = Ent.maxSchmidtRank(numeric, n).rank;
  for (const c of [...written, ...paired]) assert.ok(c.rank <= worst, `${c.above} within ${worst}`);
  assert.equal(worst, 16, 'and the written order reaches it');
});

test('matrixRank agrees with the exact product test at rank one', () => {
  for (const [name, qasm, n] of CASES) {
    const { amps, numeric } = evolve(qasm, n);
    for (let mask = 1; mask < (1 << n) - 1; mask++) {
      const part = [];
      for (let q = 0; q < n; q++) if (mask & (1 << q)) part.push(q);
      const exact = Ent.isProduct(P.Ring, Ent.splitMatrix(amps, n, part));
      assert.equal(Ent.matrixRank(Ent.splitMatrix(numeric, n, part)) <= 1, exact,
        `${name}, split ${part}`);
    }
  }
});

test('a state too wide for every bipartition says so', () => {
  const n = 13;
  const qasm = `${HEAD}qreg q[${n}];\nh q[0];\n`
    + Array.from({ length: n - 1 }, (_, i) => `cx q[${i}],q[${i + 1}];\n`).join('');
  const { numeric } = evolve(qasm, n);
  const got = Ent.maxSchmidtRank(numeric, n);
  assert.equal(got.exhausted, true);
  assert.equal(got.rank, null);
  // but the cuts of one order are always affordable, and there are only n - 1 of them
  assert.equal(Ent.cutProfile(numeric, n, Array.from({ length: n }, (_, i) => i)).length, n - 1);
});

/** A state with one excitation, and a state with two terms — the textbook pair. */
const single = (n, amp) => Array.from({ length: 2 ** n }, (_, b) => {
  const isW = Array.from({ length: n }, (_, k) => 1 << k).includes(b);
  return { re: isW ? amp : 0, im: 0 };
});
const cat = (n) => Array.from({ length: 2 ** n }, (_, b) => ({
  re: (b === 0 || b === 2 ** n - 1) ? Math.SQRT1_2 : 0, im: 0,
}));

test('tensor rank: W on n qubits is n, GHZ is two however wide', () => {
  // The two states that make the point. They have the *same* Schmidt rank across every
  // bipartition — 2 — so a Schmidt rank cannot tell them apart; their tensor ranks can.
  for (const n of [3, 4, 5, 6]) {
    const w = single(n, 1 / Math.sqrt(n));
    const g = cat(n);
    assert.equal(Ent.maxSchmidtRank(w, n).rank, 2, `W${n} Schmidt rank`);
    assert.equal(Ent.maxSchmidtRank(g, n).rank, 2, `GHZ${n} Schmidt rank`);
    assert.equal(Ent.tensorRank(w, n, { lower: 2 }).found, n, `W${n} tensor rank is ${n}`);
    assert.equal(Ent.tensorRank(g, n, { lower: 2 }).found, 2, `GHZ${n} tensor rank is 2`);
  }
});

test('tensor rank agrees with the Schmidt rank where it must', () => {
  // On two qubits the two notions coincide, and on a product state both are one.
  for (const [name, qasm, n] of CASES) {
    const { numeric } = evolve(qasm, n);
    const lower = Ent.maxSchmidtRank(numeric, n).rank;
    const t = Ent.tensorRank(numeric, n, { lower });
    if (t.found === null) continue;
    assert.ok(t.found >= lower, `${name}: the tensor rank is at least the Schmidt rank`);
    if (lower === 1) assert.equal(t.found, 1, `${name}: a product state is one term`);
  }
  const bell = evolve(CASES[1][1], 2);
  assert.equal(Ent.tensorRank(bell.numeric, 2, { lower: 2 }).found, 2, 'two qubits: the same notion');
  assert.equal(Ent.tensorRank(bell.numeric, 2, { lower: 2 }).exact, true);
});

test('a rank-2 fit of W is refused, because it never reaches W', () => {
  // The trap the whole implementation is shaped around. W has border rank 2: a two-term
  // decomposition converges on it without attaining it, its factors diverging. Judging a
  // fit on residual alone would report W as rank 2, which is wrong.
  const w = single(3, 1 / Math.sqrt(3));
  const got = Ent.tensorRank(w, 3, { lower: 2 });
  assert.equal(got.found, 3);
  assert.equal(got.exact, false, 'three terms found, two is all that is proved');
  assert.equal(got.lower, 2);
});

test('a search that cannot finish reports a floor, not a rank', () => {
  // A generic state has a high tensor rank and each further term costs more to look for.
  let seed = 99;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const raw = Array.from({ length: 64 }, () => ({ re: rand() * 2 - 1, im: rand() * 2 - 1 }));
  const scale = Math.sqrt(raw.reduce((s, z) => s + z.re * z.re + z.im * z.im, 0));
  const v = raw.map((z) => ({ re: z.re / scale, im: z.im / scale }));
  const got = Ent.tensorRank(v, 6, { lower: Ent.maxSchmidtRank(v, 6).rank });
  assert.equal(got.found, null);
  assert.equal(got.gaveUp, true);
  assert.ok(got.searchedTo >= got.lower, 'and says how far it got');
});
