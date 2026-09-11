// Reading HSL — the specification language a set of quantum states is written in.
//
// The language is from the CAV'26 paper and is what AutoQ takes; its own benchmark files
// look like this:
//
//     Constants
//     cp := 1/sqrt2
//     Extended Dirac
//     {pH |01001> + pL ∑ |i|=3, i≠010 |i01>}
//     Constraints
//     real(pL) * real(pL) < 1/8
//
// What is read here is the fragment `aut-examples.js` writes plus what the simpler
// benchmark files use: the three sections, sets joined by ∪, a sum of terms, a summation
// over a bitstring variable with a length and inequality constraints, and the
// `{diracs : varcons}` form where the variables range over *states*. Everything else —
// ⊗, tensor powers, and the outer union over amplitude constraints — is refused by name
// rather than misread.
//
// The distinction is the one the whole page turns on, and this language marks it twice.
// A ∑ sums *within* one state, so it stays one state: `{p ∑ |i|=2 |i>}` is one uniform
// superposition. A ∪, and equally a `: |i|=2` after the kets, makes a set of several:
// `{p |i> : |i|=2}` is four states, one per basis vector. Only the second kind makes the
// automaton nondeterministic, and only then is there anything to see that a decision
// diagram could not have shown.
//
// The second kind is also how the two preconditions a verifier reaches for first are
// written — `{c |0...0>}`, and `{c |i> : |i|=n}` for every computational basis state.
//
// Constraints on the amplitudes are parsed far enough to be shown and no further. AutoQ
// discharges them with an SMT solver; a browser does not have one, and pretending
// otherwise would be worse than saying so.

import { parseAmplitude } from './state.js';

/**
 * How many quantum states one specification may denote.
 *
 * Not a limit on the picture, which is the thing it used to be: `{c |i> : |i|=n}` is 2^n
 * states and its automaton, once reduced, is 2n+1 — twenty-five of them at twelve qubits,
 * which would draw perfectly well. The limit is on *this reader*, which makes every
 * member in full, as a dense vector of 2^n amplitudes, before the automaton gets a chance
 * to share anything between them. That is 4^n work, and it is what a set of this size
 * actually costs today.
 *
 * So the number is measured rather than chosen. Every basis state of nine qubits — 512 of
 * them — is read, built, reduced, counted and carried through a circuit in under half a
 * second; ten qubits takes 1.7s and eleven takes nine, almost all of it in making those
 * vectors and in counting the members back out of the automaton afterwards. Sparse
 * amplitudes would move the wall a long way, and are not built.
 */
export const MAX_STATES = 512;

export class HslError extends Error {
  constructor(message, line) {
    super(line ? `line ${line}: ${message}` : message);
    this.name = 'HslError';
    this.line = line;
  }
}

const SECTIONS = ['Constants', 'Extended Dirac', 'Constraints'];

/** Split the text into its named sections, keeping each line's number for the errors. */
function sections(text) {
  const out = new Map(SECTIONS.map((s) => [s, []]));
  let current = null;
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/(\/\/|#).*$/, '').trim();
    if (!line) return;
    if (SECTIONS.includes(line)) { current = line; return; }
    if (!current) throw new HslError(`'${line}' is outside any section`, i + 1);
    out.get(current).push({ text: line, line: i + 1 });
  });
  return out;
}

/** `name := expression`, the amplitudes a specification gives a name to. */
function constants(lines) {
  const out = new Map();
  for (const { text, line } of lines) {
    const at = text.indexOf(':=');
    if (at < 0) throw new HslError(`a constant is written 'name := value', not '${text}'`, line);
    const name = text.slice(0, at).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new HslError(`'${name}' is not a name`, line);
    if (out.has(name)) throw new HslError(`'${name}' is defined twice`, line);
    try {
      out.set(name, parseAmplitude(text.slice(at + 2).trim()));
    } catch (e) {
      throw new HslError(`${name}: ${e.message}`, line);
    }
  }
  return out;
}

/** The constraints on a summation variable: how long it is, and what it is not. */
function varConstraints(text, line) {
  const lengths = new Map();
  const excluded = new Map();
  for (const part of text.split(',').map((s) => s.trim()).filter(Boolean)) {
    let m = part.match(/^\|(\w+)\|\s*=\s*(\d+)$/);
    if (m) { lengths.set(m[1], Number(m[2])); continue; }
    m = part.match(/^(\w+)\s*(?:≠|!=|<>)\s*([01]+)$/);
    if (m) {
      if (!excluded.has(m[1])) excluded.set(m[1], []);
      excluded.get(m[1]).push(m[2]);
      continue;
    }
    throw new HslError(`'${part}' is not a constraint this reads`, line);
  }
  return { lengths, excluded };
}

/** Every assignment of the named variables, as a map from name to bit string. */
function* assignments(names, lengths, excluded) {
  const counts = names.map((v) => 2 ** lengths.get(v));
  const total = counts.reduce((a, b) => a * b, 1);
  for (let k = 0; k < total; k++) {
    const pick = new Map();
    let rest = k;
    let ok = true;
    for (let i = 0; i < names.length; i++) {
      const v = names[i];
      const width = lengths.get(v);
      const bits = (rest % counts[i]).toString(2).padStart(width, '0');
      rest = Math.floor(rest / counts[i]);
      if ((excluded.get(v) ?? []).includes(bits)) { ok = false; break; }
      pick.set(v, bits);
    }
    if (ok) yield pick;
  }
}

