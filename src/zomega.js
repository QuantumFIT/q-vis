// Exact arithmetic in a tower of cyclotomic rings, Z[zeta_2d, 1/sqrt(2)].
//
// An element is written  (c_0 + c_1*z + ... + c_{d-1}*z^{d-1}) / sqrt(2)^k
// with z = e^{i*pi/d}, integer c_j, k >= 0, and d a power of two, at least 4.
//
// d = 4 is z = e^{i*pi/4}, the ring of Clifford+T amplitudes, and where everything this
// tool did before lives. Larger d buys finer phases: d = 8 holds pi/8, d = 16 pi/16, so a
// QFT needs d = 2^{n-1} on n qubits. Nothing else changes — the coefficients are still
// BigInt, the arithmetic is still exact, and equality is still structural.
//
// Why this representation:
//   - {1, z, ..., z^{d-1}} is a Z-basis of Z[z] (z is a primitive 2d-th root of unity and
//     phi(2d) = d), so the coefficients of a numerator are unique.
//   - z^d = -1, so multiplication is polynomial multiplication mod x^d + 1.
//   - sqrt(2) = z^{d/4} - z^{3d/4} is (up to units) the unique prime above 2. Reduce k to
//     its minimum and the pair (numerator, k) is unique too.
//
// The levels nest: Q(z_2d) is inside Q(z_4d) because z_2d = z_4d^2, which in this basis is
// just "coefficient j moves to index 2j". So an element carries its own level, operations
// promote to the larger of two, and the canonical form takes the *smallest* level that
// holds the value. Two consequences worth stating:
//
//   - Nothing needs to know which level is in play. A T gate and a pi/16 phase compose
//     with no special case, and no mode has to be selected anywhere.
//   - Every key of every value expressible at d = 4 is what it always was, so the diagram
//     shares exactly as it did before. => structural equality is semantic equality, which
//     is what the MTBDD leans on.
//
// Coefficients are only ever added and multiplied, never divided except by 2 in the exact
// reduction step, so nothing here can silently lose precision.
//
// Relation to the (a,b,c,d,k) tuple of the MEDUSA/SliQSim literature, which means
// (a*z^3 + b*z^2 + c*z + d)/sqrt(2)^k at d = 4:  a=c3, b=c2, c=c1, d=c0.

/** @typedef {{c: bigint[], k: number}} ZOmega */

const B0 = 0n, B1 = 1n, B2 = 2n;

/** The floor of the tower: Z[e^{i pi/4}, 1/sqrt(2)], the Clifford+T amplitudes. */
export const BASE_LEVEL = 4;

/** z_2d = z_4d^2, so coefficient j of the lower level is coefficient 2j of the higher. */
function promote(c) {
  const out = new Array(c.length * 2).fill(B0);
  for (let j = 0; j < c.length; j++) out[2 * j] = c[j];
  return out;
}

/**
 * The smallest level holding this numerator. Every odd coefficient being zero says the
 * value is a polynomial in z^2, which is the root one level down; the basis is a Z-basis,
 * so that test is exact rather than a guess. Never goes below the floor.
 */
function demote(c) {
  let out = c;
  while (out.length > BASE_LEVEL) {
    for (let j = 1; j < out.length; j += 2) if (out[j] !== B0) return out;
    const half = new Array(out.length / 2);
    for (let j = 0; j < half.length; j++) half[j] = out[2 * j];
    out = half;
  }
  return out;
}

/** Two numerators at a common level. */
function align(a, b) {
  let ac = a;
  let bc = b;
  while (ac.length < bc.length) ac = promote(ac);
  while (bc.length < ac.length) bc = promote(bc);
  return [ac, bc];
}

/**
 * Numerator times sqrt(2) = z^{d/4} - z^{3d/4}, in place of the hand-derived formula the
 * four-coefficient case allowed. Degrees at or past d wrap around with a sign flip, since
 * z^d = -1.
 */
function numMulSqrt2(c) {
  const d = c.length;
  const s = d / 4;
  const out = new Array(d).fill(B0);
  const at = (index, v) => {
    let i = index;
    let value = v;
    while (i >= d) { i -= d; value = -value; }
    out[i] += value;
  };
  for (let j = 0; j < d; j++) {
    if (c[j] === B0) continue;
    at(j + s, c[j]);
    at(j + 3 * s, -c[j]);
  }
  return out;
}

