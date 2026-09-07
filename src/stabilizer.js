// Linear algebra on Pauli stabilizer groups: the machinery a LIMDD needs to choose a
// canonical label for a high edge. This is App. A and App. D of arXiv:2108.00931.
//
// Modulo phase a Pauli string is a vector in F_2^2n — the check vector of pauli.js — and
// multiplication is xor. A stabilizer group is abelian with at most n generators, so it
// is a subspace, and the questions the diagram asks are linear algebra: reduce a
// generating set, find the smallest element of a coset, intersect two groups.
//
// The phases are what make it more than linear algebra, and they are kept by never
// dropping them: a row is a whole LIM and a row operation is a Pauli product, so the
// weight follows the string wherever the elimination takes it.
//
// Where two groups meet, an element is a product with one factor from each side. The two
// sides need not commute with each other, so a single accumulated product would forget
// which side owed what; elements are carried as the *pair* of factors instead, and each
// side is multiplied within itself, where everything commutes. Whatever the pair is
// worth is then worked out from the two factors when it is needed.

import * as Pauli from './pauli.js';

/** Bit `pos` of a check vector; positions from 32 up are the X block. */
const bitAt = (x, z, pos) => (pos >= 32 ? (x >>> (pos - 32)) : (z >>> pos)) & 1;

const pivotOf = (x, z) => Pauli.pivot({ x, z });

const identity = (R) => ({ w: R.one, x: 0, z: 0 });

/**
 * A basis for the strings reachable as <G0> * <G1>, each row remembering the two factors
 * that produce it. Rows that reduce to the identity string are set aside: those are the
 * places where the two groups agree, up to a sign.
 */
function basis(R, G0, G1) {
  const byPivot = new Map();
  const trivial = [];
  const one = identity(R);

  const insert = (row) => {
    let cur = row;
    for (;;) {
      const p = pivotOf(cur.x, cur.z);
      if (p < 0) { trivial.push(cur); return; }
      const r = byPivot.get(p);
      if (r === undefined) { byPivot.set(p, cur); return; }
      cur = {
        x: cur.x ^ r.x,
        z: cur.z ^ r.z,
        g0: Pauli.mul(R, cur.g0, r.g0),
        g1: Pauli.mul(R, cur.g1, r.g1),
      };
    }
  };

  for (const g of G0) insert({ x: g.x, z: g.z, g0: g, g1: one });
  for (const g of G1) insert({ x: g.x, z: g.z, g0: one, g1: g });
  return { byPivot, trivial };
}

/**
 * A minimal generating set for <gens>, in echelon form. Not back-substituted: the pivot
 * positions are a property of the subspace, so clearing them top-down already yields the
 * unique coset representative that is zero at every pivot, which is the minimum. The
 * generating set itself is only ever used as a generating set.
 */
export function echelon(R, gens) {
  const { byPivot } = basis(R, gens, []);
  return [...byPivot.keys()].sort((a, b) => b - a).map((p) => byPivot.get(p).g0);
}

/**
 * Both things worth knowing about how two stabilizer groups meet, out of one elimination
 * (IntersectStabilizerGroups, Alg. 15, and FindOpposite, Alg. 17): a generating set for
 * their intersection, and an element of <G0> whose negation lies in <G1>, if there is one.
 *
 * A row that reduces to the identity string holds a g0 and a g1 with the same string, so
 * their product is a scalar, and by their Lemma 8 it can only be +-1. Which sign it is
 * answers which of the two questions that row is about.
 */
export function meet(R, G0, G1) {
  const { trivial } = basis(R, G0, G1);
  const shared = [];
  let witness = null;
  for (const row of trivial) {
    const product = Pauli.mul(R, row.g0, row.g1);
    if (R.eq(product.w, R.one)) shared.push(row.g0);
    else if (witness === null) witness = row.g0;
    else shared.push(Pauli.mul(R, witness, row.g0));   // two of the wrong sign make a right one
  }
  return { intersection: echelon(R, shared), witness };
}

/**
 * The lexicographically smallest element of `A <G0> <G1>`, or of `<G0> A <G1>` when
 * `sandwich` is set, together with the factors reaching it (ArgLexMin, Alg. 17).
 *
 * The string is minimised by ordinary division with remainder. Only the sign is then
 * left to decide, because two elements of the set that share a string differ by no more
 * than a sign, and the other sign is available exactly when some g lies in <G0> with -g
 * in <G1>.
 */
export function argLexMin(R, G0, G1, A, sandwich = false) {
  const value = (g0, g1) => (sandwich
    ? Pauli.mul(R, Pauli.mul(R, g0, A), g1)
    : Pauli.mul(R, Pauli.mul(R, A, g0), g1));

  const { byPivot } = basis(R, G0, G1);
  const one = identity(R);
  let acc = { x: A.x, z: A.z, g0: one, g1: one };
  // Clear the string from the top down. A row's pivot is its highest set bit, so no row
  // can put back a bit that a row above it has already cleared.
  for (const p of [...byPivot.keys()].sort((a, b) => b - a)) {
    if (!bitAt(acc.x, acc.z, p)) continue;
    const r = byPivot.get(p);
    acc = {
      x: acc.x ^ r.x,
      z: acc.z ^ r.z,
      g0: Pauli.mul(R, acc.g0, r.g0),
      g1: Pauli.mul(R, acc.g1, r.g1),
    };
  }

  let best = { lim: value(acc.g0, acc.g1), g0: acc.g0, g1: acc.g1 };
  const { witness } = meet(R, G0, G1);
  if (witness !== null) {
    const g0 = Pauli.mul(R, acc.g0, witness);
    const g1 = Pauli.mul(R, Pauli.negate(R, witness), acc.g1);
    const lim = value(g0, g1);
    if (Pauli.compare(R, lim, best.lim) < 0) best = { lim, g0, g1 };
  }
  return best;
}

/**
 * Where two cosets of stabilizer groups meet (IntersectIsomorphismSets, Alg. 14): given
 * pi0 <G0> and pi1 <G1>, a pi and a group with pi <G> their intersection, or null when
 * they do not meet. The identity is the smallest LIM there is, so the cosets meet exactly
 * when the smallest element of pi1^-1 pi0 <G0> <G1> is it.
 */
export function meetCosets(R, pi0, G0, pi1, G1, tryInvert) {
  const back = Pauli.inverse(R, pi1, tryInvert);
  if (back === null) return null;                 // no inverse in this ring: give up on it
  const { lim, g0 } = argLexMin(R, G0, G1, Pauli.mul(R, back, pi0));
  if (!Pauli.isIdentityString(lim) || !R.eq(lim.w, R.one)) return null;
  return { pi: Pauli.mul(R, pi0, g0), group: meet(R, G0, G1).intersection };
}
