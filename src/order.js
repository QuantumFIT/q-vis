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

/**
 * For the field and the summary, in the circuit's own names — `q[0] q[2] q[1] b[0]`.
 *
 * Bare indices are what the order *is*, but they are not what a reader has to work with.
 * A circuit may declare several registers, which are flattened into one run of qubits, so
 * `qreg q[3]; qreg b[1];` makes `b[0]` the qubit at index 3 and `0 2 1 3` says nothing
 * about which qubit is which. Given the labels, this writes them out.
 */
export const format = (order, labels = null, sep = ' ') =>
  order.map((q) => (labels && labels[q] !== undefined ? labels[q] : q)).join(sep);

/** The indices, for a link: compact, and not invalidated by editing a register's name. */
export const formatIndices = (order, sep = '-') => order.join(sep);

/** Already an array of indices — check it is a permutation of this circuit's qubits. */
export function validate(order, n, labels = null) {
  const name = (q) => (labels && labels[q] !== undefined ? labels[q] : `qubit ${q}`);
  if (!Array.isArray(order) || !order.length) {
    throw new OrderError('give the qubits in the order you want them, top first');
  }
  if (order.length !== n) {
    throw new OrderError(`${order.length} qubit${order.length === 1 ? '' : 's'} listed, `
      + `the circuit has ${n} — every qubit has to appear exactly once`);
  }
  const seen = new Set();
  for (const q of order) {
    if (!Number.isInteger(q) || q < 0 || q >= n) {
      throw new OrderError(`there is no qubit ${q}: this circuit has ${n}, `
        + `${labels ? `${labels[0]} to ${labels[n - 1]}` : `0 to ${n - 1}`}`);
    }
    if (seen.has(q)) {
      throw new OrderError(`${name(q)} appears twice; every qubit has to appear exactly once`);
    }
    seen.add(q);
  }
  return order;
}

/**
 * An order from text: the qubits, top level first. Each may be written the way the circuit
 * writes it — `q[0]`, `b[0]` — or as a bare index into the flattened run of qubits, which
 * is the same thing when there is only one register. Separated by spaces, commas or
 * dashes, so what a link carries parses too.
 *
 * Every failure names itself, because a rejected order with no reason is worse than no
 * field at all.
 */
export function parse(text, n, labels = null) {
  const tokens = String(text).trim().split(/[\s,;-]+/).filter((t) => t !== '');
  if (!tokens.length) throw new OrderError('give the qubits in the order you want them, top first');

  const byLabel = new Map();
  if (labels) labels.forEach((label, q) => byLabel.set(label.toLowerCase(), q));

  const order = tokens.map((token) => {
    if (/^\d+$/.test(token)) return Number(token);
    const hit = byLabel.get(token.toLowerCase());
    if (hit !== undefined) return hit;
    // Name what is on offer: with several registers a reader cannot guess the spelling.
    const known = labels ? labels.join(' ') : `0 to ${n - 1}`;
    throw new OrderError(`'${token}' is not a qubit of this circuit. It has ${known}`);
  });
  return validate(order, n, labels);
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
