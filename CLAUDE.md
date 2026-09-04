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
- Layer discipline: `zomega.js` → `poly.js` → `dd.js`/`evdd.js` → `sim.js`/`qasm.js` →
  `layout.js` → `ui.js`. **Only `ui.js` may touch the DOM.** Everything else runs headless
  in Node, which is what makes the test suite possible.

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

A state can be drawn four ways, and `layout.js` produces all of them from one interface:
shared (`dd.js`) or unreduced, with the amplitudes in the terminals or on the edges
(`evdd.js`). The edge-valued forms need a normalisation rule, and since `Z[1/√2, i]` is
not a field that rule is a **parameter**, not a constant — see `docs/EVDD.md` before
changing it. Simulation always runs on `dd.js`; the edge-valued form is converted from it.

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
