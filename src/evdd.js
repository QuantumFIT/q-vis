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
   * @param {(low: object, high: object) => ({unit: any, inverse: any}|null)} [normalise]
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
    // scalar — and which edge it comes from — is the normaliser's business.
    const factor = this.normalise(e0, e1);
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

// ---- canonisation ---------------------------------------------------------
//
// The literature's schemes all pick a normalisation factor v from the pair of edge
// weights and divide both by it: Q-Sylvan implements v = low, min, max and an L2 rule,
// and Quist et al. use 'low' (and 'L2') for the same Clifford+T ring this project uses.
//
// Dividing by a whole weight needs a field, and Z[1/sqrt(2), i] is not one — across this
// project's own examples, 45% of the amplitudes that appear have no inverse in it (3/4
// and 13/256 among them). Quist et al. answer that by moving to the fraction field and
// canonicalising with Euclid's algorithm; until that exists here, what is available is
// the *unit part* of the chosen weight, which is always invertible.
//
// So the choice offered is which edge the factor is taken from — the literature's
// question — while what is taken from it is as much as this ring allows. Where the
// chosen weight is a unit the two coincide exactly.

/** |w|^2 as an exact ring element, or null when the weight is symbolic. */
function magnitudeSquared(P, Z, w) {
  const s = P.asScalar(w);
  return s === null ? null : Z.mul(s, Z.conj(s));
}

function unitFactor(P, Z, w) {
  const scalar = P.asScalar(w);
  if (scalar === null || Z.isZero(scalar)) return null;
  const { unit } = Z.unitPart(scalar);
  if (Z.eq(unit, Z.ONE)) return null;
  return { unit: P.fromZ(unit), inverse: P.fromZ(Z.invert(unit)) };
}

/**
 * Which of the two edges the factor comes from.
 * @param {'low'|'max'|'min'} pick
 */
function chooseEdge(P, Z, pick, e0, e1) {
  if (P.isZero(e0.w)) return e1;
  if (P.isZero(e1.w)) return e0;
  if (pick === 'low') return e0;
  const m0 = magnitudeSquared(P, Z, e0.w);
  const m1 = magnitudeSquared(P, Z, e1.w);
  if (m0 === null || m1 === null) return e0;   // symbolic: no magnitude to compare

  // Whatever this decides must be a function of the two weights and nothing else. Two
  // subfunctions that differ by a unit have to normalise the same way or they will not
  // merge, and the same state converted twice has to be drawn the same way both times.
  //
  // That rules out the node ids this used to break ties on: they are creation order, so
  // the same state came out differently depending on what the manager had converted
  // earlier, and the unfolded tree — which numbers its positions rather than its nodes —
  // disagreed with the shared diagram on every tie. A tie now goes to the low edge, which
  // is intrinsic, and which the two views therefore agree on.
  if (Z.eq(m0, m1)) return e0;

  // Only the ordering of *unequal* magnitudes is left to floating point. That is safe
  // because a unit's squared magnitude is a power of two, so scaling both sides by one
  // scales both doubles exactly and cannot change their order — but only if the
  // comparison is relative. Two magnitudes that are exactly unequal and yet a bit apart
  // as doubles are treated as a tie, rather than ordered on a bit of rounding noise.
  const c0 = Z.toComplex(m0).re;
  const c1 = Z.toComplex(m1).re;
  if (Math.abs(c0 - c1) <= 1e-12 * Math.max(Math.abs(c0), Math.abs(c1))) return e0;
  return (pick === 'max') === (c0 > c1) ? e0 : e1;
}

/** The canonisation rules on offer, keyed as they are named in the literature. */
export const NORMALISERS = {
  none: {
    label: 'none',
    note: 'Weights are left where they fall. Sharing then needs subfunctions to be equal, '
      + 'not merely proportional — but the terminals still collapse to one.',
    make: () => () => null,
  },
  low: {
    label: 'low edge',
    note: "The default. Q-Sylvan's norm-low and the rule Quist et al. use for their scaling guarantees: "
      + 'the factor comes from the low edge, or the high edge when the low one is zero.',
    make: (P, Z) => (e0, e1) => unitFactor(P, Z, chooseEdge(P, Z, 'low', e0, e1).w),
  },
  max: {
    label: 'larger edge',
    note: "Q-Sylvan's norm-max, its default: the factor comes from the edge of larger "
      + '|w|², so the larger values stay low in the diagram. Ties go to the low edge.',
    make: (P, Z) => (e0, e1) => unitFactor(P, Z, chooseEdge(P, Z, 'max', e0, e1).w),
  },
  min: {
    label: 'smaller edge',
    note: "Q-Sylvan's norm-min, which it measured as the least numerically stable of the "
      + 'four. Exact arithmetic here makes that objection moot, so it is offered for comparison.',
    make: (P, Z) => (e0, e1) => unitFactor(P, Z, chooseEdge(P, Z, 'min', e0, e1).w),
  },
};

/**
 * The default: take the factor from the low edge. That is the rule Quist et al. prove
 * their scaling guarantees for, and the only one a Pauli-LIMDD can use — the Pauli rules
 * assume the low edge has been emptied — so it is the one rule that means the same thing
 * in every view the tool offers.
 */
export const DEFAULT_NORMALISER = 'low';

export function unitNormaliser(P, Z, kind = DEFAULT_NORMALISER) {
  return (NORMALISERS[kind] || NORMALISERS[DEFAULT_NORMALISER]).make(P, Z);
}
