// Applying a unitary gate to a set of quantum states, and recording one frame per gate.
//
// The equation is the one in `sim.js`, unchanged:
//
//     psi'  =  sum_r  cube(qubits = r) * ( sum_c M[r][c] * psi|_{qubits = c} )
//
// and that is the point. The decision-diagram page applies a gate by splitting the state
// into the 2^k cofactors that fix the gate's qubits, recombining them by the matrix, and
// masking each new cofactor with the cube that selects its assignment. Every one of those
// operations — restrict, scale, add, multiply, cube — is a walk over a tree, and works
// the same on the perfect trees an automaton is built from. So the two engines are not
// merely consistent; they are the same formula, and any gate the other page can apply
// this one can apply too: any arity, any qubit order, any control pattern, no cases.
//
// Two things are genuinely different.
//
// **The trees are perfect.** An MTBDD skips a level whose value it does not depend on;
// here every branch is exactly n long. So `restrict` cannot delete the level it fixes —
// it replaces it with a node whose two children are the same, which is what "no longer
// depends on this qubit" has to look like when the shape is fixed. Everything else falls
// out unchanged.
//
// **A set is not a state.** The automaton accepts a set, and applying a gate to a set is
// applying it to every member. The members are the root's transitions: one per state in
// the set, because that is what `fromVectors` builds. So each is transformed on its own
// and the results are collected back into a root. Sharing survives it — two members that
// agree on a subtree still share it afterwards, because interning and the memo tables
// cannot help but notice.
//
// That decomposition is also where the limit of a *plain* tree automaton shows. Below the
// root every state here accepts exactly one tree, and the algebra needs that: `add` of
// two states walks them in lockstep, which only means anything when each has one run. A
// state with a real choice under it would need the two children of a transformed node to
// agree on which choice they took, and two sibling subtrees of a plain TA cannot agree on
// anything — that correlation is exactly what a level-synchronized automaton adds. So it
// is refused by name rather than quietly over-approximated.

import { GATES } from './gates.js';

/** How many automaton states a run may build before it is called off. */
export const STATE_BUDGET = 200000;

/**
 * The pointwise algebra on the perfect trees an automaton is built from.
 *
 * One per automaton and kept for the whole run, so the memo tables carry across gates:
 * most of what a gate touches, it has touched before.
 */
export class Algebra {
  constructor(ta) {
    this.ta = ta;
    this.ring = ta.ring;
    this.constants = new Map();
    this.sums = new Map();
    this.products = new Map();
    this.scalings = new Map();
    this.restrictions = new Map();
  }

  /** The tree that is `value` at every leaf, from `level` down. */
  constant(level, value) {
    const key = `${level}|${this.ring.key(value)}`;
    const had = this.constants.get(key);
    if (had !== undefined) return had;
    const made = level === this.ta.nvars
      ? this.ta.leaf(value)
      : (() => { const s = this.constant(level + 1, value); return this.ta.state(level, [[s, s]]); })();
    this.constants.set(key, made);
    return made;
  }

  /** Zero from `level` down — the tree every short-circuit below tests against. */
  zeroAt(level) { return this.constant(level, this.ring.zero); }

