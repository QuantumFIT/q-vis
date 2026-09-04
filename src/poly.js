// Multivariate polynomials over the exact ring Z[1/sqrt(2), i], used as MTBDD terminal values.
//
// A symbolic input state such as  a|00> + b|11>  has amplitudes that are free symbols.
// Gates are linear, so amplitudes stay linear in those symbols in practice, but nothing
// here assumes that: the representation is a general sparse multivariate polynomial.
//
// Canonical form (required — the MTBDD relies on structural equality being semantic
// equality): terms with zero coefficient are dropped, variables inside a monomial are
// sorted by name, and terms are keyed by their canonical monomial string.

import * as Z from './zomega.js';

/** @typedef {import('./zomega.js').ZOmega} ZOmega */
/** @typedef {{mono: Array<[string, number]>, coef: ZOmega}} Term */
/** @typedef {{t: Map<string, Term>}} Poly */

const CONST_KEY = '';

function monoKey(mono) {
  if (mono.length === 0) return CONST_KEY;
  return mono.map(([n, e]) => (e === 1 ? n : `${n}^${e}`)).join('*');
}

function monoMul(a, b) {
  /** @type {Array<[string, number]>} */
  const out = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && a[i][0] < b[j][0])) out.push([a[i][0], a[i][1]]), i++;
    else if (i >= a.length || b[j][0] < a[i][0]) out.push([b[j][0], b[j][1]]), j++;
    else out.push([a[i][0], a[i][1] + b[j][1]]), i++, j++;
  }
  return out;
}

function fromTerms(terms) {
  /** @type {Map<string, Term>} */
  const t = new Map();
  for (const term of terms) {
    if (Z.isZero(term.coef)) continue;
    const k = monoKey(term.mono);
    const prev = t.get(k);
    if (prev) {
      const coef = Z.add(prev.coef, term.coef);
      if (Z.isZero(coef)) t.delete(k); else t.set(k, { mono: prev.mono, coef });
    } else {
      t.set(k, term);
    }
  }
  return { t };
}

export const zero = { t: new Map() };
export const one = fromZ(Z.ONE);

/** Lift an exact scalar to a constant polynomial. */
export function fromZ(z) { return fromTerms([{ mono: [], coef: z }]); }
export function fromInt(n) { return fromZ(Z.fromInt(n)); }

/** The free symbol `name`, e.g. the `a` in `a|00> + b|11>`. */
export function variable(name) { return fromTerms([{ mono: [[name, 1]], coef: Z.ONE }]); }

export function isZero(p) { return p.t.size === 0; }

export function add(p, q) { return fromTerms([...p.t.values(), ...q.t.values()]); }

export function neg(p) {
  return fromTerms([...p.t.values()].map(({ mono, coef }) => ({ mono, coef: Z.neg(coef) })));
}

export function sub(p, q) { return add(p, neg(q)); }

export function mul(p, q) {
  if (p.t.size === 0 || q.t.size === 0) return zero;
  const terms = [];
  for (const a of p.t.values()) {
    for (const b of q.t.values()) {
      terms.push({ mono: monoMul(a.mono, b.mono), coef: Z.mul(a.coef, b.coef) });
    }
  }
  return fromTerms(terms);
}

/** Canonical string; the hash-consing key for MTBDD terminals. */
export function key(p) {
  if (p.t.size === 0) return '0';
  return [...p.t.keys()].sort().map((k) => `${k}:${Z.key(p.t.get(k).coef)}`).join(';');
}

export function eq(p, q) { return key(p) === key(q); }

/** If the polynomial is a constant, return its exact scalar; otherwise null. */
export function asScalar(p) {
  if (p.t.size === 0) return Z.ZERO;
  if (p.t.size === 1 && p.t.has(CONST_KEY)) return p.t.get(CONST_KEY).coef;
  return null;
}

/** The largest power of sqrt(2) any coefficient here is divided by. */
export function denominatorPower(p) {
  let k = 0;
  for (const { coef } of p.t.values()) k = Math.max(k, Z.denominatorPower(coef));
  return k;
}

