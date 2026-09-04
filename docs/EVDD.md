# Extending q-vis to edge-valued diagrams

## What changes

Today every amplitude sits in a terminal, and two subfunctions are shared only when they
are *equal*. In an edge-valued diagram each edge carries a weight from the amplitude ring
and a node denotes `weight × subfunction`, so two subfunctions are shared when they are
equal **up to a scalar**. There is one terminal, `1`, and the state's global factor rides
on a root edge.

That is exactly the sharing quantum circuits produce, because circuits multiply
subfunctions by phases.

## Why it is worth doing

The 3-qubit QFT is the case where the current representation looks worst: 15 nodes, one
terminal per basis state, "nothing can be shared" (its own example note says so). But its
amplitudes are `ω^(x·y)/√8`, and that function is a *product* over the bits of `y`:

    ψ(y) = (1/√8) · (ω^20)^y0 · (ω^10)^y1 · (ω^5)^y2

A product like that is one node per level in an edge-valued diagram — each with low
weight 1 and high weight a phase — so **15 nodes should become 4**. Showing the same
state both ways, side by side, is the clearest possible argument for edge weights, and
this tool is already built to show two representations of one state (the `full tree`
toggle does it today).

## The problem: this ring is not a field

Canonicity needs a normalisation rule, and every standard rule divides by something. Our
amplitudes live in `Z[1/√2, i]`, where division is not always possible. Measured:

| element | inverse |
| --- | --- |
| `i`, `ω`, `√2`, `2`, `1+i`, `1+ω` | in the ring |
| `3`, `1+2i` | **not in the ring** |

So "divide the child weights by the low one" can leave the ring, and with it exactness —
the property the whole project is built on. Three ways out:

1. **Normalise by units only.** Factor out the unit part of the first non-zero child
   weight and push it up the edge. Exact, no new number type, a small change. Shares every
   pair of subfunctions differing by a phase, by ±1, or by a power of √2 — which is what
   circuits actually generate, and enough for the QFT result above. Not fully canonical:
   subfunctions differing by a non-unit factor (3, say) stay separate.
2. **Normalise by gcd and unit.** `Z[ω]` is a principal ideal domain with a Euclidean
   algorithm, so a genuine gcd exists. Divide both child weights by their gcd times a
   canonical unit. Fully canonical, still exact, still no new number type — at the cost of
   implementing gcd in `Z[ω]` and clearing denominators first.
3. **Extend to fractions.** Represent weights as elements of `Q(ω)`, so any non-zero
   weight can be divided out and the textbook QMDD rule applies directly. The most
   sharing, but a new number type, and "exact" starts to mean something different in the
   interface.

Whichever is chosen, the existing canonicity test — build the same state by different
routes, assert the same node id — carries over unchanged and is the thing to write first.

## Shape of the work

- `src/zomega.js`: unit extraction (and gcd, for option 2). Testable headless, as always.
- `src/evdd.js`: a second manager beside `MTBDD`, same read interface, weights on edges.
  The layout and renderer already consume that interface, so most of the UI is free.
- `src/layout.js`: edge labels; the terminal row collapses to a single `1`.
- UI: a representation switch beside `full tree`, so one state can be seen both ways.
