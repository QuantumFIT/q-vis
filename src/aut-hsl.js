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
// benchmark files use: the three sections, sets joined by ∪, a sum of terms, and a
// summation over a bitstring variable with a length and inequality constraints.
// Everything else — ⊗, tensor powers, the outer union over amplitude constraints, and
// the `{diracs : varcons}` form where the variables range over *states* rather than
// being summed within one — is refused by name rather than misread.
//
// The distinction ∪ marks is the one the whole page turns on. A ∑ sums *within* one
// state, so it stays one state; a ∪ joins two states into a set of two. Only the second
// makes the automaton nondeterministic, and only then is there anything to see that a
// decision diagram could not have shown.
//
// Constraints on the amplitudes are parsed far enough to be shown and no further. AutoQ
// discharges them with an SMT solver; a browser does not have one, and pretending
// otherwise would be worse than saying so.

import { parseAmplitude } from './state.js';

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
    if (group[1].includes(':')) {
      throw new HslError('variables that range over states ({… : |v|=N}) are not read yet; '
        + 'a summation (∑) within one state is', line);
    }
    const made = readSet(group[1], named, nqubits, line);
    terms += made.terms;
    vectors.push(made.amplitudes);
  }
  return {
    vectors,
    constraints: parts.get('Constraints').map((c) => c.text),
    terms,
  };
}

/** One `{...}`: a sum of terms, and so one quantum state. */
function readSet(body, named, nqubits, line) {
  const amplitudes = new Array(2 ** nqubits).fill(null);
  let terms = 0;
  for (const piece of body.split('+')) {
    if (!piece.trim()) continue;
    terms += 1;
    const term = readTerm(piece.trim(), line);
    const value = named.get(term.coefficient) ?? (() => {
      try { return parseAmplitude(term.coefficient); } catch (e) {
        throw new HslError(e.message, line);
      }
    })();

    // The ket is bits and variables; each assignment of the variables is a basis state.
    const names = [...term.constraints.lengths.keys()];
    const used = names.filter((v) => term.pattern.includes(v));
    for (const v of names) {
      if (!used.includes(v)) throw new HslError(`'${v}' is summed over but not used`, line);
    }
    let any = false;
    for (const pick of assignments(used, term.constraints.lengths, term.constraints.excluded)) {
      let bits = term.pattern;
      for (const [v, b] of pick) bits = bits.split(v).join(b);
      if (!/^[01]*$/.test(bits)) {
        throw new HslError(`'${term.pattern}' has something that is neither a bit nor a `
          + 'summed variable', line);
      }
      if (bits.length !== nqubits) {
        throw new HslError(`|${term.pattern}> covers ${bits.length} qubits, `
          + `the circuit has ${nqubits}`, line);
      }
      const at = parseInt(bits, 2);
      amplitudes[at] = amplitudes[at] === null ? value : { add: [amplitudes[at], value] };
      any = true;
    }
    if (!any) throw new HslError('the constraints leave this term with nothing to sum over', line);
  }
  if (!terms) throw new HslError('the set is empty', line);
  return { amplitudes, terms };
}

/** Finish the amplitudes into ring values, adding where two terms met on a basis state. */
export function toVector(amplitudes, ring) {
  return amplitudes.map((a) => {
    if (a === null) return ring.zero;
    const flatten = (x) => (x && x.add ? ring.add(flatten(x.add[0]), flatten(x.add[1])) : x);
    return flatten(a);
  });
}