/**
 * True iff the numerator is divisible by sqrt(2) inside Z[z]. Since p/sqrt(2) is
 * p*sqrt(2)/2, that is exactly the question of whether every coefficient of p*sqrt(2) is
 * even. (At d = 4 this used to be a parity shortcut on two sums; the general form is the
 * definition, and cheap enough.)
 */
function numDivisibleBySqrt2(c) {
  return numMulSqrt2(c).every((v) => v % B2 === B0);
}

/** Numerator divided by sqrt(2). Caller must have checked divisibility. */
function numDivSqrt2(c) {
  return numMulSqrt2(c).map((v) => v / B2);
}

const isZeroNumerator = (c) => c.every((v) => v === B0);

/** Canonical form: the smallest level, and then the smallest k. Zero is 0 at the floor. */
function normalize(c, k) {
  let num = demote(c);
  if (isZeroNumerator(num)) {
    return Object.freeze({ c: Object.freeze(new Array(BASE_LEVEL).fill(B0)), k: 0 });
  }
  // A negative k means "multiplied by sqrt(2)^|k|"; fold it into the numerator.
  while (k < 0) { num = numMulSqrt2(num); k++; }
  while (k > 0 && numDivisibleBySqrt2(num)) {
    num = demote(numDivSqrt2(num));
    k--;
  }
  return Object.freeze({ c: Object.freeze(num), k });
}

/** An element from its coefficients over z = e^{i pi/coeffs.length}. */
export function zeta(coeffs, k = 0) {
  const d = coeffs.length;
  if (d < BASE_LEVEL || (d & (d - 1)) !== 0) {
    throw new Error(`level must be a power of two at least ${BASE_LEVEL}, got ${d}`);
  }
  return normalize(coeffs.map(BigInt), k);
}

/** The four-coefficient constructor, unchanged: (c0 + c1*w + c2*w^2 + c3*w^3)/sqrt(2)^k. */
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

/** The level this element sits at: how many coefficients its numerator needs. */
export function levelOf(a) { return a.c.length; }

export function isZero(a) { return isZeroNumerator(a.c); }

export function eq(a, b) {
  return a.k === b.k && a.c.length === b.c.length && a.c.every((v, j) => v === b.c[j]);
}

export function add(a, b) {
  let [ac, bc] = align(a.c, b.c);
  const k = Math.max(a.k, b.k);
  for (let i = a.k; i < k; i++) ac = numMulSqrt2(ac);
  for (let i = b.k; i < k; i++) bc = numMulSqrt2(bc);
  return normalize(ac.map((v, j) => v + bc[j]), k);
}

export function neg(a) { return normalize(a.c.map((v) => -v), a.k); }

export function sub(a, b) { return add(a, neg(b)); }

export function mul(a, b) {
  const [ac, bc] = align(a.c, b.c);
  const d = ac.length;
  const r = new Array(d).fill(B0);
  for (let i = 0; i < d; i++) {
    if (ac[i] === B0) continue;
    for (let j = 0; j < d; j++) {
      if (bc[j] === B0) continue;
      const p = ac[i] * bc[j];
      const e = i + j;
      if (e < d) r[e] += p; else r[e - d] -= p;   // z^d = -1
    }
  }
  return normalize(r, a.k + b.k);
}

/**
 * e^{i*pi*j/d}, the j-th power of the primitive root at level `d`. This is how every
 * phase enters the ring: a rotation by pi/4 is `rootPow(1, 4)`, one by pi/16 is
 * `rootPow(1, 16)`, and an angle that is not pi times a dyadic rational has no form here
 * at all.
 */
export function rootPow(j, d = BASE_LEVEL) {
  const level = Math.max(BASE_LEVEL, d);
  const scale = level / d;
  const period = 2 * level;
  const r = (((j * scale) % period) + period) % period;
  const c = new Array(level).fill(B0);
  if (r < level) c[r] = B1; else c[r - level] = -B1;
  return normalize(c, 0);
}

