# quantum-vis

Watch the **MTBDD** of a pure quantum state change, gate by gate, as a unitary circuit
is applied to it.

- **Circuit**: OpenQASM 2.0, unitary gates only.
- **Input state**: a sparse list of `basis pattern : amplitude`, where amplitudes may be
  concrete or **symbolic**.
- **Output**: a steppable, animatable diagram — with the nodes that this gate created
  picked out in colour, so a glance answers "what did that gate do".

Amplitudes are **exact**, in the ring `Z[1/√2, i]` extended with free symbols. Nothing is
rounded, and two states are equal exactly when their diagrams are the same node.

No dependencies, no CDN, no build step while developing. Ships as one HTML file.

## Try it

```sh
python3 -m http.server 8000     # then open http://localhost:8000/dev.html
```

## Writing the input state

One line per basis pattern. `-` matches either value of that qubit:

```
|00> : a                    # symbols are free variables
|11> : b
0-1  : 1/sqrt(2)            # '-' is a don't-care: 2 basis states, 1 line, 0 extra nodes
----------- : 1/2^5         # a 10-qubit uniform superposition — one terminal
```

Amplitudes are expressions over integers, `i`, `sqrt2`, `omega` (= e^{iπ/4}) and symbols,
combined with `+ - * / ^`. Division must stay exact: `1/2` and `1/(1+i)` are fine, `1/3`
and `0.5` are refused with an explanation rather than silently rounded.

## Which gates work

Clifford+T and anything else whose matrix entries lie in the ring: `x y z h s sdg t tdg
sx sxdg`, controlled forms `cx cy cz ch cs csdg csx ct ctdg`, `swap iswap ccx ccz cswap`,
and `u1`/`p`/`cu1`/`cp` when the angle is a multiple of π/4 (enough for QFT).

Arbitrary rotations such as `rz(π/3)` are **deliberately unsupported**: their entries
leave the ring, which would cost both exactness and the property that equal states have
identical diagrams. `measure`, `reset` and classical control are rejected for the same
kind of reason — this tool shows unitary evolution of a pure state.

## Conventions

Qubit *q* is decided at level *q*, so **qubit 0 is the top of the diagram and the
leftmost bit of the ket**: the path `0,1,1` from the root leads to the amplitude of
`|011>`. Low (0) edges are dashed, high (1) edges solid. Terminals hold amplitudes.

## Development

Developed on Node 24. Nothing in the project needs more than Node 18, but pass the test
runner a glob rather than a directory — since Node 24 a bare directory is resolved as a
module.

```sh
node --test tests/*.test.js    # 57 tests, no node_modules
node tools/build.mjs           # -> quantum-vis.html, one self-contained file
```

The engine is tested against an independent dense state-vector simulator: random
circuits over the whole gate table, checked amplitude by amplitude after *every* gate,
for concrete and symbolic amplitudes alike. Two further checks use exactness in a way a
floating-point simulator could not — `U† U |ψ⟩` must return the *identical* node, and
building the same state by different routes must land on the same node.

`quantum-vis.html` is a build output and is gitignored. Drop that line from
`.gitignore` if you want GitHub Pages to serve it straight from the repository.

See `CLAUDE.md` for the conventions the code relies on.
