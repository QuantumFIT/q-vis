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
 * @param {{qubitLabels?: string[], expand?: boolean,
 *   formatValue?: (v: any, frameIndex: number) => string}} [opts] the frame index is
 *   passed because a representation may factor something out per state — the algebraic
 *   tuple form writes every amplitude of one frame over a common denominator.
 * @returns {{frames: FrameLayout[], xMin: number, xMax: number, width: number, height: number}}
 */
export function layoutFrames(dd, frames, opts = {}) {
  const labels = opts.qubitLabels || Array.from({ length: dd.nvars }, (_, i) => `q${i}`);
  const show = opts.formatValue || ((v) => dd.ring.format(v));
  if (opts.expand) return layoutTrees(dd, frames, labels, show, opts.weighting);
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
          label: terminal ? show(dd.valueOf(id), frame.index) : labels[lev],
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
/**
 * Edge weights for an unreduced tree, normalised exactly as evdd.js normalises a shared
 * diagram: bottom-up, a node hands its parent the scalar it factored out and keeps what
 * is left on its own edges. An all-zero subtree hands up zero, so the edge into it reads
 * 0 rather than 1.
 *
 * @param {object} dd only for its ring
 * @param {any[]} values the amplitude of every basis state, in counting order
 * @returns {{weightOf: Map<number, [any, any]>, rootWeight: any}}
 */
export function treeEdgeWeights(dd, values, { ring, normalise }) {
  const n = Math.log2(values.length);
  const idOf = (level, path) => 2 ** level - 1 + path;
  const weightOf = new Map();
  const factor = (level, path) => {
    if (level === n) return values[path];
    const w0 = factor(level + 1, path * 2);
    const w1 = factor(level + 1, path * 2 + 1);
    const id = idOf(level, path);
    if (ring.isZero(w0) && ring.isZero(w1)) {
      weightOf.set(id, [w0, w1]);
      return ring.zero;
    }
    const f = normalise(ring.isZero(w0) ? w1 : w0);
    if (!f) {
      weightOf.set(id, [w0, w1]);
      return ring.one;
    }
    weightOf.set(id, [ring.mul(w0, f.inverse), ring.mul(w1, f.inverse)]);
    return f.unit;
  };
  return { weightOf, rootWeight: factor(0, 0) };
}

/**
 * @param {?{ring: object, normalise: Function}} weighting when given, the tree is drawn
 *   in the edge-valued style: weights on the edges, one terminal, normalised exactly as
 *   evdd.js does it — but with nothing shared, so the tree keeps its shape and shows
 *   what the sharing was worth.
 */
function layoutTrees(dd, frames, labels, show, weighting) {
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

    const weighted = weighting ? treeEdgeWeights(dd, values, weighting) : null;
    const weightOf = weighted && weighted.weightOf;
    const rootWeight = weighted && weighted.rootWeight;
    const weightKey = (id) => weightOf.get(id).map((w) => dd.ring.key(w)).join('|');

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
          // With weights on the edges there is no zero node: a zero subfunction is a
          // zero edge, and the subtree beneath it goes when that edge goes.
          zero: weighting ? false : zeroOnly[id],
          label: terminal ? (weighting ? '1' : show(value, frame.index)) : labels[level],
          // An unreduced tree never changes shape, so "new" can only mean that what it
          // carries is not what it was — an amplitude, or a pair of edge weights.
          fresh: prev !== null && (weighting
            ? !terminal && prev.weights.get(id) !== weightKey(id)
            : terminal && dd.ring.key(prev.values[path]) !== dd.ring.key(value)),
        });
        if (terminal) continue;
        for (const high of [false, true]) {
          const childPath = path * 2 + (high ? 1 : 0);
          const weight = weighting ? weightOf.get(id)[high ? 1 : 0] : null;
          edges.push({
            from: id,
            to: idOf(level + 1, childPath),
            high,
            toZero: weighting ? dd.ring.isZero(weight) : zeroOnly[idOf(level + 1, childPath)],
            // An edge of weight 1 is left unlabelled, as these diagrams are drawn.
            ...(weighting ? { label: show(weight, frame.index) === '1' ? '' : show(weight, frame.index) } : {}),
          });
        }
      }
    }

    out.push({
      index: frame.index, gate: frame.gate, root: idOf(0, 0), nodes, edges,
      size: nodes.length, changed: nodes.filter((nd) => nd.fresh).length,
      ...(weighting ? { rootWeight: show(rootWeight, frame.index) } : {}),
    });
    prev = weighting
      ? { weights: new Map([...weightOf.keys()].map((id) => [id, weightKey(id)])) }
      : { values };
  }

  return { frames: out, xMin: -leaves / 2 + 0.5, xMax: leaves / 2 - 0.5, width: leaves, height: n + 1 };
}

