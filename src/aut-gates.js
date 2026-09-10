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
// **A set is not a state, and the colours are what keep it one thing.** Every operation
// below is the same product: pair the two automata's transitions, intersect their
// colours, and recurse. Under one colouring the automaton is an ordinary tree and the
// product is ordinary arithmetic on it; over all colourings it is the whole set at once.
// So a gate never takes the set apart, and the sharing an automaton was built for
// survives it — which is the entire reason a level-synchronized automaton exists.
//
// The correlation a mixing gate needs falls out of this for free. `restrict` gives the
// cofactors, and adding two of them pairs their transitions by colour: under a colouring
// each cofactor has exactly one run, so the two halves of a transformed node are the two
// halves of the *same* tree. In a plain automaton they were not, and the only exact
// answer was to enumerate the members.
//
// That "exactly one run under a colouring" is the invariant the whole construction rests
// on, so `applyGate` checks it rather than assuming it. It holds by how the colours are
// made: `fromVectors` paints one colour per member and a member is a single tree, so the
// alternatives a state offers are painted with disjoint sets; `reduce` unites states no
// member shares, which keeps them disjoint; and a product of two automata that each have
// one run has one run. See `colourDeterministic`.

import { GATES } from './gates.js';
import { ANY, meet } from './aut-lsta.js';
import { reduce } from './aut-reduce.js';

/** A combination that exists under no colouring, and so is no state at all. */
const DEAD = -1;

/** How many automaton states a run may build before it is called off. */
export const STATE_BUDGET = 200000;

/**
 * A colouring under which some state could take two steps at once.
 *
 * The gate construction needs each colouring to pick out one tree, because that is what
 * makes the two cofactors it adds two halves of the same one. Reported as the state and
 * the colour rather than as a bare false, since if this ever fires the interesting
 * question is which colour stopped telling two things apart.
 */
