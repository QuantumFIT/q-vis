// Where an automaton's states go on the plate.
//
// A sibling of `layout.js` rather than a generalisation of it: the decision-diagram page
// is released and working, and a second consumer is not reason enough to reshape the
// thing it depends on. What the two share is the *output* — the same frame shape, so the
// renderer and, later, the TikZ export need learn nothing new.
//
// One thing here has no counterpart in a decision diagram. A DD node has a low child and
// a high child and that is the whole story; an automaton state has a *set* of (low, high)
// pairs, and which pair a run takes is a choice. So the two edges of one transition have
// to be readable as a pair — otherwise a state with three transitions is six loose lines
// and the picture says nothing about which of them go together.
//
// The notation is the one the tree-automata papers use, and the one AND/OR graphs have
// used for decades: the pair leaves the state at two *different* points and an arc is
// drawn across them near the source. This module does the part of that which is not
// pixels — it groups the edges by transition and fans their exit angles — and leaves the
// drawing to the renderer.
//
// `fanAngles` is also where a level-synchronized automaton will hang its choices: an arc
// is a better place to write one on than a bare edge ever was.

import { stableOrder } from './stable-order.js';

/** How far from straight down an edge may leave, in degrees, and how the fan widens. */
const MIN_SPREAD = 26;
const FAN_STEP = 12;
const FAN_LIMIT = 72;

/** A gap between two transitions, relative to the gap inside one. */
const GROUP_GAP = 1.7;

/**
 * Spread one state's outgoing edges around the bottom of its circle.
 *
 * Two rules, and they are the whole of it. Transitions are kept contiguous and ordered
 * left to right, so each one owns an angular sector and its arc cannot be confused with
 * its neighbour's. Within a transition the two edges are ordered by where they are going,
 * so neither pair crosses itself the moment it leaves the state — the dash pattern, not
 * the side, is what says which is the 0-edge.
 *
 * @param {number[][]} groups one array of wanted angles per transition, in degrees from
 *   straight down and positive to the right
 * @returns {number[][]} the angle to give each edge, in the shape it came in
 */
export function fanAngles(groups) {
  const order = groups
    .map((angles, g) => ({ g, mid: angles.reduce((a, b) => a + b, 0) / angles.length }))
    .sort((a, b) => a.mid - b.mid || a.g - b.g);

  const laid = [];
  let span = 0;
  for (const { g } of order) {
    groups[g]
      .map((want, i) => ({ g, i, want }))
      .sort((a, b) => a.want - b.want || a.i - b.i)
      .forEach((slot, i) => {
        if (laid.length) span += i === 0 ? GROUP_GAP : 1;
        laid.push({ ...slot, at: span });
      });
  }

  const spread = Math.min(FAN_LIMIT, MIN_SPREAD + FAN_STEP * (laid.length - 2));
  const out = groups.map((angles) => new Array(angles.length));
  for (const slot of laid) {
    out[slot.g][slot.i] = span ? -spread + (2 * spread * slot.at) / span : 0;
  }
  return out;
}

/**
 * Place things that each want to be somewhere in particular, keeping them apart.
 *
 * This is the arriving half of the same problem `fanAngles` solves for the leaving half,
 * and it is a different problem: an edge coming *in* belongs to no group, and where it
 * wants to arrive is wherever it is coming from. So each keeps as near to that as it can
 * while staying `gap` from its neighbours and inside ±`limit`, and the order they wanted
 * is the order they get — which is what stops one edge crossing another to get in.
 *
 * The units are the caller's: degrees around a state's rim, pixels along the top of an
 * amplitude box.
 *
 * @param {number[]} wanted where each would go if it were the only one
 * @param {{limit: number, gap: number}} room how far out they may sit, and how far apart
 * @returns {number[]} where each goes, in the order they came in
 */
