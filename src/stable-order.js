// Keeping a row in the order it was already in.
//
// A row laid out again after something changed should not shuffle: a node that is still
// there belongs where it was, and a node that is new belongs between whichever of its
// neighbours were. That is all this does, and it is why a diagram can be stepped through
// without the eye losing its place.
//
// It knows nothing about what it is ordering — an id is opaque here, and may be a number
// or a string — which is what lets both the decision diagram and the automaton use it.

/**
 * Order one level, honouring the previous frame's order for nodes that persist.
 * @param {number[]} ids nodes at this level, in scan order
 * @param {Map<number, number>} prevRank rank each node had in the previous frame
 * @returns {number[]} the ids in drawing order, left to right
 */
export function stableOrder(ids, prevRank) {
  const known = ids.map((id) => (prevRank.has(id) ? prevRank.get(id) : null));
  const ranks = known.slice();

  for (let i = 0; i < ids.length; i++) {
    if (ranks[i] !== null) continue;
    let p = i - 1;
    while (p >= 0 && known[p] === null) p--;
    let q = i + 1;
    while (q < ids.length && known[q] === null) q++;
    const before = p >= 0 ? known[p] : null;
    const after = q < ids.length ? known[q] : null;
    if (before === null && after === null) ranks[i] = i;                 // nothing persisted
    else if (before === null) ranks[i] = after - (q - i) / (q + 1);      // insert to the left
    else if (after === null) ranks[i] = before + (i - p) / (ids.length - p);
    else ranks[i] = before + ((after - before) * (i - p)) / (q - p);     // interpolate
  }

  return ids
    .map((id, i) => ({ id, rank: ranks[i], scan: i }))
    .sort((a, b) => (a.rank - b.rank) || (a.scan - b.scan))
    .map((e) => e.id);
}
