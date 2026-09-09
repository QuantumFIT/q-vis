// The qubit order: which qubit each level of the diagram decides.
//
// Every diagram here decides qubit q at level q, and that identity is a choice rather than
// a fact. In BDD terms it is *the* choice — the same function can be linear under one
// order and exponential under another — so it is a knob this tool has to have.
//
// An order is `atLevel`: `atLevel[level]` is the qubit decided at that level, top first.
// Its inverse is `levelOf`: `levelOf[qubit]` is where that qubit sits. Both are wanted, in
// different places, and confusing them is the one way to get this wrong — so they are
// named apart and so are the two directions a bit string can be permuted.
//
// Only the diagram is reordered. A ket and a Pauli string are always written in qubit
// order, so the rows of the picture move and the notation does not.

export class OrderError extends Error {}

export const identity = (n) => Array.from({ length: n }, (_, i) => i);

export const reversed = (n) => Array.from({ length: n }, (_, i) => n - 1 - i);

/**
 * `0, n-1, 1, n-2, …` — the order that brings qubit i next to qubit n-1-i. Exactly what a
 * state entangled in nested pairs wants, and what it costs to get it wrong is the point of
 * the `Nested Bell pairs` example.
 */
export function paired(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(i % 2 === 0 ? i / 2 : n - 1 - (i - 1) / 2);
  return out;
}

export const PRESETS = {
  written: { name: 'as written', of: identity },
  reversed: { name: 'reversed', of: reversed },
  paired: { name: 'paired', of: paired },
};

/** `levelOf` from `atLevel`, and back — the function is its own inverse in shape. */
export function invert(order) {
  const out = new Array(order.length);
  order.forEach((q, level) => { out[q] = level; });
  return out;
}

export const isIdentity = (order) => order.every((q, i) => q === i);

/** For the field, and — with a dash — for a link. */
export const format = (order, sep = ' ') => order.join(sep);

/**
 * An order from text: the qubits, top level first, separated by anything that is not a
 * digit. Every failure names itself, because a rejected order with no reason is worse than
 * no field at all.
 */
export function parse(text, n) {
  const parts = String(text).trim().split(/[^0-9]+/).filter((s) => s !== '');
  if (!parts.length) throw new OrderError('give the qubits in the order you want them, top first');
  const order = parts.map(Number);
  if (order.length !== n) {
    throw new OrderError(`${order.length} qubit${order.length === 1 ? '' : 's'} listed, `
      + `the circuit has ${n} — every qubit has to appear exactly once`);
  }
  const seen = new Set();
  for (const q of order) {
    if (q >= n) throw new OrderError(`there is no qubit ${q}: they run 0 to ${n - 1}`);
    if (seen.has(q)) throw new OrderError(`qubit ${q} appears twice; every qubit has to appear exactly once`);
    seen.add(q);
  }
  return order;
}

/**
 * A bit string written in qubit order, read in level order — which is what the diagram
 * wants when a `|0101>` becomes a path from the root.
 */
export function toLevels(byQubit, levelOf) {
  const out = new Array(levelOf.length);
  for (let q = 0; q < levelOf.length; q++) out[levelOf[q]] = byQubit[q];
  return typeof byQubit === 'string' ? out.join('') : out;
}

/**
 * The other direction: a path down the diagram, read as a ket. Every string the reader is
 * shown goes through here, so that the notation never depends on the order.
 */
export function toQubits(byLevel, levelOf) {
  const out = new Array(levelOf.length);
  for (let q = 0; q < levelOf.length; q++) out[q] = byLevel[levelOf[q]];
  return typeof byLevel === 'string' ? out.join('') : out;
}
