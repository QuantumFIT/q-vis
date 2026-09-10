// Gate matrices, exact in Z[zeta, 1/sqrt(2)].
//
// A k-qubit gate is a 2^k x 2^k matrix of ring scalars. Row/column indices are read
// with the *first* qubit passed to the gate as the most significant bit: for a CX
// applied to [control, target], index 2 = |10> = "control set, target clear".
//
// Only gates whose entries lie in the ring are expressible. The fixed table below is
// Clifford+T (plus controlled versions, SWAP, iSWAP, sqrt(X)); the parametrised gates
// built further down cover rx/ry/rz/u and friends at any angle that is pi times a
// dyadic rational, which is exactly the set the ring reaches. An angle like pi/3 has no
// form here at any level and is refused rather than rounded — see CLAUDE.md.

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
const Y = [[O, NI], [I, O]];
const ZZ = [[L, O], [O, NL]];
export const H = [[H2, H2], [H2, NH2]];
export const S = [[L, O], [O, I]];
const SDG = [[L, O], [O, NI]];
export const T = [[L, O], [O, Z.OMEGA]];
const TDG = [[L, O], [O, Z.OMEGA_INV]];
const SX = [[P1, P2], [P2, P1]];
const SXDG = dagger(SX);
export const SWAP = [[L, O, O, O], [O, O, L, O], [O, L, O, O], [O, O, O, L]];
const ISWAP = [[L, O, O, O], [O, O, I, O], [O, I, O, O], [O, O, O, L]];

/** name -> { matrix, arity, label }. Labels are what the circuit strip will draw. */
export const GATES = {
  id: { matrix: identity(2), label: 'I', doc: 'does nothing', draw: { controls: 0, target: 'box', symbol: 'I' } },
  x: { matrix: X, label: 'X', doc: 'bit flip', draw: { controls: 0, target: 'box', symbol: 'X' } },
  y: { matrix: Y, label: 'Y', doc: 'bit flip with a phase', draw: { controls: 0, target: 'box', symbol: 'Y' } },
  z: { matrix: ZZ, label: 'Z', doc: 'flips the sign of |1>', draw: { controls: 0, target: 'box', symbol: 'Z' } },
  h: { matrix: H, label: 'H', doc: 'Hadamard: |0> becomes (|0>+|1>)/√2', draw: { controls: 0, target: 'box', symbol: 'H' } },
  s: { matrix: S, label: 'S', doc: 'multiplies |1> by i', draw: { controls: 0, target: 'box', symbol: 'S' } },
  sdg: { matrix: SDG, label: 'S†', doc: 'inverse of s', draw: { controls: 0, target: 'box', symbol: 'S†' } },
  t: { matrix: T, label: 'T', doc: 'multiplies |1> by ω', draw: { controls: 0, target: 'box', symbol: 'T' } },
  tdg: { matrix: TDG, label: 'T†', doc: 'inverse of t', draw: { controls: 0, target: 'box', symbol: 'T†' } },
  sx: { matrix: SX, label: '√X', doc: 'square root of X', draw: { controls: 0, target: 'box', symbol: '√X' } },
  sxdg: { matrix: SXDG, label: '√X†', doc: 'inverse of sx', draw: { controls: 0, target: 'box', symbol: '√X†' } },
  cx: { matrix: controlled(X), label: 'CX', controls: 1, doc: 'flips the target when the control is 1', draw: { controls: 1, target: 'not' } },
  cy: { matrix: controlled(Y), label: 'CY', controls: 1, doc: 'applies Y to the target when the control is 1', draw: { controls: 1, target: 'box', symbol: 'Y' } },
  cz: { matrix: controlled(ZZ), label: 'CZ', controls: 1, doc: 'flips the sign of |11>', draw: { controls: 1, target: 'dot' } },
  ch: { matrix: controlled(H), label: 'CH', controls: 1, doc: 'applies H to the target when the control is 1', draw: { controls: 1, target: 'box', symbol: 'H' } },
  cs: { matrix: controlled(S), label: 'CS', controls: 1, doc: 'applies S to the target when the control is 1', draw: { controls: 1, target: 'box', symbol: 'S' } },
  csdg: { matrix: controlled(SDG), label: 'CS†', controls: 1, doc: 'applies S† to the target when the control is 1', draw: { controls: 1, target: 'box', symbol: 'S†' } },
  csx: { matrix: controlled(SX), label: 'C√X', controls: 1, doc: 'applies √X to the target when the control is 1', draw: { controls: 1, target: 'box', symbol: '√X' } },
  ct: { matrix: controlled(T), label: 'CT', controls: 1, doc: 'applies T to the target when the control is 1', draw: { controls: 1, target: 'box', symbol: 'T' } },
  ctdg: { matrix: controlled(TDG), label: 'CT†', controls: 1, doc: 'applies T† to the target when the control is 1', draw: { controls: 1, target: 'box', symbol: 'T†' } },
  swap: { matrix: SWAP, label: 'SWAP', swap: true, doc: 'exchanges two qubits', draw: { controls: 0, target: 'swap' } },
  iswap: { matrix: ISWAP, label: 'iSWAP', swap: true, doc: 'exchanges two qubits and multiplies the swapped amplitudes by i', draw: { controls: 0, target: 'swap', symbol: 'i' } },
  ccx: { matrix: controlled(X, 2), label: 'CCX', controls: 2, doc: 'Toffoli: flips the target when both controls are 1', draw: { controls: 2, target: 'not' } },
  ccz: { matrix: controlled(ZZ, 2), label: 'CCZ', controls: 2, doc: 'flips the sign of |111>', draw: { controls: 2, target: 'dot' } },
  cswap: { matrix: controlled(SWAP), label: 'CSWAP', controls: 1, swap: true, doc: 'Fredkin: exchanges the last two qubits when the control is 1', draw: { controls: 1, target: 'swap' } },
  // Three controls, which a Grover diffuser on four qubits needs. Not in qelib1 — but
  // neither is ccz, and the entries are integers, so both are exact here.
  c3x: { matrix: controlled(X, 3), label: 'C³X', controls: 3, doc: 'flips the target when all three controls are 1', draw: { controls: 3, target: 'not' } },
  c3z: { matrix: controlled(ZZ, 3), label: 'C³Z', controls: 3, doc: 'flips the sign of |1111>', draw: { controls: 3, target: 'dot' } },
};

