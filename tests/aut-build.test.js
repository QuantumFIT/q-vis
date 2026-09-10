import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APPS, bundle, buildHtml } from '../tools/build.mjs';
import { archiveUrl, liveUrl } from '../src/ui.js';

const SITE = 'https://quantum.fit.vut.cz/q-vis/';
const AUT = `${SITE}aut/`;

test('the two pages are built from the same bundler and share no engine', () => {
  // The whole point of a second page rather than a second mode: one import of ui.js from
  // the automata side would pull the decision-diagram engine — nineteen modules of it —
  // into a page that has no use for it, and the two would stop being separable.
  const one = bundle(APPS['q-vis'].entry);
  const two = bundle(APPS.aut.entry);
  assert.ok(one.modules.includes('dd.js'), 'the decision-diagram page has the engine');
  // The line is drawn at the *diagram*, not at everything quantum. The ring, the circuit
  // parser and the gate matrices are shared ground that an automaton needs just as much;
  // what must not cross is the decision diagram itself and what is built on it.
  for (const engine of ['dd.js', 'evdd.js', 'limdd.js', 'layout.js', 'sim.js',
    'tableau.js', 'entangle.js', 'pauli.js', 'stabilizer.js', 'ui.js']) {
    assert.ok(!two.modules.includes(engine), `${engine} reached the automata page`);
  }
  assert.equal(two.modules[two.modules.length - 1], 'aut-ui.js', 'its entry is built last');
  // What it does share is the ground both sit on, and the circuit drawn the same way.
  for (const shared of ['qasm.js', 'gates.js', 'circuit-view.js', 'shell.js']) {
    assert.ok(one.modules.includes(shared) && two.modules.includes(shared),
      `${shared} should be common ground`);
  }
});

test('no page is built over its own shell', () => {
  // It was: the automata page's shell and output were both aut.html, so the first build
  // silently overwrote the source it had just read. A page whose shell is its output is
  // a page that can only be built once.
  const outs = new Set();
  for (const [name, app] of Object.entries(APPS)) {
    assert.notEqual(app.shell, app.out, `${name} builds over its own shell`);
    assert.ok(!outs.has(app.out), `${name} writes a file another page already writes`);
    outs.add(app.out);
  }
});

test('the automata page is self-contained and knows which build it is', () => {
  const { html } = buildHtml('v21', 'aut');
  assert.match(html, /<meta name="q-vis-version" content="v21">/);
  assert.match(html, /__m\['aut-ui\.js'\]\.boot\(\);/, 'it boots its own entry, not the other one');
  assert.doesNotMatch(html, /(?:src|href)="(?!data:)(?:\.\/)?src\//, 'nothing is left to fetch');
  assert.doesNotMatch(html, /<script type="module">/);
  assert.match(html, /--accent:/, 'the stylesheet came with it');
  assert.match(html, /<meta charset="utf-8">/, 'the anchor a preview build adds noindex to');
  assert.match(html, /id="version"/, 'somewhere to say which build this is');
  // Every remote reference is a namespace or a link, never something the page loads.
  for (const url of html.match(/https?:\/\/[^"'\s)]+/g) || []) {
    assert.ok(url.startsWith('http://www.w3.org/'), `the page reaches out to ${url}`);
  }
});

test('building one page leaves the other alone, and an unknown page is refused', () => {
  assert.equal(buildHtml('dev').html, buildHtml('dev', 'q-vis').html,
    'the default is still the decision-diagram page, so every existing caller is unmoved');
  assert.notEqual(buildHtml('dev', 'aut').html, buildHtml('dev', 'q-vis').html);
  assert.throws(() => buildHtml('dev', 'nope'), /no such app/);
  assert.throws(() => buildHtml('nonsense', 'aut'), /version must be/);
});

test('a page in a subdirectory pins and unpins its own links, with no new code', () => {
  // This is why the site puts everything belonging to a page under that page's own base:
  // /aut/ archives to /aut/v/<tag>/ and previews at /aut/preview/. archiveUrl and liveUrl
  // resolve relative to the page they are called from, so they already do the right thing
  // there — the layout is chosen to fit the functions rather than the other way round.
  assert.equal(archiveUrl(AUT, 'v21'), `${AUT}v/v21/`);
  assert.equal(archiveUrl(`${AUT}#c=abc`, 'v21'), `${AUT}v/v21/`);
  assert.equal(archiveUrl(`${AUT}v/v21/`, 'v21'), null, 'the frozen copy is already frozen');
  assert.equal(liveUrl(`${AUT}v/v21/#c=abc`, 'v21'), AUT, 'and back again');
  assert.equal(liveUrl(`${AUT}preview/`, 'preview'), AUT);

  // And the two pages' archives cannot be confused for one another.
  assert.notEqual(archiveUrl(AUT, 'v21'), archiveUrl(SITE, 'v21'));
  assert.equal(archiveUrl(SITE, 'v21'), `${SITE}v/v21/`, 'the root page is unaffected');
});
