// The stabilizer tableau of a Pauli-LIMDD.
//
// Every node of a LIMDD carries the stabilizer group of the state it denotes — the group
// of Pauli strings P with P|v> = |v>. `LIMDD.stabilizers` already computes it (Alg. 13 of
// arXiv:2108.00931), because choosing a canonical label for a high edge means asking where
// two such groups meet. It is computed, used and thrown away; this module writes it down.
//
// It is worth writing down because it explains the shape of the diagram. A state on m
// qubits is a stabilizer state exactly when its group has m independent generators, and by
// the paper's Theorem 1 that is exactly when its LIMDD is a tower. So a node whose rank
// equals the number of qubits below it is the reason the diagram does not branch there.
//
// One asymmetry to be careful about, and the reason this module claims less than it might.
// What `LIMDD.stabilizers` returns is a subgroup of the true stabilizer group — every
// generator in it really does fix the node, but the search can miss some, because the X
// and Y cases of Alg. 13 go through `LIMDD.isomorphism`, which cannot see that a branch
// reaching a node directly and a branch reaching it past a skipped level are the same
// state. So full rank *proves* a stabilizer state; short of full rank proves nothing,
// since the shortfall may be the diagram's gap rather than the state's. See docs/LIMDD.md.
//
// Pure and DOM-free, like tikz.js. `tableauFrame` is the structure — what the tests assert
// against and what the interface draws — and `tableauText` is the same thing as aligned
// text, which is what the copy button hands over.

import * as Pauli from './pauli.js';

/** Past this many nodes a listing stops being something anyone reads. */
export const MAX_NODES = 200;

/** `(-i)^k`, which is the phase a printed Y owes back to the weight. */
function minusIPow(ring, k) {
  switch (k & 3) {
    case 0: return ring.one;
    case 1: return ring.i === undefined ? null : ring.neg(ring.i);
    case 2: return ring.neg(ring.one);
    default: return ring.i === undefined ? null : ring.i;
  }
}

/** A check vector block as bits, qubit 0 leftmost — the order `Pauli.formatString` uses. */
export function blockBits(mask, n) {
  let out = '';
  for (let q = 0; q < n; q++) out += (mask >> q) & 1;
  return out;
}

/**
 * One generator, ready to show. A stabilizer's weight can only be a fourth root of unity
 * here: the strings are held as `X^x Z^z`, and `Y = i X Z`, so a string with Y in it needs
 * an `i` in the weight to mean what it says. Pay that back — the same correction
 * `limLabel` makes for edge labels — and what is left is a sign, which is what belongs in
 * a tableau.
 *
 * If it is somehow not a sign, `sign` is null and the weight is handed back for printing.
 * Better an odd-looking tableau than a wrong one.
 */
export function generatorRow(ring, g, n) {
  const owed = Pauli.phaseShift(g);
  const fix = minusIPow(ring, owed);
  const w = fix === null ? g.w : ring.mul(g.w, fix);
  let sign = null;
  if (ring.eq(w, ring.one)) sign = '+';
  else if (ring.eq(w, ring.neg(ring.one))) sign = '−';
  return {
    sign,
    weight: w,
    x: blockBits(g.x, n),
    z: blockBits(g.z, n),
    letters: [...Pauli.formatString(g, n).split('⊗')],
    string: Pauli.formatString(g, n),
  };
}

/**
 * The tableau of one node: its generators, and the two numbers that say what the group
 * means — the rank, and the number of qubits the node's function spans, which is how many
 * generators a stabilizer state would have.
 */
export function nodeTableau(lim, id) {
  const n = lim.nvars;
  const terminal = lim.isTerminal(id);
  const gens = lim.stabilizers(id);
  const span = n - lim.levelOf(id);
  return {
    id,
    level: lim.levelOf(id),
    terminal,
    span,
    rank: gens.length,
    // The terminal denotes the scalar 1 on no qubits, which is vacuously full rank and
    // says nothing; only an internal node earns the label.
    full: !terminal && gens.length === span,
    rows: gens.map((g) => generatorRow(lim.ring, g, n)),
  };
}