  /** The one transition of a state, or a refusal if it has a choice to make. */
  #only(id) {
    const out = this.ta.transitionsOf(id);
    if (out.length !== 1) {
      throw new Error('this state has more than one transition, and a gate cannot be '
        + 'applied to it: the two halves of a transformed node would each have to know '
        + 'which choice the other made. That is what a level-synchronized automaton is '
        + 'for, and it is not built yet');
    }
    return out[0];
  }

  /** Pointwise sum of two trees at the same level. */
  add(a, b) {
    const level = this.ta.levelOf(a);
    if (a === this.zeroAt(level)) return b;
    if (b === this.zeroAt(level)) return a;
    const key = a <= b ? `${a},${b}` : `${b},${a}`;      // pointwise sum commutes
    const had = this.sums.get(key);
    if (had !== undefined) return had;
    let made;
    if (this.ta.isLeaf(a)) {
      made = this.ta.leaf(this.ring.add(this.ta.valueOf(a), this.ta.valueOf(b)));
    } else {
      const [al, ah] = this.#only(a);
      const [bl, bh] = this.#only(b);
      made = this.ta.state(level, [[this.add(al, bl), this.add(ah, bh)]]);
    }
    this.sums.set(key, made);
    return made;
  }

  /** Pointwise product of two trees at the same level. */
  mul(a, b) {
    const level = this.ta.levelOf(a);
    const zero = this.zeroAt(level);
    if (a === zero || b === zero) return zero;
    const key = a <= b ? `${a},${b}` : `${b},${a}`;
    const had = this.products.get(key);
    if (had !== undefined) return had;
    let made;
    if (this.ta.isLeaf(a)) {
      made = this.ta.leaf(this.ring.mul(this.ta.valueOf(a), this.ta.valueOf(b)));
    } else {
      const [al, ah] = this.#only(a);
      const [bl, bh] = this.#only(b);
      made = this.ta.state(level, [[this.mul(al, bl), this.mul(ah, bh)]]);
    }
    this.products.set(key, made);
    return made;
  }

  /** Every leaf multiplied by one ring value. */
  scale(value, a) {
    const level = this.ta.levelOf(a);
    if (this.ring.isZero(value)) return this.zeroAt(level);
    if (this.ring.eq(value, this.ring.one)) return a;
    const key = `${this.ring.key(value)}|${a}`;
    const had = this.scalings.get(key);
    if (had !== undefined) return had;
    let made;
    if (this.ta.isLeaf(a)) {
      made = this.ta.leaf(this.ring.mul(value, this.ta.valueOf(a)));
    } else {
      const [lo, hi] = this.#only(a);
      made = this.ta.state(level, [[this.scale(value, lo), this.scale(value, hi)]]);
    }
    this.scalings.set(key, made);
    return made;
  }

  /**
   * The cofactor at `qubit = bit`, still as a tree over every variable.
   *
   * An MTBDD drops the level it fixes; a perfect tree cannot, so the level stays with
   * both of its children set to the branch that was kept. Same function, same shape.
   */
  restrict(a, qubit, bit) {
    const level = this.ta.levelOf(a);
    if (level > qubit) return a;
    const key = `${a}|${qubit}|${bit}`;
    const had = this.restrictions.get(key);
    if (had !== undefined) return had;
    const [lo, hi] = this.#only(a);
    const made = level === qubit
      ? this.ta.state(level, [[bit ? hi : lo, bit ? hi : lo]])
      : this.ta.state(level, [[this.restrict(lo, qubit, bit), this.restrict(hi, qubit, bit)]]);
    this.restrictions.set(key, made);
    return made;
  }

  /** One at the assignments where each of `qubits` takes its bit, zero elsewhere. */
  cube(qubits, bits) {
    const walk = (level) => {
      if (level === this.ta.nvars) return this.ta.leaf(this.ring.one);
      const at = qubits.indexOf(level);
      const rest = walk(level + 1);
      if (at < 0) return this.ta.state(level, [[rest, rest]]);
      const zero = this.zeroAt(level + 1);
      return this.ta.state(level, bits[at] ? [[zero, rest]] : [[rest, zero]]);
    };
    return walk(0);
  }
}

/**
 * Apply a k-qubit unitary to one quantum state, held as a deterministic tree.
 *
 * Line for line `sim.js`'s `applyGate`, with the decision diagram swapped for the
 * algebra above. If one of them is ever wrong, the difference will show.
 *
 * @param {Algebra} alg
 * @param {number} root a state whose subtree accepts exactly one tree
 * @param {number[]} qubits gate qubits, first one is the most significant matrix index
 * @param {Array<Array<any>>} matrix 2^k x 2^k over the *scalar* ring
 */
