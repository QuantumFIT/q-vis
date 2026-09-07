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

// ---- how small a Pauli-LIMDD could possibly be ----------------------------
//
// The diagram in src/limdd.js merges two nodes when their states are equal up to a
// scalar and a local Pauli. Here that equivalence is decided the stupid way, on dense
// vectors and by trying all 4^k Pauli strings, so that the diagram's own count can be
// checked against a number it had no hand in producing.

/** The subfunction at `node` as a dense vector over the ring, qubit `level` first. */
function subvector(dd, node, n, ring) {
  const level = dd.levelOf(node);
  const k = n - level;
  const out = [];
  for (let b = 0; b < (1 << k); b++) {
    let cur = node;
    while (!dd.isTerminal(cur)) {
      const bit = (b >> (k - 1 - (dd.levelOf(cur) - level))) & 1;
      cur = bit ? dd.highOf(cur) : dd.lowOf(cur);
    }
    out.push(dd.valueOf(cur));
  }
  return out;
}

const bits = (m) => { let c = 0; while (m) { c += m & 1; m >>= 1; } return c; };

/**
 * Are two vectors proportional? Asked by cross-multiplication, so that it also works
 * where the ratio is not an element of the ring — u_i v_j = u_j v_i needs no division.
 */
function proportional(ring, u, v) {
  let first = -1;
  for (let i = 0; i < u.length; i++) {
    if (ring.isZero(u[i]) !== ring.isZero(v[i])) return false;
    if (first < 0 && !ring.isZero(u[i])) first = i;
  }
  if (first < 0) return true;
  return u.every((_, i) => ring.eq(ring.mul(u[first], v[i]), ring.mul(u[i], v[first])));
}

function pauliEquivalent(ring, u, v, k) {
  for (let x = 0; x < (1 << k); x++) {
    for (let z = 0; z < (1 << k); z++) {
      const turned = u.map((_, b) => {
        const src = b ^ x;
        return (bits(src & z) & 1) ? ring.neg(v[src]) : v[src];
      });
      if (proportional(ring, u, turned)) return true;
    }
  }
  return false;
}

/** The fewest nodes any Pauli-LIMDD of this state could have, the terminal included. */
export function pauliClassCount(dd, root, n, ring) {
  const byLevel = new Map();
  for (const id of dd.reachable(root)) {
    if (dd.isTerminal(id)) continue;
    const level = dd.levelOf(id);
    if (!byLevel.has(level)) byLevel.set(level, []);
    byLevel.get(level).push(subvector(dd, id, n, ring));
  }
  let total = 1;                                    // the terminal
  for (const [level, vectors] of byLevel) {
    const reps = [];
    for (const v of vectors) {
      if (!reps.some((r) => pauliEquivalent(ring, r, v, n - level))) reps.push(v);
    }
    total += reps.length;
  }
  return total;
}
