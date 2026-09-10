#!/usr/bin/env node
// Inlines the ES module graph and the stylesheet into one self-contained HTML file.
//
// The dev loop has no build step: dev.html loads real modules over http. This script
// exists only to produce the artefact — a single q-vis.html that works offline
// from file://, with no server, no CDN and no dependencies.
//
// It is a deliberately tiny bundler, not a general one. It understands exactly the
// three import forms and three export forms this codebase uses, and refuses anything
// else rather than emitting subtly wrong code. Modules become entries in a registry
// evaluated in dependency order, which keeps plain ES module semantics without needing
// import maps or data: URLs (both of which are fragile from file://).
//
// Its one assumption: a line beginning with `import ` or `export ` is a real statement,
// not text inside a template literal. Violating that is caught by the leftover check
// at the end of bundle().

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, 'src');

const IMPORT_NS = /^import \* as (\w+) from '\.\/([\w.-]+)';\s*$/;
const IMPORT_NAMED = /^import \{([^}]*)\} from '\.\/([\w.-]+)';\s*$/;
const EXPORT_DECL = /^export (?:async )?(?:function|const|let|var|class) (\w+)/;

const REFUSED = [
  [/^export default/, 'default exports'],
  [/^export \{/, 're-export lists'],
  [/^export \*/, 'star re-exports'],
  [/^export (?:const|let|var) \w+\s*,/, 'multiple declarators in one export'],
  [/^import\s+\w+\s*(,|from)/, 'default imports'],
  [/^import\s+['"]/, 'side-effect-only imports'],
];

/** Read one module, rewrite its imports/exports, and report what it needs and provides. */
function readModule(name) {
  const lines = readFileSync(resolve(SRC, name), 'utf8').split('\n');
  const deps = [];
  const exports = [];
  const out = lines.map((line, i) => {
    const where = `${name}:${i + 1}`;
    for (const [re, what] of REFUSED) {
      if (re.test(line)) throw new Error(`${where}: ${what} are not supported by this bundler`);
    }
    let m = line.match(IMPORT_NS);
    if (m) {
      deps.push(m[2]);
      return `const ${m[1]} = __m[${JSON.stringify(m[2])}];`;
    }
    m = line.match(IMPORT_NAMED);
    if (m) {
      deps.push(m[2]);
      const names = m[1].split(',').map((s) => s.trim()).filter(Boolean)
        .map((s) => s.replace(/^(\w+) as (\w+)$/, '$1: $2')).join(', ');
      return `const { ${names} } = __m[${JSON.stringify(m[2])}];`;
    }
    if (/^import\b/.test(line)) throw new Error(`${where}: unrecognised import form: ${line.trim()}`);
    m = line.match(EXPORT_DECL);
    if (m) {
      exports.push(m[1]);
      return line.replace(/^export /, '');
    }
    if (/^export\b/.test(line)) throw new Error(`${where}: unrecognised export form: ${line.trim()}`);
    return line;
  });
  return { name, deps, exports, code: out.join('\n') };
}

/** Depth-first postorder, so every module is defined after the ones it imports. */
function order(entry) {
  const mods = new Map();
  const sorted = [];
  const state = new Map();
  const visit = (name, stack) => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'visiting') {
      throw new Error(`import cycle: ${[...stack, name].join(' -> ')}`);
    }
    state.set(name, 'visiting');
    const mod = readModule(name);
    mods.set(name, mod);
    for (const dep of mod.deps) visit(dep, [...stack, name]);
    state.set(name, 'done');
    sorted.push(mod);
  };
  visit(entry, []);
  return sorted;
}

/** The module registry as plain script source, declaring `__m`. */
export function bundle(entry) {
  const mods = order(entry);
  const parts = ['const __m = Object.create(null);'];
  for (const mod of mods) {
    parts.push(
      `__m[${JSON.stringify(mod.name)}] = (function () {`,
      mod.code,
      `return { ${mod.exports.join(', ')} };`,
      '})();',
    );
  }
  const code = parts.join('\n');
  const leftover = code.split('\n').find((l) => /^(import|export)\b/.test(l));
  if (leftover) throw new Error(`a statement survived rewriting, refusing to emit: ${leftover.trim()}`);
  return { code, modules: mods.map((m) => m.name) };
}

/**
 * The pages this repository builds. Each is a shell, the module whose `boot` starts it,
 * and the file it is written to. They share `src/` and this bundler and nothing else —
 * two separate pages, so neither one's engine can reach into the other's.
 *
 * The keys are the site paths: 'q-vis' is the root, 'aut' is /aut/.
 */
export const APPS = {
  'q-vis': { shell: 'dev.html', entry: 'ui.js', out: 'q-vis.html' },
  // The shell and the output must not share a name, or building overwrites the source.
  aut: { shell: 'aut-dev.html', entry: 'aut-ui.js', out: 'aut.html' },
};

/**
 * @param {string} version the tag being built, 'preview', or 'dev'. It is stamped into
 *   the page so that a copied link can point at this exact build, which is archived under
 *   /v/<tag>/ and never changes again. See docs/VERSIONS.md.
 * @param {string} app which of `APPS` to build. Version stays the first argument so that
 *   every existing caller keeps building what it did.
 */
export function buildHtml(version = 'dev', app = 'q-vis') {
  if (!/^(dev|preview|v\d+)$/.test(version)) {
    throw new Error(`version must be 'dev', 'preview' or a release tag like v3, got '${version}'`);
  }
  if (!Object.hasOwn(APPS, app)) throw new Error(`no such app '${app}'`);
  const { shell, entry } = APPS[app];
  const { code, modules } = bundle(entry);
  let html = readFileSync(resolve(ROOT, shell), 'utf8');

  // Every replacement below passes a *function*, never a string: in a string replacement
  // `$&`, `$'` and `$\`` are substitution patterns, so any source containing one would be
  // silently spliced. src/tikz.js has `$: '\\$'` in its LaTeX escape table, which is
  // exactly that, and it produced a bundle that parsed in Node and not in a browser.
  const stamped = html.replace('<meta name="q-vis-version" content="dev">',
    () => `<meta name="q-vis-version" content="${version}">`);
  if (stamped === html && version !== 'dev') throw new Error('no version meta tag to stamp');
  html = stamped;

  // Every stylesheet the shell links, in the order it links them, so a page can carry a
  // shared sheet and its own. Matching each link rather than one literal path is what
  // lets the two apps share `shell.css` without either of them inlining the other's.
  let sheets = 0;
  html = html.replace(/<link rel="stylesheet" href="src\/([\w.-]+\.css)">/g, (_, name) => {
    sheets += 1;
    return `<style>\n${readFileSync(resolve(SRC, name), 'utf8')}\n</style>`;
  });
  if (!sheets) throw new Error(`${shell} links no stylesheet from src/`);

  html = html.replace(
    /<script type="module">[\s\S]*?<\/script>/,
    () => `<script>\n(function () {\n${code}\n__m['${entry}'].boot();\n})();\n</script>`,
  );

  if (/(?:src|href)="(?!data:)(?:\.\/)?src\//.test(html)) {
    throw new Error('the built file still references src/ — it would not work offline');
  }
  return { html, modules };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Named apps, or all of them. A release names them one at a time so that a build which
  // cannot produce one — an old tag has no second app — does not take the other with it.
  const want = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const names = want.length ? want : Object.keys(APPS);
  const version = process.env.Q_VIS_VERSION || 'dev';
  for (const name of names) {
    if (!Object.hasOwn(APPS, name)) throw new Error(`no such app '${name}'`);
    const out = resolve(ROOT, APPS[name].out);
    const { html, modules } = buildHtml(version, name);
    writeFileSync(out, html);
    const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
    console.log(`${out}  ${version}  ${kb} kB  (${modules.length} modules: ${modules.join(' ')})`);
  }
}