export function colourDeterministic(ta, root) {
  for (const id of ta.reachable(root)) {
    if (ta.isLeaf(id)) continue;
    const steps = ta.transitionsOf(id);
    if (steps.length < 2) continue;
    const anys = steps.filter(([, , c]) => c === ANY).length;
    if (anys > 1 || (anys && steps.length > 1)) return { state: id, colour: ANY };
    const seen = new Set();
    for (const [, , choice] of steps) {
      for (const c of choice) {
        if (seen.has(c)) return { state: id, colour: c };
        seen.add(c);
      }
    }
  }
  return null;
}

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

  /**
   * The two automata, paired step by step and colour by colour.
   *
   * The one shape everything below is: for each way `a` may step and each way `b` may
   * step, a step of the product admitted under exactly the colours that admit both, with
   * the children paired the same way. `DEAD` when no pair survives — a combination that
   * exists under no colouring at all — and a step to a dead child is simply not a step.
   */
  #pair(a, b, cache, leaves, combine) {
    const level = this.ta.levelOf(a);
    const key = `${a},${b}`;
    const had = cache.get(key);
    if (had !== undefined) return had;
    let made;
    if (this.ta.isLeaf(a)) {
      made = this.ta.leaf(leaves(this.ta.valueOf(a), this.ta.valueOf(b)));
    } else {
      const steps = [];
      for (const [al, ah, ac] of this.ta.transitionsOf(a)) {
        for (const [bl, bh, bc] of this.ta.transitionsOf(b)) {
          const choice = meet(ac, bc);
          if (choice !== ANY && !choice.length) continue;
          const low = combine(al, bl);
          const high = combine(ah, bh);
          if (low === DEAD || high === DEAD) continue;
          steps.push([low, high, choice]);
        }
      }
      made = steps.length ? this.ta.state(level, steps) : DEAD;
    }
    cache.set(key, made);
    return made;
  }

  /** Pointwise sum of two automata: under any colouring, of the two trees they are. */
  add(a, b) {
    const level = this.ta.levelOf(a);
    if (a === this.zeroAt(level)) return b;
    if (b === this.zeroAt(level)) return a;
    return this.#pair(a, b, this.sums, (x, y) => this.ring.add(x, y), (x, y) => this.add(x, y));
  }

  /** Pointwise product, the same way. */
  mul(a, b) {
    const level = this.ta.levelOf(a);
    const zero = this.zeroAt(level);
    if (a === zero || b === zero) return zero;
    return this.#pair(a, b, this.products, (x, y) => this.ring.mul(x, y), (x, y) => this.mul(x, y));
  }

  /** Every leaf multiplied by one ring value. The colours are untouched: no choice moved. */
  scale(value, a) {
    const level = this.ta.levelOf(a);
    if (this.ring.isZero(value)) return this.zeroAt(level);
    if (this.ring.eq(value, this.ring.one)) return a;
    const key = `${this.ring.key(value)}|${a}`;
    const had = this.scalings.get(key);
    if (had !== undefined) return had;
    const made = this.ta.isLeaf(a)
      ? this.ta.leaf(this.ring.mul(value, this.ta.valueOf(a)))
      : this.ta.state(level, this.ta.transitionsOf(a)
        .map(([lo, hi, c]) => [this.scale(value, lo), this.scale(value, hi), c]));
    this.scalings.set(key, made);
    return made;
  }

  /**
   * The cofactor at `qubit = bit`, still as a tree over every variable.
   *
   * An MTBDD drops the level it fixes; a perfect tree cannot, so the level stays with
   * both of its children set to the branch that was kept — and keeps its colour, so the
   * two cofactors of one automaton still agree about which run they came from. That
   * agreement is the whole point: it is what makes adding them exact.
   */
  restrict(a, qubit, bit) {
    const level = this.ta.levelOf(a);
    if (level > qubit) return a;
    const key = `${a}|${qubit}|${bit}`;
    const had = this.restrictions.get(key);
    if (had !== undefined) return had;
    const made = this.ta.state(level, this.ta.transitionsOf(a).map(([lo, hi, c]) => {
      const kept = bit ? hi : lo;
      return level === qubit
        ? [kept, kept, c]
        : [this.restrict(lo, qubit, bit), this.restrict(hi, qubit, bit), c];
    }));
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
 * @param {number} root the automaton, whose colours must pick out one tree each
 * @param {number[]} qubits gate qubits, first one is the most significant matrix index
 * @param {Array<Array<any>>} matrix 2^k x 2^k over the *scalar* ring
 */
export function applyGate(alg, root, qubits, matrix) {
  const loose = colourDeterministic(alg.ta, root);
  if (loose) {
    throw new Error(`state ${loose.state} can take two steps under one colour, so the two `
      + 'halves of a transformed node would not be halves of the same tree. A gate needs '
      + 'the colours to pick out a run, and here they do not');
  }
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
 * Apply one circuit operation to the whole set at once.
 *
 * One call. The set is never taken apart, because the colours hold it together, and that
 * is the difference between this and what a plain tree automaton could do.
 */
export function applyOp(alg, root, op, levelOf = null) {
  const matrix = op.matrix || (GATES[op.name] && GATES[op.name].matrix);
  if (!matrix) throw new Error(`unknown gate '${op.name}'`);
  const at = levelOf ? op.qubits.map((q) => levelOf[q]) : op.qubits;
  return applyGate(alg, root, at, matrix);
}

/**
 * @typedef {object} Frame
 * @property {number} index          0 for the input set, i+1 after the i-th gate
 * @property {?object} gate          the gate just applied (null for the input set)
 * @property {number} root           the reduced automaton after that gate
 * @property {number} size           states reachable from it
 * @property {number} expanded       states it took before the reduction — what the
 *                                   merge and the recolouring between them saved
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
  let root = reduce(ta, initialRoot);

  // A unitary is a bijection on the set, so how many states it holds is settled once.
  const members = ta.language(initialRoot).length;

  const push = (index, gate, expanded) => {
    const now = new Set(ta.reachable(root));
    frames.push({
      index,
      gate,
      root,
      size: now.size,
      expanded,
      members,
      added: [...now].filter((s) => !prev.has(s)),
      removed: [...prev].filter((s) => !now.has(s)),
    });
    prev = now;
  };

  push(0, null, ta.size(initialRoot));
  circuit.gates.forEach((g, i) => {
    // Transform, reduce — and the next gate starts from what came out. There is no
    // expansion any more: the colours carry the correlation a gate needs, so the set
    // goes through whole and the sharing found once is never paid for twice.
    const wide = applyOp(alg, root, g, levelOf);
    root = reduce(ta, wide);
    if (ta.states.length > STATE_BUDGET) {
      throw new Error(`the automaton passed ${STATE_BUDGET} states at gate ${i + 1} `
        + `(${g.name}), which is more than this page will draw`);
    }
    push(i + 1, g, ta.size(wide));
  });
  return frames;
}