/**
 * Lay out the edge-valued form, where the amplitudes ride on the edges and there is a
 * single terminal. Same coordinate conventions as the reduced diagram, so the renderer
 * needs no special case beyond drawing the weights; what is new is that an edge carries
 * a label, and the state's overall factor sits on the root edge rather than anywhere in
 * the picture.
 *
 * @param {import('./evdd.js').EVDD} ev
 * @param {{index:number, gate:?object, edge:object}[]} frames
 * @param {string[]} labels qubit names
 * @param {(v: any, frameIndex: number) => string} show
 */
export function layoutEdgeValued(ev, frames, labels, show) {
  const out = [];
  let prevRank = new Map();
  let prevX = new Map();
  let prevNodes = new Set();
  let xMin = Infinity;
  let xMax = -Infinity;

  for (const frame of frames) {
    const root = frame.edge;
    // Scan order, low edge first, exactly as for the reduced diagram.
    const scan = new Map();
    const stack = [root.node];
    while (stack.length) {
      const id = stack.pop();
      if (scan.has(id)) continue;
      scan.set(id, scan.size);
      if (!ev.isTerminal(id)) stack.push(ev.highOf(id).node, ev.lowOf(id).node);
    }

    const byLevel = new Map();
    for (const id of scan.keys()) {
      const lev = ev.levelOf(id);
      if (!byLevel.has(lev)) byLevel.set(lev, []);
      byLevel.get(lev).push(id);
    }
    for (const ids of byLevel.values()) ids.sort((a, b) => scan.get(a) - scan.get(b));

    const rank = new Map();
    const nextX = new Map();
    const nodes = [];
    for (const [lev, ids] of [...byLevel].sort((a, b) => a[0] - b[0])) {
      const ordered = lev === ev.nvars ? ids : stableOrder(ids, prevRank);
      const centred = (ordered.length - 1) / 2;
      let offset = centred;
      const anchors = ordered.map((id, i) => [id, i]).filter(([id]) => prevX.has(id));
      if (anchors.length) {
        const [id, i] = anchors[anchors.length >> 1];
        offset = Math.max(centred - DRIFT_LIMIT, Math.min(centred + DRIFT_LIMIT, i - prevX.get(id)));
      }
      ordered.forEach((id, i) => {
        rank.set(id, i);
        const x = i - offset;
        nextX.set(id, x);
        xMin = Math.min(xMin, x);
        xMax = Math.max(xMax, x);
        const terminal = ev.isTerminal(id);
        nodes.push({
          id,
          level: lev,
          x,
          y: lev,
          terminal,
          // Nothing is a zero node here: a zero subfunction is a zero *edge*, and never
          // reaches a node at all.
          zero: false,
          label: terminal ? '1' : labels[lev],
          fresh: frame.index > 0 && !prevNodes.has(id),
        });
      });
    }

    const edges = [];
    for (const id of scan.keys()) {
      if (ev.isTerminal(id)) continue;
      for (const high of [false, true]) {
        const e = high ? ev.highOf(id) : ev.lowOf(id);
        const weight = show(e.w, frame.index);
        edges.push({
          from: id,
          to: e.node,
          high,
          toZero: ev.ring.isZero(e.w),
          // An unlabelled edge means a weight of 1, as decision diagrams are usually drawn.
          label: weight === '1' ? '' : weight,
        });
      }
    }

    out.push({
      index: frame.index,
      gate: frame.gate,
      root: root.node,
      rootWeight: show(root.w, frame.index),
      nodes,
      edges,
      size: nodes.length,
      changed: nodes.filter((nd) => nd.fresh).length,
    });
    prevRank = rank;
    prevX = nextX;
    prevNodes = new Set(scan.keys());
  }

  return { frames: out, xMin, xMax, width: xMax - xMin + 1, height: ev.nvars + 1 };
}
