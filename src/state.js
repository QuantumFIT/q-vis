// The input-state language: a sparse list of basis patterns with exact amplitudes.
//
//     |00> : a
//     |11> : b
//     0-1  : 1/sqrt(2)      // '-' is a don't-care, matching both values of that qubit
//
// Amplitudes are expressions over integers, i, sqrt2, omega (= e^{i pi/4}) and free
// symbols, combined with + - * / ^. Division is exact: it is allowed only by a constant
// whose inverse stays in Z[1/sqrt(2), i], so 1/sqrt(2) and 1/2 work and 1/3 does not.
//
// A '?' in the amplitude gives every basis state the pattern matches its *own* symbol,
// named after that state: "--0-- : ?" is a five-qubit state with sixteen unknowns a00000
// ... a11011 and zero wherever the middle qubit is 1. Write "x?" for a different prefix,
// and the rest of the expression still applies, so "?/2" halves each of them.

import * as Z from './zomega.js';
import * as P from './poly.js';

/** One line may not introduce more symbols than this; each becomes its own terminal. */
const MAX_GENERATED_SYMBOLS = 256;

const WILDCARD = /([A-Za-z_][A-Za-z0-9_]*)?\?/g;

/** Every basis state a pattern matches, in counting order. */
function* matching(pattern) {
  const free = [...pattern].map((c, i) => (c === '-' ? i : -1)).filter((i) => i >= 0);
  for (let m = 0; m < 2 ** free.length; m++) {
    const bits = [...pattern];
    free.forEach((pos, j) => { bits[pos] = String((m >> (free.length - 1 - j)) & 1); });
    yield bits.join('');
  }
}

export class StateError extends Error {
  constructor(message, line) {
    super(line ? `line ${line}: ${message}` : message);
    this.name = 'StateError';
    this.line = line;
  }
}

const ETOKEN = /\s+|[A-Za-z_][A-Za-z0-9_]*|\d+\.\d+|\d+|√2|[()+\-*/^]/g;

function tokenizeExpr(text, line) {
  const out = [];
  let pos = 0;
  ETOKEN.lastIndex = 0;
  let m;
  while ((m = ETOKEN.exec(text)) !== null) {
    if (m.index !== pos) throw new StateError(`unexpected character ${JSON.stringify(text[pos])}`, line);
    pos = m.index + m[0].length;
    if (!/^\s+$/.test(m[0])) out.push(m[0]);
  }
  if (pos !== text.length) throw new StateError(`unexpected character ${JSON.stringify(text[pos])}`, line);
  return out;
}

/** Parse one amplitude expression into a polynomial. */
export function parseAmplitude(text, line) {
  const t = tokenizeExpr(text, line);
  let i = 0;
  const peek = () => t[i];
  const eat = (s) => (t[i] === s ? (i++, true) : false);

  const constantOf = (p, what) => {
    const s = P.asScalar(p);
    if (s === null) throw new StateError(`cannot ${what} a symbolic expression`, line);
    return s;
  };

  const atom = () => {
    const tok = peek();
    if (tok === undefined) throw new StateError('unexpected end of amplitude expression', line);
    if (eat('(')) {
      const v = expr();
      if (!eat(')')) throw new StateError("expected ')'", line);
      return v;
    }
    i++;
    if (/^\d+$/.test(tok)) return P.fromInt(parseInt(tok, 10));
    if (/^\d+\.\d+$/.test(tok)) {
      throw new StateError(`decimals are not exact: write ${tok === '0.5' ? '1/2' : 'a fraction'} instead of ${tok}`, line);
    }
    if (tok === 'i') return P.fromZ(Z.I);
    if (tok === '√2' || tok === 'sqrt2') return P.fromZ(Z.SQRT2);
    if (tok === 'omega' || tok === 'w' || tok === 'ω') return P.fromZ(Z.OMEGA);
    if (tok === 'sqrt') {
      if (!eat('(')) throw new StateError("expected '(' after sqrt", line);
      const inner = expr();
      if (!eat(')')) throw new StateError("expected ')'", line);
      const s = P.asScalar(inner);
      if (s === null || !Z.eq(s, Z.fromInt(2))) {
        throw new StateError('only sqrt(2) is supported', line);
      }
      return P.fromZ(Z.SQRT2);
    }
    if (/^[A-Za-z_]/.test(tok)) return P.variable(tok);
    throw new StateError(`unexpected '${tok}' in amplitude expression`, line);
  };

  const power = () => {
    const base = atom();
    if (!eat('^')) return base;
    const e = t[i++];
    if (!/^\d+$/.test(e)) throw new StateError('the exponent must be a non-negative integer', line);
    let acc = P.one;
    for (let k = 0; k < parseInt(e, 10); k++) acc = P.mul(acc, base);
    return acc;
  };

  const unary = () => {
    if (eat('-')) return P.neg(unary());
    if (eat('+')) return unary();
    return power();
  };

  const term = () => {
    let v = unary();
    for (;;) {
      if (eat('*')) v = P.mul(v, unary());
      else if (eat('/')) {
        const d = constantOf(unary(), 'divide by');
        if (Z.isZero(d)) throw new StateError('division by zero', line);
        try {
          v = P.mul(v, P.fromZ(Z.invert(d)));
        } catch (e) {
          throw new StateError(e.message, line);
        }
      } else return v;
    }
  };

  const expr = () => {
    let v = term();
    for (;;) {
      if (eat('+')) v = P.add(v, term());
      else if (eat('-')) v = P.sub(v, term());
      else return v;
    }
  };

  const value = expr();
  if (i !== t.length) throw new StateError(`unexpected '${t[i]}' in amplitude expression`, line);
  return value;
}

