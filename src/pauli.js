// Pauli local invertible maps: the labels that turn an edge-valued diagram into a LIMDD.
//
// A LIM is a scalar times a tensor product of single-qubit Pauli matrices. Written in the
// form used throughout,
//
//     A = w * (X^x_0 Z^z_0) (x) (X^x_1 Z^z_1) (x) ... (x) (X^x_n-1 Z^z_n-1)
//
// it is a ring weight `w` plus two bitmasks, bit j standing for qubit j — the same
// numbering the diagram uses, so qubit 0 is at the top. Every LIM here carries masks for
// all n qubits, with I above the level it labels, which spares the algebra any special
// case for the levels an MTBDD skips.
//
// Keeping the string in X^x Z^z form rather than as letters is what makes the phases
// easy: a product of two such strings is another one times +-1, never +-i, so all the
// phase bookkeeping folds into `w` through `ring.neg`. Y only appears when a string is
// printed, since X Z = -i Y.
//
// The point of all this is that a Pauli string is invertible over *any* ring — X, Z and
// their products square to +-I — which is what lets the diagram factor Paulis out of
// edges even though it cannot always divide by a weight. See docs/LIMDD.md.

/** Number of set bits, for 32-bit masks. */
export function popcount(m) {
  m -= (m >> 1) & 0x55555555;
  m = (m & 0x33333333) + ((m >> 2) & 0x33333333);
  m = (m + (m >> 4)) & 0x0f0f0f0f;
  return (m * 0x01010101) >> 24;
}

const parity = (m) => popcount(m) & 1;

/** Masks are 32-bit, so this is the largest diagram the Pauli layer can label. */
export const MAX_QUBITS = 30;

/** The identity LIM with weight `w`. */
export const lim = (w, x = 0, z = 0) => ({ w, x, z });

export const isIdentityString = (a) => a.x === 0 && a.z === 0;

/** X on a single qubit, as a LIM with weight one. */
export const xOn = (ring, q) => ({ w: ring.one, x: 1 << q, z: 0 });

/** Z on a single qubit, as a LIM with weight one. */
export const zOn = (ring, q) => ({ w: ring.one, x: 0, z: 1 << q });

/**
 * Product of two LIMs. Z^b X^c = (-1)^bc X^c Z^b is the only rule needed: pushing b's Z
 * block past a's X block leaves a sign and nothing else.
 */
export function mul(ring, a, b) {
  const w = ring.mul(a.w, b.w);
  return { w: parity(a.z & b.x) ? ring.neg(w) : w, x: a.x ^ b.x, z: a.z ^ b.z };
}

/**
 * The inverse, which exists exactly when the weight does. The string part always
 * inverts: it squares to (-1)^|x&z| times the identity.
 */
export function inverse(ring, a, invertWeight) {
  const w = invertWeight(a.w);
  if (w === null) return null;
  return { w: parity(a.x & a.z) ? ring.neg(w) : w, x: a.x, z: a.z };
}

/** The adjoint. A Pauli string is unitary, so this is the inverse with a conjugated weight. */
export function dagger(ring, conj, a) {
  const w = conj(a.w);
  return { w: parity(a.x & a.z) ? ring.neg(w) : w, x: a.x, z: a.z };
}

export const negate = (ring, a) => ({ w: ring.neg(a.w), x: a.x, z: a.z });

/** Do the two strings commute? The standard symplectic form on the check vectors. */
export const commute = (a, b) => parity((a.z & b.x) ^ (a.x & b.z)) === 0;

/** Whether two LIMs are equal, weights included. */
export const equal = (ring, a, b) => a.x === b.x && a.z === b.z && ring.eq(a.w, b.w);

export const key = (ring, a) => `${a.x}.${a.z}.${ring.key(a.w)}`;

/**
 * A total order on LIMs: the string first, with the X block more significant than the Z
 * block, and the weight last. The identity string is the least, which is what the
 * stabilizer algorithms rely on. The paper orders the weight by its float polar form;
 * the ring's own key is exact and just as total, so it is used instead.
 */
export function compare(ring, a, b) {
  if (a.x !== b.x) return a.x < b.x ? -1 : 1;
  if (a.z !== b.z) return a.z < b.z ? -1 : 1;
  const ka = ring.key(a.w);
  const kb = ring.key(b.w);
  return ka === kb ? 0 : (ka < kb ? -1 : 1);
}

/**
 * The leading position of a check vector, X block first, as a single comparable number;
 * -1 for the identity. Used as the pivot by the linear algebra below.
 */
export function pivot(a) {
  if (a.x !== 0) return 32 + (31 - Math.clz32(a.x));
  if (a.z !== 0) return 31 - Math.clz32(a.z);
  return -1;
}

/**
 * How the string acts on a basis state: X^x Z^z |b> = (-1)^(z.b) |b XOR x>, so reading
 * the amplitude of |b> from `A |v>` means reading |b XOR x> from |v> with that sign.
 * Returned as the flipped index and whether the amplitude is negated.
 */
export function preimage(a, bits) {
  const flipped = bits ^ a.x;
  return { bits: flipped, negated: parity(a.z & flipped) === 1 };
}

/** `A |v>` for a state given as a dense amplitude vector, used by the tests. */
export function apply(ring, a, vec) {
  return vec.map((_, b) => {
    const { bits, negated } = preimage(a, b);
    const amp = ring.mul(a.w, vec[bits]);
    return negated ? ring.neg(amp) : amp;
  });
}

const LETTERS = [['I', 'Z'], ['X', 'Y']];

/**
 * The string as letters joined by the tensor product, qubit 0 first — the same order as
 * the ket, so `X⊗Z⊗I` reads off the diagram top to bottom. X^x Z^z is -i Y when both bits
 * are set, so printing Y means the caller owes the weight a factor of (-i)^|x&z|; that
 * is what `phaseShift` reports.
 */
export function formatString(a, n) {
  const letters = [];
  for (let q = 0; q < n; q++) letters.push(LETTERS[(a.x >> q) & 1][(a.z >> q) & 1]);
  return letters.join('⊗');
}

/** The power of -i owed to the weight when the string is printed with Y in it. */
export const phaseShift = (a) => popcount(a.x & a.z) % 4;
