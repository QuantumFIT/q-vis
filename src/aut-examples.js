// Worked examples for the automata page — the same circuits the decision-diagram page
// offers, so the two can be put side by side on the same problem.
//
// What differs is the second box. There a circuit is paired with *one* input state; here
// it is paired with a *set* of them, written in HSL. `hslFor` does that translation, and
// the two languages line up more neatly than they might: a don't-care in a basis pattern
// is exactly a summation over a variable of that length, which is what HSL is for.
//
//     0--0 : 1/(2*sqrt2)      becomes      c1 ∑ |v|=2 |0v0>
//
// Nothing here parses HSL — that comes with `aut-hsl.js`. This only writes it, and the
// two will be checked against each other by round-tripping once the reader exists.

import { EXAMPLES as DIAGRAM_EXAMPLES, instantiate as instantiateDiagram } from './examples.js';

/** Names for the variables a summation introduces, one per run of don't-cares. */
const VARS = [...'ijklmnpqrstuvwxyz'];

/**
 * One basis pattern as an HSL ket. Runs of '-' become variables with a length
 * constraint; a pattern with no don't-cares is written out as it stands.
 *
 * @returns {{ket: string, constraints: string[]}}
 */
export function patternToKet(pattern, used = 0) {
  const ket = [];
  const constraints = [];
  let i = 0;
  let next = used;
  while (i < pattern.length) {
    if (pattern[i] !== '-') { ket.push(pattern[i]); i += 1; continue; }
    let run = 0;
    while (i + run < pattern.length && pattern[i + run] === '-') run += 1;
    const name = VARS[next % VARS.length] + (next >= VARS.length ? String(next) : '');
    next += 1;
    ket.push(name);
    constraints.push(`|${name}|=${run}`);
    i += run;
  }
  return { ket: ket.join(''), constraints, used: next };
}

/**
 * An amplitude as HSL writes one. The decision-diagram page prints √ and ω; HSL's own
 * benchmark files are plain ASCII, so they are spelled out.
 */
export function amplitudeToHsl(text) {
  return text
    .replace(/√2/g, 'sqrt2')
    .replace(/√/g, 'sqrt')
    .replace(/ω/g, 'omega')
    .replace(/·/g, '*')
    .replace(/−/g, '-')
    .replace(/\s+/g, '');
}

/**
 * The input-state text of a decision-diagram example, as an HSL specification of the set
 * containing just that state.
 *
 * A set of one is a modest thing to say in a language built for sets, and that is the
 * point: it is the same problem the other page shows, stated in the other language, so
 * the step from one state to many is the reader's to take.
 */
export function hslFor(stateText) {
  const lines = stateText.split('\n').map((l) => l.trim()).filter(Boolean);
  const constants = [];
  const terms = [];
  const constraints = [];
  let used = 0;

  lines.forEach((line, i) => {
    const at = line.lastIndexOf(':');
    const pattern = line.slice(0, at).trim().replace(/^\||[>⟩]$/g, '');
    const amplitude = amplitudeToHsl(line.slice(at + 1));
    const ket = patternToKet(pattern, used);
    used = ket.used;

    // A bare symbol is already an HSL amplitude variable and needs no constant; anything
    // else is named, because the Constants section is where a value belongs.
    let coefficient = amplitude;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(amplitude)) {
      coefficient = `c${i + 1}`;
      constants.push(`${coefficient} := ${amplitude}`);
    }
    const sum = ket.constraints.length ? ` ∑ ${ket.constraints.join(', ')}` : '';
    terms.push(`${coefficient}${sum} |${ket.ket}>`);
    constraints.push(...ket.constraints);
  });

  const head = constants.length ? `Constants\n${constants.join('\n')}\n` : '';
  return `${head}Extended Dirac\n{${terms.join(' + ')}}\n`;
}

/** The same examples the other page offers; only the second box is written differently. */
export const EXAMPLES = DIAGRAM_EXAMPLES;

/**
 * One concrete example: a family built at `size`, or a fixed one as it stands. The circuit
 * is taken verbatim from the other page so the two show the same thing.
 */
export function instantiate(example, size) {
  const made = instantiateDiagram(example, size);
  return { name: made.name, size: made.size, qasm: made.qasm, spec: hslFor(made.state) };
}

/** Every example at every size it offers — what the tests sweep over. */
export function allInstances() {
  return EXAMPLES.flatMap((ex) => (ex.sizes ?? [undefined]).map((n) => instantiate(ex, n)));
}

/** Which example and size produced this text, or null; used to restore a saved view. */
export function identify(qasm, spec) {
  for (const example of EXAMPLES) {
    for (const size of example.sizes ?? [undefined]) {
      const made = instantiate(example, size);
      if (made.qasm === qasm && made.spec === spec) return { example, ...made };
    }
  }
  return null;
}