/** One term: an amplitude, an optional summation, and a ket of bits and variables. */
function readTerm(text, line) {
  const ket = text.match(/\|([^|>⟩]*)[>⟩]\s*$/);
  if (!ket) throw new HslError(`'${text}' has no ket at the end of it`, line);
  const head = text.slice(0, ket.index).trim();
  const sum = head.match(/(∑|\\sum)\s*(.*)$/);
  const coefficient = (sum ? head.slice(0, sum.index) : head).trim();
  return {
    coefficient,
    pattern: ket[1].trim(),
    constraints: sum ? varConstraints(sum[2], line) : { lengths: new Map(), excluded: new Map() },
    line,
  };
}

/**
 * Read a specification, and give back the states it denotes.
 *
 * @param {string} text
 * @param {number} nqubits how wide the circuit is, so a set of the wrong width is caught
 * @returns {{vectors: any[][], constraints: string[], terms: number}} one amplitude
 *   vector per state in the set, plus the amplitude constraints, unread and for showing
 */
export function parseHsl(text, nqubits) {
  const parts = sections(text);
  const named = constants(parts.get('Constants'));
  const body = parts.get('Extended Dirac');
  if (!body.length) throw new HslError('no Extended Dirac section, so no set of states');

  const joined = body.map((b) => b.text).join(' ');
  const line = body[0].line;
  for (const [token, what] of [['⊗', 'a tensor product'], ['^', 'a tensor power'],
    ['⋃', 'a union over amplitude constraints']]) {
    if (joined.includes(token)) {
      throw new HslError(`${what} (${token}) is not read yet`, line);
    }
  }

  const groups = joined.split('∪').map((g) => g.trim());
  const vectors = [];
  let terms = 0;
  for (const raw of groups) {
    const group = raw.match(/^\{(.*)\}$/s);
    if (!group) throw new HslError(`a set is written {...}, not '${raw}'`, line);

    // `{ kets : |v|=N }` — the variables after the colon range over *states*, so the set
    // has one member per assignment of them. A ∑ inside the kets is the other thing
    // entirely and is read per member, below.
    const colon = group[1].indexOf(':');
    const body = colon < 0 ? group[1] : group[1].slice(0, colon);
    const over = colon < 0 ? null : varConstraints(group[1].slice(colon + 1), line);

    const parsed = readTerms(body, named, line);
    terms += parsed.length;
    const outerNames = over ? [...over.lengths.keys()] : [];
    for (const v of outerNames) {
      if (!parsed.some((t) => t.pattern.includes(v))) {
        throw new HslError(`'${v}' ranges over states but is not used`, line);
      }
      if (parsed.some((t) => t.constraints.lengths.has(v))) {
        throw new HslError(`'${v}' is both summed within a state and ranged over states`, line);
      }
    }

    let any = false;
    for (const pick of assignments(outerNames, over?.lengths ?? new Map(),
      over?.excluded ?? new Map())) {
      vectors.push(buildSet(parsed, nqubits, pick, line));
      any = true;
      if (vectors.length > MAX_STATES) {
        throw new HslError(`this names more than ${MAX_STATES} quantum states, which is `
          + 'more than this reader will build — it makes each one in full before the '
          + 'automaton shares anything between them', line);
      }
    }
    if (!any) throw new HslError('the constraints leave this set with no states in it', line);
  }
  return {
    vectors,
    constraints: parts.get('Constraints').map((c) => c.text),
    terms,
  };
}

/** The `+`-separated terms of one `{...}`, each with its amplitude resolved. */
function readTerms(body, named, line) {
  const terms = [];
  for (const piece of body.split('+')) {
    if (!piece.trim()) continue;
    const term = readTerm(piece.trim(), line);
    const value = named.get(term.coefficient) ?? (() => {
      try { return parseAmplitude(term.coefficient); } catch (e) {
        throw new HslError(e.message, line);
      }
    })();
    terms.push({ ...term, value });
  }
  if (!terms.length) throw new HslError('the set is empty', line);
  return terms;
}

/**
 * One quantum state: the terms, with `outer` fixed to this member's assignment.
 *
 * Two kinds of variable meet here and they are substituted in order. `outer` came from
 * after the colon and picks *which state of the set* this is; what is left is summed
 * over within it, and each of those assignments is a basis state of this one state.
 */
function buildSet(terms, nqubits, outer, line) {
  const amplitudes = new Array(2 ** nqubits).fill(null);
  for (const term of terms) {
    let pattern = term.pattern;
    for (const [v, b] of outer) pattern = pattern.split(v).join(b);

    const names = [...term.constraints.lengths.keys()];
    const used = names.filter((v) => pattern.includes(v));
    for (const v of names) {
      if (!used.includes(v)) throw new HslError(`'${v}' is summed over but not used`, line);
    }
    let any = false;
    for (const pick of assignments(used, term.constraints.lengths, term.constraints.excluded)) {
      let bits = pattern;
      for (const [v, b] of pick) bits = bits.split(v).join(b);
      if (!/^[01]*$/.test(bits)) {
        throw new HslError(`'${term.pattern}' has something that is neither a bit nor a `
          + 'variable this reads', line);
      }
      if (bits.length !== nqubits) {
        throw new HslError(`|${term.pattern}> covers ${bits.length} qubits, `
          + `the circuit has ${nqubits}`, line);
      }
      const at = parseInt(bits, 2);
      amplitudes[at] = amplitudes[at] === null
        ? term.value : { add: [amplitudes[at], term.value] };
      any = true;
    }
    if (!any) throw new HslError('the constraints leave this term with nothing to sum over', line);
  }
  return amplitudes;
}

/** Finish the amplitudes into ring values, adding where two terms met on a basis state. */
export function toVector(amplitudes, ring) {
  return amplitudes.map((a) => {
    if (a === null) return ring.zero;
    const flatten = (x) => (x && x.add ? ring.add(flatten(x.add[0]), flatten(x.add[1])) : x);
    return flatten(a);
  });
}
