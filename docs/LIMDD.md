# Pauli-LIMDDs

The fifth view. The edge-valued diagram shares two subfunctions when they are equal **up
to a scalar**; this one shares them when they are equal **up to a scalar and a local
Pauli** — a label `w · P₁⊗…⊗Pₙ` with each `Pᵢ` one of `I, X, Y, Z`. Vinkhuijzen,
Coopmans, Elkouss, Dunjko and Laarman, [arXiv:2108.00931](https://arxiv.org/abs/2108.00931).

An edge reads `w·X⊗Z⊗I`: `w` times X on the first qubit, Z on the second, nothing on
the third. An unlabelled edge is the identity with weight 1, as usual.

## What it buys

Their Theorem 1: a state is a stabilizer state **exactly when** its LIMDD is a *tower* —
one node per qubit. Measured here on the final state of each circuit:

| state | MTBDD | edge-valued | LIMDD |
| --- | --- | --- | --- |
| GHZ, 4 / 5 / 6 qubits | 9 / 11 / 13 | 8 / 10 / 12 | **5 / 6 / 7** |
| cluster (line graph), 4 / 5 / 6 | 10 / 14 / 18 | 7 / 9 / 11 | **5 / 6 / 7** |
| complete graph, 6 / 8 | 18 / 26 | 11 / 15 | **7 / 9** |
| Bell pair | 5 | 4 | 3 |
| W state, 4 qubits | 9 | 8 | 7 |
| QFT-3, Grover, Toffoli | | 4 / 3–5 / 4 | unchanged |

Every stabilizer state lands on exactly `n+1`, whatever the graph. Nothing else in the
collection moves much, and QFT and Grover do not move at all — their subfunctions differ
by phases, which the edge-valued diagram already shares, and not by Paulis. The
`Cluster state, 5 qubits` example exists to show the one case where the difference is
plain: 9 nodes against 6, a fork against a tower.

## What the ring decides

Their labels carry an arbitrary complex scalar, so `Â := A⁻¹B` in MakeEdge (Alg. 11) is
always available. `Z[1/√2, i]` is not a field — 45% of the amplitudes in this project's
examples have no inverse in it — so the two halves of a label part company:

- **The Pauli string always factors out.** X, Z and their products are their own inverses
  up to a sign, over any ring. Every Pauli-side rule holds exactly as written.
- **The scalar factors out only as far as `evdd.js` already manages**, through the same
  `NORMALISERS` rule and the same unit part.

The gap misses precisely the states the diagram exists for. Their Theorem 1 builds the
tower of a stabilizer state with high-edge scalars in `{0, ±1, ±i}` — all units here —
so those states are as canonical in this ring as in `C`.

**The low-edge rule is not optional in this view.** Low factoring (rule 4) empties the low
edge, and the Pauli rules are stated for a diagram where it is empty. Any other scalar
rule leaves weights on the low edges, which then have to match before two nodes can merge:
the 5-qubit cluster state comes out as 6 nodes under `low edge` and 9 under `larger edge`.
Selecting the LIMDD view therefore switches the scalar rule to `low edge`. The others stay
selectable, and what they cost is worth seeing once.

## What is implemented

| | |
| --- | --- |
| Def. 5 | merge, zero edges, low precedence, low factoring, high determinism |
| Alg. 11 | `LIMDD.mk` |
| Alg. 12 | `LIMDD.highLabel` |
| Alg. 13 | `LIMDD.stabilizers` |
| Alg. 14, 15, 17 | `stabilizer.js`: `meetCosets`, `meet`, `argLexMin` |
| Alg. 16 | `LIMDD.isomorphism` — O(1), since both nodes are already canonical |

Three gaps, all of which cost a merge or a generator and never an amplitude, and all
decided by the values rather than by the order they were met in, so the diagram stays
deterministic:

- Anywhere a weight would have to be inverted and cannot be, that case is skipped: the
  isomorphism between two branches, and `π₁⁻¹` in Alg. 14.
- The `x = 1` branch of Alg. 12, which inverts the label when the two children coincide,
  additionally needs the low edge to be bare and the string to square to `+I`.
- **`LIMDD.isomorphism` does not see through a skipped level.** It is `O(1)` because it
  compares two already-canonical nodes, and a branch that reaches a node directly and one
  that reaches it past a level the diagram dropped are the same state held by different
  nodes. The X and Y cases of Alg. 13 go through it, so where that happens the stabilizer
  group comes back a proper subgroup — the line cluster state is short one generator per
  node, which is what the **tableau** button's closing note is about.

One thing that was a bug rather than a gap, fixed: **`Pauli.compare` now puts the identity
weight first.** Alg. 14 asks whether the *minimum* of a set of LIMs is the identity as its
way of asking whether the identity is *in* it, which is sound under the paper's order —
the weight as `(r, θ)`, so `+1` at `θ = 0` precedes `-1` at `θ = π`. The ring's exact key
is a string, `":1,0,0,0/0"` against `":-1,0,0,0/0"`, and `'-'` sorts first, so a set
holding both signs of the identity answered with `-I` and the caller concluded the
identity was absent. Every stabilizer with support on a node's own qubit was being missed:
GHZ on four qubits reported rank 2 where the group has rank 4. No node count changed when
this was fixed — the oracle test checks every example — so it had been costing generators
rather than merges.

Two details the paper does not have to deal with:

- **Skipped levels.** An MTBDD drops a level the state does not depend on; a LIMDD in the
  paper has a node on every level. Rather than putting the nodes back, a skipped qubit is
  accounted for where it matters — that factor of the branch is `|0⟩+|1⟩`, which `X`
  stabilises, so `branchStabilizers` adds one generator per skipped level.
- **Ordering.** Their lexicographic order ends with the weight written as floats `(r, θ)`.
  Here the check vector is followed by the ring's own key, which is exact and just as
  total: the only floating point in the comparison is gone.

## How it is checked

`tests/limdd.test.js`, against `pauliClassCount` in `tests/oracle.js` — which groups the
subfunctions of the MTBDD into equivalence classes by trying all `4^k` Pauli strings on
dense vectors, deciding proportionality by cross-multiplication so that it never needs to
divide. The diagram must have exactly as many nodes as there are classes: for every
example, for random states, and for GHZ and graph states, where the answer is separately
known to be `n+1`.

The amplitudes are checked the same way as the edge-valued diagram: every basis state of
every example, under every scalar rule.

## The tableau

**tableau**, beside the TikZ buttons and shown only in this view, gives the stabilizer
group of every node in the current step: the generators the diagram found, each as a sign,
the two check-vector blocks, and the string of `I/X/Y/Z`.

It is there because the group is why the diagram has the shape it has. A state on `m`
qubits is a stabilizer state exactly when its group has `m` independent generators, so a
node whose rank matches the qubits below it is the reason the diagram does not branch
there — Theorem 1, read off the plate. GHZ on four qubits gives `X⊗X⊗X⊗X`, `Z⊗Z⊗I⊗I`,
`I⊗Z⊗Z⊗I`, `I⊗I⊗Z⊗Z` at the root and one fewer at each level down.

Two things it is careful about:

- **The sign is a sign.** Strings are held as `X^x Z^z` and `Y = i·X·Z`, so a generator
  with a `Y` in it carries an `i` in its weight to mean what it says. That is paid back
  before printing, exactly as `limLabel` does for edge labels; printing an `i` in a
  tableau column would be wrong. Anything that then fails to be `±1` is printed as itself
  rather than dressed up as a sign.
- **Full rank proves a stabilizer state; short of it proves nothing.** Every generator
  shown really does fix its node — `tests/tableau.test.js` checks `P|v⟩ = |v⟩` against
  dense vectors — but the search can miss some, per the skipped-level gap above. The text
  says so whenever any node comes up short.

In the unfolded tree the same node stands in many places and the listing collapses them,
saying how many positions it collapsed: the group is a property of the node, not of where
it sits.

It is drawn as a table, with the 1s of each check vector inked and the 0s left faint, so a
generator reads as a shape before it is read as digits, and with the qubit index over each
column. The **copy** button hands over the same thing as aligned text, since that is what a
paper or a test fixture wants. `tableauFrame` in `src/tableau.js` is the structure both are
made from, which is also what the tests assert against.

No link, unlike the figure exports: a tableau is about a node, and where the view came from
belongs to **copy link** and to the TikZ snippets.

## The tree

**full tree** applies to this representation like any other, and here it is the diagram
*unfolded*: every shared node copied out once per path that reaches it, carrying the same
labels. The difference between the two pictures is exactly what the sharing was worth.

Unfolding rather than recomputing is what makes the two agree. Which label a LIMDD puts on
an edge depends on the diagram it is building — which branch precedes which, what
stabilises the children — so a tree derived from the amplitudes alone would be a different
diagram wearing the same name. `layoutEdgeValuedTree` therefore walks the finished
diagram, and the tests check that every slot in the tree holds the edge the diagram
reaches by the same low/high steps.

Two shortcuts the reduced diagram takes and the tree cannot, since a tree that skips
levels is not a tree:

- a level the diagram drops because nothing depends on it becomes a node whose two edges
  say nothing and lead to the same place;
- a zero edge keeps its subtree as scaffolding, rather than showing whatever the diagram
  happened to point the dead edge at. It dims and hides with **hide zeros**, as elsewhere.

One thing to read carefully: a Pauli label reroutes as well as scales — `X` on a qubit
exchanges that qubit's branches — so a path down a LIMDD does not spell a basis state the
way a path down the other two trees does. That is true of the reduced LIMDD as well; the
tree only makes it easier to notice.

## What is not here

Simulation still runs on the MTBDD and `LIMDD.fromMTBDD` converts each frame in one pass,
exactly as `EVDD` does. The paper's gate algorithms (Alg. 6–10) are what would make this a
faster *simulator*; they are not what makes it a clearer picture.
