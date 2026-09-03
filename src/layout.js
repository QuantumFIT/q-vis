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

/** How far a level may sit from centred, in slots, before it is pulled back. */
const DRIFT_LIMIT = 1.5;

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
 * Lay out every frame in one pass, in abstract units: x is a slot index on a grid shared
 * by every frame, y is the level. Scaling to pixels is the renderer's business.
 *
 * @param {import('./dd.js').MTBDD} dd
 * @param {{index:number, gate:?object, root:number, added:number[]}[]} frames
 * @param {{qubitLabels?: string[], expand?: boolean, formatValue?: (v: any) => string}} [opts]
 * @returns {{frames: FrameLayout[], xMin: number, xMax: number, width: number, height: number}}
 */
export function layoutFrames(dd, frames, opts = {}) {
  const labels = opts.qubitLabels || Array.from({ length: dd.nvars }, (_, i) => `q${i}`);
  const show = opts.formatValue || ((v) => dd.ring.format(v));
  if (opts.expand) return layoutTrees(dd, frames, labels, show);
  const out = [];
  let prevRank = new Map();
  let prevX = new Map();
  let xMin = Infinity;
  let xMax = -Infinity;

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
    const nextX = new Map();
    const nodes = [];
    // Frame 0 is the input state, not a change to it. Flagging every node there as new
    // would paint the whole opening diagram in the "just changed" colour and so make the
    // colour meaningless exactly where the reader first looks.
    const fresh = frame.index === 0 ? new Set() : new Set(frame.added || []);
    for (const [lev, ids] of [...byLevel].sort((a, b) => a[0] - b[0])) {
      // The zero terminal is a sink every diagram has; pinning it to the right keeps it
      // from shuffling the useful terminals around as the state changes.
      const zeroLast = ids.filter((id) => id !== dd.zero).concat(ids.filter((id) => id === dd.zero));
      // Internal nodes are anonymous, so their position *is* their identity and it must
      // persist. Terminals carry their value as a label, so a reader finds "(1-i)/4" by
      // reading it, not by remembering where it was — which frees the terminal row to be
      // ordered for legibility instead. Following the scan there removes the edge
      // crossings that stability would otherwise force after a gate reshuffles the tree
      // above a set of terminals that all persisted (a SWAP does exactly this).
      const ordered = lev === dd.nvars ? zeroLast : stableOrder(zeroLast, prevRank);

      // Where the level sits horizontally. Centring each level independently means every
      // node in it shifts by half a slot whenever the level gains or loses one, so the
      // whole diagram twitches on every step even where nothing structural changed.
      // Instead the level is anchored on a node that was already on screen, which keeps
      // survivors exactly where they were. The drift limit stops a long circuit from
      // slowly walking the diagram off to one side.
      const centred = (ordered.length - 1) / 2;
      let offset = centred;
      const anchors = ordered.map((id, i) => [id, i]).filter(([id]) => prevX.has(id));
      if (anchors.length) {
        const [id, i] = anchors[anchors.length >> 1];
        offset = i - prevX.get(id);
        offset = Math.max(centred - DRIFT_LIMIT, Math.min(centred + DRIFT_LIMIT, offset));
      }

      ordered.forEach((id, i) => {
        rank.set(id, i);
        const x = i - offset;
        nextX.set(id, x);
        xMin = Math.min(xMin, x);
        xMax = Math.max(xMax, x);
        const terminal = dd.isTerminal(id);
        nodes.push({
          id,
          level: lev,
          x,
          y: lev,
          terminal,
          zero: id === dd.zero,
          label: terminal ? show(dd.valueOf(id)) : labels[lev],
          fresh: fresh.has(id),
        });
      });
    }

    const edges = [];
    for (const id of scan.keys()) {
      if (dd.isTerminal(id)) continue;
      edges.push({ from: id, to: dd.lowOf(id), high: false, toZero: dd.lowOf(id) === dd.zero });
      edges.push({ from: id, to: dd.highOf(id), high: true, toZero: dd.highOf(id) === dd.zero });
    }

    out.push({
      index: frame.index, gate: frame.gate, root: frame.root, nodes, edges,
      size: nodes.length, changed: nodes.filter((nd) => nd.fresh).length,
    });
    prevRank = rank;
    prevX = nextX;
  }

  // The grid every frame shares, so the renderer never rescales or recentres mid-circuit.
  return { frames: out, xMin, xMax, width: xMax - xMin + 1, height: dd.nvars + 1 };
}

/**
 * The unreduced decision tree: the same function drawn without any sharing and without
 * skipping a level, so a reader can see what the reduction actually bought. Every state
 * on n qubits gives the same complete tree of 2^(n+1)-1 nodes, so nothing here moves
 * between frames — the only thing that changes is which amplitudes sit at the leaves,
 * and those are what get marked when a gate changes them.
 */
function layoutTrees(dd, frames, labels, show) {
  const n = dd.nvars;
  const leaves = 2 ** n;
  const idOf = (level, path) => 2 ** level - 1 + path;
  // Each node sits above the centre of the subtree it heads, which is what makes a tree
  // drawing readable; leaves land one slot apart.
  const xOf = (level, path) => (path + 0.5) * 2 ** (n - level) - leaves / 2;

  const out = [];
  let prev = null;
  for (const frame of frames) {
    const values = [];
    for (let p = 0; p < leaves; p++) {
      values.push(dd.evaluate(frame.root, p.toString(2).padStart(n, '0')));
    }

    // A node counts as zero when everything under it is zero, not just when it is the
    // zero leaf itself. In a reduced diagram those subtrees collapse into the single 0
    // terminal; a tree keeps them, and they are pure scaffolding — so they dim together
    // and hide together, leaving exactly the paths the state actually occupies.
    const zeroOnly = new Array(2 ** (n + 1) - 1);
    for (let p = 0; p < leaves; p++) zeroOnly[idOf(n, p)] = dd.ring.isZero(values[p]);
    for (let level = n - 1; level >= 0; level--) {
      for (let path = 0; path < 2 ** level; path++) {
        zeroOnly[idOf(level, path)] =
          zeroOnly[idOf(level + 1, path * 2)] && zeroOnly[idOf(level + 1, path * 2 + 1)];
      }
    }

    const nodes = [];
    const edges = [];
    for (let level = 0; level <= n; level++) {
      for (let path = 0; path < 2 ** level; path++) {
        const id = idOf(level, path);
        const terminal = level === n;
        const value = terminal ? values[path] : null;
        nodes.push({
          id,
          level,
          x: xOf(level, path),
          y: level,
          terminal,
          zero: zeroOnly[id],
          label: terminal ? show(value) : labels[level],
          // An unreduced tree never changes shape, so "new" can only mean "this
          // amplitude is not what it was before this gate".
          fresh: terminal && prev !== null && dd.ring.key(prev[path]) !== dd.ring.key(value),
        });
        if (terminal) continue;
        for (const high of [false, true]) {
          const childPath = path * 2 + (high ? 1 : 0);
          edges.push({
            from: id,
            to: idOf(level + 1, childPath),
            high,
            toZero: zeroOnly[idOf(level + 1, childPath)],
          });
        }
      }
    }

    out.push({
      index: frame.index, gate: frame.gate, root: idOf(0, 0), nodes, edges,
      size: nodes.length, changed: nodes.filter((nd) => nd.fresh).length,
    });
    prev = values;
  }

  return { frames: out, xMin: -leaves / 2 + 0.5, xMax: leaves / 2 - 0.5, width: leaves, height: n + 1 };
}
