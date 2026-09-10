// Making an automaton smaller without changing what it accepts.
//
// `aut-lsta.js` interns a state on its set of transitions, so two states with the same
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
// where an automaton beats a list — and the colours come along for the ride: a merged
// step is admitted under the colours of both the steps it replaces, and the states that
// unite keep their own. Nothing here invents a colour, and nothing here loses one, which
// is what lets a gate afterwards still tell the alternatives apart.
//
// Then `recolour`, which is the other half. `fromVectors` paints one colour per member,
// so a set of thirty-two arrives with thirty-two colours; after merging, most levels can
// only tell two things apart. Colours that no transition on their level separates are
// the same colour, so they are made into one. That keeps the sets small, the products in
// `aut-gates.js` cheap, and the dots on the picture countable.

import { ANY, join } from './aut-lsta.js';

/**
 * The same language, in fewer states.
 *
 * @param {import('./aut-lsta.js').LSTA} ta
 * @param {number} root
 * @returns {number} the root of the reduced automaton, interned in the same `ta`
 */
export function reduce(ta, root, { recolour: paint = true } = {}) {
  const done = new Map();
  const walk = (id) => {
    if (ta.isLeaf(id)) return id;
    const had = done.get(id);
    if (had !== undefined) return had;
    const level = ta.levelOf(id);
    // Children first: a merge at this level can only see sharing that already happened
    // below it, and reducing bottom-up means it always has.
    const steps = ta.transitionsOf(id).map(([lo, hi, c]) => [walk(lo), walk(hi), c]);
    const made = ta.state(level, share(ta, steps, level + 1));
    done.set(id, made);
    return made;
  };
  const merged = walk(root);
  return paint ? recolour(ta, merged) : merged;
}

const key = (steps) => steps.map((p) => `${p[0]},${p[1]}:${p[2] === ANY ? '*' : p[2].join('.')}`)
  .sort().join(';');

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
function pass(ta, steps, side, childLevel) {
  const groups = new Map();
  for (const step of steps) {
    const at = step[side];
    if (!groups.has(at)) groups.set(at, []);
    groups.get(at).push(step);
  }
  const out = [];
  for (const [at, group] of groups) {
    const distinct = [...new Set(group.map((step) => step[1 - side]))];
    const canUnite = distinct.length > 1 && distinct.every((id) => !ta.isLeaf(id))
      && tellsApart(ta, distinct);
    if (!canUnite) {
      for (const step of group) out.push(step);
      continue;
    }
    // One step where there were several, admitted under the colours of all of them —
    // which is exact, since the side they agree on is the same state either way.
    const colour = group.map((step) => step[2]).reduce(join);
    const united = unite(ta, distinct, childLevel);
    out.push(side === 0 ? [at, united, colour] : [united, at, colour]);
  }
  return out;
}

/**
 * Could these states be united without a colour losing track of which one it is in?
 *
 * The merge is always safe for the *language*: what a united state accepts is what its
 * parts accepted, because the side they agree on is the same state either way. It is not
 * always safe for the colours. If two of the parts offer different steps under the same
 * colour, then after uniting, that colour no longer picks out a run — and a gate needs
 * it to, or the two halves of a transformed node stop being halves of one tree.
 *
 * So the merge asks first. Where the answer is no the transitions stay as they were:
 * a slightly larger automaton, and one a gate can still be applied to. The cases that
 * matter most are all yes — states no member shares carry disjoint colours by
 * construction, which is what makes every basis state fold into 2n+1.
 */
function tellsApart(ta, ids) {
  const steps = new Map();
  for (const id of ids) {
    for (const [low, high, choice] of ta.transitionsOf(id)) {
      const key = `${low},${high}`;
      steps.set(key, steps.has(key) ? join(steps.get(key), choice) : choice);
    }
  }
  if (steps.size < 2) return true;
  const seen = new Set();
  for (const choice of steps.values()) {
    if (choice === ANY) return false;              // admits every colour, beside others
    for (const c of choice) {
      if (seen.has(c)) return false;
      seen.add(c);
    }
  }
  return true;
}

/** One state accepting everything any of `ids` accepts — and reduced while it is built. */
function unite(ta, ids, level) {
  const steps = ids.flatMap((id) => ta.transitionsOf(id));
  return ta.state(level, share(ta, steps, level + 1));
}

/**
 * The same automaton with the fewest colours its levels can tell apart.
 *
 * Two colours on one level are the same colour if no transition there admits one without
 * the other: nothing in the automaton can distinguish them, and a run that picks either
 * has the same choices open to it. So they are quotiented, and a set that ends up holding
 * every class is written `ANY`, which is what a transition that constrains nothing is.
 *
 * This is what keeps the colours countable. A set of thirty-two members arrives with
 * thirty-two of them and comes out of the merge with two per level, which is the number
 * the picture can draw and the products can afford.
 */
export function recolour(ta, root) {
  const classes = [];
  const totals = [];
  for (let level = 0; level < ta.nvars; level++) { classes.push(new Map()); totals.push(0); }
  for (const level of classes.keys()) {
    const at = ta.reachable(root).filter((id) => !ta.isLeaf(id) && ta.levelOf(id) === level);
    const sets = at.flatMap((id) => ta.transitionsOf(id).map(([, , c]) => c))
      .filter((c) => c !== ANY);

    // Which sets a colour belongs to is what decides its class, and that is a fact about
    // the automaton. Which *number* the class gets must be one too, or reducing an
    // already-reduced automaton would renumber it and rebuild every state above it. So
    // the classes are numbered by their smallest colour: on an automaton that has been
    // through here once the classes are singletons and the numbering is the identity.
    const together = new Map();
    for (const c of new Set(sets.flat())) {
      const signature = sets.map((set) => (set.includes(c) ? '1' : '0')).join('');
      if (!together.has(signature)) together.set(signature, []);
      together.get(signature).push(c);
    }
    [...together.values()]
      .sort((a, b) => Math.min(...a) - Math.min(...b))
      .forEach((group, id) => { for (const c of group) classes[level].set(c, id); });
    totals[level] = together.size;
  }

  const done = new Map();
  const walk = (id) => {
    if (ta.isLeaf(id)) return id;
    const had = done.get(id);
    if (had !== undefined) return had;
    const level = ta.levelOf(id);
    const total = totals[level];
    const made = ta.state(level, ta.transitionsOf(id).map(([lo, hi, c]) => {
      if (c === ANY) return [walk(lo), walk(hi), ANY];
      const now = [...new Set(c.map((one) => classes[level].get(one)))].sort((a, b) => a - b);
      return [walk(lo), walk(hi), now.length === total ? ANY : now];
    }));
    done.set(id, made);
    return made;
  };
  return walk(root);
}
