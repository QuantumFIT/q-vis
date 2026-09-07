// Pauli-LIMDD: the edge-valued diagram of evdd.js, with a Pauli string on every edge.
//
// An edge is (w, P, node) and denotes `w * P * (what the node denotes)`. Two subfunctions
// are then shared whenever they are equal up to a scalar *and a local Pauli*, which is a
// much coarser equivalence than proportionality: every stabilizer state collapses to a
// single tower of n nodes, where the edge-valued diagram still branches.
//
// Vinkhuijzen et al., "LIMDD: A Decision Diagram for Simulation of Quantum Computing
// Including Stabilizer States", Quantum 7, 1108 (2023), arXiv:2108.00931. The reduction
// rules are their Def. 5 and the construction is their MakeEdge, Alg. 11.
//
// What differs here is the ring. Their labels carry an arbitrary complex scalar, so
// dividing by one is always allowed; Z[1/sqrt(2), i] is not a field, and 45% of the
// amplitudes in this project's own examples have no inverse in it. The two halves of a
// label therefore behave differently, and the split is clean:
//
//   - the Pauli string always factors out, because X, Z and their products are their own
//     inverses up to a sign. Every Pauli-side rule holds exactly as written.
//   - the scalar factors out only as far as evdd.js already manages, through the same
//     pluggable `normalise` rule.
//
// The limitation misses precisely the states that motivate the diagram: a stabilizer
// state's amplitudes are all +-1/sqrt(2)^n, whose unit part is the whole of them, so
// those are canonical here too. See docs/LIMDD.md.

import * as Pauli from './pauli.js';

export class LIMDD {
  /**
   * @param {object} ring the amplitude ring, as in dd.js
   * @param {number} nvars
   * @param {(low: object, high: object) => ({unit: any, inverse: any}|null)} [normalise]
   *   the scalar rule, shared with evdd.js
   */
  constructor(ring, nvars, normalise = () => null) {
    if (nvars > Pauli.MAX_QUBITS) {
      throw new Error(`the Pauli labels are 32-bit masks, so at most ${Pauli.MAX_QUBITS} qubits`);
    }
    this.ring = ring;
    this.nvars = nvars;
    this.normalise = normalise;
    /** @type {Array<{level:number, low:?object, high:?object}>} */
    this.nodes = [{ level: nvars, low: null, high: null }];   // node 0: the terminal, denoting 1
    this.unique = new Map();
    this.one = 0;
    this.zeroEdge = Object.freeze({ w: ring.zero, x: 0, z: 0, node: 0 });
  }

  isTerminal(id) { return this.nodes[id].low === null; }
  levelOf(id) { return this.nodes[id].level; }
  lowOf(id) { return this.nodes[id].low; }
  highOf(id) { return this.nodes[id].high; }

  edgeKey(e) { return `${this.ring.key(e.w)}.${e.x}.${e.z}@${e.node}`; }

