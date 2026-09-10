import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMDD } from '../src/limdd.js';
import { unitNormaliser } from '../src/evdd.js';
import { MTBDD } from '../src/dd.js';
import * as P from '../src/poly.js';
import * as Z from '../src/zomega.js';
import * as Pauli from '../src/pauli.js';
import { parseQasm } from '../src/qasm.js';
import { parseState, buildState } from '../src/state.js';
import { simulate } from '../src/sim.js';
import { layoutEdgeValued, layoutEdgeValuedTree } from '../src/layout.js';
import { blockBits, generatorRow, nodeTableau, frameNodes, tableauFrame, tableauText } from '../src/tableau.js';

const header = (n) => `OPENQASM 2.0;\ninclude "qelib1.inc";\nqreg q[${n}];\n`;
const zeros = (n) => `|${'0'.repeat(n)}> : 1`;

const ghz = (n) => header(n) + 'h q[0];\n'
  + Array.from({ length: n - 1 }, (_, i) => `cx q[${i}],q[${i + 1}];\n`).join('');
const cluster = (n) => header(n)
  + Array.from({ length: n }, (_, i) => `h q[${i}];\n`).join('')
  + Array.from({ length: n - 1 }, (_, i) => `cz q[${i}],q[${i + 1}];\n`).join('');

/** Run a circuit and lay it out the way the LIMDD view does. */
function laidOut(qasm, state, { tree = false } = {}) {
  const circuit = parseQasm(qasm);
  const n = circuit.nqubits;
  const dd = new MTBDD(P.Ring, n);
  const frames = simulate(dd, buildState(dd, parseState(state, n).entries), circuit);
  const li = new LIMDD(P.Ring, n, unitNormaliser(P, Z, 'low'));
  const memo = new Map();
  const built = frames.map((f) => ({ index: f.index, gate: f.gate, edge: li.fromMTBDD(dd, f.root, memo) }));
  const labels = circuit.qubits.map((q) => q.label);
  const layout = (tree ? layoutEdgeValuedTree : layoutEdgeValued)(li, built, labels, () => '');
  return { li, layout, labels, n, last: layout.frames.length - 1 };
}

/**
 * The dense amplitude vector of what a node denotes, indexed so that bit `j` is the qubit
 * `j` levels below the node — the same numbering `Pauli.apply` and a shifted check vector
 * use, so the three can be compared without any reversal in between.
 */
function vectorOf(li, id, n) {
  const level = li.levelOf(id);
  const span = n - level;
  const bare = { w: P.one, x: 0, z: 0, node: id };
  return Array.from({ length: 1 << span }, (_, b) => {
    const bits = new Array(n).fill(0);
    for (let j = 0; j < span; j++) bits[level + j] = (b >> j) & 1;
    return li.evaluate(bare, bits);
  });
}

test('a check vector block reads qubit 0 first, like the printed string', () => {
  // The two presentations sit side by side in the tableau, so a reader will compare them
  // column by column; if one were reversed the table would be quietly wrong.
  assert.equal(blockBits(0b0001, 4), '1000');
  assert.equal(blockBits(0b1010, 4), '0101');
  assert.equal(blockBits(0, 3), '000');
  const g = { w: P.one, x: 0b0001, z: 0b0100 };
  assert.equal(Pauli.formatString(g, 4), 'X⊗I⊗Z⊗I');
  assert.equal(blockBits(g.x, 4), '1000');
  assert.equal(blockBits(g.z, 4), '0010');
});

test('a generator comes out as a sign, never as an i', () => {
  // The strings are held as X^x Z^z and Y = i X Z, so a Y needs an i in the weight to
  // mean what it says. Printing that i in a tableau would be wrong: pay it back first.
  const y = { w: P.fromZ(Z.I), x: 1, z: 1 };            // i * X Z = Y on qubit 0
  const row = generatorRow(P.Ring, y, 1);
  assert.equal(row.string, 'Y');
  assert.equal(row.sign, '+', 'the i belonged to the Y, not to the sign');

  const minusY = { w: P.fromZ(Z.neg(Z.I)), x: 1, z: 1 };
  assert.equal(generatorRow(P.Ring, minusY, 1).sign, '−');

  assert.equal(generatorRow(P.Ring, { w: P.one, x: 1, z: 0 }, 1).sign, '+');
  assert.equal(generatorRow(P.Ring, { w: P.Ring.neg(P.one), x: 0, z: 1 }, 1).sign, '−');

  // Anything that is not a sign is handed back rather than dressed up as one.
  const odd = { w: P.fromZ(Z.zo(1, 0, 0, 0, 1)), x: 0, z: 1 };   // 1/sqrt(2) * Z
  assert.equal(generatorRow(P.Ring, odd, 1).sign, null);
});