/** w^m for any integer m, w = e^{i pi/4}. The level-4 rotation, unchanged. */
export function omegaPow(m) { return rootPow(m, BASE_LEVEL); }

/** Repeated multiplication; `n` is small (a power of sqrt(2), say). */
function pow(a, n) {
  let acc = ONE;
  for (let i = 0; i < n; i++) acc = mul(acc, a);
  return acc;
}

/**
 * The Galois conjugate sending z to z^j, for odd j. Applied to numerators only: sqrt(2)
 * maps to +-sqrt(2), so the denominator is the caller's business (see `tryInvert`).
 */
function sigma(c, j) {
  const d = c.length;
  const period = 2 * d;
  const out = new Array(d).fill(B0);
  for (let m = 0; m < d; m++) {
    if (c[m] === B0) continue;
    const r = (((j * m) % period) + period) % period;
    if (r < d) out[r] += c[m]; else out[r - d] -= c[m];
  }
  return out;
}

function log2Exact(n) {
  if (n <= 0n) return -1;
  let t = 0;
  while (n % B2 === B0) { n /= B2; t++; }
  return n === B1 ? t : -1;
}

/** The product of a numerator's conjugates other than itself, and the norm they give. */
function conjugateProduct(c) {
  const d = c.length;
  let prod = ONE;
  for (let j = 3; j < 2 * d; j += 2) prod = mul(prod, Object.freeze({ c: sigma(c, j), k: 0 }));
  const n = mul(Object.freeze({ c, k: 0 }), prod);
  if (n.k !== 0 || n.c.some((v, j) => j > 0 && v !== B0)) {
    throw new Error('internal: a Galois norm came out irrational');
  }
  return { prod, norm: n.c[0] };
}

/**
 * Multiplicative inverse, when it exists.
 *
 * For a numerator p, the product of p with its d-1 Galois conjugates is the rational
 * integer norm N(p). So 1/p = (conjugate product)/N(p), which stays inside the ring
 * exactly when |N(p)| is a power of two — 1/2 = (1/sqrt(2))^2 is available, 1/3 is not.
 * @throws if the element is zero or not invertible
 */
export function invert(a) {
  if (isZero(a)) throw new Error('division by zero');
  const inv = tryInvert(a);
  if (inv === null) {
    const { norm } = conjugateProduct(normalize([...a.c], 0).c);
    throw new Error(`${format(a)} is not invertible: its norm ${norm} is not a power of two`);
  }
  return inv;
}

/**
 * The same inverse, or null when there is none. Weights without an inverse are ordinary
 * in this ring — 3/4 and 13/256 among them — so a diagram deciding whether it may divide
 * needs to ask without being thrown at.
 */
export function tryInvert(a) {
  if (isZero(a)) return null;
  const p = normalize([...a.c], 0);
  const { prod, norm } = conjugateProduct(p.c);
  const negative = norm < B0;
  const t = log2Exact(negative ? -norm : norm);
  if (t < 0) return null;
  // 1/p = prod / (+-2^t), then 1/a = sqrt(2)^k / p.
  let inv = normalize([...prod.c], 2 * t);
  if (negative) inv = neg(inv);
  return mul(inv, pow(SQRT2, a.k));
}

/** sqrt(2)^v for any integer v; a negative power is a denominator. */
function sqrt2Pow(v) { return v >= 0 ? pow(SQRT2, v) : zo(1, 0, 0, 0, -v); }

/**
 * Split off a canonical unit factor: returns `{ unit, rest }` with `a = unit * rest`.
 *
 * The units taken out are a power of sqrt(2) and a power of the root at this element's
 * own level — the factors gates actually introduce. (The full unit group is larger: it
 * contains 1+sqrt(2) and is infinite. Restricting to these keeps the factorisation finite
 * and canonical.)
 *
 * Two elements differing by such a unit share a `rest`, which is what lets an
 * edge-valued diagram share the subfunctions beneath them. A unit itself has rest 1.
 */
