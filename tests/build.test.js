import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bundle, buildHtml } from '../tools/build.mjs';

test('the bundle evaluates and the engine still works inside it', () => {
  const { code, modules } = bundle('ui.js');
  // ui.js touches the DOM only inside functions, so the module graph evaluates in Node
  // as long as boot() is never called. That is what makes this test possible at all.
  const registry = new Function(`${code}\nreturn __m;`)();

  assert.deepEqual([...modules].sort(),
    ['dd.js', 'examples.js', 'gates.js', 'layout.js', 'poly.js', 'qasm.js',
      'sim.js', 'state.js', 'ui.js', 'zomega.js'].sort());
  assert.equal(typeof registry['ui.js'].boot, 'function');

  const { MTBDD } = registry['dd.js'];
  const P = registry['poly.js'];
  const { parseQasm } = registry['qasm.js'];
  const { parseState, buildState, squaredNorm } = registry['state.js'];
  const { simulate } = registry['sim.js'];

  const circuit = parseQasm('OPENQASM 2.0;\nqreg q[3];\nh q[0];\ncx q[0],q[1];\ncx q[1],q[2];\n');
  const dd = new MTBDD(P.Ring, circuit.nqubits);
  const { entries } = parseState('|000> : 1', 3);
  const frames = simulate(dd, buildState(dd, entries), circuit);
  const last = frames[frames.length - 1];

  assert.equal(last.size, 7, 'GHZ on 3 qubits is 7 nodes, bundled exactly as unbundled');
  assert.equal(P.format(dd.evaluate(last.root, '111')), '1/√2');
  assert.equal(P.format(dd.evaluate(last.root, '101')), '0');
  assert.ok(Math.abs(squaredNorm(dd, last.root) - 1) < 1e-12);
});

test('dependencies are defined before the modules that import them', () => {
  const { modules } = bundle('ui.js');
  const at = (m) => modules.indexOf(m);
  for (const [dep, user] of [['zomega.js', 'poly.js'], ['poly.js', 'state.js'],
    ['gates.js', 'sim.js'], ['gates.js', 'qasm.js'], ['dd.js', 'ui.js'], ['examples.js', 'ui.js']]) {
    assert.ok(at(dep) < at(user), `${dep} must be defined before ${user}`);
  }
  assert.equal(modules[modules.length - 1], 'ui.js', 'the entry point comes last');
});

test('the built page carries everything it needs', () => {
  const { html } = buildHtml();
  assert.doesNotMatch(html, /(?:src|href)="(?!data:)(?:\.\/)?src\//, 'no references to src/');
  assert.doesNotMatch(html, /<script type="module">/, 'the module script is replaced');
  assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org)/, 'nothing is fetched from the network');
  assert.match(html, /--accent:/, 'the stylesheet is inlined');
  assert.match(html, /class MTBDD/, 'the engine is inlined');
  assert.match(html, /__m\['ui\.js'\]\.boot\(\)/, 'and it is started');
});
