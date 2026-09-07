import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archiveUrl, liveUrl, viewCode, viewFromCode } from '../src/ui.js';
import { buildHtml } from '../tools/build.mjs';

const SITE = 'https://quantum.fit.vut.cz/q-vis/';

test('a copied link points at the frozen copy of the build that made it', () => {
  assert.equal(archiveUrl(SITE, 'v10'), `${SITE}v/v10/`);
  assert.equal(archiveUrl(`${SITE}index.html`, 'v10'), `${SITE}v/v10/`);
  assert.equal(archiveUrl(`${SITE}#c=abc&t=l`, 'v10'), `${SITE}v/v10/`,
    'the settings are added by the caller, not carried over');
});

test('there is nothing to pin to when nothing was archived', () => {
  assert.equal(archiveUrl(SITE, 'dev'), null, 'an unreleased build has no frozen copy');
  assert.equal(archiveUrl('file:///home/someone/q-vis.html', 'v10'), null,
    'a downloaded page has no site to point at');
  assert.equal(archiveUrl('not a url', 'v10'), null);
  assert.equal(archiveUrl(`${SITE}v/v10/`, 'v10'), null,
    'the archived copy is already where a link should point');
});

test('an archived page offers the way back, and only it does', () => {
  assert.equal(liveUrl(`${SITE}v/v10/#c=abc`, 'v10'), SITE);
  assert.equal(liveUrl(`${SITE}v/v10/index.html`, 'v10'), SITE);
  assert.equal(liveUrl(SITE, 'v10'), null, 'the current build is already current');
  assert.equal(liveUrl(SITE, 'dev'), null);
});

test('a preview is not something a link can be pinned to', () => {
  // A preview changes without warning and disappears when it is done, so there is nothing
  // to pin to — which leaves a copied link on the preview itself, where it belongs.
  assert.equal(archiveUrl(`${SITE}preview/`, 'preview'), null);
  assert.equal(archiveUrl(SITE, 'preview'), null);
  // And it offers the way back to the site the way an archived release does.
  assert.equal(liveUrl(`${SITE}preview/#c=abc`, 'preview'), SITE);
  assert.equal(liveUrl(`${SITE}preview/index.html`, 'preview'), SITE);
  assert.equal(liveUrl(SITE, 'preview'), null, 'the root is not a preview');
});

test('the build stamps the version it was told, and refuses nonsense', () => {
  const stamp = (v) => buildHtml(v).html.match(/name="q-vis-version" content="([^"]*)"/)[1];
  assert.equal(stamp('v3'), 'v3');
  assert.equal(stamp('preview'), 'preview');
  assert.equal(stamp(), 'dev', 'an ordinary build is not a release');
  // A bad version would be baked into a page that then points links at a directory the
  // release never created, so it fails at build time instead.
  for (const bad of ['1.2.3', 'v3; rm -rf /', 'prev', 'previews', 'v', 'V3']) {
    assert.throws(() => buildHtml(bad), /must be 'dev', 'preview' or a release tag/, bad);
  }
});

test('a view is spelled in a link the way it always was', () => {
  // The codes predate the split into a representation and a tree toggle, and links
  // already in the wild use them, so both directions have to keep agreeing.
  const cases = [['reduced', false, ''], ['reduced', true, '1'],
    ['edge-valued', false, 'e'], ['edge-valued', true, 'te'],
    ['limdd', false, 'l'], ['limdd', true, 'tl']];
  for (const [rep, tree, code] of cases) {
    assert.equal(viewCode(rep, tree), code, `${rep}${tree ? ' as a tree' : ''}`);
    if (code) assert.deepEqual(viewFromCode(code), [rep, tree], `t=${code}`);
  }
  assert.deepEqual(viewFromCode(undefined), ['reduced', false], 'a link with no view');
  assert.deepEqual(viewFromCode('nonsense'), ['reduced', false], 'and one from the future');
});