/**
 * The distinct nodes of a frame, in the order they appear down the plate.
 *
 * `src` is the diagram's own node id. In the unfolded tree the same node stands in many
 * places and would otherwise be listed many times over, which is repetition without
 * information: the tableau is a property of the node, not of where it sits. Positions
 * under a zero edge have no state at all and carry `src === null`.
 */
export function frameNodes(frame) {
  const seen = new Set();
  const out = [];
  for (const nd of frame.nodes) {
    const id = nd.src;
    if (id === null || id === undefined || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * The whole frame, as data.
 * @param {object} lim the LIMDD the layout was built from
 * @param {object} layout as returned by layoutEdgeValued or layoutEdgeValuedTree
 * @param {number} index which frame
 * @param {object} [opts] `qubitLabels`
 */
export function tableauFrame(lim, layout, index, opts = {}) {
  const { qubitLabels = [] } = opts;
  const frame = layout.frames[index];
  const ids = frameNodes(frame);
  const shown = ids.slice(0, MAX_NODES);
  const nodes = shown.map((id) => {
    const t = nodeTableau(lim, id);
    return { ...t, where: t.terminal ? 'terminal' : (qubitLabels[t.level] ?? `level ${t.level}`) };
  });
  return {
    step: index,
    last: layout.frames.length - 1,
    qubits: lim.nvars,
    qubitLabels,
    nodes,
    distinct: ids.length,
    // How many places on the plate those nodes occupy, which differs only in the tree.
    positions: frame.nodes.filter((nd) => nd.src !== null && nd.src !== undefined).length,
    omitted: ids.length - shown.length,
    // Whether any node came up short, which is what the caveat is about.
    short: nodes.some((t) => !t.terminal && !t.full),
  };
}

const pad = (s, w) => s + ' '.repeat(Math.max(0, w - [...s].length));

/** The same frame as aligned text. A tableau is aligned text, and this is the copy path. */
export function tableauText(lim, layout, index, opts = {}) {
  const { formatWeight = () => '?' } = opts;
  const f = tableauFrame(lim, layout, index, opts);
  const n = f.qubits;
  const lines = [`Pauli-LIMDD stabilizers · step ${f.step} of ${f.last}`];
  if (f.qubitLabels.length) lines.push(`${n} qubits, qubit 0 first: ${f.qubitLabels.join(' ')}`);
  lines.push(f.distinct === f.positions
    ? `${f.distinct} node${f.distinct === 1 ? '' : 's'}`
    : `${f.distinct} distinct nodes in ${f.positions} tree positions`);
  lines.push('');

  for (const t of f.nodes) {
    const head = [`node ${t.id}`, t.where, `rank ${t.rank} of ${t.span}`, `|G| = 2^${t.rank}`];
    if (t.terminal) head.push('trivial');
    else if (t.full) head.push('stabilizer state');
    lines.push(head.join('  ·  '));

    if (!t.rows.length) {
      lines.push('    the identity alone');
    } else {
      const signs = t.rows.map((r) => r.sign ?? formatWeight(r.weight));
      // Every column keeps a two-space gap of its own, so the widest entry never runs
      // into the next heading — 'sign' is itself four characters wide.
      const signW = Math.max(4, ...signs.map((v) => [...v].length)) + 2;
      const blockW = Math.max(n, 1) + 2;
      lines.push('    ' + pad('sign', signW) + pad('x', blockW) + pad('z', blockW) + 'generator');
      t.rows.forEach((r, i) => {
        lines.push('    ' + pad(signs[i], signW) + pad(r.x, blockW) + pad(r.z, blockW) + r.string);
      });
    }
    lines.push('');
  }

  if (f.omitted) {
    lines.push(`… and ${f.omitted} more nodes, not listed`);
    lines.push('');
  }
  if (f.short) {
    lines.push('Every generator above fixes its node. The search can still miss some, so');
    lines.push('full rank proves a stabilizer state and less than full rank proves nothing.');
  }
  return lines.join('\n');
}