test('every generator really does stabilize its node', () => {
  // The whole feature is worthless if the generators are wrong, and a plausible-looking
  // table is exactly how that would hide. So check the definition: P|v> = |v>.
  const cases = [
    ['GHZ', ghz(4), 4],
    ['cluster', cluster(4), 4],
    ['with a T', `${header(3)}h q[0];\ncx q[0],q[1];\nt q[2];\nh q[2];\n`, 3],
  ];
  for (const [name, qasm, n] of cases) {
    const { li, layout, last } = laidOut(qasm, zeros(n));
    for (const id of frameNodes(layout.frames[last])) {
      const level = li.levelOf(id);
      const vec = vectorOf(li, id, n);
      for (const g of li.stabilizers(id)) {
        // A node's group lives on the qubits at or below it, so nothing may touch the
        // ones above — that is what makes the shift below sound.
        const above = (1 << level) - 1;
        assert.equal((g.x | g.z) & above, 0, `${name}: ${Pauli.formatString(g, n)} reaches above node ${id}`);
        const shifted = { w: g.w, x: g.x >>> level, z: g.z >>> level };
        Pauli.apply(P.Ring, shifted, vec).forEach((v, b) => {
          assert.ok(P.Ring.eq(v, vec[b]),
            `${name}: node ${id} is not fixed by ${Pauli.formatString(g, n)} at |${b}>`);
        });
      }
    }
  }
});

test('GHZ is full rank at every node, and a T gate is not', () => {
  // Theorem 1 of the paper, read off the tableau: full rank means a stabilizer state,
  // which means a tower. This is the reading the whole feature exists to make possible,
  // so it is worth pinning to both a yes and a no.
  for (const n of [2, 3, 4, 5]) {
    const { li, layout, last } = laidOut(ghz(n), zeros(n));
    const ids = frameNodes(layout.frames[last]);
    assert.equal(ids.length, n + 1, `GHZ on ${n}: a tower of n + 1 nodes`);
    for (const id of ids) {
      const t = nodeTableau(li, id);
      assert.equal(t.rank, t.span, `GHZ on ${n}: node ${id} is short of full rank`);
      assert.equal(t.full, !t.terminal, `GHZ on ${n}: node ${id} mislabelled`);
    }
  }

  // A T gate leaves the stabilizer group behind, and the tableau has to say so.
  const { li, layout, last } = laidOut(`${header(2)}h q[0];\ncx q[0],q[1];\nt q[1];\n`, zeros(2));
  const shortfall = frameNodes(layout.frames[last])
    .map((id) => nodeTableau(li, id))
    .filter((t) => !t.terminal && t.rank < t.span);
  assert.ok(shortfall.length > 0, 'a non-stabilizer state should not read as full rank');
});

test('a stabilizer state is full rank at every node', () => {
  // This used to be the other way round: the cluster state came up one generator short at
  // every node, because the X and Y cases of Alg. 13 go through `LIMDD.isomorphism`, which
  // could not see that a branch reaching a node directly and one reaching it past a
  // skipped level are the same state. There are no skipped levels any more — a LIMDD here
  // carries a node on every level — so that gap is closed, and this guards it.
  for (const n of [3, 4, 5]) {
    const { li, layout, last } = laidOut(cluster(n), zeros(n));
    const ids = frameNodes(layout.frames[last]);
    assert.equal(ids.length, n + 1, `cluster on ${n}: a tower`);
    for (const t of ids.map((id) => nodeTableau(li, id))) {
      if (t.terminal) continue;
      assert.equal(t.rank, t.span, `cluster on ${n}: node ${t.id} is short of full rank`);
    }
  }
});

test('the listing follows the plate, and the tree collapses to distinct nodes', () => {
  const flat = laidOut(ghz(3), zeros(3));
  const flatIds = frameNodes(flat.layout.frames[flat.last]);
  assert.deepEqual(flatIds, flat.layout.frames[flat.last].nodes.map((nd) => nd.id),
    'in the diagram a position is a node, so the two agree');

  const tree = laidOut(ghz(3), zeros(3), { tree: true });
  const frame = tree.layout.frames[tree.last];
  const treeIds = frameNodes(frame);
  assert.ok(frame.nodes.length > treeIds.length,
    'the unfolded tree repeats nodes and the listing should not');
  assert.deepEqual([...new Set(treeIds)], treeIds, 'no node listed twice');
  // A position under a zero edge denotes nothing, and must not be asked about.
  assert.ok(frame.nodes.some((nd) => nd.src === null), 'GHZ has zero edges to skip');
  assert.ok(treeIds.every((id) => id !== null));
});