/**
 * Parse a whole state description.
 * @returns {{entries: {pattern:string, amplitude:any, line:number}[], symbols: string[]}}
 */
export function parseState(text, nqubits) {
  const entries = [];
  const symbols = new Set();
  text.split('\n').forEach((raw, idx) => {
    const line = idx + 1;
    const stripped = raw.replace(/(\/\/|#).*$/, '').trim();
    if (!stripped) return;

    const sep = stripped.search(/[:=]/);
    if (sep < 0) throw new StateError(`expected '<basis> : <amplitude>', found '${stripped}'`, line);
    let pattern = stripped.slice(0, sep).trim();
    const rhs = stripped.slice(sep + 1).trim();

    pattern = pattern.replace(/^\|/, '').replace(/[>⟩]$/, '').replace(/[\s_]/g, '');
    pattern = pattern.replace(/[*x?]/gi, '-');
    if (!pattern) throw new StateError('missing basis state', line);
    if (/[^01-]/.test(pattern)) {
      throw new StateError(`a basis pattern may only contain 0, 1 and '-' (got '${pattern}')`, line);
    }
    if (pattern.length !== nqubits) {
      throw new StateError(`basis pattern '${pattern}' has ${pattern.length} qubit(s), the circuit has ${nqubits}`, line);
    }
    if (!rhs) throw new StateError('missing amplitude', line);

    if (WILDCARD.test(rhs)) {
      WILDCARD.lastIndex = 0;
      const count = 2 ** [...pattern].filter((c) => c === '-').length;
      if (count > MAX_GENERATED_SYMBOLS) {
        throw new StateError(
          `'${pattern}' matches ${count} basis states, so '?' would introduce ${count} `
          + `symbols; at most ${MAX_GENERATED_SYMBOLS} are allowed`, line);
      }
      for (const bits of matching(pattern)) {
        // Name each unknown after the basis state it belongs to, so a terminal says which
        // amplitude it is rather than just that it is the seventh one.
        const amplitude = parseAmplitude(rhs.replace(WILDCARD, (_, name) => (name || 'a') + bits), line);
        for (const sym of P.symbols(amplitude)) symbols.add(sym);
        entries.push({ pattern: bits, amplitude, line });
      }
      return;
    }

    const amplitude = parseAmplitude(rhs, line);
    for (const s of P.symbols(amplitude)) symbols.add(s);
    entries.push({ pattern, amplitude, line });
  });

  if (!entries.length) throw new StateError('the state is empty: give at least one basis state');
  return { entries, symbols: [...symbols].sort() };
}

/** Build the diagram for a parsed state. Repeated patterns add up. */
export function buildState(dd, entries) {
  return dd.fromPatterns(entries.map((e) => [e.pattern, e.amplitude]));
}

/** The all-zeros state, the default when the user gives no input state. */
export function defaultStateText(nqubits) { return `|${'0'.repeat(nqubits)}> : 1`; }

/** A fully general state: every basis state its own unknown. */
export function symbolicStateText(nqubits) { return `${'-'.repeat(nqubits)} : ?`; }

/**
 * Squared norm, if the state has no free symbols. Returns null when it is symbolic,
 * since normalisation then depends on the values the symbols take.
 */
export function squaredNorm(dd, root) {
  let total = 0;
  for (const { value } of dd.amplitudes(root, 1 << 20)) {
    if (P.symbols(value).size) return null;
    const c = P.evaluate(value, {});
    total += c.re * c.re + c.im * c.im;
  }
  return total;
}