export function applyGate(alg, root, qubits, matrix) {
  const k = qubits.length;
  const dim = 1 << k;
  if (matrix.length !== dim) throw new Error(`gate on ${k} qubits needs a ${dim}x${dim} matrix`);
  if (new Set(qubits).size !== k) throw new Error(`repeated qubit in ${JSON.stringify(qubits)}`);
  for (const q of qubits) {
    if (!Number.isInteger(q) || q < 0 || q >= alg.ta.nvars) throw new Error(`qubit ${q} out of range`);
  }

  const bitsOf = (i) => qubits.map((_, j) => (i >> (k - 1 - j)) & 1);
  const M = matrix.map((row) => row.map((e) => alg.ring.fromScalar(e)));
  const zero = alg.zeroAt(0);

  const cof = [];
  for (let c = 0; c < dim; c++) {
    let cur = root;
    const bits = bitsOf(c);
    for (let j = 0; j < k; j++) cur = alg.restrict(cur, qubits[j], bits[j]);
    cof.push(cur);
  }

  let res = zero;
  for (let r = 0; r < dim; r++) {
    let acc = zero;
    for (let c = 0; c < dim; c++) {
      if (cof[c] === zero || alg.ring.isZero(M[r][c])) continue;
      acc = alg.add(acc, alg.scale(M[r][c], cof[c]));
    }
    if (acc === zero) continue;
    res = alg.add(res, alg.mul(alg.cube(qubits, bitsOf(r)), acc));
  }
  return res;
}

/**
 * Apply one circuit operation to every state in the set.
 *
 * The members of the set are the root's transitions. Each is lifted back into a root of
 * its own, transformed, and put back — so a gate moves every state the automaton accepts
 * and moves each of them the same way.
 */
export function applyOp(alg, root, op, levelOf = null) {
  const matrix = op.matrix || (GATES[op.name] && GATES[op.name].matrix);
  if (!matrix) throw new Error(`unknown gate '${op.name}'`);
  const at = levelOf ? op.qubits.map((q) => levelOf[q]) : op.qubits;
  const moved = alg.ta.transitionsOf(root)
    .map((pair) => applyGate(alg, alg.ta.state(0, [pair]), at, matrix));
  return alg.ta.state(0, moved.flatMap((m) => alg.ta.transitionsOf(m)));
}

/**
 * @typedef {object} Frame
 * @property {number} index          0 for the input set, i+1 after the i-th gate
 * @property {?object} gate          the gate just applied (null for the input set)
 * @property {number} root           the automaton's root state after that gate
 * @property {number} size           states reachable from it
 * @property {number} members        how many quantum states it accepts
 * @property {number[]} added        states present now but not in the previous frame
 * @property {number[]} removed      states present in the previous frame but not now
 */

/**
 * Run a circuit over a set of states, keeping every intermediate automaton.
 *
 * Nothing is freed and states are interned, so frames share everything unchanged between
 * them: keeping the whole history costs only the genuinely new states, and the diff
 * between consecutive frames is a set difference over ids. Which is what makes the
 * picture hold still from one gate to the next.
 *
 * @returns {Frame[]} one frame for the input set plus one per gate
 */
export function simulate(ta, initialRoot, circuit, levelOf = null) {
  const alg = new Algebra(ta);
  const frames = [];
  let prev = new Set();
  let root = initialRoot;

  const push = (index, gate) => {
    const now = new Set(ta.reachable(root));
    frames.push({
      index,
      gate,
      root,
      size: now.size,
      members: ta.transitionsOf(root).length,
      added: [...now].filter((s) => !prev.has(s)),
      removed: [...prev].filter((s) => !now.has(s)),
    });
    prev = now;
  };

  push(0, null);
  circuit.gates.forEach((g, i) => {
    root = applyOp(alg, root, g, levelOf);
    if (ta.states.length > STATE_BUDGET) {
      throw new Error(`the automaton passed ${STATE_BUDGET} states at gate ${i + 1} `
        + `(${g.name}), which is more than this page will draw`);
    }
    push(i + 1, g);
  });
  return frames;
}
