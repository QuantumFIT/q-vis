#!/usr/bin/env node
// Assembles the whole published site: the current build at the root, and a frozen copy
// of every released version under /v/<tag>/.
//
// The point of the archive is that a link keeps showing what it showed when it was made.
// "copy link" in a released build points at /v/<that version>/, so the page behind a
// shared link never changes again — not when the parameters change meaning, not when a
// view is renamed, not when the QASM dialect grows.
//
// Every version is rebuilt from its tag on every deploy, so the archive is a function of
// the repository alone: nothing is carried over from the previous deploy, and a lost or
// corrupted publish is repaired by running the workflow again. Each tag is built by *its
// own* tools/build.mjs, which is what makes the copy faithful rather than merely old.
//
// Usage: node tools/release.mjs [outdir]        (default _site)

import { execFileSync, execSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE = /^v\d+$/;

// stderr is swallowed: `git describe` on a repository with no tags is a normal answer
// here, not a problem worth printing.
const git = (...args) => execFileSync('git', args,
  { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** Released versions, oldest first. */
function releases() {
  return git('tag', '--list', '--format=%(refname:short)%09%(contents:subject)')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [tag, subject = ''] = line.split('\t');
      return { tag, subject };
    })
    .filter(({ tag }) => RELEASE.test(tag))
    .sort((a, b) => Number(a.tag.slice(1)) - Number(b.tag.slice(1)));
}

/** The tag HEAD is exactly at, or 'dev' — an untagged build promises no frozen copy. */
function headVersion() {
  try {
    const tag = git('describe', '--tags', '--exact-match', 'HEAD');
    return RELEASE.test(tag) ? tag : 'dev';
  } catch {
    return 'dev';
  }
}

function build(version, into) {
  mkdirSync(dirname(into), { recursive: true });
  execFileSync('node', [join(ROOT, 'tools', 'build.mjs')],
    { cwd: ROOT, env: { ...process.env, Q_VIS_VERSION: version }, stdio: 'pipe' });
  cpSync(join(ROOT, 'q-vis.html'), into);
}

/** A tag is built from its own source, by its own build script. */
function buildTag(tag, into) {
  const work = mkdtempSync(join(tmpdir(), `q-vis-${tag}-`));
  try {
    execSync(`git archive ${tag} | tar -x -C ${JSON.stringify(work)}`, { cwd: ROOT });
    execFileSync('node', [join(work, 'tools', 'build.mjs')],
      { cwd: work, env: { ...process.env, Q_VIS_VERSION: tag }, stdio: 'pipe' });
    mkdirSync(dirname(into), { recursive: true });
    cpSync(join(work, 'q-vis.html'), into);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const escape = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

/** A plain index of the archive, so the versions are discoverable without guessing. */
function indexPage(versions, current) {
  const rows = [...versions].reverse().map(({ tag, subject }) => `    <li><a href="${tag}/">${tag}</a>`
    + `${tag === current ? ' <em>(current)</em>' : ''} — ${escape(subject)}</li>`).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>q-vis — archived versions</title>
<style>
  body { margin: 0 auto; padding: 3rem 1.5rem; max-width: 42rem;
         font: 15px/1.6 ui-sans-serif, system-ui, sans-serif; color: #14202a; }
  h1 { font-size: 1.3rem; font-weight: 500; }
  li { margin: 0.4rem 0; }
  a { color: #a8175f; }
  p { color: #4a5a68; }
  @media (prefers-color-scheme: dark) {
    body { background: #14202a; color: #e6edf3; }
    p { color: #9fb0bf; }
    a { color: #ff74b1; }
  }
</style>
</head>
<body>
  <h1>q-vis — archived versions</h1>
  <p>Every released version is kept here exactly as it was published, so that a link
     copied from one of them keeps showing what it showed. The
     <a href="../">current version</a> is what to use for new work.</p>
  <ul>
${rows}
  </ul>
</body>
</html>
`;
}

const out = resolve(process.argv[2] || join(ROOT, '_site'));
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const current = headVersion();
build(current, join(out, 'index.html'));
console.log(`/            ${current}`);

const versions = releases();
for (const { tag } of versions) {
  buildTag(tag, join(out, 'v', tag, 'index.html'));
  console.log(`/v/${tag}/${' '.repeat(Math.max(0, 9 - tag.length))}   archived`);
}
if (versions.length) {
  writeFileSync(join(out, 'v', 'index.html'), indexPage(versions, current));
  console.log(`/v/          index of ${versions.length} version${versions.length === 1 ? '' : 's'}`);
}

// build.mjs always writes q-vis.html in the working tree, so a tagged run leaves a
// stamped copy behind. Put an unstamped one back, or a later local build would inherit a
// version it has no right to.
if (current !== 'dev') {
  execFileSync('node', [join(ROOT, 'tools', 'build.mjs')], { cwd: ROOT, stdio: 'pipe' });
}
