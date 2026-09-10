# q-vis

Watch the **MTBDD** of a pure quantum state change, gate by gate, as a unitary circuit is
applied to it.

[![CI](https://github.com/QuantumFIT/q-vis/actions/workflows/ci.yml/badge.svg)](https://github.com/QuantumFIT/q-vis/actions/workflows/ci.yml)

**[Try it →](https://quantum.fit.vut.cz/q-vis/)** — or download the single HTML file and
open it offline. No install, no server, no dependencies.

![The 3-qubit QFT mid-circuit: the diagram, the circuit as a score strip, and the exact amplitudes](docs/screenshot.png)

- **Circuit**: OpenQASM 2.0, unitary gates only.
- **Input state**: a sparse list of `basis pattern : amplitude`, concrete or **symbolic**.
- **Output**: a steppable, animatable diagram, with the nodes this gate created picked out
  in colour and the qubits it acted on marked on their rules.
- The circuit itself is drawn in standard notation above the diagram, and doubles as the
  scrubber: click a column to jump to that step.

Amplitudes are **exact**, in a tower of rings `Z[ζ, 1/√2]` extended with free symbols —
`Z[1/√2, i]` for a Clifford+T circuit, one level finer for every halving of a phase. Nothing is
rounded, and two states are equal precisely when their diagrams are the same node.

## Why a decision diagram

The point is what the structure costs. A uniform superposition over 8 qubits has 256 equal
amplitudes and is **one node**. A 5-qubit GHZ state is 11 nodes, growing by two per qubit;
the same state drawn as an unreduced tree is 63. A 3-qubit QFT gives every basis state a
different phase, so nothing can be shared and the diagram is as large as the state vector.
Grover on 4 qubits ends in **6 nodes**, because the state is symmetric in every unmarked
basis state and sharing captures exactly that — `13/256` on one shared terminal and
`-251/256` on the marked path, exactly, where a float simulator would say 0.98.

The 5-qubit cluster state ends in **6 nodes** in the LIMDD view against 9 edge-valued: a
tower, one node per qubit, which is what every stabilizer state looks like there.

All of them are one click apart in the examples. The ones whose size is the whole point —
GHZ, the cluster state, Grover, a uniform superposition — take a qubit count beside the
picker and generate the circuit, so the growth can be watched rather than described. The
view selector then draws whatever state that is three ways, each with or without sharing.

## Writing the input state

One line per basis pattern. `-` matches either value of that qubit:

```
|00> : a                    # symbols are free variables
|11> : b
0-1  : 1/sqrt(2)            # a don't-care: 2 basis states, 1 line, 0 extra nodes
----------- : 1/2^5         # a 10-qubit uniform superposition — one terminal
0-  : ?                     # two unknowns, a and b
--0-- : ?                   # 16 unknowns a..q, zero where the middle qubit is 1
```

A `?` amplitude gives every basis state the pattern matches its **own** symbol, so a whole
space of inputs can be explored at once — `all symbolic` fills this in for the current
circuit. Symbols are plain letters while there are enough (skipping `i` and `w`, which
already mean the imaginary unit and ω); past that each is named after its basis state,
`a00000` and so on. Write `x?` to force that naming under a chosen prefix; the rest of the
expression still applies, so `?/2` halves each of them.

Amplitudes are expressions over integers, `i`, `sqrt2`, `omega` (= e^{iπ/4}) and symbols,
combined with `+ - * / ^`. Division must stay exact: `1/2` and `1/(1+i)` are fine, while
`1/3` and `0.5` are refused with an explanation rather than silently rounded.

## Which gates work

Clifford+T and anything else whose matrix entries lie in the ring: `x y z h s sdg t tdg
sx sxdg`, controlled forms `cx cy cz ch cs csdg csx ct ctdg`, `swap iswap ccx ccz cswap`,
and `u1`/`p`/`cu1`/`cp` when the angle is π times a dyadic rational — π/4, π/8, π/256.
A finer phase moves the ring up a level instead of rounding, so a QFT is exact at any
width; `π/3` is refused at every level.

The parametrised rotations are there too — `rx ry rz`, their controlled forms `crx cry
crz`, the two-qubit `rxx rzz`, and the general one-qubit gate `u`/`u2`/`u3`/`cu3` — at the
same kind of angle. A rotation turns through *half* its angle, so its entries are a cosine
and a sine rather than a root of unity; those are exact here too, because
cos(θ/2) = (z + z̄)/2 and halving is two factors of 1/√2, which the ring has. The cost is
one level: a rotation reaches π/256 where a phase reaches π/512.

Note that `rz(θ)` is the rotation `diag(e^{-iθ/2}, e^{iθ/2})`, not qelib1's
`gate rz(θ) a { u1(θ) a; }`. The two differ by a global phase, which this tool draws, so
they are not the same picture. The rotation is what `rz` means in current toolchains.

`barrier` is accepted and drawn as a divider between steps in the circuit strip. It has
no effect on the state, since there is no compiler here for it to constrain.

An angle off the dyadic grid, such as `rz(π/3)`, is **deliberately unsupported** at every
level: its entries leave the ring, which would cost both exactness and the property that
equal states have identical diagrams. It is refused rather than rounded. `measure`, `reset`
and classical control are rejected for a related reason — this tool shows unitary evolution
of a pure state.

### A random circuit

`random`, beside `gates`, is a menu whose entries write one into the box: pick the gate
set to draw from, or *any set* to have that drawn too. It goes back to reading `random`
after each pick, so the same set can be rolled again. The set comes first and the gates
only from it, because the set is the interesting variable: a Clifford circuit and a
Clifford+T circuit of the same length give diagrams of quite different character, and
landing on one of those characters at random is more use than a uniform soup of every
gate the parser knows.

| set | what its diagrams show |
| --- | --- |
| Clifford | a stabilizer state — the Pauli-LIMDD is a tower, one node per qubit |
| Clifford+T | universal; the T gates take the amplitude ring past level 4 |
| Toffoli–Hadamard | real amplitudes: every one is an integer over a power of √2 |
| diagonal | nothing moves between basis states, only the phases change |
| rotations | the parametrised gates, at angles the ring still holds |
| mixed | no class in particular |

The generated circuit is ordinary text: the header comment names the set, says what to
watch for, and records the seed, so a roll worth keeping survives editing, a permalink,
and being pasted somewhere else. `src/random.js` is a pure function of that seed.

The Clifford case is worth a few picks on its own. Theorem 1 of the Pauli-LIMDD paper says
a state is a stabilizer state *exactly* when its LIMDD is a tower, and rolling Clifford
circuits is a way to watch that hold on states nobody chose — 40 seeds of it are a test.

## Three ways to draw one state, times a toggle

The selector chooses what the diagram puts on its edges. Each answers a different
question, and each shares subfunctions under a wider notion of sameness than the one
above it, so each is at most as large.

| representation | what it shows |
| --- | --- |
| **MTBDD** | the default: amplitudes in the terminals, and two subfunctions share a node when they are *equal* |
| **EVDD** | amplitudes on the edges and one terminal, so subfunctions equal *up to a scalar* are shared too |
| **Pauli-LIMDD** | a Pauli string on each edge as well, so subfunctions equal *up to a local Pauli* are shared |

**full tree** then draws whichever of the three you are looking at with nothing shared, so
the sharing can be seen for what it saves. For the first two it is the complete binary
tree of the state; for the LIMDD it is the diagram unfolded, every shared node copied out
along each path that reaches it.

The 3-qubit QFT is the case that separates the first two: 15 nodes reduced, and **4**
edge-valued, because its amplitudes differ only by phases and phases factor onto the
edges. The cluster state separates the third: 9 edge-valued, 6 as a LIMDD, and a
stabilizer state is a tower there whatever its graph. Where there are edge weights, a
second selector
chooses which edge the normalisation factor is taken from — the choice Q-Sylvan calls
`norm-low`, `norm-min` and `norm-max`. `docs/EVDD.md` maps those onto what is expressible
here, and explains why the ring not being a field makes this a decision rather than a
formula; `docs/LIMDD.md` does the same for the Pauli labels, where the ring turns out to
matter much less.

## Reading the amplitudes

Amplitudes are shown exactly by default: `1/√2`, `(1-i)/2`, `ω` (explained on the plate
whenever it appears). The picker switches to floating point, either rectangular
(`0.5-0.5i`) or polar with the angle in degrees (`0.3536∠-45°`), radians
(`0.3536∠-0.7854`) or multiples of π (`0.3536∠-π/4`). Symbolic amplitudes keep their
symbols in every mode; only the coefficient changes: `0.7071a + 0.7071b`.

**tuple (a,b,c,d)** is the algebraic form used in the MEDUSA/SliQSim literature: `(a,b,c,d)`
standing for `(a·ω³ + b·ω² + c·ω + d)/√2^k`. The `k` is not part of each tuple, because a
state is written over one common power of √2 — the plate names that power under the
diagram, and it changes from step to step. In this form the 3-qubit QFT is exactly the
eight signed unit tuples.

Polar is the one to reach for when a circuit only moves phase around — the 3-qubit QFT
prints as eight amplitudes of identical magnitude and eight different angles. Every angle
in this ring is π times a dyadic rational, so the π form stays exact where the other two
round.

## How entangled is it

`entanglement`, in the transport, answers that in the two ways worth asking about the
state at the current step.

**Entanglement depth** is the size of the largest group of qubits that has to be entangled
at once — the finest partition the state is a product over, which the panel shows. A depth
of 1 is a product state; a depth of *n* means nothing at all factors out.

This half is **exact**. "These qubits factor out" is a Schmidt rank of one, and a rank of
one says only that certain products are equal, so it is decided on the ring with no
tolerance anywhere — symbolic amplitudes included.

The blocks are found by searching subsets, and there is no shortcut through pairwise
tests. Take `q2 = q0 XOR q1` on three uniform qubits: every *pair* of its qubits is
completely uncorrelated, and yet no qubit factors out and its depth is three. The search
is exhaustive because anything cheaper gets that state wrong. Past about twelve qubits it
says so rather than making you wait.

**A Schmidt decomposition** of any split you name — type the qubits on one side, in the
circuit's own names or as bare indices — gives the Schmidt rank, the coefficients, and the
entanglement entropy across it.

This half is **floating point**, and the panel says so. Schmidt coefficients are square
roots of eigenvalues and are not ring elements even when every amplitude is, so there is
nothing exact to be had. Where the two halves overlap they agree: rank 1 from the
numerical side is exactly the case the ring can decide, and a test checks that on every
bipartition of every worked example.

## Sharing a view

**copy link** puts the whole view in the URL — circuit, input state, which gate you are
on, and how it is drawn (tree or reduced, zeros hidden or not, exact or numeric). Opening
that link reproduces exactly what you were looking at, which is what you want when
pointing at one step from lecture notes, an issue, or a paper. **export SVG** saves the
current diagram as a standalone figure, legend included.

**TikZ diagram** and **TikZ circuit** give the same two things as LaTeX instead — the
diagram as `\node`s and `\draw`s, the circuit as `quantikz` — in a dialog so the code can
be read before it is taken. Amplitudes are translated on the way (`√2` to `\sqrt{2}`, `ω³`
to `\omega^{3}`), and the TikZ styles come with the picture, so every low edge or terminal
can be restyled in one place. That is what belongs in a paper: text in the document's own
fonts, editable afterwards, rather than an SVG at a size nobody chose.

**Every boundary can be dragged.** The input column against the plate, each panel against
the next, and the circuit against the diagram. Double-click a boundary to put it back, or
focus it and use the arrow keys; **Amplitudes** folds away by its own header. Sizes and
folds are remembered, so a layout you set once stays set.

**order** decides which qubit each level of the diagram decides — *as written*, *reversed*,
*paired*, or any permutation typed in, top level first in the circuit's own names —
`q[0] q[2] q[1] b[0]`, which is what several registers flattened into one run makes of
`0 2 1 3`. It is the biggest lever there is on
how big a diagram gets: **Nested Bell pairs** on eight qubits is 47 nodes as written and 14
when paired, the same state either way. **sift** searches for an order that makes the widest
frame smaller. Only the rows move: a ket and a Pauli string are always written in qubit
order. See `docs/ORDER.md`.

**tableau**, in the Pauli-LIMDD view only, gives the stabilizer group of every node in the
current step — a sign, the two check-vector blocks with the qubit index over each column,
and the string of `I/X/Y/Z`. The
diagram computes these groups anyway, to choose its edge labels; the button is where you
can read them. A node whose rank matches the number of qubits below it is a stabilizer
state, which is why the diagram is a tower there. See `docs/LIMDD.md`.

A copied link points at a frozen copy of the version that made it — `…/q-vis/v/v10/#…` —
so it keeps showing what it showed even after the settings it encodes change meaning. An
exported snippet carries both that link and the current page, since a pinned link cannot
tell a reader that a newer version exists.
Every release is kept at [`/v/`](https://quantum.fit.vut.cz/q-vis/v/), and the archived
page links back to the current one. `docs/VERSIONS.md` says how that is built, and how to
cut a release.

## Conventions

Qubit *q* is decided at level *q*, so **qubit 0 is the top of the diagram and the leftmost
bit of the ket**: the path `0,1,1` from the root leads to the amplitude of `|011>`. Low (0)
edges are dashed, high (1) edges solid, and terminals hold amplitudes.

## Development

No dependencies and no build step while developing: `dev.html` loads the ES modules
directly, so a change is one reload away.

```sh
python3 -m http.server 8000    # then open http://localhost:8000/dev.html
node --test tests/*.test.js    # 81 tests, no node_modules
node tools/build.mjs           # -> q-vis.html, one self-contained file
```

Developed on Node 24. Nothing in the project needs more than Node 18, but pass the test
runner a glob rather than a directory — since Node 24 a bare directory is resolved as a
module.

The engine is tested against an independent dense state-vector simulator: random circuits
over the whole gate table, checked amplitude by amplitude after *every* gate, for concrete
and symbolic amplitudes alike. Two further checks use exactness in a way a floating-point
simulator could not — `U† U |ψ⟩` must return the *identical* node, and building the same
state by different routes must land on the same node.

`CLAUDE.md` records the conventions the code relies on and why, and is worth reading before
changing the algebra or the layout.

## Licence

MIT — see [LICENSE](LICENSE).
