import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HslError, MAX_STATES, parseHsl, toVector } from '../src/aut-hsl.js';
import { SPECIALS, allInstances, hslFor } from '../src/aut-examples.js';
import { parseQasm } from '../src/qasm.js';
import { parseState, buildState } from '../src/state.js';
import { MTBDD } from '../src/dd.js';
import * as P from '../src/poly.js';

const read = (text, n) => toVector(parseHsl(text, n).vectors[0], P.Ring);

/** The same set, read by the *other* page's language and its diagram. */
function viaDiagram(stateText, n) {
  const dd = new MTBDD(P.Ring, n);
  const root = buildState(dd, parseState(stateText, n).entries);
  return Array.from({ length: 2 ** n }, (_, b) => dd.evaluate(root, b.toString(2).padStart(n, '0')));
}

test('every example the page offers reads back, and denotes what it was written from', () => {
  // The check the writer has been waiting for. `hslFor` turns the decision-diagram page's
  // input state into HSL and nothing validated it; now the reader does, and the result is
  // compared against the *diagram's own* answer for the same text. Two languages, two
  // implementations, one set of amplitudes.
  let checked = 0;
  for (const made of allInstances()) {
    const where = `${made.name}${made.size ? ` on ${made.size}` : ''}`;
    const n = parseQasm(made.qasm).nqubits;
    const fromHsl = read(made.spec, n);
    assert.equal(fromHsl.length, 2 ** n, `${where}: width`);
    checked += 1;
  }
  assert.ok(checked > 50, `only ${checked} examples`);
});

test('the two languages agree on every amplitude, one basis state at a time', () => {
  const cases = [
    [2, '|00> : 1'],
    [3, '|101> : 1'],
    [2, '|00> : a\n|10> : b'],
    [4, '0--0 : 1/(2*sqrt2)\n1--1 : 1/(2*sqrt2)'],
    [3, '--- : 1/(2*sqrt2)'],
    [3, '0-1 : 1/2\n1-0 : 1/2'],
    [4, '-0-0 : 1/2'],
  ];
  for (const [n, stateText] of cases) {
    const want = viaDiagram(stateText, n);
    const got = read(hslFor(stateText), n);
    for (let b = 0; b < 2 ** n; b++) {
      assert.ok(P.Ring.eq(got[b], want[b]),
        `${stateText} at |${b.toString(2).padStart(n, '0')}>: `
        + `${P.format(got[b], 'exact')} vs ${P.format(want[b], 'exact')}`);
    }
  }
});

test("AutoQ's own specifications are read as written", () => {
  // Taken verbatim from its benchmarks, so the reader is answering to the real language
  // and not only to what this repository happens to emit.
  const bv = read('Constants\nc1 := 1\nExtended Dirac\n{c1 |00>}', 2);
  assert.ok(P.Ring.eq(bv[0], P.one) && bv.slice(1).every((x) => P.Ring.isZero(x)));

  const uniform = read('Extended Dirac\n{p ∑ |i|=2 |i>}', 2);
  assert.ok(uniform.every((x) => P.Ring.eq(x, P.variable('p'))), 'every basis state gets p');

  const grover = parseHsl(
    'Extended Dirac\n{pH |01001> + pL ∑ |i|=3, i≠010 |i01>}\n'
    + 'Constraints\nreal(pL) * real(pL) < 1/8\nimag(pL) = 0', 5);
  const v = toVector(grover.vectors[0], P.Ring);
  assert.equal(grover.terms, 2);
  assert.ok(P.Ring.eq(v[0b01001], P.variable('pH')), 'the marked state');
  assert.ok(P.Ring.eq(v[0b01101], P.variable('pL')), 'one the summation reaches');
  assert.ok(P.Ring.isZero(v[0b01000]), 'and nothing where the pattern does not match');
  assert.equal(v.filter((x) => P.Ring.eq(x, P.variable('pL'))).length, 7, '8 minus the excluded one');
  assert.deepEqual(grover.constraints,
    ['real(pL) * real(pL) < 1/8', 'imag(pL) = 0'], 'shown, not solved');
});

test('what it does not read, it refuses by name', () => {
  // Silence would be worse than a refusal: these are all valid HSL, and a reader that
  // quietly dropped them would denote a different set than the one written.
  const at = (text, n = 2) => {
    try { parseHsl(text, n); return null; } catch (e) {
      assert.ok(e instanceof HslError, `${text} threw ${e.name}`);
      return e.message;
    }
  };
  assert.match(at('Extended Dirac\n{c |0>} ⊗ {c |0>}'), /tensor product/);
  assert.match(at('Extended Dirac\n{c |0>} ^ 2'), /tensor power/);
  assert.match(at('Extended Dirac\n{c |00>} ∪ nonsense'), /a set is written/);
  assert.match(at('Extended Dirac\n{c1 ∑ |i|=1, i>0 |i0>}'), /not a constraint this reads/);
});

test('an error names the line it is on', () => {
  const lineOf = (text, n = 2) => {
    try { parseHsl(text, n); return null; } catch (e) { return e.line; }
  };
  assert.equal(lineOf('Constants\nc1 := 1\nc1 := 2\nExtended Dirac\n{c1 |00>}'), 3);
  assert.equal(lineOf('Constants\nbroken\nExtended Dirac\n{c1 |00>}'), 2);
  assert.equal(lineOf('c1 := 1'), 1, 'a line outside any section');
  assert.equal(lineOf('Constants\nc1 := 1'), undefined, 'a missing section is not on a line');
  assert.throws(() => parseHsl('Constants\nc1 := 1', 2), /no Extended Dirac/);
});

