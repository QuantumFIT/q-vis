// Edge-valued decision diagram: the same states as dd.js, but with the amplitudes on the
// edges instead of in the terminals.
//
// An edge is a pair (weight, node) denoting `weight * (what the node denotes)`, there is
// one terminal denoting 1, and the state's overall factor rides on a root edge. Two
// subfunctions are then shared whenever they are equal *up to a scalar*, which is what
// circuits produce — a gate multiplies subfunctions by phases.
//
// Canonicity needs a rule for which scalar to push up the edge, and every textbook rule
// divides. Z[1/sqrt(2), i] is not a field (3 and 1+2i have no inverse), so the rule is a
// parameter: `normalise` is handed the weight to factor by and returns a unit and its
// inverse, or null to leave the weights alone. See docs/EVDD.md.

const TERMINAL = -1;

export class EVDD {
  /**
   * @param {object} ring the amplitude ring, as in dd.js
   * @param {number} nvars
   * @param {(w: any) => ({unit: any, inverse: any}|null)} [normalise]
   */
  constructor(ring, nvars, normalise = () => null) {
    this.ring = ring;
    this.nvars = nvars;
    this.normalise = normalise;
    /** @type {Array<{level:number, low:?object, high:?object}>} */
    this.nodes = [{ level: nvars, low: null, high: null }];   // node 0: the terminal, denoting 1
    this.unique = new Map();
    this.one = 0;
    this.zeroEdge = Object.freeze({ w: ring.zero, node: 0 });
  }

  isTerminal(id) { return this.nodes[id].low === null; }
  levelOf(id) { return this.nodes[id].level; }
  lowOf(id) { return this.nodes[id].low; }
  highOf(id) { return this.nodes[id].high; }

  edgeKey(e) { return `${this.ring.key(e.w)}@${e.node}`; }

  /** The reduced edge for `level` with the given child edges. */
  mk(level, e0, e1) {
    const zero0 = this.ring.isZero(e0.w);
    const zero1 = this.ring.isZero(e1.w);
    if (zero0 && zero1) return this.zeroEdge;
    // Identical child edges mean the variable is a don't-care, exactly as in dd.js.
    if (this.edgeKey(e0) === this.edgeKey(e1)) return e0;

    // Factor a scalar out of both children and hand it to the incoming edge. Which
    // scalar is the normaliser's business; it is taken from the first non-zero child so
    // that the choice does not depend on which side happens to be zero.
    const factor = this.normalise(zero0 ? e1.w : e0.w);
    let w0 = e0.w;
    let w1 = e1.w;
    let carried = this.ring.one;
    if (factor) {
      w0 = this.ring.mul(w0, factor.inverse);
      w1 = this.ring.mul(w1, factor.inverse);
      carried = factor.unit;
    }

    const low = { w: w0, node: e0.node };
    const high = { w: w1, node: e1.node };
    const k = `${level}:${this.edgeKey(low)}:${this.edgeKey(high)}`;
    let id = this.unique.get(k);
    if (id === undefined) {
      id = this.nodes.length;
      this.nodes.push({ level, low: Object.freeze(low), high: Object.freeze(high) });
      this.unique.set(k, id);
    }
    return Object.freeze({ w: carried, node: id });
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
      edge = this.ring.isZero(value) ? this.zeroEdge : Object.freeze({ w: value, node: this.one });
    } else {
      edge = this.mk(dd.levelOf(node),
        this.fromMTBDD(dd, dd.lowOf(node), memo),
        this.fromMTBDD(dd, dd.highOf(node), memo));
    }
    memo.set(node, edge);
    return edge;
  }

  /** The amplitude of one basis state: the product of the weights along its path. */
  evaluate(edge, bits) {
    const b = typeof bits === 'string' ? [...bits].map(Number) : bits;
    let w = edge.w;
    let n = edge.node;
    while (!this.isTerminal(n)) {
      const next = b[this.levelOf(n)] ? this.highOf(n) : this.lowOf(n);
      w = this.ring.mul(w, next.w);
      n = next.node;
    }
    return w;
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

/**
 * Factor out the units a circuit produces — a power of sqrt(2) and a power of w. Exact,
 * since those are invertible. A symbolic weight is left alone rather than guessed at.
 * A gcd-based normaliser would slot in here unchanged; see docs/EVDD.md.
 */
export function unitNormaliser(P, Z) {
  return (w) => {
    const scalar = P.asScalar(w);
    if (scalar === null || Z.isZero(scalar)) return null;
    const { unit } = Z.unitPart(scalar);
    if (Z.eq(unit, Z.ONE)) return null;
    return { unit: P.fromZ(unit), inverse: P.fromZ(Z.invert(unit)) };
  };
}
