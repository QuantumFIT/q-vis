# quantum-vis

Visualising the evolution of an **MTBDD** representing a pure quantum state as a
unitary circuit is applied to it, gate by gate.

- Input: an OpenQASM circuit (unitary gates only) + a pure state given as a sparse
  list of `basis state -> amplitude`, where amplitudes may be **symbolic**.
- Output: a steppable/animatable rendering of the decision diagram after each gate.

Exact arithmetic in `Z[1/sqrt2, i]` (Clifford+T), extended to polynomials in free
symbols. No dependencies, no build step; ships as a single self-contained HTML file.

## Development

Requires Node 20.19+ (the test runner and the tooling assume it).

```sh
python3 -m http.server 8000   # then open http://localhost:8000/dev.html
node --test tests/*.test.js   # no node_modules required
node tools/build.mjs          # -> quantum-vis.html (single file)
```

See `CLAUDE.md` for the conventions the code relies on.