  /** The reduced edge for `level` with the given child edges (MakeEdge, Alg. 11). */
  mk(level, e0, e1) {
    const R = this.ring;
    const zero0 = R.isZero(e0.w);
    const zero1 = R.isZero(e1.w);
    if (zero0 && zero1) return this.zeroEdge;
    // Identical child edges mean the variable is a don't-care, exactly as in dd.js.
    if (this.edgeKey(e0) === this.edgeKey(e1)) return e0;

    // Low precedence (rule 3), and the same swap when the low edge is zero so that rule 4
    // has something to factor. Paid for with an X on this level's qubit, which is what
    // exchanging the two branches means. Never swapped when the *high* edge is zero: rule
    // 2 below settles that case, and swapping there would bounce back and forth.
    if (zero0 || (!zero1 && e1.node < e0.node)) {
      const e = this.mk(level, e1, e0);
      return Object.freeze({ ...Pauli.mul(R, Pauli.xOn(R, level), e), node: e.node });
    }

    // Zero edges (rule 2): a zero high edge says nothing about where it points, so point
    // it back at the low child and label it with the identity.
    const high = zero1 ? { w: R.zero, x: 0, z: 0, node: e0.node } : e1;

    // Low factoring (rule 4). The Pauli half comes out in full: the low string is its own
    // inverse up to a sign, and moving it to the root means multiplying it into the high
    // label. The scalar half comes out only as far as the ring allows, through the same
    // rule the edge-valued diagram uses.
    const factor = this.normalise(e0, high);
    const unit = factor ? factor.unit : R.one;
    const inverse = factor ? factor.inverse : R.one;

    let hw = R.mul(high.w, inverse);
    // Two signs: one from inverting the low string, one from the product with the high one.
    if (Pauli.popcount(e0.x & e0.z) % 2) hw = R.neg(hw);
    if (Pauli.popcount(e0.z & high.x) % 2) hw = R.neg(hw);

    const low = { w: R.mul(e0.w, inverse), x: 0, z: 0, node: e0.node };
    // A zero edge is 0 whatever string it is given, so it gets the identity — otherwise
    // two nodes that differ only in a string nobody can observe would fail to merge.
    const semi = zero1
      ? { w: R.zero, x: 0, z: 0, node: low.node }
      : { w: hw, x: e0.x ^ high.x, z: e0.z ^ high.z, node: high.node };

    // High determinism (rule 5): swap the high label for the canonical one among those
    // that describe an isomorphic node, taking back whatever that costs on the root.
    const { high: chosen, root: broot } = this.highLabel(low, semi);

    const k = `${level}:${this.edgeKey(low)}:${this.edgeKey(chosen)}`;
    let id = this.unique.get(k);
    if (id === undefined) {
      id = this.nodes.length;
      this.nodes.push({ level, low: Object.freeze(low), high: Object.freeze(chosen) });
      this.unique.set(k, id);
    }
    // The root carries what low factoring took off, then the high rule's correction.
    const lowLim = { w: unit, x: e0.x, z: e0.z };
    return Object.freeze({ ...Pauli.mul(R, lowLim, broot), node: id });
  }

  /**
   * Which of the eligible high labels to use (high determinism, rule 5), and the root LIM
   * that keeps the state unchanged. Left alone here: the semi-reduced diagram takes the
   * label that low factoring produced. Overridden in canonical.js.
   */
  highLabel(low, high) {
    return { high, root: { w: this.ring.one, x: 0, z: 0 } };
  }

  /**
   * The same state as an MTBDD holds it. Simulation stays on dd.js; this is the state
   * seen the other way, which is all a visualiser needs and costs one pass.
   */
  fromMTBDD(dd, node, memo = new Map()) {
    const hit = memo.get(node);
    if (hit) return hit;
    let edge;
    if (dd.isTerminal(node)) {
      const value = dd.valueOf(node);
      edge = this.ring.isZero(value)
        ? this.zeroEdge
        : Object.freeze({ w: value, x: 0, z: 0, node: this.one });
    } else {
      edge = this.mk(dd.levelOf(node),
        this.fromMTBDD(dd, dd.lowOf(node), memo),
        this.fromMTBDD(dd, dd.highOf(node), memo));
    }
    memo.set(node, edge);
    return edge;
  }

  /**
   * The amplitude of one basis state. A Pauli label reroutes the walk as well as scaling
   * it: X^x Z^z |b> = (-1)^(z.b) |b XOR x>, so reading |b> from `A |v>` means reading
   * |b XOR x> from |v>, with a sign.
   */
  evaluate(edge, bits) {
    const b = typeof bits === 'string' ? [...bits].map(Number) : bits;
    let mask = 0;
    for (let q = 0; q < this.nvars; q++) if (b[q]) mask |= 1 << q;

    const R = this.ring;
    let w = R.one;
    let e = edge;
    for (;;) {
      const step = Pauli.preimage(e, mask);
      mask = step.bits;
      w = R.mul(w, e.w);
      if (step.negated) w = R.neg(w);
      if (R.isZero(w) || this.isTerminal(e.node)) return w;
      const lev = this.levelOf(e.node);
      e = ((mask >> lev) & 1) ? this.highOf(e.node) : this.lowOf(e.node);
    }
  }

  /** Every node reachable from an edge, the terminal included. */
  reachable(edge) {
    const seen = new Set();
    const stack = [edge.node];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      if (!this.isTerminal(id)) stack.push(this.lowOf(id).node, this.highOf(id).node);
    }
    return [...seen];
  }

  size(edge) { return this.reachable(edge).length; }
}