for (const [name, g] of Object.entries(GATES)) {
  g.name = name;
  g.arity = Math.log2(g.matrix.length);
}

export const omegaPow = Z.omegaPow;   // e^{i*m*pi/4}

/**
 * The phase gate diag(1, e^{i*pi*j/d}). This is how `u1`/`p` from qelib1 enters the ring:
 * an angle that is pi times a dyadic rational is exactly representable at level d, any
 * other angle is not representable at all. Called with one argument it is the quarter
 * turn it always was, diag(1, w^m).
 */
export function phaseGate(j, d = Z.BASE_LEVEL) { return [[L, O], [O, Z.rootPow(j, d)]]; }

// ---- parametrised rotations ------------------------------------------------
//
// An angle of pi*j/d is a root of unity, which is why `phaseGate` above is exact. A
// *rotation* by that angle is not made of roots of unity at all — its entries are the
// cosine and sine of the half angle. They are still in the ring, and for a reason worth
// stating: with z = e^{i*pi/D},
//
//     cos(pi*j/D) = (z^j + z^-j)/2      sin(pi*j/D) = -i (z^j - z^-j)/2
//
// so the only thing needed beyond a root of unity is a division by two — and 1/2 is
// (1/sqrt(2))^2, which the ring has. Every rotation by pi times a dyadic rational is
// therefore exact here, one level finer than the angle itself: rx(pi/4) is built at
// level 8, not 4.
//
// Angles arrive as `{ j, d }` meaning pi*j/d, the form `dyadicTurns` in qasm.js produces.

/** Divide by two: two factors of 1/sqrt(2), which is exact. */
const half = (a) => Z.mul(Z.mul(a, H2), H2);

/** cos and sin of half of pi*j/d, exactly. */
function cosSin({ j, d }) {
  const D = 2 * d;
  const up = Z.rootPow(j, D);
  const down = Z.rootPow(-j, D);
  return { c: half(Z.add(up, down)), s: half(Z.mul(NI, Z.sub(up, down))) };
}

/** Rx(t) = exp(-i t X/2), the rotation about x. */
export function rxGate(t) {
  const { c, s } = cosSin(t);
  const m = Z.mul(NI, s);
  return [[c, m], [m, c]];
}

/** Ry(t) = exp(-i t Y/2). Real, and the only rotation that is. */
export function ryGate(t) {
  const { c, s } = cosSin(t);
  return [[c, Z.neg(s)], [s, c]];
}

/**
 * Rz(t) = exp(-i t Z/2) = diag(e^{-it/2}, e^{it/2}).
 *
 * Note this is the *rotation*, not qelib1's `gate rz(t) a { u1(t) a; }`, which differs
 * from it by a global phase of e^{-it/2}. The two are the same operation on a state
 * vector up to that phase, and this tool draws the phase, so they are drawn differently.
 * The rotation is what `rz` means in every current toolchain, so it is what is meant here.
 */
export function rzGate({ j, d }) {
  return [[Z.rootPow(-j, 2 * d), O], [O, Z.rootPow(j, 2 * d)]];
}

/** Rxx(t) = exp(-i t X⊗X/2). */
export function rxxGate(t) {
  const { c, s } = cosSin(t);
  const m = Z.mul(NI, s);
  return [[c, O, O, m], [O, c, m, O], [O, m, c, O], [m, O, O, c]];
}

/** Rzz(t) = exp(-i t Z⊗Z/2), diagonal. */
export function rzzGate({ j, d }) {
  const a = Z.rootPow(-j, 2 * d);
  const b = Z.rootPow(j, 2 * d);
  return [[a, O, O, O], [O, b, O, O], [O, O, b, O], [O, O, O, a]];
}

/**
 * The general single-qubit gate of qelib1: U(t, p, l), which u3 and u are spellings of
 * and u2/u1 are special cases of. The matrix is the one in the OpenQASM 2 spec.
 */
export function uGate(t, p, l) {
  const { c, s } = cosSin(t);
  const ep = Z.rootPow(p.j, p.d);
  const el = Z.rootPow(l.j, l.d);
  return [[c, Z.neg(Z.mul(el, s))], [Z.mul(ep, s), Z.mul(Z.mul(ep, el), c)]];
}

/** Numeric matrix, for the floating-point oracle. */
export function toComplexMatrix(m) {
  return m.map((row) => row.map(Z.toComplex));
}
