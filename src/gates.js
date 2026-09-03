// Gate matrices, exact in Z[1/sqrt(2), i].
//
// A k-qubit gate is a 2^k x 2^k matrix of ring scalars. Row/column indices are read
// with the *first* qubit passed to the gate as the most significant bit: for a CX
// applied to [control, target], index 2 = |10> = "control set, target clear".
//
// Only gates whose entries lie in the ring are expressible. That is exactly Clifford+T
// (plus controlled versions, SWAP, iSWAP, sqrt(X)); parametrised rotations rx/ry/rz
// with an arbitrary angle are deliberately not supported — see CLAUDE.md.

import * as Z from './zomega.js';

const O = Z.ZERO, L = Z.ONE, NL = Z.MINUS_ONE, I = Z.I, NI = Z.MINUS_I;
const H2 = Z.INV_SQRT2, NH2 = Z.neg(Z.INV_SQRT2);
const P1 = Z.mul(Z.OMEGA, Z.INV_SQRT2);    // (1+i)/2
const P2 = Z.conj(P1);                     // (1-i)/2

/** Identity of dimension `d`. */
export function identity(d) {
  return Array.from({ length: d }, (_, r) => Array.from({ length: d }, (_, c) => (r === c ? L : O)));
}

/** Conjugate transpose. */
export function dagger(m) {
  const d = m.length;
  return Array.from({ length: d }, (_, r) => Array.from({ length: d }, (_, c) => Z.conj(m[c][r])));
}

export function matMul(a, b) {
  const d = a.length;
  return Array.from({ length: d }, (_, r) => Array.from({ length: d }, (_, c) => {
    let acc = O;
    for (let i = 0; i < d; i++) acc = Z.add(acc, Z.mul(a[r][i], b[i][c]));
    return acc;
  }));
}

/** `nc` control qubits (listed first) on top of `m`. */
export function controlled(m, nc = 1) {
  const d = m.length * (1 << nc);
  const out = identity(d);
  const off = d - m.length;
  for (let r = 0; r < m.length; r++) for (let c = 0; c < m.length; c++) out[off + r][off + c] = m[r][c];
  return out;
}

export const X = [[O, L], [L, O]];
export const Y = [[O, NI], [I, O]];
export const ZZ = [[L, O], [O, NL]];
export const H = [[H2, H2], [H2, NH2]];
export const S = [[L, O], [O, I]];
export const SDG = [[L, O], [O, NI]];
export const T = [[L, O], [O, Z.OMEGA]];
export const TDG = [[L, O], [O, Z.OMEGA_INV]];
export const SX = [[P1, P2], [P2, P1]];
export const SXDG = dagger(SX);
export const SWAP = [[L, O, O, O], [O, O, L, O], [O, L, O, O], [O, O, O, L]];
export const ISWAP = [[L, O, O, O], [O, O, I, O], [O, I, O, O], [O, O, O, L]];

/** name -> { matrix, arity, label }. Labels are what the circuit strip will draw. */
export const GATES = {
  id: { matrix: identity(2), label: 'I' },
  x: { matrix: X, label: 'X' },
  y: { matrix: Y, label: 'Y' },
  z: { matrix: ZZ, label: 'Z' },
  h: { matrix: H, label: 'H' },
  s: { matrix: S, label: 'S' },
  sdg: { matrix: SDG, label: 'S†' },
  t: { matrix: T, label: 'T' },
  tdg: { matrix: TDG, label: 'T†' },
  sx: { matrix: SX, label: '√X' },
  sxdg: { matrix: SXDG, label: '√X†' },
  cx: { matrix: controlled(X), label: 'CX', controls: 1 },
  cy: { matrix: controlled(Y), label: 'CY', controls: 1 },
  cz: { matrix: controlled(ZZ), label: 'CZ', controls: 1 },
  ch: { matrix: controlled(H), label: 'CH', controls: 1 },
  cs: { matrix: controlled(S), label: 'CS', controls: 1 },
  csdg: { matrix: controlled(SDG), label: 'CS†', controls: 1 },
  csx: { matrix: controlled(SX), label: 'C√X', controls: 1 },
  ct: { matrix: controlled(T), label: 'CT', controls: 1 },
  ctdg: { matrix: controlled(TDG), label: 'CT†', controls: 1 },
  swap: { matrix: SWAP, label: 'SWAP', swap: true },
  iswap: { matrix: ISWAP, label: 'iSWAP', swap: true },
  ccx: { matrix: controlled(X, 2), label: 'CCX', controls: 2 },
  ccz: { matrix: controlled(ZZ, 2), label: 'CCZ', controls: 2 },
  cswap: { matrix: controlled(SWAP), label: 'CSWAP', controls: 1, swap: true },
};

for (const [name, g] of Object.entries(GATES)) {
  g.name = name;
  g.arity = Math.log2(g.matrix.length);
}

/** w^m, i.e. e^{i*m*pi/4}, for any integer m. */
export function omegaPow(m) {
  let acc = L;
  const r = ((m % 8) + 8) % 8;
  for (let i = 0; i < r; i++) acc = Z.mul(acc, Z.OMEGA);
  return acc;
}

/**
 * The phase gate diag(1, e^{i*m*pi/4}). This is how `u1`/`p` from qelib1 enters the
 * ring: an angle that is a multiple of pi/4 is exactly representable, any other is not.
 */
export function phaseGate(m) { return [[L, O], [O, omegaPow(m)]]; }

/** Numeric matrix, for the floating-point oracle. */
export function toComplexMatrix(m) {
  return m.map((row) => row.map(Z.toComplex));
}
