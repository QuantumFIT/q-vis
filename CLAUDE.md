# q-vis — project conventions

Web app that visualises how an **MTBDD representing a pure quantum state** evolves,
gate by gate, as a unitary circuit (OpenQASM) is applied to it. Teaching/demo tool.

## Hard constraints

- **No runtime dependencies. No CDN. No build step in the dev loop.**
  Source is native ES modules in `src/`, loaded by `dev.html` via `<script type="module">`.
  `tools/build.mjs` inlines everything into a single self-contained `q-vis.html`
  that works offline from `file://`. Same idea as `~/qf-art/wrap.py`.
- **No TypeScript compiler.** Types are documented with JSDoc only.
- `node --test tests/*.test.js` must pass with **zero `node_modules`**. Tests import the
  exact same ES modules the browser loads. (Pass the glob, not the directory: since
  Node 24 a bare directory argument is resolved as a module and fails.)
- Layer discipline: `zomega.js` → `poly.js` → `dd.js`/`evdd.js`/`limdd.js` →
  `sim.js`/`qasm.js` → `layout.js` → `ui.js`, with `pauli.js` → `stabilizer.js` →
  `limdd.js` off to the side. **Only `ui.js` may touch the DOM.** Everything else runs headless
  in Node, which is what makes the test suite possible.

## Previewing

Push a branch to `preview` and it is published at `/preview/` for review; the site root
keeps serving `master`, because the deploy job checks master out whatever ref started it.

```
git push -f origin HEAD:preview
```

Hand over the link — <https://quantum.fit.vut.cz/q-vis/preview/> — whenever a task is
pushed there, so it can be clicked from the message rather than looked up. It refreshes
about a minute after the push.

Delete the branch when the change lands — `/preview/` goes on the next deploy. Details in
`docs/VERSIONS.md`.

## Releasing

**Tag every deploy worth linking to.** `copy link` in a released build points at the
frozen copy of that build under `/v/<tag>/`, which is how a shared link keeps showing what
it showed. An untagged build stamps itself `dev` and copies plain root links instead.

```
git tag -a v12 -m "One line saying what this release added"
git push origin master --atomic --follow-tags
```

**Nothing lands on master until Ondra has reviewed the preview and says to deploy**, and
the release is tagged in the same push. Master is therefore always exactly at a tag — work
in progress lives on `preview`, never on master.

Tag the commit being deployed, and push both refs together: only `master` may deploy, so a
tag push on its own is refused by the environment, and a root build that is not exactly at
a tag stamps itself `dev` and stops pinning links.

`tools/release.mjs` rebuilds every tag from its own source on each deploy, so the archive
is a function of the repository alone. See `docs/VERSIONS.md`.

## Domain conventions (fixed — do not silently change)

- **Qubit *q* lives at DD level *q*.** Qubit 0 is the *top* of the diagram and the
  *leftmost* bit of the ket: path `0,1,1` from the root means basis state `|011>`,
  i.e. q0=0, q1=1, q2=1. (This is big-endian, the opposite of Qiskit's display order.
  It is chosen so that reading the diagram top-to-bottom reads the ket left-to-right.)
- **Terminals hold the amplitude** of the basis state spelled by the path to them.
- **Low edge (variable = 0) is dashed; high edge (variable = 1) is solid.**
- MTBDD reduction is the usual one: a node whose two children are identical is skipped,
  and identical subgraphs are shared (hash-consing). Reduction is applied eagerly, so
  **structural equality of node ids is semantic equality** — the whole design leans on this.
- A skipped level means "this variable is a don't-care here", *not* "this qubit is absent".

## Representations

A state can be drawn three ways — amplitudes in the terminals (`dd.js`), on the edges
(`evdd.js`), or on the edges with a Pauli string beside them (`limdd.js`) — each with or
without sharing, and `layout.js` produces all six from one interface. The unshared LIMDD
is the diagram *unfolded* (`layoutEdgeValuedTree`) rather than rebuilt, because which
labels it chooses depends on the diagram it is building. The edge-valued
forms need a normalisation rule, and since `Z[1/√2, i]` is not a field that rule is a
**parameter**, not a constant — see `docs/EVDD.md` before changing it. The Pauli half of a
LIMDD label needs no such rule, because a Pauli string inverts over any ring; that split
is `docs/LIMDD.md`. Simulation always runs on `dd.js`; both other forms are converted
from it.

## Amplitude algebra

Amplitudes live in `Z[1/sqrt2, i]`, extended to polynomials in free symbols for symbolic input.

- `zomega.js`: exact scalar `(c0 + c1*w + c2*w^2 + c3*w^3) / sqrt(2)^k` with `w = e^{i*pi/4}`,
  `w^4 = -1`, integer coefficients as **BigInt**, `k >= 0` and minimal.
  This is the MEDUSA/SliQSim encoding written in the `w`-power basis; the classic
  `(a,b,c,d,k)` tuple is `(c3,c2,c1,c0,k)`.
  Canonical: `sqrt2 = w - w^3` is prime in `Z[w]`, so the minimal-`k` form is unique.
- `poly.js`: multivariate polynomials over that scalar ring, canonical normal form
  (zero coefficients dropped, monomials sorted). Gates are linear, so in practice
  amplitudes stay linear in the input symbols — but the implementation is general.
- Supported gate set is therefore **Clifford+T** (plus controlled/multi-controlled versions,
  SWAP, and any gate whose matrix entries lie in the ring). Arbitrary `rx/ry/rz(theta)`
  is deliberately **out of scope**: it would break exactness and canonicity.

## Style

- Small modules, plain functions, no classes except the DD manager.
- Comment *why*, not *what*. The algebra needs the why (identities, normal forms).
- Prefer obviously-correct over fast: this is a visualiser for circuits of ~20 qubits,
  not a competitive simulator. Where a faster algorithm was rejected, say so in a comment.

## Testing

Every engine change ships with tests. The three that matter:
1. **Differential oracle** — dense state-vector simulator in floating point; random circuits;
   assert `dd.evaluate(x) ~= sv[x]` after *every* gate.
2. **Canonicity** — build the same function by different routes, assert identical root id.
3. **Ring laws** — associativity, distributivity, normal-form idempotence, over random elements.
