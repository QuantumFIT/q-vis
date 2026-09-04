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

## The decision: normalising over a ring that is not a field

Canonicity needs a rule for which scalar to push up an edge, and every textbook rule
divides. Amplitudes live in `Z[1/√2, i]`, where division is not always possible:

| element | inverse |
| --- | --- |
| `i`, `ω`, `√2`, `2`, `1+i`, `1+ω` | in the ring |
| `3`, `1+2i` | **not in the ring** |

So the normaliser is a parameter (`EVDD`'s third argument), and what ships factors out a
power of `√2` and a power of `ω` — the units a gate can introduce, so the division is
exact. `zomega.unitPart` does it, choosing canonically among the eight rotations, with
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
