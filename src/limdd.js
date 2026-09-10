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
import * as Stab from './stabilizer.js';

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
    this.tryInvert = ring.tryInvert ? (w) => ring.tryInvert(w) : () => null;
    this.stabCache = new Map();
    /** @type {Array<{level:number, low:?object, high:?object}>} */
    this.nodes = [{ level: nvars, low: null, high: null, sig: '1' }];   // node 0: the terminal, denoting 1
    this.unique = new Map();
    this.one = 0;
    this.zeroEdge = Object.freeze({ w: ring.zero, x: 0, z: 0, node: 0 });
  }

  isTerminal(id) { return this.nodes[id].low === null; }
  levelOf(id) { return this.nodes[id].level; }
  lowOf(id) { return this.nodes[id].low; }
  highOf(id) { return this.nodes[id].high; }

  edgeKey(e) { return `${this.ring.key(e.w)}.${e.x}.${e.z}@${e.node}`; }

  /**
   * What a node *contains*, folded into a number, as against the id that says when it was
   * built. Two structurally identical nodes have the same signature in any manager and
   * whatever was built before them, which is what the orientation rule below needs: a
   * diagram that is a function of the state cannot be settled by creation order.
   *
   * A Merkle fold — each node's signature is taken over its children's — so it costs O(1)
   * per node and is computed once, when the node is made.
   */
  sigOf(id) { return this.nodes[id].sig; }

  signature(level, low, high) {
    const part = (e) => `${this.ring.key(e.w)}.${e.x}.${e.z}.${this.sigOf(e.node)}`;
    const text = `${level}|${part(low)}|${part(high)}`;
    // Two 32-bit FNV-1a variants, so a collision would need both to agree at once.
    let a = 0x811c9dc5;
    let b = 0x01000193;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193) >>> 0;
      b = Math.imul(b + c, 0x85ebca6b) >>> 0;
    }
    return `${a.toString(36)}.${b.toString(36)}`;
  }

  /** The reduced edge for `level` with the given child edges (MakeEdge, Alg. 11). */
  mk(level, e0, e1) {
    const R = this.ring;
    const zero0 = R.isZero(e0.w);
    const zero1 = R.isZero(e1.w);
    if (zero0 && zero1) return this.zeroEdge;
    // Identical child edges are *not* collapsed here, unlike dd.js. A LIMDD in the paper
    // has a node on every level, and this one does too: see `padTo` and the note in
    // docs/LIMDD.md. Collapsing would give two representations of one subfunction — the
    // level skipped and the level present — which then cannot merge with each other.

    // Low precedence (rule 3), and the same swap when the low edge is zero so that rule 4
    // has something to factor. Paid for with an X on this level's qubit, which is what
    // exchanging the two branches means. Never swapped when the *high* edge is zero: rule
    // 2 below settles that case, and swapping there would bounce back and forth.
    if (zero0 || (!zero1 && this.sigOf(e1.node) < this.sigOf(e0.node))) {
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
    const { high: chosen, root: broot } = this.highLabel(level, low, semi);

    const k = `${level}:${this.edgeKey(low)}:${this.edgeKey(chosen)}`;
    let id = this.unique.get(k);
    if (id === undefined) {
      id = this.nodes.length;
      this.nodes.push({
        level,
        low: Object.freeze(low),
        high: Object.freeze(chosen),
        sig: this.signature(level, low, chosen),
      });
      this.unique.set(k, id);
    }
    // The root carries what low factoring took off, then the high rule's correction.
    const lowLim = { w: unit, x: e0.x, z: e0.z };
    return Object.freeze({ ...Pauli.mul(R, lowLim, broot), node: id });
  }

  // ---- high determinism ---------------------------------------------------

  /**
   * The canonical high label (rule 5), and the root LIM that pays for the change
   * (GetLabels, Alg. 12).
   *
   * Every node isomorphic to this one has a high label of the form
   * `(-1)^s * lambda^(+-1) * g0 * P * g1` with g0, g1 stabilising the two children
   * (their Th. 14), so the canonical choice is the smallest of them. What that costs is
   * given back on the root as `(X (x) A)^x (Z^s (x) g0^-1)`.
   */
  highLabel(level, low, high) {
    const R = this.ring;
    const one = { w: R.one, x: 0, z: 0 };
    if (R.isZero(high.w)) return { high, root: one };   // a zero edge has nothing to choose

    const G0 = this.branchStabilizers(level, low);
    const G1 = this.branchStabilizers(level, high);
    const A = { w: high.w, x: high.x, z: high.z };
    const { lim, g0 } = Stab.argLexMin(R, G0, G1, A, true);

    let best = { lim, root: this.rootFor(level, g0, 0) };
    const flipped = Pauli.negate(R, lim);
    if (Pauli.compare(R, flipped, best.lim) < 0) {
      best = { lim: flipped, root: this.rootFor(level, g0, 1) };
    }

    // When the two children are the same node the label may also be inverted, which needs
    // the weight to have an inverse and the string to square to +1 — and, because this
    // diagram cannot always empty the low edge, that edge to be bare. Skipping it costs a
    // merge and never an amplitude, and the condition is a property of the values rather
    // than of the order they were met in, so the diagram stays deterministic.
    const invertible = Pauli.inverse(R, A, this.tryInvert);
    if (low.node === high.node && invertible !== null
        && R.eq(low.w, R.one) && Pauli.popcount(A.x & A.z) % 2 === 0) {
      const back = Stab.argLexMin(R, G0, G1, invertible, true);
      for (const s of [0, 1]) {
        const candidate = s ? Pauli.negate(R, back.lim) : back.lim;
        if (Pauli.compare(R, candidate, best.lim) < 0) {
          // (X (x) A) on top of the s-and-g0 correction.
          const root = Pauli.mul(R, { w: A.w, x: A.x | (1 << level), z: A.z },
            this.rootFor(level, back.g0, s));
          best = { lim: candidate, root };
        }
      }
    }

    return { high: { ...best.lim, node: high.node }, root: best.root };
  }

  /** `Z^s (x) g0^-1`, the root label that undoes a sign and a stabilizer of the low child. */
  rootFor(level, g0, s) {
    const R = this.ring;
    const back = Pauli.inverse(R, g0, this.tryInvert) ?? g0;   // a stabilizer is its own inverse
    return s ? Pauli.mul(R, Pauli.zOn(R, level), back) : back;
  }

  // ---- stabilizer subgroups ------------------------------------------------

  /**
   * The isomorphism taking the state on edge `a` to the state on edge `b`, or null when
   * there is none this ring can name (GetIsomorphism, Alg. 16). Both nodes are already
   * canonical, so the only question is whether they are the same node.
   */
  isomorphism(a, b) {
    const R = this.ring;
    if (a.node !== b.node || R.isZero(a.w) || R.isZero(b.w)) return null;
    const back = Pauli.inverse(R, { w: a.w, x: a.x, z: a.z }, this.tryInvert);
    return back === null ? null : Pauli.mul(R, { w: b.w, x: b.x, z: b.z }, back);
  }

  /**
   * What stabilises the state an edge leads to, as seen from `level`. A level the diagram
   * skips is a qubit the branch does not depend on, so that factor is |0> + |1>, which X
   * stabilises; the rest comes from the node.
   */
  branchStabilizers(level, e) {
    const out = [...this.stabilizers(e.node)];
    for (let q = level + 1; q < this.levelOf(e.node); q++) out.push(Pauli.xOn(this.ring, q));
    return out.length > 1 ? Stab.echelon(this.ring, out) : out;
  }

  /**
   * A generating set for the Pauli stabilizer subgroup of a node's state
   * (GetStabilizerGenSet, Alg. 13). A stabilizer is either the identity on this qubit —
   * in which case it stabilises both branches at once — or one of X, Y, Z on it, each of
   * which relates the two branches to each other in its own way.
   */
  stabilizers(id) {
    if (this.isTerminal(id)) return [];
    const hit = this.stabCache.get(id);
    if (hit) return hit;

    const R = this.ring;
    const level = this.levelOf(id);
    const e0 = this.lowOf(id);
    const e1 = this.highOf(id);
    const G0 = this.branchStabilizers(level, e0);

    let out;
    if (R.isZero(e1.w)) {
      // |0> (x) (low branch): everything below still holds, and Z fixes the qubit itself.
      out = Stab.echelon(R, [...G0, Pauli.zOn(R, level)]);
    } else {
      // Below the top qubit the high branch is seen through its own label, so its
      // stabilizers are conjugated by it. Only the string matters: a scalar cancels.
      const G1 = this.branchStabilizers(level, e1)
        .map((g) => (Pauli.commute(e1, g) ? g : Pauli.negate(R, g)));

      const one = { w: R.one, x: 0, z: 0 };
      const found = [...Stab.meet(R, G0, G1).intersection];

      // Z: fixes the low branch and flips the sign of the high one.
      const push = (top, meeting) => {
        if (meeting !== null) found.push(Pauli.mul(R, top, meeting.pi));
      };
      push(Pauli.zOn(R, level),
        Stab.meetCosets(R, one, G0, Pauli.negate(R, one), G1, this.tryInvert));
      // X exchanges the two branches; Y exchanges them with a quarter turn, so it is the
      // same question asked of the high branch turned by -i. A ring with no square root
      // of -1 has no Y to ask about.
      const cases = [[Pauli.xOn(R, level), e1]];
      if (R.i !== undefined) {
        const turned = Pauli.mul(R, { w: R.neg(R.i), x: 0, z: 0 }, e1);
        cases.push([{ w: R.i, x: 1 << level, z: 1 << level }, { ...turned, node: e1.node }]);
      }
      for (const [top, other] of cases) {
        const pi0 = this.isomorphism(e0, other);
        const pi1 = this.isomorphism(other, e0);
        if (pi0 !== null && pi1 !== null) {
          push(top, Stab.meetCosets(R, pi0, G0, pi1, G1, this.tryInvert));
        }
      }
      out = Stab.echelon(R, found);
    }

    this.stabCache.set(id, out);
    return out;
  }

  /**
   * The same state as an MTBDD holds it. Simulation stays on dd.js; this is the state
   * seen the other way, which is all a visualiser needs and costs one pass.
   */
  /**
   * An edge whose node sits at exactly `target`, filling in the levels an MTBDD drops.
   *
   * The MTBDD skips a level nothing depends on; a LIMDD does not. Where the source skips,
   * a node whose two edges agree goes in for each missing level, which is what "a node on
   * every level" means. A zero edge is left alone: it denotes the zero subfunction and
   * has nothing below it to populate.
   */
  padTo(target, e) {
    if (this.ring.isZero(e.w)) return e;
    let cur = e;
    for (let lev = this.levelOf(cur.node) - 1; lev >= target; lev--) cur = this.mk(lev, cur, cur);
    return cur;
  }

  /** The whole state, as an edge into a node at level 0. */
  fromMTBDD(dd, node, memo = new Map()) {
    return this.padTo(0, this.convert(dd, node, memo));
  }

  /**
   * One MTBDD node as a LIMDD edge, at that node's own level. Memoised on the source
   * node, so the padding a *caller* needs is applied at the call site rather than baked
   * in: the same subfunction can be reached from different levels.
   */
  convert(dd, node, memo) {
    const hit = memo.get(node);
    if (hit) return hit;
    let edge;
    if (dd.isTerminal(node)) {
      const value = dd.valueOf(node);
      edge = this.ring.isZero(value)
        ? this.zeroEdge
        : Object.freeze({ w: value, x: 0, z: 0, node: this.one });
    } else {
      const level = dd.levelOf(node);
      edge = this.mk(level,
        this.padTo(level + 1, this.convert(dd, dd.lowOf(node), memo)),
        this.padTo(level + 1, this.convert(dd, dd.highOf(node), memo)));
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