export function symbols(p) {
  const s = new Set();
  for (const { mono } of p.t.values()) for (const [n] of mono) s.add(n);
  return s;
}

/** Numeric value under an assignment of complex numbers to symbols. */
export function evaluate(p, env = {}) {
  let re = 0, im = 0;
  for (const { mono, coef } of p.t.values()) {
    let c = Z.toComplex(coef);
    for (const [n, e] of mono) {
      const v = env[n];
      if (v === undefined) throw new Error(`no value given for symbol '${n}'`);
      for (let i = 0; i < e; i++) {
        c = { re: c.re * v.re - c.im * v.im, im: c.re * v.im + c.im * v.re };
      }
    }
    re += c.re; im += c.im;
  }
  return { re, im };
}

function monoString(mono) {
  return mono.map(([n, e]) => (e === 1 ? n : `${n}${e === 2 ? '²' : e === 3 ? '³' : '^' + e}`)).join('');
}

/**
 * @param {Poly} p
 * @param {'exact'|'rect'|'polar-deg'|'polar-rad'|'polar-pi'|'tuple'} [mode] exact keeps
 *   the ring's own notation; rect and polar evaluate coefficients to floating point,
 *   polar in the requested angle unit; tuple is the algebraic (a,b,c,d) form over a
 *   common denominator. Symbolic terms keep their monomials in every mode — only the
 *   coefficient in front of them changes. 'polar' is accepted as 'polar-deg'.
 * @param {{k?: number}} [opts] the common power of sqrt(2) to write tuples over
 */
export function format(p, mode = 'exact', opts = {}) {
  if (p.t.size === 0) return mode === 'tuple' ? Z.formatTuple(Z.ZERO, opts.k || 0) : '0';
  if (mode !== 'exact') return formatNumeric(p, mode, opts);
  const parts = [];
  for (const k of [...p.t.keys()].sort()) {
    const { mono, coef } = p.t.get(k);
    if (mono.length === 0) { parts.push(Z.format(coef)); continue; }
    const ms = monoString(mono);
    // Render the monomial inside the fraction: "a/√2", not "1/√2a".
    const { num, den, terms } = Z.formatParts(coef);
    let head;
    if (num === '1') head = ms;
    else if (num === '-1') head = '-' + ms;
    else head = `${terms > 1 ? `(${num})` : num}${ms}`;
    const d = /^\d+√2$/.test(den) ? `(${den})` : den;
    parts.push(den === '' ? head : `${head}/${d}`);
  }
  return parts.join(' + ').replace(/\+ -/g, '- ');
}

/** @returns {(z: any) => string} */
function numberFormatter(mode, opts) {
  if (mode === 'rect') return Z.formatRect;
  if (mode === 'tuple') return (z) => Z.formatTuple(z, Math.max(opts.k || 0, z.k));
  const unit = { 'polar-rad': 'rad', 'polar-pi': 'pi' }[mode] || 'deg';
  return (z) => Z.formatPolar(z, unit);
}

function formatNumeric(p, mode, opts = {}) {
  const asNumber = numberFormatter(mode, opts);
  const parts = [];
  for (const k of [...p.t.keys()].sort()) {
    const { mono, coef } = p.t.get(k);
    const num = asNumber(coef);
    if (mono.length === 0) { parts.push(num); continue; }
    const ms = monoString(mono);
    if (num === '1') parts.push(ms);
    else if (num === '-1') parts.push(`-${ms}`);
    // Brackets only when the coefficient would otherwise run into the monomial:
    // "0.7071a" and "-ia" read fine, "0.5-0.5ia" and "1∠90°a" do not.
    else parts.push(/[+∠]|.-/.test(num) ? `(${num})${ms}` : `${num}${ms}`);
  }
  return parts.join(' + ').replace(/\+ -/g, '- ');
}

/** The ring interface consumed by the MTBDD manager. */
export const Ring = { zero, one, add, mul, neg, isZero, eq, key, format, fromScalar: fromZ };
