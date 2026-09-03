#!/usr/bin/env node
// Inlines the ES module graph and the stylesheet into one self-contained HTML file.
//
// The dev loop has no build step: dev.html loads real modules over http. This script
// exists only to produce the artefact — a single quantum-vis.html that works offline
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

export function buildHtml() {
  const { code, modules } = bundle('ui.js');
  const css = readFileSync(resolve(SRC, 'app.css'), 'utf8');
  let html = readFileSync(resolve(ROOT, 'dev.html'), 'utf8');

  html = html.replace('<link rel="stylesheet" href="src/app.css">', `<style>\n${css}\n</style>`);
  html = html.replace(
    /<script type="module">[\s\S]*?<\/script>/,
    `<script>\n(function () {\n${code}\n__m['ui.js'].boot();\n})();\n</script>`,
  );

  if (/(?:src|href)="(?!data:)(?:\.\/)?src\//.test(html)) {
    throw new Error('the built file still references src/ — it would not work offline');
  }
  return { html, modules };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = resolve(ROOT, 'quantum-vis.html');
  const { html, modules } = buildHtml();
  writeFileSync(out, html);
  const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
  console.log(`${out}  ${kb} kB  (${modules.length} modules: ${modules.join(' ')})`);
}
