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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE = /^v\d+$/;

/**
 * The pages this repository publishes, and where each one's world lives.
 *
 * Everything belonging to a page sits under its own base: the build itself, its archive,
 * and its preview. That is not a filing preference — `archiveUrl` and `liveUrl` in the
 * app build their URLs *relative to the page's own directory*, so a page at /aut/ already
 * looks for /aut/v/<tag>/ and /aut/preview/. Laying the site out this way is what lets
 * both apps share those functions untouched.
 *
 * A tag older than a page cannot build it. Nothing here insists that it can: whatever
 * that tag's own build script produced is published, and the rest is quietly absent.
 */
const PAGES = [
  { out: 'q-vis.html', base: [], name: '/' },
  { out: 'aut.html', base: ['aut'], name: '/aut/' },
];

const site = (...parts) => join(out, ...parts.flat());

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

/** Copy one built file into the site, if the build actually produced it. */
function place(from, into) {
  if (!existsSync(from)) return false;
  mkdirSync(dirname(into), { recursive: true });
  cpSync(from, into);
  return true;
}

/**
 * Build the working tree and place every page it produced. The build script is run with
 * no arguments on purpose: a script that knows one page builds one, a script that knows
 * two builds two, and neither this function nor an old tag has to be told which.
 */
function build(version, at) {
  execFileSync('node', [join(ROOT, 'tools', 'build.mjs')],
    { cwd: ROOT, env: { ...process.env, Q_VIS_VERSION: version }, stdio: 'pipe' });
  const made = [];
  for (const page of PAGES) {
    if (place(join(ROOT, page.out), site(page.base, at, 'index.html'))) made.push(page);
  }
  return made;
}

/**
 * A ref is built from its own source, by its own build script — which is what makes an
 * archived copy faithful rather than merely old, and what lets a preview branch be
 * whatever it likes.
 */
function buildRef(ref, version, at) {
  const work = mkdtempSync(join(tmpdir(), `q-vis-${version}-`));
  try {
    execSync(`git archive ${ref} | tar -x -C ${JSON.stringify(work)}`, { cwd: ROOT });
    const run = (stamp) => execFileSync('node', [join(work, 'tools', 'build.mjs')],
      { cwd: work, env: { ...process.env, Q_VIS_VERSION: stamp }, stdio: 'pipe' });
    try {
      run(version);
    } catch (e) {
      // A branch older than the stamp it is being given cannot be told what it is. Let it
      // build as an ordinary one rather than losing the preview over a label.
      if (version !== 'preview') throw e;
      run('dev');
    }
    const made = [];
    for (const page of PAGES) {
      if (place(join(work, page.out), site(page.base, at, 'index.html'))) made.push(page);
    }
    if (!made.length) throw new Error(`${ref} produced no page`);
    return made;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The preview branch, wherever it is visible from here, or null when there is none. */
function previewRef() {
  for (const ref of ['origin/preview', 'preview']) {
    try {
      git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
      return ref;
    } catch { /* not this one */ }
  }
  return null;
}

/** A preview is a working draft, and has no business in anyone's search results. */
function keepOutOfSearch(file) {
  const html = readFileSync(file, 'utf8');
  writeFileSync(file, html.replace('<meta charset="utf-8">',
    '<meta charset="utf-8">\n<meta name="robots" content="noindex">'));
}

const escape = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

/**
 * A plain index of one page's archive, so its versions are discoverable without guessing.
 * `title` names the page, because each published page keeps its own archive under its own
 * base and so each gets its own index.
 */
function indexPage(versions, current, preview, title) {
  const rows = [
    ...(preview ? ['    <li><a href="../preview/">preview</a> — <em>not a release</em>: '
      + 'a draft that changes without warning, and disappears when it is done</li>'] : []),
    ...[...versions].reverse().map(({ tag, subject }) => `    <li><a href="${tag}/">${tag}</a>`
      + `${tag === current ? ' <em>(current)</em>' : ''} — ${escape(subject)}</li>`),
  ].join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — archived versions</title>
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
  <h1>${title} — archived versions</h1>
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
for (const page of build(current, [])) console.log(`${page.name.padEnd(12)} ${current}`);

// Which versions each page has an archived copy of. A page younger than a tag has none
// from before it existed, and that is simply how the list comes out.
const archived = new Map(PAGES.map((p) => [p.name, []]));
const versions = releases();
for (const version of versions) {
  const pages = buildRef(version.tag, version.tag, ['v', version.tag]);
  for (const page of pages) archived.get(page.name).push(version);
  const where = pages.map((p) => `${p.name}v/${version.tag}/`).join(' ');
  console.log(`archived     ${where}`);
}

// The draft under review, if there is one. It is built last and its failure is survivable:
// the site the public sees must go out whatever state a working branch is in.
const draft = previewRef();
const previewed = new Set();
if (draft) {
  try {
    for (const page of buildRef(draft, 'preview', ['preview'])) {
      keepOutOfSearch(site(page.base, ['preview'], 'index.html'));
      previewed.add(page.name);
      console.log(`${`${page.name}preview/`.padEnd(12)} from ${draft}`);
    }
  } catch (e) {
    for (const page of PAGES) rmSync(site(page.base, ['preview']), { recursive: true, force: true });
    console.log(`preview      skipped: ${draft} does not build (${e.message.split('\n')[0]})`);
  }
}

for (const page of PAGES) {
  const mine = archived.get(page.name);
  if (!mine.length) continue;
  const title = page.base.length ? `q-vis/${page.base.join('/')}` : 'q-vis';
  writeFileSync(site(page.base, ['v'], 'index.html'),
    indexPage(mine, current, previewed.has(page.name), title));
  console.log(`${`${page.name}v/`.padEnd(12)} index of ${mine.length} version${mine.length === 1 ? '' : 's'}`);
}

// build.mjs always writes q-vis.html in the working tree, so a tagged run leaves a
// stamped copy behind. Put an unstamped one back, or a later local build would inherit a
// version it has no right to.
if (current !== 'dev') {
  execFileSync('node', [join(ROOT, 'tools', 'build.mjs')], { cwd: ROOT, stdio: 'pipe' });
}
