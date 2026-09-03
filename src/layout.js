// Turning a sequence of diagrams into a sequence of drawings that read as one evolving
// picture rather than a slideshow of unrelated graphs.
//
// Levels give the y coordinate for free. The whole problem is the order of nodes within
// a level, and it has two conflicting requirements:
//
//   1. Within one frame the order should read naturally: low (0) branches to the left of
//      high (1) branches, so the diagram is scanned the same way as the ket.
//   2. Across frames a node that survives must not move, or the eye loses it and the
//      animation becomes noise.
//
// The resolution: (1) gives the ideal order for a frame, taken from a depth-first walk
// that follows low before high; (2) overrides it for nodes that were already on screen,
// which keep their previous relative order. New nodes are interpolated into the position
// the depth-first walk asks for, between whichever of their neighbours already have one.
//
// Nodes are hash-consed globally, so "the same node" across frames is just id equality.

/** Depth-first order, low branch first: the order in which a reader scans the diagram. */
export function scanOrder(dd, root) {
  const order = new Map();
  const stack = [root];
  // Iterative, with the high child pushed first so the low child is visited first.
  while (stack.length) {
    const id = stack.pop();
    if (order.has(id)) continue;
    order.set(id, order.size);
    if (!dd.isTerminal(id)) stack.push(dd.highOf(id), dd.lowOf(id));
  }
  return order;
}

/**
 * Order one level, honouring the previous frame's order for nodes that persist.
 * @param {number[]} ids nodes at this level, in scan order
 * @param {Map<number, number>} prevRank rank each node had in the previous frame
 * @returns {number[]} the ids in drawing order, left to right
 */
export function stableOrder(ids, prevRank) {
  const known = ids.map((id) => (prevRank.has(id) ? prevRank.get(id) : null));
  const ranks = known.slice();

  for (let i = 0; i < ids.length; i++) {
    if (ranks[i] !== null) continue;
    let p = i - 1;
    while (p >= 0 && known[p] === null) p--;
    let q = i + 1;
    while (q < ids.length && known[q] === null) q++;
    const before = p >= 0 ? known[p] : null;
    const after = q < ids.length ? known[q] : null;
    if (before === null && after === null) ranks[i] = i;                 // nothing persisted
    else if (before === null) ranks[i] = after - (q - i) / (q + 1);      // insert to the left
    else if (after === null) ranks[i] = before + (i - p) / (ids.length - p);
    else ranks[i] = before + ((after - before) * (i - p)) / (q - p);     // interpolate
  }

  return ids
    .map((id, i) => ({ id, rank: ranks[i], scan: i }))
    .sort((a, b) => (a.rank - b.rank) || (a.scan - b.scan))
    .map((e) => e.id);
}

/**
 * @typedef {object} FrameLayout
 * @property {number} index
 * @property {?object} gate
 * @property {{id:number, level:number, x:number, y:number, terminal:boolean, label:string, fresh:boolean}[]} nodes
 * @property {{from:number, to:number, high:boolean}[]} edges
 */

/**
 * Lay out every frame in one pass, in abstract units: x is a slot index centred on 0,
 * y is the level. Scaling to pixels is the renderer's business.
 *
 * @param {import('./dd.js').MTBDD} dd
 * @param {{index:number, gate:?object, root:number, added:number[]}[]} frames
 * @param {{qubitLabels?: string[]}} [opts]
 * @returns {{frames: FrameLayout[], width: number, height: number}}
 */
export function layoutFrames(dd, frames, opts = {}) {
  const labels = opts.qubitLabels || Array.from({ length: dd.nvars }, (_, i) => `q${i}`);
  const out = [];
  let prevRank = new Map();
  let width = 1;

  for (const frame of frames) {
    const scan = scanOrder(dd, frame.root);
    const byLevel = new Map();
    for (const id of scan.keys()) {
      const lev = dd.levelOf(id);
      if (!byLevel.has(lev)) byLevel.set(lev, []);
      byLevel.get(lev).push(id);
    }
    for (const ids of byLevel.values()) ids.sort((a, b) => scan.get(a) - scan.get(b));

    const rank = new Map();
    const nodes = [];
    // Frame 0 is the input state, not a change to it. Flagging every node there as new
    // would paint the whole opening diagram in the "just changed" colour and so make the
    // colour meaningless exactly where the reader first looks.
    const fresh = frame.index === 0 ? new Set() : new Set(frame.added || []);
    for (const [lev, ids] of [...byLevel].sort((a, b) => a[0] - b[0])) {
      // The zero terminal is a sink every diagram has; pinning it to the right keeps it
      // from shuffling the useful terminals around as the state changes.
      const zeroLast = ids.filter((id) => id !== dd.zero).concat(ids.filter((id) => id === dd.zero));
      const ordered = stableOrder(zeroLast, prevRank);
      width = Math.max(width, ordered.length);
      ordered.forEach((id, i) => {
        rank.set(id, i);
        const terminal = dd.isTerminal(id);
        nodes.push({
          id,
          level: lev,
          x: i - (ordered.length - 1) / 2,
          y: lev,
          terminal,
          label: terminal ? dd.ring.format(dd.valueOf(id)) : labels[lev],
          fresh: fresh.has(id),
        });
      });
    }

    const edges = [];
    for (const id of scan.keys()) {
      if (dd.isTerminal(id)) continue;
      edges.push({ from: id, to: dd.lowOf(id), high: false });
      edges.push({ from: id, to: dd.highOf(id), high: true });
    }

    out.push({ index: frame.index, gate: frame.gate, root: frame.root, nodes, edges, size: nodes.length });
    prevRank = rank;
  }

  return { frames: out, width, height: dd.nvars + 1 };
}