export function unitPart(a) {
  if (isZero(a)) return { unit: ONE, rest: ZERO };

  // How many times sqrt(2) divides the value: out of the numerator, less the denominator.
  let c = [...a.c];
  let v = -a.k;
  while (numDivisibleBySqrt2(c)) { c = demote(numDivSqrt2(c)); v++; }
  const stripped = normalize(c, 0);

  // Then the phase. Of the 2d rotations take the one with the largest key, which prefers
  // a positive leading coefficient and is otherwise an arbitrary but fixed choice — so it
  // is canonical, and a unit lands on 1.
  const d = stripped.c.length;
  let rest = stripped;
  let phase = 0;
  for (let j = 1; j < 2 * d; j++) {
    const rotated = mul(stripped, rootPow(-j, d));
    if (key(rotated) > key(rest)) { rest = rotated; phase = j; }
  }
  return { unit: mul(rootPow(phase, d), sqrt2Pow(v)), rest };
}

/** Complex conjugate: z^j -> z^{-j}. sqrt(2) is real, so the denominator is untouched. */
export function conj(a) {
  return normalize(sigma(a.c, -1), a.k);
}

/** Numeric value, for the differential oracle and for display. @returns {{re:number,im:number}} */
export function toComplex(a) {
  const d = a.c.length;
  let re = 0;
  let im = 0;
  for (let j = 0; j < d; j++) {
    if (a.c[j] === B0) continue;
    const cj = Number(a.c[j]);
    const angle = (Math.PI * j) / d;
    re += cj * Math.cos(angle);
    im += cj * Math.sin(angle);
  }
  const scale = Math.pow(Math.SQRT2, a.k);
  return { re: re / scale, im: im / scale };
}

/** The power of sqrt(2) in this element's denominator. */
export function denominatorPower(a) { return a.k; }

/**
 * The algebraic tuple form used in the MEDUSA/SliQSim literature: (a,b,c,d) standing for
 * (a*w^3 + b*w^2 + c*w + d)/sqrt(2)^k at the base level. The k is not part of the tuple
 * because a state is written with one common k for all of its amplitudes — pass that k
 * here and the numerator is scaled up to match it, which is exact. `level` does the same
 * for the level, so that every amplitude of one state is a tuple of the same width.
 */
export function formatTuple(a, k = a.k, level = a.c.length) {
  let c = a.c;
  while (c.length < level) c = promote(c);
  for (let i = a.k; i < k; i++) c = numMulSqrt2(c);
  // MEDUSA orders the tuple by descending power of the root.
  return `(${[...c].reverse().join(',')})`;
}

/** Canonical string, used as the hash-consing key for terminals. */
export function key(a) {
  return `${a.c.join(',')}/${a.k}`;
}

const SUPERSCRIPT = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
const superscript = (n) => String(n).split('').map((ch) => SUPERSCRIPT[ch]).join('');

/**
 * How each power of the root is written at a given level: nothing for 1, `i` for the
 * quarter turn, and `w` with a superscript otherwise. At the base level this is exactly
 * `['', 'w', 'i', 'w³']`, which is what it always was.
 */
function symbolsFor(d) {
  return Array.from({ length: d }, (_, j) => {
    if (j === 0) return '';
    if (j === d / 2) return 'i';
    return j === 1 ? 'ω' : `ω${superscript(j)}`;
  });
}

/** Render a numerator given as coefficients over `syms`, e.g. "1+i" or "-2+3ω". */
function numeratorString(c, syms) {
  let out = '';
  for (let j = 0; j < c.length; j++) {
    const v = c[j];
    if (v === B0) continue;
    const abs = v < B0 ? -v : v;
    const sign = v < B0 ? '-' : (out === '' ? '' : '+');
    const mag = (abs === B1 && syms[j] !== '') ? '' : String(abs);
    out += sign + mag + syms[j];
  }
  return out;
}

