import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archiveUrl, liveUrl } from '../src/ui.js';
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

test('the build stamps the version it was told, and refuses nonsense', () => {
  const stamp = (v) => buildHtml(v).html.match(/name="q-vis-version" content="([^"]*)"/)[1];
  assert.equal(stamp('v3'), 'v3');
  assert.equal(stamp(), 'dev', 'an ordinary build is not a release');
  // A bad version would be baked into a page that then points links at a directory the
  // release never created, so it fails at build time instead.
  assert.throws(() => buildHtml('1.2.3'), /must be 'dev' or a release tag/);
  assert.throws(() => buildHtml('v3; rm -rf /'), /must be 'dev' or a release tag/);
});