export function spread(wanted, { limit, gap }) {
  const k = wanted.length;
  if (!k) return [];
  const clamp = (v) => Math.max(-limit, Math.min(limit, v));
  if (k === 1) return [clamp(wanted[0])];

  const step = Math.min(gap, (2 * limit) / (k - 1));
  const order = wanted.map((w, i) => i).sort((a, b) => wanted[a] - wanted[b] || a - b);

  // The i-th of k things, kept in order and `step` apart, cannot sit below -limit + i
  // steps nor above limit less the steps still to come. Clamping to *that* window before
  // pushing anything apart is what keeps the whole row inside the wall: the forward pass
  // can only raise a value to its predecessor plus a step, and the windows are exactly a
  // step apart, so it can never raise one past its own ceiling.
  const at = order.map((idx, i) => Math.max(-limit + i * step,
    Math.min(limit - (k - 1 - i) * step, wanted[idx])));
  const middle = (clamp(wanted[order[0]]) + clamp(wanted[order[k - 1]])) / 2;
  for (let i = 1; i < k; i++) at[i] = Math.max(at[i], at[i - 1] + step);

  // Pushing things apart drifts the whole row one way; put it back where it wanted to be,
  // as far as the walls allow. Both walls are reachable, so the two bounds cannot cross.
  const shift = Math.max(-limit - at[0],
    Math.min(limit - at[k - 1], middle - (at[0] + at[k - 1]) / 2));
  const out = new Array(k);
  order.forEach((idx, i) => { out[idx] = at[i] + shift; });
  return out;
}

/**
 * Lay out one automaton.
 *
 * @param {import('./aut-ta.js').TA} ta
 * @param {number} root
 * @param {object} opts
 * @param {(value: any) => string} opts.formatValue how a leaf amplitude is written
 * @param {Map<number, number>} [opts.prevRank] where each state sat last time, so that one
 *   which survives a gate stays where it was instead of being re-sorted around it
 * @returns {{nodes: object[], edges: object[], rank: Map<number, number>,
 *            xMin: number, xMax: number, width: number, height: number}}
 */
export function layoutAutomaton(ta, root, { formatValue, prevRank = new Map() } = {}) {
  const reachable = ta.reachable(root);

  // Depth-first, low before high, so that a first layout reads left to right the way the
  // tree does. `stableOrder` then keeps survivors put on every layout after the first.
  const scan = new Map();
  let seen = 0;
  const walk = (id) => {
    if (scan.has(id)) return;
    scan.set(id, seen++);
    for (const [low, high] of ta.transitionsOf(id)) { walk(low); walk(high); }
  };
  walk(root);

  const byRow = new Map();
  for (const id of reachable) {
    const row = ta.levelOf(id);
    if (!byRow.has(row)) byRow.set(row, []);
    byRow.get(row).push(id);
  }

  const nodes = [];
  const rank = new Map();
  let xMin = 0;
  let xMax = 0;
  for (const [row, ids] of [...byRow].sort((a, b) => a[0] - b[0])) {
    const sorted = stableOrder([...ids].sort((a, b) => scan.get(a) - scan.get(b)), prevRank);
    sorted.forEach((id, i) => {
      const x = i - (sorted.length - 1) / 2;
      rank.set(id, x);
      xMin = Math.min(xMin, x);
      xMax = Math.max(xMax, x);
      const leaf = ta.isLeaf(id);
      nodes.push({
        id,
        x,
        y: row,
        kind: leaf ? 'leaf' : 'state',
        terminal: leaf,
        label: leaf ? formatValue(ta.valueOf(id)) : `q${id}`,
        transitions: ta.transitionsOf(id).length,
        // A root state, in the automaton's sense: a tree is accepted when a run over it
        // ends in one. There is one here because `fromVectors` folds a set of states into
        // a single top state's transitions, but the field is a flag per node rather than
        // an id, because an automaton read from a file may mark several.
        root: id === root,
        fresh: !prevRank.has(id) && prevRank.size > 0,
      });
    });
  }

  // Two edges per transition, each carrying which transition it belongs to. That index is
  // what the renderer fans and arcs by, and it is the only thing a decision diagram's
  // edge does not already have.
  const edges = [];
  for (const id of reachable) {
    ta.transitionsOf(id).forEach(([low, high], transition) => {
      edges.push({ from: id, to: low, high: false, transition });
      edges.push({ from: id, to: high, high: true, transition });
    });
  }

  return {
    nodes,
    edges,
    rank,
    xMin,
    xMax,
    width: xMax - xMin,
    height: ta.nvars,
  };
}