test('the structure says what the frame holds', () => {
  // The interface draws this and the text is written from it, so the assertions belong
  // here rather than against either rendering.
  const { li, layout, labels, last } = laidOut(ghz(3), zeros(3));
  const f = tableauFrame(li, layout, last, { qubitLabels: labels });
  assert.equal(f.step, 3);
  assert.equal(f.last, 3);
  assert.equal(f.qubits, 3);
  assert.equal(f.distinct, 4);
  assert.equal(f.positions, 4, 'in the diagram a position is a node');
  assert.equal(f.omitted, 0);
  assert.equal(f.short, false, 'GHZ is full rank throughout');
  assert.deepEqual(f.nodes.map((t) => t.where), ['q[0]', 'q[1]', 'q[2]', 'terminal']);
  assert.deepEqual(f.nodes.map((t) => t.rank), [3, 2, 1, 0]);
  // Each generator carries both presentations, and they have to agree.
  for (const t of f.nodes) {
    for (const r of t.rows) {
      assert.equal(r.letters.join('⊗'), r.string);
      assert.equal(r.letters.length, f.qubits);
      r.letters.forEach((ch, q) => {
        const expect = [['I', 'Z'], ['X', 'Y']][+r.x[q]][+r.z[q]];
        assert.equal(ch, expect, `${r.string}: qubit ${q} disagrees with the check vectors`);
      });
    }
  }
});

test('the text is the same frame, aligned, and carries no link', () => {
  const { li, layout, labels, last } = laidOut(ghz(3), zeros(3));
  const text = tableauText(li, layout, last, { qubitLabels: labels });
  assert.match(text, /^Pauli-LIMDD stabilizers · step 3 of 3\n/);
  assert.match(text, /3 qubits, columns in qubit order: q\[0\] q\[1\] q\[2\]/);
  assert.doesNotMatch(text, /diagram rows/, 'nothing to say when the order is the identity');
  assert.match(text, /4 nodes/);
  assert.match(text, /rank 3 of 3.*stabilizer state/, 'the root of a GHZ is a stabilizer state');
  assert.doesNotMatch(text, /proves nothing/, 'GHZ is full rank throughout, so no caveat');
  assert.match(text, /terminal.*trivial/);
  assert.match(text, /sign\s+x\s+z\s+generator/);
  assert.match(text, /X⊗X⊗X/, 'GHZ is stabilized by all-X');
  // A tableau is about a node, not about a page. Where the view came from belongs to the
  // state permalink and the figure exports, not here.
  assert.ok(!text.includes('http'), 'no link in a tableau');

  // Nothing non-ASCII beyond the few marks the tableau means to use: this text goes onto
  // a clipboard and into other people's files.
  const strays = [...text].filter((c) => c.charCodeAt(0) > 126 && !'·⊗−…'.includes(c));
  assert.deepEqual([...new Set(strays)], [], 'no unexpected characters');

  // Where a node is short of full rank the text says what that does and does not mean.
  // A T gate leaves the stabilizer formalism, so its rank really is short — the caveat is
  // about not reading that backwards.
  const t = laidOut(`${header(2)}h q[0];\ncx q[0],q[1];\nt q[1];\n`, zeros(2));
  const caveat = tableauText(t.li, t.layout, t.last, { qubitLabels: t.labels });
  assert.match(caveat, /full rank proves a stabilizer state and less than full rank proves nothing/);
  assert.equal(tableauFrame(t.li, t.layout, t.last, { qubitLabels: t.labels }).short, true);

  // Under an order the columns and the rows are different orders, and the text has to say
  // both — a tableau whose columns silently meant levels would be wrong, not just unclear.
  const order = [0, 2, 1];
  const rows = order.map((q) => labels[q]);
  const reordered = tableauText(li, layout, last,
    { qubitLabels: rows, names: labels, order, levelOf: [0, 2, 1] });
  assert.match(reordered, /columns in qubit order: q\[0\] q\[1\] q\[2\]/);
  assert.match(reordered, /diagram rows, top first: q\[0\] q\[2\] q\[1\]/);
  assert.equal(tableauFrame(li, layout, last, { order }).reordered, true);
  assert.equal(tableauFrame(li, layout, last, { order: [0, 1, 2] }).reordered, false);
});
