// What a state's entanglement looks like, for a bipartition and for the state as a whole.
//
// Two questions, and they want different arithmetic.
//
// *Does this set of qubits factor out?* is a Schmidt rank of one, and a rank of one is a
// statement about products being equal — so it is decided exactly, on the ring, with no
// tolerance anywhere. Entanglement depth is built out of nothing but that test.
//
// *How entangled is it?* is a set of Schmidt coefficients, and those are square roots of
// eigenvalues. They leave the ring in general — the Schmidt coefficients of a state whose
// amplitudes are all in Z[zeta, 1/sqrt2] need not be — so that half is floating point and
// says so. Nothing in the tool's exactness rests on it: it is a measurement of a state
// that has already been computed exactly.

import { toLevels } from './order.js';

/** Every amplitude, indexed by the basis string read in *qubit* order. */
export function amplitudes(dd, root, n, levelOf = null) {
  return Array.from({ length: 2 ** n }, (_, b) => {
    const bits = b.toString(2).padStart(n, '0');
    return dd.evaluate(root, levelOf ? toLevels(bits, levelOf) : bits);
  });
}

/**
 * The amplitudes rearranged as a matrix: one row per assignment of the qubits in `part`,
 * one column per assignment of the rest. A state factors across the split exactly when
 * this matrix has rank one, and its Schmidt coefficients are its singular values.
 */
export function splitMatrix(amps, n, part) {
  const inPart = new Array(n).fill(false);
  for (const q of part) inPart[q] = true;
  const rows = 2 ** part.length;
  const cols = 2 ** (n - part.length);
  const out = Array.from({ length: rows }, () => new Array(cols));
  for (let b = 0; b < amps.length; b++) {
    let r = 0;
    let c = 0;
    for (let q = 0; q < n; q++) {
      const bit = (b >> (n - 1 - q)) & 1;          // qubit 0 is the most significant
      if (inPart[q]) r = (r << 1) | bit; else c = (c << 1) | bit;
    }
    out[r][c] = amps[b];
  }
  return out;
}

/**
 * Has this matrix rank at most one — exactly, in the ring?
 *
 * Rank one means every 2x2 minor vanishes, and against a fixed non-zero pivot that is one
 * pass: M[i][j]·M[i0][j0] = M[i][j0]·M[i0][j]. No division, so it needs nothing of the
 * ring but multiplication and equality, and it holds for symbolic amplitudes too.
 */
export function isProduct(ring, m) {
  let pi = -1;
  let pj = -1;
  for (let i = 0; i < m.length && pi < 0; i++) {
    for (let j = 0; j < m[i].length; j++) {
      if (!ring.isZero(m[i][j])) { pi = i; pj = j; break; }
    }
  }
  if (pi < 0) return true;                          // the zero state factors trivially
  for (let i = 0; i < m.length; i++) {
    for (let j = 0; j < m[i].length; j++) {
      if (!ring.eq(ring.mul(m[i][j], m[pi][pj]), ring.mul(m[i][pj], m[pi][j]))) return false;
    }
  }
  return true;
}

/** The same question in floating point: cheap, and only ever used to reject. */
function looksProduct(m, tol = 1e-9) {
  let pi = -1;
  let pj = -1;
  let big = 0;
  for (let i = 0; i < m.length; i++) {
    for (let j = 0; j < m[i].length; j++) {
      const a = Math.hypot(m[i][j].re, m[i][j].im);
      if (a > big) { big = a; pi = i; pj = j; }
    }
  }
  if (big === 0) return true;
  const p = m[pi][pj];
  const bound = tol * big * big;
  for (let i = 0; i < m.length; i++) {
    for (let j = 0; j < m[i].length; j++) {
      const a = m[i][j];
      const b = m[i][pj];
      const c = m[pi][j];
      const re = (a.re * p.re - a.im * p.im) - (b.re * c.re - b.im * c.im);
      const im = (a.re * p.im + a.im * p.re) - (b.re * c.im + b.im * c.re);
      if (Math.hypot(re, im) > bound) return false;
    }
  }
  return true;
}

/** Subsets of `xs` of size `k`, as arrays. */
function* choose(xs, k) {
  if (k === 0) { yield []; return; }
  for (let i = 0; i <= xs.length - k; i++) {
    for (const rest of choose(xs.slice(i + 1), k - 1)) yield [xs[i], ...rest];
  }
}

/**
 * The finest partition of the qubits into groups the state is a product over, and the
 * size of its largest group — the entanglement depth, the most qubits that have to be
 * entangled with one another at once.
 *
 * The sets that factor out are closed under union and intersection, so they are exactly
 * the unions of this partition's blocks, and a block is the *smallest* factoring set
 * containing any of its qubits. That is what is searched for: sizes upward from one, and
 * the first hit is the block. Peeling a block off leaves a pure state on the rest, so the
 * search then repeats over what is left.
 *
 * There is no shortcut through pairwise tests. Take q2 = q0 XOR q1 on three qubits: every
 * pair of its qubits is completely uncorrelated, and yet no qubit factors out and its
 * depth is three. The exhaustive search is the price of getting that right.
 *
 * `budget` bounds the work, in matrix entries examined. A state that would cost more says
 * so rather than hanging the page.
 */
