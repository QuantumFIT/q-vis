# Level-synchronized tree automata

The automata page represents a **set** of quantum states, and the encoding of each one is
the PLDI'23 one: a perfect binary tree of depth n, an internal node at level i decides
qubit i, a leaf holds an amplitude, and every branch is a computational basis state. What
this page adds is the POPL'25 level-synchronized automaton, which changes one thing about
what an automaton may say — and that one thing is the difference between a picture that
stays small and one that does not.

## What a plain tree automaton cannot do

A tree automaton reads the two children of a node **independently**. That is the whole of
the problem.

Applying a gate that mixes siblings — H, and every rotation — sends a node's two subtrees
`(t₀, t₁)` to `(a·t₀ + b·t₁, c·t₀ + d·t₁)`. Both halves have to use the *same* `(t₀, t₁)`.
When the subtrees are sets rather than single trees, a plain automaton cannot say that:
its two children are read apart, and nothing relates them. The only exact answer left is
to take the set apart into its members, transform each, and put it back — which is
correct, and throws away every bit of sharing the automaton was built for.

Measured, on the set of every computational basis state of five qubits:

| | states |
| --- | --- |
| the set, as an automaton | **11** (2n+1) |
| after one Hadamard, as a plain tree automaton | 67 |
| after one Hadamard, level-synchronized | **16** |

The gap is `2ⁿ` against `n`, and it is why the level-synchronized version exists.

## The one idea

Every transition carries a set of **colours**, and a run picks **one colour per level**
that every node on that level must admit:

```
q --{red, blue}--> f(q₀, q₁)
```

The choices stop being local to a node. Two subtrees that both offer the red and the blue
alternative are forced to take the same one — which is exactly the agreement a mixing gate
needs. The papers draw the colours as dots on the transition; so does this page, on the
arc that already marks it.

## What follows from it

**Gates.** Two automata are combined by pairing their transitions and intersecting their
colours. `add`, `mul`, `restrict` and `scale` are all that one product, so `aut-gates.js`
still computes the same equation the decision-diagram page computes —

```
psi' = Σ_r cube(qubits = r) · ( Σ_c M[r][c] · psi|_{qubits = c} )
```

— and never expands a member. Under a single colouring the automaton is an ordinary tree
and every step is ordinary arithmetic on it; over all colourings it is the whole set at
once.

**The invariant.** All of that rests on each colouring picking out **one** run, because
that is what makes the two cofactors being added two halves of the same tree. It holds by
construction: `fromVectors` paints one colour per member and a member is a single tree, so
the alternatives a state offers carry disjoint colours; `reduce` only unites states whose
colours still tell them apart; and a product of two automata that each have one run has
one run. `colourDeterministic` checks it, and `applyGate` refuses rather than
over-approximate.

**Reduction.** Two transitions that agree on one side merge and the other sides unite,
admitted under the colours of both — exact, because the side they agree on is the same
state either way. Then the colours are quotiented: two on one level that no transition
separates are the same colour and are made into one. A set of sixty-four members arrives
painted with sixty-four colours and comes out with two per level, which is the number the
picture can draw and the products can afford.

The merge asks first whether uniting would leave a colour unable to tell the parts apart,
and declines when it would. That costs a little compression and keeps every automaton one
a gate can still be applied to.

## What is checked

The differential oracle, as everywhere else in this repository: after every gate, the
automaton's language must equal the gate applied — by the dense floating-point simulator
in `tests/oracle.js`, which shares no code with any of this — to every member of its
language before. Swept over random sets, random gates and random qubits.

Beside it: that the language survives reduction exactly, that reducing twice is reducing
once, that a colouring picks out one run, and that every basis state of n qubits is 2n+1
states and stays linear through a Hadamard.

## Not built

SWTA weights and cycles (POPL'26); inclusion, emptiness and entailment; reading AutoQ's
own `.aut` files, which the format would make easy — it maps onto `aut-lsta.js` directly
and the amplitude ring already matches.