const countTerms = (c) => c.reduce((n, v) => n + (v === B0 ? 0 : 1), 0);

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
  const gaussian = ['', '', 'i', ''];
  // The two shortcuts below read the four-coefficient basis directly. Above the base
  // level a normalised value always has an odd coefficient — that is what keeps it up
  // there — so neither could fire anyway, and the root basis is the honest form.
  if (a.c.length === BASE_LEVEL) {
    let c = a.c;
    let k = a.k;
    if (k & 1) { c = numMulSqrt2(c); k++; }   // clear the half-power of two; exact
    if (c[1] === B0 && c[3] === B0) {
      const m = k >> 1;
      return { num: numeratorString(c, gaussian), den: m > 0 ? String(2n ** BigInt(m)) : '', terms: countTerms(c) };
    }
    // Even k and no Gaussian form: the value may still be a Gaussian multiple of sqrt(2),
    // which reads far better as "√2" or "(1+i)√2" than as "ω-ω³".
    const q = numMulSqrt2(a.c);
    if (q[1] === B0 && q[3] === B0 && q[0] % B2 === B0 && q[2] % B2 === B0) {
      const h = [q[0] / B2, B0, q[2] / B2, B0];
      const t = countTerms(h);
      const body = numeratorString(h, gaussian);
      const head = body === '1' ? '' : body === '-1' ? '-' : (t > 1 ? `(${body})` : body);
      const m2 = a.k >> 1;
      return { num: `${head}√2`, den: m2 > 0 ? String(2n ** BigInt(m2)) : '', terms: 1 };
    }
  }
  const m = a.k >> 1;
  let den = m > 0 ? String(2n ** BigInt(m)) : '';
  if (a.k & 1) den += '√2';
  return {
    num: numeratorString(a.c, symbolsFor(a.c.length)),
    den,
    terms: countTerms(a.c),
  };
}

/** Four decimals, trailing zeros trimmed, and no "-0". */
function decimal(x) {
  if (Math.abs(x) < 5e-5) return '0';
  return x.toFixed(4).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

/** Floating-point rectangular form: "0.7071", "-0.5+0.5i", "-0.7071i". */
export function formatRect(a) {
  const { re, im } = toComplex(a);
  const r = decimal(re);
  const i = decimal(im);
  if (i === '0') return r;
  const imag = `${i === '1' ? '' : i === '-1' ? '-' : i}i`;
  return r === '0' ? imag : `${r}${imag.startsWith('-') ? '' : '+'}${imag}`;
}

/**
 * The angle as a multiple of pi, exactly when it is a simple one. Every amplitude in this
 * ring has an angle that is pi times a dyadic rational, so this is the form that stays
 * exact: "3π/4" rather than "2.3562".
 */
function overPi(theta) {
  const r = theta / Math.PI;
  if (Math.abs(r) < 1e-9) return '0';
  // Ascending denominators, so the first hit is already in lowest terms. Far enough to
  // name every angle the tower reaches at the levels this tool draws.
  for (let d = 1; d <= 64; d++) {
    const n = r * d;
    if (Math.abs(n - Math.round(n)) > 1e-9) continue;
    const num = Math.round(n);
    if (d === 1) return num === 1 ? 'π' : num === -1 ? '-π' : `${num}π`;
    if (num === 1) return `π/${d}`;
    if (num === -1) return `-π/${d}`;
    return `${num}π/${d}`;
  }
  return `${decimal(r)}π`;
}

/**
 * Floating-point polar form: "0.7071∠45°", "0.7071∠0.7854" or "0.7071∠π/4". The angle is
 * always shown, even at zero, so a column of amplitudes can be compared phase against
 * phase at a glance — which is the only reason to ask for polar in the first place.
 * @param {'deg'|'rad'|'pi'} [unit]
 */
export function formatPolar(a, unit = 'deg') {
  const { re, im } = toComplex(a);
  const r = Math.hypot(re, im);
  if (r < 5e-5) return '0';
  const theta = Math.atan2(im, re);
  const angle = unit === 'pi' ? overPi(theta)
    : unit === 'rad' ? decimal(theta)
      : `${decimal((theta * 180) / Math.PI)}°`;
  return `${decimal(r)}∠${angle}`;
}

/** Human-readable form: "1/√2", "-i", "(1-i)/2", "ω/2", ... */
export function format(a) {
  const { num, den, terms } = formatParts(a);
  if (den === '') return num;
  // "1/(2√2)" rather than "1/2√2", which reads as (1/2)·√2.
  const d = /^\d+√2$/.test(den) ? `(${den})` : den;
  return `${terms > 1 ? `(${num})` : num}/${d}`;
}
