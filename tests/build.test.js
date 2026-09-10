import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bundle, buildHtml } from '../tools/build.mjs';

test('the bundle evaluates and the engine still works inside it', () => {
  const { code, modules } = bundle('ui.js');
  // ui.js touches the DOM only inside functions, so the module graph evaluates in Node
  // as long as boot() is never called. That is what makes this test possible at all.
  const registry = new Function(`${code}\nreturn __m;`)();

  assert.deepEqual([...modules].sort(),
    ['circuit-view.js', 'dd.js', 'entangle.js', 'evdd.js', 'examples.js', 'gates.js', 'layout.js',
      'limdd.js', 'order.js',
      'pauli.js', 'stabilizer.js',
      'poly.js', 'qasm.js', 'random.js', 'sim.js', 'state.js', 'tableau.js', 'tikz.js', 'ui.js',
      'zomega.js'].sort());
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

test('the script the page actually carries is the script that was built', () => {
  // The bundle evaluating is not enough: it still has to survive being spliced into the
  // HTML. A string replacement treats `$&`, `$'` and `$\`` as substitution patterns, so a
  // module containing one used to come out mangled — parsing in Node, failing in a
  // browser. src/tikz.js contains `$: '\\$'`, which is one.
  const { html } = buildHtml();
  const script = html.match(/<script>\n\(function \(\) \{\n([\s\S]*?)\n\}\)\(\);\n<\/script>/);
  assert.ok(script, 'the page has one inlined script block');
  assert.doesNotThrow(() => new Function(script[1].replace(/__m\['ui\.js'\]\.boot\(\);$/, '')),
    'and it parses');
  assert.match(html, /\$: '\\\\\$'/, 'with the escape table intact, patterns and all');
});

test('the built page carries everything it needs', () => {
  const { html } = buildHtml();
  assert.doesNotMatch(html, /(?:src|href)="(?!data:)(?:\.\/)?src\//, 'no references to src/');
  assert.doesNotMatch(html, /<script type="module">/, 'the module script is replaced');
  // A hyperlink is not a fetch. The contact note in the footer points at a home page, which
  // is only loaded if the reader clicks it; what would break the promise that this one file
  // works offline is a script, stylesheet, font, image or @import pulled from elsewhere. So
  // every remote URL in the page has to be either the XML namespace or an anchor's target.
  const remote = [...html.matchAll(/https?:\/\/[^"')\s]+/g)]
    .filter((m) => !m[0].startsWith('http://www.w3.org/'))
    .filter((m) => !/<a\s[^>]*href="$/.test(html.slice(0, m.index)));
  assert.deepEqual(remote.map((m) => m[0]), [], 'nothing is fetched from the network');
  assert.match(html, /--accent:/, 'the stylesheet is inlined');
  assert.match(html, /class MTBDD/, 'the engine is inlined');
  assert.match(html, /__m\['ui\.js'\]\.boot\(\)/, 'and it is started');
});