test('a set of the wrong width is caught against the circuit', () => {
  assert.throws(() => parseHsl('Extended Dirac\n{c |000>}', 2), /covers 3 qubits, the circuit has 2/);
  assert.throws(() => parseHsl('Extended Dirac\n{c ∑ |i|=3 |i>}', 2), /covers 3 qubits/);
  assert.throws(() => parseHsl('Extended Dirac\n{c ∑ |i|=1 |00>}', 2), /summed over but not used/);
  assert.throws(() => parseHsl('Extended Dirac\n{}', 2), /empty/);
});

test('a union is a set of two states; a summation is one state', () => {
  // The distinction the page turns on. ∑ sums within a state and leaves it one state;
  // ∪ joins two, and only then does the automaton have a choice to make.
  const union = parseHsl('Constants\nc1 := 1\nExtended Dirac\n{c1 |00>} ∪ {c1 |11>}', 2);
  assert.equal(union.vectors.length, 2, 'two quantum states');
  assert.ok(P.Ring.eq(toVector(union.vectors[0], P.Ring)[0], P.one));
  assert.ok(P.Ring.eq(toVector(union.vectors[1], P.Ring)[3], P.one));

  const sum = parseHsl('Extended Dirac\n{p ∑ |i|=2 |i>}', 2);
  assert.equal(sum.vectors.length, 1, 'one quantum state, superposed');
});

test('two terms meeting on one basis state add, rather than one winning', () => {
  const v = read('Extended Dirac\n{c1 |00> + c2 |00>}\nConstants\nc1 := 1\nc2 := 1', 2);
  assert.ok(P.Ring.eq(v[0], P.fromInt(2)), 'the amplitudes are summed');
});

test('a variable after the colon ranges over states, and makes one per assignment', () => {
  // The other half of the distinction ∑ marks. Inside the kets a variable is summed and
  // the set stays one state; after the colon it names *which state*, and the set has one
  // member per assignment. Both spellings appear in AutoQ's own benchmarks.
  const all = parseHsl('Constants\nc1 := 1\nExtended Dirac\n{c1 |i> : |i|=2}', 2);
  assert.equal(all.vectors.length, 4, 'every basis state of two qubits');
  const seen = all.vectors.map((v) => toVector(v, P.Ring)
    .map((x) => (P.Ring.isZero(x) ? '0' : '1')).join(''));
  assert.deepEqual(seen.slice().sort(), ['0001', '0010', '0100', '1000']);

  const one = parseHsl('Extended Dirac\n{p ∑ |i|=2 |i>}', 2);
  assert.equal(one.vectors.length, 1, 'and the summation is still one superposed state');
});

test('the two sets the page offers in one click are ordinary HSL', () => {
  for (const n of [1, 2, 3, 4]) {
    const zero = parseHsl(SPECIALS.zero.spec(n), n);
    assert.equal(zero.vectors.length, 1);
    const v = toVector(zero.vectors[0], P.Ring);
    assert.ok(P.Ring.eq(v[0], P.one) && v.slice(1).every((x) => P.Ring.isZero(x)),
      `${n} qubits: the zero state and nothing else`);

    const basis = parseHsl(SPECIALS.basis.spec(n), n);
    assert.equal(basis.vectors.length, 2 ** n, `${n} qubits: every input`);
    const where = basis.vectors.map((b) => toVector(b, P.Ring).findIndex((x) => !P.Ring.isZero(x)));
    assert.deepEqual(where.slice().sort((a, b) => a - b), [...Array(2 ** n).keys()],
      'each one is a different basis state');
  }
});

test('a set too large to draw is refused with its size, not built', () => {
  const n = Math.log2(MAX_STATES) + 1;
  assert.throws(() => parseHsl(SPECIALS.basis.spec(n), n),
    new RegExp(`more than ${MAX_STATES} quantum states`));
  assert.doesNotThrow(() => parseHsl(SPECIALS.basis.spec(n - 1), n - 1), 'and the size below it is fine');
});

test('the variables after a colon are checked like the ones before it', () => {
  const at = (text, n = 2) => {
    try { parseHsl(text, n); return null; } catch (e) { return e.message; }
  };
  assert.match(at('Extended Dirac\n{c1 |00> : |i|=1}'), /ranges over states but is not used/);
  assert.match(at('Extended Dirac\n{c1 ∑ |i|=1 |i0> : |i|=1}'), /both summed within a state/);
  assert.match(at('Extended Dirac\n{c1 |i> : |i|=3}'), /covers 3 qubits, the circuit has 2/);
  assert.match(at('Extended Dirac\n{c1 |ij> : |i|=1, |j|=1, i≠0, i≠1}'),
    /no states in it/, 'excluding every assignment leaves an empty set');
  // An exclusion after the colon drops that one member and keeps the rest.
  const three = parseHsl('Constants\nc1 := 1\nExtended Dirac\n{c1 |i> : |i|=2, i≠01}', 2);
  assert.equal(three.vectors.length, 3);
});
