// Exact arithmetic in the ring Z[1/sqrt(2), i], the amplitude ring of Clifford+T circuits.
//
// An element is written  (c0 + c1*w + c2*w^2 + c3*w^3) / sqrt(2)^k
// with w = e^{i*pi/4} (so w^4 = -1, w^2 = i), integer c_j, and k >= 0.
//
// Why this is a good representation:
//   - {1, w, w^2, w^3} is a Z-basis of Z[w] (w is a primitive 8th root of unity, phi(8)=4),
//     so the four coefficients of a numerator are unique.
//   - sqrt(2) = w - w^3 is (up to units) the unique prime of Z[w] above 2. Hence if we
//     always reduce k to its minimum, the pair (numerator, k) is unique too.
//     => structural equality is semantic equality, which is exactly what the MTBDD needs.
//
// Coefficients are BigInt. They are only ever added and multiplied, never divided except
// by 2 in the exact reduction step, so nothing here can silently lose precision.
//
// Relation to the (a,b,c,d,k) tuple used in the MEDUSA/SliQSim literature, which means
// (a*w^3 + b*w^2 + c*w + d)/sqrt(2)^k:  a=c3, b=c2, c=c1, d=c0.

/** @typedef {{c: [bigint,bigint,bigint,bigint], k: number}} ZOmega */

const B0 = 0n, B1 = 1n, B2 = 2n;

/** Numerator times sqrt(2), using sqrt(2) = w - w^3 and w^4 = -1. */
function numMulSqrt2([c0, c1, c2, c3]) {
  // p*w   = -c3 + c0*w + c1*w^2 + c2*w^3
  // p*w^3 = -c1 - c2*w - c3*w^2 + c0*w^3
  // p*(w - w^3) = (c1-c3) + (c0+c2)*w + (c1+c3)*w^2 + (c2-c0)*w^3
  return [c1 - c3, c0 + c2, c1 + c3, c2 - c0];
}

/** True iff the numerator is divisible by sqrt(2) inside Z[w]. */
function numDivisibleBySqrt2([c0, c1, c2, c3]) {
  // p/sqrt(2) = p*sqrt(2)/2, so we need every coefficient of p*sqrt(2) to be even.
  // (c1-c3) and (c1+c3) share a parity, as do (c0+c2) and (c2-c0).
  return ((c0 + c2) % B2 === B0) && ((c1 + c3) % B2 === B0);
}

/** Numerator divided by sqrt(2). Caller must have checked divisibility. */
function numDivSqrt2([c0, c1, c2, c3]) {
  return [(c1 - c3) / B2, (c0 + c2) / B2, (c1 + c3) / B2, (c2 - c0) / B2];
}

/** Canonical form: zero has k=0, otherwise k is minimal. */
function normalize(c, k) {
  if (c[0] === B0 && c[1] === B0 && c[2] === B0 && c[3] === B0) {
    return Object.freeze({ c: Object.freeze([B0, B0, B0, B0]), k: 0 });
  }
  while (k > 0 && numDivisibleBySqrt2(c)) {
    c = numDivSqrt2(c);
    k--;
  }
  while (k < 0) {           // negative k means "multiplied by sqrt(2)^|k|"; fold it into the numerator
    c = numMulSqrt2(c);
    k++;
  }
  return Object.freeze({ c: Object.freeze(c), k });
}

/** @returns {ZOmega} */
export function zo(c0, c1, c2, c3, k = 0) {
  return normalize([BigInt(c0), BigInt(c1), BigInt(c2), BigInt(c3)], k);
}

export const ZERO = zo(0, 0, 0, 0);
export const ONE = zo(1, 0, 0, 0);
export const MINUS_ONE = zo(-1, 0, 0, 0);
export const I = zo(0, 0, 1, 0);            // w^2
export const MINUS_I = zo(0, 0, -1, 0);
export const OMEGA = zo(0, 1, 0, 0);        // e^{i pi/4}, the T phase
export const OMEGA_INV = zo(0, 0, 0, -1);   // w^{-1} = -w^3
export const SQRT2 = zo(0, 1, 0, -1);       // w - w^3
export const INV_SQRT2 = zo(1, 0, 0, 0, 1);

export function fromInt(n) { return zo(n, 0, 0, 0); }

export function isZero(a) { return a.c[0] === B0 && a.c[1] === B0 && a.c[2] === B0 && a.c[3] === B0; }

export function eq(a, b) {
  return a.k === b.k && a.c[0] === b.c[0] && a.c[1] === b.c[1] && a.c[2] === b.c[2] && a.c[3] === b.c[3];
}

