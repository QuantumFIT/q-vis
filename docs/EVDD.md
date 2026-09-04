# Edge-valued diagrams

A state can be drawn four ways in q-vis: shared or unreduced, with the amplitudes in the
terminals or on the edges. This note records why the edge-valued pair exists and the one
decision it turned on.

## What the edges buy

With amplitudes in the terminals, two subfunctions are shared only when they are *equal*.
With weights on the edges — one terminal, `1`, and the state's overall factor on a root
edge — they are shared when they are equal **up to a scalar**. That is what circuits
produce, because a gate multiplies subfunctions by phases.

The 3-qubit QFT is the case the terminal-valued form handles worst: a different phase on
every amplitude, so nothing can be shared. Its amplitudes are `ω^(x·y)/√8`, which factors
over the bits of `y`, and the two effects separate cleanly:

| | nodes |
| --- | --- |
| terminal-valued, shared | 15 |
| edge-valued, no normalisation | 8 |
| edge-valued, units factored out | 4 |

Moving the amplitudes onto the edges collapses the *terminals* — eight become one.
Normalising then collapses the *internal nodes*, leaving one per qubit.

## The canonisation rules on offer

Every scheme in the literature picks a normalisation factor ν from a node's pair of edge
weights and divides both by it, multiplying the incoming edge by ν. Q-Sylvan [1]
implements four choices and measures them; Quist et al. [2] use two, over the same
Clifford+T ring this project uses.

| Q-Sylvan | ν | ℓ₂ error measured there | here |
| --- | --- | --- | --- |
| `norm-low` | α, the low weight | 8% | **low edge** |
| `norm-min` | min(α, β) | 20% | **smaller edge** |
| `norm-max` | max(α, β) | 0% (their default) | **larger edge** (our default) |
| `norm-L2` | ‖(α,β)‖ with α/ν real positive | 0% | not expressible — see below |

Their ranking is driven by floating-point error, and they conclude that "having larger
values higher up in the decision diagram can increase issues with numerical instability".
Exact arithmetic removes that objection entirely, so the rules are offered here on their
other merits: what they do to the picture, and to the node count.

Two things follow from the ring rather than from the rule.

**Dividing by a whole weight needs a field, and this is not one.** Across this project's
own examples, 45% of the amplitudes that appear have no inverse in `Z[1/√2, i]` — `3/4`,
`5/(4√2)`, `13/256`. So what is factored out here is the *unit part* of the chosen
weight, which is always invertible. Where the chosen weight is a unit the two coincide
exactly; where it is not, this rule leaves the non-unit part behind and the literature's
rule would leave the ring. Quist et al. answer the same problem by moving to the fraction
field and canonicalising with Euclid's algorithm, which is the route to full canonicity
here too.

**`norm-L2` cannot be done exactly at all**, since it divides by ‖(α,β)‖ — a square root,
which is not in the ring even after passing to fractions.

Measured over the examples, the three edge choices give the same node counts (49 against
53 for no normalisation) but visibly different diagrams: `smaller edge` mirrors the QFT,
moving the phases onto the low edges. The choice of edge is what the literature debates;
here it changes the drawing more than the size.

[1] Brand & Laarman, *Q-Sylvan: A Parallel Decision Diagram Package for Quantum
Computing*, arXiv:2508.00514.
[2] Quist et al., *Exact quantum decision diagrams with scaling guarantees for Clifford+T
circuits and beyond*, arXiv:2602.17775 — same ring, `low` canonicity, fractions plus
Euclid for a canonical form.

## Why the ring makes this a decision

Canonicity needs a rule for which scalar to push up an edge, and every textbook rule
divides. Amplitudes live in `Z[1/√2, i]`, where division is not always possible:

| element | inverse |
| --- | --- |
| `i`, `ω`, `√2`, `2`, `1+i`, `1+ω` | in the ring |
| `3`, `1+2i` | **not in the ring** |

So the normaliser is a parameter (`EVDD`'s third argument, `NORMALISERS` in `evdd.js`),
and what it factors out is a power of `√2` and a power of `ω` — the units a gate can
introduce, so the division is exact. `zomega.unitPart` does it, choosing canonically among the eight rotations, with
the property that makes it work: **every unit reduces to 1**, so two amplitudes differing
by a phase leave the same remainder. A symbolic weight is left alone rather than guessed
at.

This is not fully canonical: subfunctions differing by a non-unit factor such as 3 stay
separate. Two ways further, both still open:

1. **gcd and unit.** `Z[ω]` is a principal ideal domain with a Euclidean algorithm, so
   divide both child weights by their gcd times a canonical unit. Fully canonical, still
   exact, no new number type — at the cost of implementing gcd in `Z[ω]`.
2. **Fractions.** Weights in `Q(ω)`, so any non-zero weight divides out and the textbook
   QMDD rule applies. The most sharing, but a new number type, and "exact" starts to mean
   something different in the interface.

Either drops into the same slot.

## How it is wired

Simulation is unchanged: it runs on the MTBDD in `dd.js`, and `EVDD.fromMTBDD` converts
each frame in one pass. That is all a visualiser needs, and it avoids reimplementing gate
application to see the difference. If the goal ever becomes cheaper *simulation* rather
than a clearer picture, native edge-valued gate application is the next step.

`layout.treeEdgeWeights` applies the same normalisation to an unreduced tree, which is
what the fourth view draws. The tests check the property directly: the weights along a
path, times the root weight, are the amplitude.
