// Deterministic PRNG so failures are reproducible without a property-testing dependency.
export function rng(seed = 0x2545f491) {
  let s = seed >>> 0;
  return function next() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(r, lo, hi) { return lo + Math.floor(r() * (hi - lo + 1)); }

export const CLOSE = 1e-9;
export function assertClose(got, want, msg) {
  const d = Math.hypot(got.re - want.re, got.im - want.im);
  if (!(d < CLOSE)) {
    throw new Error(`${msg || 'complex mismatch'}: got ${got.re}${got.im < 0 ? '' : '+'}${got.im}i, ` +
      `want ${want.re}${want.im < 0 ? '' : '+'}${want.im}i (|d|=${d})`);
  }
}

export const cx = {
  add: (a, b) => ({ re: a.re + b.re, im: a.im + b.im }),
  mul: (a, b) => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re }),
  neg: (a) => ({ re: -a.re, im: -a.im }),
};