export function add(a, b) {
  let ac = a.c, bc = b.c;
  const k = Math.max(a.k, b.k);
  for (let i = a.k; i < k; i++) ac = numMulSqrt2(ac);
  for (let i = b.k; i < k; i++) bc = numMulSqrt2(bc);
  return normalize([ac[0] + bc[0], ac[1] + bc[1], ac[2] + bc[2], ac[3] + bc[3]], k);
}

export function neg(a) { return normalize([-a.c[0], -a.c[1], -a.c[2], -a.c[3]], a.k); }

export function sub(a, b) { return add(a, neg(b)); }

export function mul(a, b) {
  // Multiply in Z[x]/(x^4 + 1): degrees >= 4 wrap around with a sign flip.
  const r = [B0, B0, B0, B0];
  for (let i = 0; i < 4; i++) {
    if (a.c[i] === B0) continue;
    for (let j = 0; j < 4; j++) {
      if (b.c[j] === B0) continue;
      const p = a.c[i] * b.c[j];
      const d = i + j;
      if (d < 4) r[d] += p; else r[d - 4] -= p;
    }
  }
  return normalize(r, a.k + b.k);
}

/** Complex conjugate: w^j -> w^{-j}. Used for norm checks, not by the DD itself. */
export function conj(a) {
  return normalize([a.c[0], -a.c[3], -a.c[2], -a.c[1]], a.k);
}

/** Numeric value, for the differential oracle and for display. @returns {{re:number,im:number}} */
export function toComplex(a) {
  const s = Math.SQRT1_2;
  const basis = [[1, 0], [s, s], [0, 1], [-s, s]];   // w^0..w^3
  let re = 0, im = 0;
  for (let j = 0; j < 4; j++) {
    const cj = Number(a.c[j]);
    re += cj * basis[j][0];
    im += cj * basis[j][1];
  }
  const d = Math.pow(Math.SQRT2, a.k);
  return { re: re / d, im: im / d };
}

/** Canonical string, used as the hash-consing key for terminals. */
export function key(a) {
  return `${a.c[0]},${a.c[1]},${a.c[2]},${a.c[3]}/${a.k}`;
}

/** Render a numerator given as coefficients over `syms`, e.g. "1+i" or "-2+3ω". */
function numeratorString(c, syms) {
  let out = '';
  for (let j = 0; j < 4; j++) {
    const v = c[j];
    if (v === B0) continue;
    const abs = v < B0 ? -v : v;
    const sign = v < B0 ? '-' : (out === '' ? '' : '+');
    const mag = (abs === B1 && syms[j] !== '') ? '' : String(abs);
    out += sign + mag + syms[j];
  }
  return out;
}

function countTerms(c) {
  let n = 0;
  for (let j = 0; j < 4; j++) if (c[j] !== B0) n++;
  return n;
}

/**
 * Split into numerator/denominator strings, so callers that multiply the value by
 * something else (a monomial, say) can render "a/√2" instead of "1/√2a".
 * Values with no genuine w-phase (i.e. every Clifford amplitude) come back in the
 * familiar Gaussian form (a+bi)/2^m, because "-ω³/√2" is a needlessly obscure way
 * to write "(1-i)/2". T-phases fall back to the w basis.
 * @returns {{num: string, den: string, terms: number}}
 */
export function formatParts(a) {
  if (isZero(a)) return { num: '0', den: '', terms: 1 };
  let c = a.c, k = a.k;
  if (k & 1) { c = numMulSqrt2(c); k++; }   // clear the half-power of two; exact, see numMulSqrt2
  if (c[1] === B0 && c[3] === B0) {
    const m = k >> 1;
    return { num: numeratorString(c, ['', '', 'i', '']), den: m > 0 ? String(2n ** BigInt(m)) : '', terms: countTerms(c) };
  }
  const m = a.k >> 1;
  let den = m > 0 ? String(2n ** BigInt(m)) : '';
  if (a.k & 1) den += '√2';
  return { num: numeratorString(a.c, ['', 'ω', 'i', 'ω³']), den, terms: countTerms(a.c) };
}

/** Human-readable form: "1/√2", "-i", "(1-i)/2", "ω/2", ... */
export function format(a) {
  const { num, den, terms } = formatParts(a);
  if (den === '') return num;
  // "1/(2√2)" rather than "1/2√2", which reads as (1/2)·√2.
  const d = /^\d+√2$/.test(den) ? `(${den})` : den;
  return `${terms > 1 ? `(${num})` : num}/${d}`;
}
