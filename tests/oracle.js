// Dense state-vector simulator in floating point: the independent oracle the MTBDD
// engine is checked against. Deliberately dumb and direct — no diagrams, no sharing.

import { toComplexMatrix } from '../src/gates.js';
import { GATES } from '../src/gates.js';

const add = (a, b) => ({ re: a.re + b.re, im: a.im + b.im });
const mul = (a, b) => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });

/** Amplitude index of a basis string, qubit 0 = most significant (see CLAUDE.md). */
export function indexOf(bits) { return parseInt(bits, 2); }

export function basisString(index, n) { return index.toString(2).padStart(n, '0'); }

/** @param {{re:number,im:number}[]} vec */
export function applyGateDense(vec, n, qubits, matrix) {
  const m = toComplexMatrix(matrix);
  const k = qubits.length;
  const dim = 1 << k;
  const out = vec.map(() => ({ re: 0, im: 0 }));
  // Qubit q is bit (n-1-q) of the amplitude index, since qubit 0 is most significant.
  const bitpos = qubits.map((q) => n - 1 - q);
  for (let idx = 0; idx < vec.length; idx++) {
    let c = 0;
    for (let j = 0; j < k; j++) c |= ((idx >> bitpos[j]) & 1) << (k - 1 - j);
    for (let r = 0; r < dim; r++) {
      const e = m[r][c];
      if (e.re === 0 && e.im === 0) continue;
      let target = idx;
      for (let j = 0; j < k; j++) {
        const bit = (r >> (k - 1 - j)) & 1;
        target = bit ? (target | (1 << bitpos[j])) : (target & ~(1 << bitpos[j]));
      }
      out[target] = add(out[target], mul(e, vec[idx]));
    }
  }
  return out;
}

export function applyNamedDense(vec, n, name, qubits) {
  return applyGateDense(vec, n, qubits, GATES[name].matrix);
}
