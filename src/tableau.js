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
// since the shortfall may be the diagram's gap rather than the state's. The text says so
// wherever it comes up. See docs/LIMDD.md.
//
// Two presentations of each generator, because they answer different questions: the check
// vectors `x` and `z`, which are what the algebra manipulates, and the string of I/X/Y/Z,
// which is what the diagram's edge labels show.
//
// Pure and DOM-free, like tikz.js, so the interesting assertions can be made in Node.

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
 * One generator, ready to print. A stabilizer's weight can only be a fourth root of unity
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
  return { sign, weight: w, x: blockBits(g.x, n), z: blockBits(g.z, n), string: Pauli.formatString(g, n) };
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

const pad = (s, w) => s + ' '.repeat(Math.max(0, w - [...s].length));

/**
 * The whole frame as text.
 * @param {object} lim the LIMDD the layout was built from
 * @param {object} layout as returned by layoutEdgeValued or layoutEdgeValuedTree
 * @param {number} index which frame
 * @param {object} [opts] `qubitLabels`, `formatWeight` for the exceptional non-sign
 *   weight, and `link` — a URL, or a `{pinned, current}` pair — for where the view came from
 */
export function tableauText(lim, layout, index, opts = {}) {
  const { qubitLabels = [], formatWeight = () => '?', link } = opts;
  const links = !link ? [] : (typeof link === 'string' ? [link] : [link.pinned, link.current])
    .filter(Boolean);
  const frame = layout.frames[index];
  const n = lim.nvars;
  const ids = frameNodes(frame);
  const lines = [];

  lines.push(`Pauli-LIMDD stabilizers · step ${index} of ${layout.frames.length - 1}`);
  if (qubitLabels.length) {
    lines.push(`${n} qubits, qubit 0 first: ${qubitLabels.join(' ')}`);
  }
  const positions = frame.nodes.filter((nd) => nd.src !== null && nd.src !== undefined).length;
  lines.push(ids.length === positions
    ? `${ids.length} node${ids.length === 1 ? '' : 's'}`
    : `${ids.length} distinct nodes in ${positions} tree positions`);
  // Both the frozen copy of this build and the current page: see permalinkPair in ui.js.
  for (const url of links) lines.push(url);
  lines.push('');

  const shown = ids.slice(0, MAX_NODES);
  let short = false;
  for (const id of shown) {
    const t = nodeTableau(lim, id);
    const where = t.terminal ? 'terminal' : (qubitLabels[t.level] ?? `level ${t.level}`);
    const head = [`node ${id}`, where, `rank ${t.rank} of ${t.span}`, `|G| = 2^${t.rank}`];
    if (t.terminal) head.push('trivial');
    else if (t.full) head.push('stabilizer state');
    else short = true;
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

  if (ids.length > shown.length) {
    lines.push(`… and ${ids.length - shown.length} more nodes, not listed`);
    lines.push('');
  }
  if (short) {
    lines.push('Every generator above fixes its node. The search can still miss some, so');
    lines.push('full rank proves a stabilizer state and less than full rank proves nothing.');
  }
  return lines.join('\n');
}