export function productPartition(ring, amps, n, { numeric = null, budget = 2e7 } = {}) {
  const blocks = [];
  let left = Array.from({ length: n }, (_, i) => i);
  let work = 0;

  while (left.length) {
    const head = left[0];
    const rest = left.slice(1);
    let block = null;
    for (let size = 1; size <= left.length && !block; size++) {
      if (size === left.length) { block = left.slice(); break; }   // what remains always factors
      for (const combo of choose(rest, size - 1)) {
        const part = [head, ...combo];
        work += 2 ** n;
        if (work > budget) return { blocks: null, depth: null, exhausted: true, work };
        // Floating point rejects the great majority, and every acceptance is then
        // confirmed on the ring — so the answer is exact and the search is not slow.
        if (numeric && !looksProduct(splitMatrix(numeric, n, part))) continue;
        if (isProduct(ring, splitMatrix(amps, n, part))) { block = part; break; }
      }
    }
    blocks.push(block);
    const gone = new Set(block);
    left = left.filter((q) => !gone.has(q));
  }
  return { blocks, depth: Math.max(...blocks.map((b) => b.length)), exhausted: false, work };
}

// ---- Schmidt coefficients -------------------------------------------------

/** Eigenvalues of a real symmetric matrix, by cyclic Jacobi. Descending. */
function jacobi(src, d) {
  const a = src.map((row) => row.slice());
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < d; p++) for (let q = p + 1; q < d; q++) off += a[p][q] * a[p][q];
    if (off < 1e-26) break;
    for (let p = 0; p < d; p++) {
      for (let q = p + 1; q < d; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < d; k++) {
          const kp = a[k][p];
          const kq = a[k][q];
          a[k][p] = c * kp - s * kq;
          a[k][q] = s * kp + c * kq;
        }
        for (let k = 0; k < d; k++) {
          const pk = a[p][k];
          const qk = a[q][k];
          a[p][k] = c * pk - s * qk;
          a[q][k] = s * pk + c * qk;
        }
      }
    }
  }
  return Array.from({ length: d }, (_, i) => a[i][i]).sort((x, y) => y - x);
}

/**
 * The Schmidt decomposition of `numeric` across (part | the rest): how many terms it has,
 * how big they are, and how much entanglement that is.
 *
 * Taken from the eigenvalues of the reduced density matrix, on whichever side is smaller —
 * the two sides have the same non-zero spectrum, and the smaller one is the cheaper matrix
 * to diagonalise. A Hermitian d×d becomes a real symmetric 2d×2d under
 * H = A + iB  ->  [[A, -B], [B, A]], whose eigenvalues are H's, each of them twice; the
 * duplicates are dropped on the way out.
 *
 * The coefficients are square roots of those eigenvalues and are not ring elements in
 * general, so this half is floating point. The *rank* it reports is the one the exact
 * test would give at rank one, which is the case that decides whether a state is a
 * product at all.
 */
export function schmidt(numeric, n, part, { tol = 1e-9 } = {}) {
  const m = splitMatrix(numeric, n, part);
  const rows = m.length;
  const cols = m[0].length;
  const flip = cols < rows;                    // diagonalise the smaller side
  const d = flip ? cols : rows;
  const other = flip ? rows : cols;

  // rho = M M* (or M* M), Hermitian and positive semi-definite.
  const re = Array.from({ length: d }, () => new Array(d).fill(0));
  const im = Array.from({ length: d }, () => new Array(d).fill(0));
  for (let i = 0; i < d; i++) {
    for (let j = 0; j < d; j++) {
      let sr = 0;
      let si = 0;
      for (let k = 0; k < other; k++) {
        const a = flip ? m[k][i] : m[i][k];
        const b = flip ? m[k][j] : m[j][k];
        sr += a.re * b.re + a.im * b.im;        // a * conj(b)
        si += a.im * b.re - a.re * b.im;
      }
      re[i][j] = sr;
      im[i][j] = si;
    }
  }

  const big = Array.from({ length: 2 * d }, () => new Array(2 * d).fill(0));
  for (let i = 0; i < d; i++) {
    for (let j = 0; j < d; j++) {
      big[i][j] = re[i][j];
      big[i + d][j + d] = re[i][j];
      big[i][j + d] = -im[i][j];
      big[i + d][j] = im[i][j];
    }
  }
  const doubled = jacobi(big, 2 * d);
  const values = doubled.filter((_, i) => i % 2 === 0).map((v) => Math.max(0, v));

  const total = values.reduce((s, v) => s + v, 0) || 1;
  const probs = values.map((v) => v / total);
  const cut = tol * (probs[0] || 1);
  const kept = probs.filter((p) => p > cut);
  const entropy = -kept.reduce((s, p) => s + p * Math.log2(p), 0);
  return {
    rank: kept.length,
    probabilities: kept,
    coefficients: kept.map(Math.sqrt),
    entropy,
    dims: [rows, cols],
    maxRank: Math.min(rows, cols),
  };
}

/**
 * A bipartition written the way the reader names qubits: `q[0] q[2]`, or bare indices, in
 * any order and separated by anything that is not part of a name. Returns the qubits, or
 * an error saying which word was not understood.
 */
export function parseSubset(text, labels) {
  const words = (text.match(/[A-Za-z_][A-Za-z0-9_]*\[\d+\]|\d+/g) || []);
  if (!words.length) return { error: 'name at least one qubit, such as ' + labels[0] };
  const seen = new Set();
  const out = [];
  for (const w of words) {
    let q = labels.indexOf(w);
    if (q < 0 && /^\d+$/.test(w)) {
      const i = Number(w);
      if (i >= 0 && i < labels.length) q = i;
    }
    if (q < 0) return { error: `'${w}' is not a qubit of this circuit` };
    if (seen.has(q)) return { error: `${labels[q]} is named twice` };
    seen.add(q);
    out.push(q);
  }
  if (out.length === labels.length) return { error: 'one side of a split cannot be every qubit' };
  return { part: out.sort((a, b) => a - b) };
}
