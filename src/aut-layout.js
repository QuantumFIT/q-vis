// Where an automaton's states go on the plate.
//
// A sibling of `layout.js` rather than a generalisation of it: the decision-diagram page
// is released and working, and a second consumer is not reason enough to reshape the
// thing it depends on. What the two share is the *output* — the same frame shape, so the
// renderer and, later, the TikZ export need learn nothing new.
//
// One thing is drawn here that has no counterpart in a decision diagram. A DD node has a
// low child and a high child and that is the whole story; an automaton state has a *set*
// of (low, high) pairs, and which pair a run takes is a choice. So a transition is drawn
// as an object in its own right — a small junction between the state and the pair it
// leads to — and a state with only one transition has it suppressed, so a deterministic
// automaton looks exactly like the diagram it is.
//
// That junction is also where a level-synchronized automaton will hang its choices.

import { stableOrder } from './stable-order.js';

/** Junctions sit between their level and the next, close enough to read as belonging. */
const JUNCTION_DROP = 0.42;

/** A transition's identity: the state it leaves and the pair it goes to. */
const junctionId = (from, low, high) => `${from}>${low},${high}`;

/**
 * Lay out one automaton.
 *
 * @param {import('./aut-ta.js').TA} ta
 * @param {number} root
 * @param {object} opts
 * @param {(value: any) => string} opts.formatValue how a leaf amplitude is written
 * @param {Map<string, number>} [opts.prevRank] where each node sat last time, so that a
 *   state which survives a gate stays where it was instead of being re-sorted around it
 * @returns {{nodes: object[], edges: object[], rank: Map<string, number>,
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
  const addTo = (row, id) => {
    if (!byRow.has(row)) byRow.set(row, []);
    byRow.get(row).push(id);
  };
  for (const id of reachable) {
    addTo(ta.levelOf(id), String(id));
    const transitions = ta.transitionsOf(id);
    if (transitions.length > 1) {
      for (const [low, high] of transitions) {
        addTo(ta.levelOf(id) + JUNCTION_DROP, junctionId(id, low, high));
      }
    }
  }

  const orderOf = (key) => {
    const via = key.indexOf('>');
    return scan.get(Number(via < 0 ? key : key.slice(0, via))) ?? 0;
  };

  const nodes = [];
  const rank = new Map();
  let xMin = 0;
  let xMax = 0;
  for (const [row, ids] of [...byRow].sort((a, b) => a[0] - b[0])) {
    const sorted = stableOrder(
      [...ids].sort((a, b) => orderOf(a) - orderOf(b) || (a < b ? -1 : 1)),
      prevRank,
    );
    sorted.forEach((key, i) => {
      const x = i - (sorted.length - 1) / 2;
      rank.set(key, x);
      xMin = Math.min(xMin, x);
      xMax = Math.max(xMax, x);
      const isJunction = key.includes('>');
      const id = isJunction ? key : Number(key);
      nodes.push({
        id: key,
        x,
        y: row,
        kind: isJunction ? 'junction' : (ta.isLeaf(id) ? 'leaf' : 'state'),
        terminal: !isJunction && ta.isLeaf(id),
        label: isJunction ? '' : (ta.isLeaf(id) ? formatValue(ta.valueOf(id)) : `q${id}`),
        fresh: !prevRank.has(key) && prevRank.size > 0,
      });
    });
  }

  const edges = [];
  for (const id of reachable) {
    const transitions = ta.transitionsOf(id);
    const direct = transitions.length === 1;
    for (const [low, high] of transitions) {
      const via = direct ? String(id) : junctionId(id, low, high);
      if (!direct) edges.push({ from: String(id), to: via, kind: 'stem' });
      edges.push({ from: via, to: String(low), high: false, kind: 'child' });
      edges.push({ from: via, to: String(high), high: true, kind: 'child' });
    }
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
