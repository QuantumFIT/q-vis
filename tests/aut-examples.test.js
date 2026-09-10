import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXAMPLES, allInstances, amplitudeToHsl, hslFor, identify, instantiate, patternToKet } from '../src/aut-examples.js';
import { parseQasm } from '../src/qasm.js';

/** How many qubits an HSL ket stands for: a literal bit is one, a variable is its length. */
function ketWidth(spec) {
  const inner = spec.match(/\{([^}]*)\}/)[1];
  return inner.split('+').map((term) => {
    const ket = term.match(/\|([^|>]*)>/)[1];
    const lengths = new Map();
    for (const [, name, n] of term.matchAll(/\|(\w+)\|=(\d+)/g)) lengths.set(name, Number(n));
    let width = 0;
    let i = 0;
    while (i < ket.length) {
      const named = [...lengths.keys()].find((v) => ket.startsWith(v, i));
      if (named) { width += lengths.get(named); i += named.length; } else { width += 1; i += 1; }
    }
    return width;
  });
}

test('every example is a circuit the parser accepts, at every size it offers', () => {
  // The circuits are the other page's, taken verbatim, so this is really a check that
  // taking them verbatim is what happened.
  let count = 0;
  for (const made of allInstances()) {
    const where = `${made.name}${made.size ? ` on ${made.size}` : ''}`;
    const circuit = parseQasm(made.qasm);
    assert.ok(circuit.gates.length > 0, `${where}: no gates`);
    if (made.size) assert.ok(circuit.nqubits >= made.size, `${where}: too few qubits`);
    count += 1;
  }
  assert.ok(count > 50, `only ${count} instances`);
});

test('every example states a set of the right width, in the three-section shape', () => {
  for (const made of allInstances()) {
    const where = `${made.name}${made.size ? ` on ${made.size}` : ''}`;
    assert.match(made.spec, /Extended Dirac\n\{/, where);
    assert.ok(!made.spec.includes('undefined'), `${where}: something did not translate`);
    // A Constants section, when there is one, comes first and defines what the set uses.
    if (made.spec.startsWith('Constants')) {
      for (const [, name] of made.spec.matchAll(/^(c\d+) :=/gm)) {
        assert.ok(made.spec.includes(`${name} `), `${where}: ${name} is defined and unused`);
      }
    }
    // Every term must describe as many qubits as the circuit declares.
    const n = parseQasm(made.qasm).nqubits;
    for (const width of ketWidth(made.spec)) {
      assert.equal(width, n, `${where}: a term covers ${width} qubits, the circuit has ${n}`);
    }
  }
});

test("a don't-care becomes a summation, which is what HSL has them for", () => {
  // The two languages line up here: '-' in a basis pattern means "either value of this
  // qubit", and a summation over a variable of that length means exactly the same.
  assert.deepEqual(patternToKet('0110'), { ket: '0110', constraints: [], used: 0 });
  assert.deepEqual(patternToKet('0--0'), { ket: '0i0', constraints: ['|i|=2'], used: 1 });
  assert.deepEqual(patternToKet('----'), { ket: 'i', constraints: ['|i|=4'], used: 1 });
  // Runs that are not adjacent need a variable each, since they are separated by a bit.
  assert.deepEqual(patternToKet('-0-'), { ket: 'i0j', constraints: ['|i|=1', '|j|=1'], used: 2 });
  // And a second pattern in the same specification must not reuse the first's names.
  assert.deepEqual(patternToKet('--', 1), { ket: 'j', constraints: ['|j|=2'], used: 2 });
});

test('an amplitude is spelled the way HSL spells it', () => {
  assert.equal(amplitudeToHsl(' 1/(2√2) '), '1/(2sqrt2)');
  assert.equal(amplitudeToHsl('−ω/2'), '-omega/2');
  assert.equal(amplitudeToHsl('1'), '1');
});

test('a set of one is written the way AutoQ writes it', () => {
  // Its own benchmarks open with exactly this, which is the shape to match.
  assert.equal(hslFor('|00> : 1'), 'Constants\nc1 := 1\nExtended Dirac\n{c1 |00>}\n');
  // A symbolic amplitude is already an HSL variable and is not given a constant.
  assert.equal(hslFor('|00> : a\n|10> : b'), 'Extended Dirac\n{a |00> + b |10>}\n');
});

test('the picker stops naming an example once the text is edited', () => {
  const first = instantiate(EXAMPLES[0], undefined);
  const found = identify(first.qasm, first.spec);
  assert.ok(found, 'an untouched example is recognised');
  assert.equal(found.name, EXAMPLES[0].name);
  assert.equal(identify(`${first.qasm}\nx q[0];\n`, first.spec), null, 'an edited circuit is not');
  assert.equal(identify(first.qasm, `${first.spec}\n`), null, 'nor an edited specification');
});
