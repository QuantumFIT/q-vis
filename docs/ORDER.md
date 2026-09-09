# The qubit order

Every diagram here decides one qubit per level, top to bottom. **Which** qubit is a choice,
and in decision-diagram terms it is *the* choice: the same function can be linear under one
order and exponential under another. A tool about how big a diagram is and why has to let
you turn that knob.

The **order** control does. Three presets and a field:

| | |
| --- | --- |
| **as written** | level `i` decides qubit `i` — what the diagram always did |
| **reversed** | level `i` decides qubit `n−1−i` |
| **paired** | `0, n−1, 1, n−2, …`, which brings qubit `i` next to qubit `n−1−i` |
| **custom…** | type the qubits, top level first: `0 7 1 6 2 5 3 4` |

## What it costs, in one example

**Nested Bell pairs** exists to be looked at under two orders. It puts a Bell pair between
qubit `i` and qubit `n−1−i`, so as written the diagram has to remember the whole first half
of the bits before it can decide any of the second half:

| qubits | as written | paired |
| --- | --- | --- |
| 4 | 11 | 8 |
| 6 | 23 | 11 |
| 8 | **47** | **14** |
| 10 | 95 | 17 |
| 12 | 191 | 20 |

`3·2^(n/2) − 1` against `3n/2 + 2`. Same circuit, same state, same amplitudes — one switch.

The QFT is the other lesson: sift it and nothing improves, because all `2^n` of its
amplitudes differ and no order can share anything. Order is not a cure.

## What moves and what does not

**Only the rows.** A ket is written in qubit order and so is a Pauli string, always, so the
notation never depends on the order and you never have to permute anything in your head:

- the gutter names each row for the qubit it decides;
- the amplitude list shows `|0101⟩` with qubit 0 first, whatever level qubit 0 sits at;
- a tableau's check-vector columns are in qubit order, and where that differs from the row
  order the tableau says both;
- the circuit strip stays in circuit order. It is the circuit as written, not a picture of
  the diagram.

`tests/order.test.js` holds the assertion the whole feature rests on: for every example at
every size, under every order, every amplitude is unchanged. Reordering may only change the
picture.

## sift

**sift** searches for an order that makes the *largest frame* smaller — the largest,
because the plate is sized for the widest frame of the run and that is what decides whether
the picture is drawable.

One pass of classic sifting: take each qubit in turn, try it at every position, keep the
best. About `n²/2` rebuilds, which is affordable only because it measures on the cheap
path — an MTBDD and `simulate`, whose per-frame sizes come for free — and never builds a
layout or an edge-valued diagram. Measured on the QFT at 7 qubits, `simulate` is 21 ms
against 484 ms for the conversion and layout on top of it, so the difference between the
two paths is the difference between a quarter of a second and twelve.

It times the first rebuild and refuses the search if `n²/2` of them would take more than
about three seconds, saying how long it would have been — a measured ceiling rather than a
qubit limit that would be wrong in both directions.

## In a link

A copied link carries the order as `o=0-7-1-6-2-5-3-4`, and only when it is not the
identity, so every link written before this existed still means what it meant. What travels
is the permutation, not which preset produced it: a preset is a way of typing one.

## Where it lives in the code

`src/order.js` is the permutation and nothing else — the presets, `invert`, `parse`,
`format`, and the two directions a bit string can be permuted, named apart because
confusing them is the one way to get this wrong.

The diagram needed no changes at all. `src/dd.js` was already level-indexed throughout, and
`applyGate` in `src/sim.js` already took its qubits as levels and said so. The permutation
lives at seven boundaries, each taking it as an optional argument that defaults to the
identity:

| boundary | where |
| --- | --- |
| gate application | `applyOp` in `src/sim.js` |
| the input state | `buildState` in `src/state.js` |
| the gutter labels | `resetCanvas` and the layout's labels, `src/ui.js` |
| the acting highlight | `drawFrame` in `src/ui.js` |
| the amplitude list | `renderReadout` in `src/ui.js` |
| Pauli strings | `formatString` in `src/pauli.js` |
| tableau blocks | `blockBits` in `src/tableau.js` |
