// Making an automaton smaller without changing what it accepts.
//
// `aut-ta.js` interns a state on its set of transitions, so two states with the same
// transitions are already one state and nothing below the root is ever built twice. What
// that does not touch is the *root*, and the root is where the size is: `fromVectors`
// gives it one transition per member of the set, so a set of 2^n basis states arrives as
// 2^n transitions and 2^n trees standing side by side, sharing only what interning
// happened to notice.
//
// One rule fixes most of that, and it is the whole of this module:
//
//     two transitions that agree on one side merge, and the other sides unite.
//
// If a state has (L, H₁) and (L, H₂), a run may take either, so what it accepts through
// them is {t_L} × (L(H₁) ∪ L(H₂)) — which is exactly what the single transition
// (L, H₁∪H₂) accepts. Same for a shared high child. The rule is exact *because* one side
// is identical: merging (A, C) with (B, D) would add (A, D) and (B, C), which were never
// there, and that is why nothing here does it.
//
// Applied to every level and run to a fixed point, this turns the 2^n transitions of
// "every computational basis state" into two, and its 2^n trees into the 2n+1 states any
// textbook would draw: one per level that says "the 1 is somewhere below me", one per
// level that says "everything below me is zero".
//
// What it produces is *nondeterministic below the root*, which is the point — that is
// where an automaton beats a list — and also why `aut-gates.js` is given the unreduced
// automaton to work on. A gate has to know which choice each half of a transformed node
// took, and a plain tree automaton cannot say. So the page reduces what it *shows* and
// transforms what it *has*; the two accept the same set at every step, which is the only
// thing that has to be true.

/**
 * The same language, in fewer states.
 *
 * @param {import('./aut-ta.js').TA} ta
 * @param {number} root
 * @returns {number} the root of the reduced automaton, interned in the same `ta`
 */
export function reduce(ta, root) {
  const done = new Map();
  const walk = (id) => {
    if (ta.isLeaf(id)) return id;
    const had = done.get(id);
    if (had !== undefined) return had;
    const level = ta.levelOf(id);
    // Children first: a merge at this level can only see sharing that already happened
    // below it, and reducing bottom-up means it always has.
    const pairs = ta.transitionsOf(id).map(([lo, hi]) => [walk(lo), walk(hi)]);
    const made = ta.state(level, share(ta, pairs, level + 1));
    done.set(id, made);
    return made;
  };
  return walk(root);
}

const key = (pairs) => pairs.map((p) => p.join(',')).sort().join(';');

/** Merge transitions that agree on one side until no two of them do. */
function share(ta, pairs, childLevel) {
  let now = pairs;
  for (;;) {
    const next = pass(ta, pass(ta, now, 0, childLevel), 1, childLevel);
    if (key(next) === key(now)) return next;
    now = next;
  }
}

/**
 * One sweep: group the transitions by the child on `side`, and unite the others.
 *
 * A leaf holds an amplitude rather than transitions, so two different leaves cannot be
 * united into one state and a group whose other side is a leaf is left alone. That is
 * not a gap: it is the bottom level saying that a 0 and a 1 are two different things.
 */
function pass(ta, pairs, side, childLevel) {
  const groups = new Map();
  for (const pair of pairs) {
    const at = pair[side];
    if (!groups.has(at)) groups.set(at, []);
    groups.get(at).push(pair[1 - side]);
  }
  const out = [];
  for (const [at, others] of groups) {
    const distinct = [...new Set(others)];
    const canUnite = distinct.length > 1 && distinct.every((id) => !ta.isLeaf(id));
    const kept = canUnite ? [unite(ta, distinct, childLevel)] : distinct;
    for (const other of kept) out.push(side === 0 ? [at, other] : [other, at]);
  }
  return out;
}

/** One state accepting everything any of `ids` accepts — and reduced while it is built. */
function unite(ta, ids, level) {
  const pairs = ids.flatMap((id) => ta.transitionsOf(id));
  return ta.state(level, share(ta, pairs, level + 1));
}
