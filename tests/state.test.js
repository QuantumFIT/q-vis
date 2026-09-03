import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmplitude, parseState, buildState, squaredNorm, StateError } from '../src/state.js';
import { MTBDD } from '../src/dd.js';
import * as P from '../src/poly.js';
import * as Z from '../src/zomega.js';

test('amplitude expressions are parsed exactly', () => {
  const cases = [
    ['1', '1'], ['-2', '-2'], ['i', 'i'], ['-i/2', '-i/2'],
    ['1/sqrt(2)', '1/√2'], ['1/sqrt2', '1/√2'], ['1/√2', '1/√2'],
    ['omega', 'ω'], ['omega^2', 'i'], ['omega^8', '1'], ['(1+i)/2', '(1+i)/2'],
    ['2^3', '8'], ['1 - 1', '0'], ['a', 'a'], ['3*a - b/2', '3a - b/2'],
    ['a^2*b', 'a²b'], ['-(a+b)', '-a - b'], ['(a+b)*(a-b)', 'a² - b²'],
  ];
  for (const [src, want] of cases) assert.equal(P.format(parseAmplitude(src, 1)), want, src);
});

test('inexact or ill-formed amplitudes are refused', () => {
  const cases = [
    ['1/3', /not invertible/], ['0.5', /decimals are not exact/], ['1/a', /cannot divide by a symbolic/],
    ['2 +', /unexpected end/], ['a b', /unexpected 'b'/], ['(1', /expected '\)'/],
    ['1/(1-1)', /division by zero/], ['a^-1', /exponent must be a non-negative integer/],
    ['sqrt(3)', /only sqrt\(2\)/], ['%', /unexpected character/],
  ];
  for (const [src, re] of cases) assert.throws(() => parseAmplitude(src, 1), re, src);
});

test('a state description parses into patterns and symbols', () => {
  const { entries, symbols } = parseState('|00> : a\n// comment\n\n|11> = b   # trailing\n', 2);
  assert.deepEqual(entries.map((e) => e.pattern), ['00', '11']);
  assert.deepEqual(symbols, ['a', 'b']);
  assert.deepEqual(entries.map((e) => e.line), [1, 4]);
  // ket decorations, spaces and the various wildcard spellings are all accepted
  assert.deepEqual(parseState('|0 1⟩:1\n1*:1\n1?:1\n', 2).entries.map((e) => e.pattern), ['01', '1-', '1-']);
});

test('state errors are located and explained', () => {
  const cases = [
    ['|0> : 1', 2, /has 1 qubit\(s\), the circuit has 2/],
    ['|00>', 2, /expected '<basis> : <amplitude>'/],
    ['|00> :', 2, /missing amplitude/],
    [' : 1', 2, /missing basis state/],
    ['|02> : 1', 2, /may only contain 0, 1/],
    ['', 2, /the state is empty/],
  ];
  for (const [src, n, re] of cases) assert.throws(() => parseState(src, n), re, JSON.stringify(src));
  try { parseState('|00> : 1\n|01> : 1/3\n', 2); assert.fail('should throw'); }
  catch (e) { assert.ok(e instanceof StateError); assert.equal(e.line, 2); }
});

test('wildcards cost nothing: a uniform state is a single terminal', () => {
  const n = 10;
  const { entries } = parseState(`${'-'.repeat(n)} : 1/2^5`, n);
  const m = new MTBDD(P.Ring, n);
  const root = buildState(m, entries);
  assert.equal(m.size(root), 1);
  assert.ok(Math.abs(squaredNorm(m, root) - 1) < 1e-12);
  // ... and it really is the uniform state.
  for (const b of ['0000000000', '1111111111', '1010101010']) {
    assert.ok(Z.eq(P.asScalar(m.evaluate(root, b)), Z.zo(1, 0, 0, 0, 10)));
  }
});

test('partial wildcards select the right basis states', () => {
  const m = new MTBDD(P.Ring, 3);
  const { entries } = parseState('0-1 : 1/2', 3);
  const root = buildState(m, entries);
  const seen = [...m.amplitudes(root)].map((a) => a.bits).sort();
  assert.deepEqual(seen, ['001', '011']);
  assert.equal(P.format(m.evaluate(root, '011')), '1/2');
  assert.equal(P.format(m.evaluate(root, '111')), '0');
});

test('repeated patterns add up', () => {
  const m = new MTBDD(P.Ring, 2);
  const { entries } = parseState('|00> : a\n|00> : b\n', 2);
  assert.equal(P.format(m.evaluate(buildState(m, entries), '00')), 'a + b');
});

test('squaredNorm is null exactly when the state is symbolic', () => {
  const m = new MTBDD(P.Ring, 2);
  const sym = buildState(m, parseState('|00> : a\n|11> : b\n', 2).entries);
  assert.equal(squaredNorm(m, sym), null);
  const bell = buildState(m, parseState('|00> : 1/sqrt2\n|11> : 1/sqrt2\n', 2).entries);
  assert.ok(Math.abs(squaredNorm(m, bell) - 1) < 1e-12);
  const unnormalised = buildState(m, parseState('|00> : 1\n|11> : 1\n', 2).entries);
  assert.ok(Math.abs(squaredNorm(m, unnormalised) - 2) < 1e-12);
});
