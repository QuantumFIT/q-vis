// The automata app: sets of quantum states as tree automata, drawn as a circuit runs.
//
// This is the second page this repository builds, and it is deliberately a *page* rather
// than a mode of the first one. The two share `src/`, the bundler, the look, the circuit
// parser and the circuit drawing; they share no engine. Nothing here reaches into the
// decision diagram, and a test fails if it ever does.
//
// What is here now: the circuit, drawn and steppable, and the worked examples of the
// other page restated as sets. What is not: the automaton itself (`aut-ta.js`), the
// specification language (`aut-hsl.js`), and the picture (`aut-layout.js`). See the plan.

import { parseQasm, QasmError } from './qasm.js';
import { circuitStrip, svgEl } from './circuit-view.js';
import { EXAMPLES, instantiate, identify } from './aut-examples.js';
import { HslError, parseHsl, toVector } from './aut-hsl.js';
import { layoutAutomaton } from './aut-layout.js';
import { TA } from './aut-ta.js';
import * as P from './poly.js';

const $ = (id) => document.getElementById(id);

const THEME_STORE = 'q-vis:theme';       // shared with the other page: one choice, both apps
const STORE = 'q-vis:aut';               // its own text, though — different second box
const THEMES = ['auto', 'light', 'dark'];
const THEME_GLYPH = { auto: '◐', light: '☀', dark: '☾' };

const app = {
  circuit: null,
  index: 0,
  columns: [],
  ta: null,
  root: null,
  rank: new Map(),      // where each node sat last time, so a survivor stays put
};

/** The plate's geometry, in the same spirit as the other page's. */
const GEO = { rowH: 78, colW: 66, padX: 34, padY: 34, gutter: 62, r: 11, termW: 46, termH: 22 };

/** 'auto' follows the system; the other two pin it. Kept per viewer, not in the file. */
function applyTheme(name) {
  if (name === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', name);
  const button = $('theme');
  button.dataset.theme = name;
  button.textContent = THEME_GLYPH[name];
  button.title = `theme: ${name} — click to cycle through auto, light and dark`;
  button.setAttribute('aria-label', `theme: ${name}`);
  try { localStorage.setItem(THEME_STORE, name); } catch { /* storage may be unavailable */ }
}

/** The tag this page was built from, or 'dev' when it was not built by a release. */
export function version() {
  return document.querySelector('meta[name="q-vis-version"]')?.content || 'dev';
}

function showVersion() {
  const chip = $('version');
  const v = version();
  if (v === 'preview') {
    chip.textContent = 'preview · open the current version';
    chip.href = '../';
  } else if (/^v\d+$/.test(v)) {
    chip.textContent = v;
    chip.removeAttribute('href');
  } else {
    chip.textContent = '';
  }
}

// ---- the circuit --------------------------------------------------------

/**
 * Which step is showing. A column is a step, as it is on the other page.
 *
 * With no circuit there is no step, and in particular the index is *not* clamped away:
 * a typo in the box is transient, and the step you were on should survive being fixed.
 */
function setStep(i) {
  if (!app.circuit) {
    $('prev').disabled = true;
    $('next').disabled = true;
    $('position').textContent = '';
    return;
  }
  const last = app.circuit.gates.length;
  app.index = Math.max(0, Math.min(i, last));
  app.columns.forEach((col, k) => col.classList.toggle('current', k === app.index));
  $('position').textContent = `${app.index} / ${last}`;
  $('prev').disabled = app.index === 0;
  $('next').disabled = app.index === last;
}

/** Read the circuit box, draw what it says, and say plainly when it says nothing valid. */
function compile() {
  // Saved first, and on every path: a circuit that does not parse is still work, and so
  // is whatever has been written beside it. Only the success path used to save, so an
  // afternoon in the specification box vanished if the circuit had a typo in it.
  save();
  showPlaceholder();
  const text = $('qasm').value;
  try {
    app.circuit = parseQasm(text);
  } catch (e) {
    if (!(e instanceof QasmError)) throw e;
    app.circuit = null;
    app.columns = [];
    $('circuit').replaceChildren();
    $('error').textContent = `circuit — ${e.message}`;
    $('stats').textContent = '';
    setStep(app.index);
    return;
  }
  $('error').textContent = '';
  const { svg, columns } = circuitStrip(app.circuit, (i) => setStep(i + 1));
  app.columns = columns;
  $('circuit').replaceChildren(svg);
  const n = app.circuit.nqubits;
  const g = app.circuit.gates.length;
  $('stats').textContent = `${n} qubit${n === 1 ? '' : 's'} · ${g} gate${g === 1 ? '' : 's'}`;
  setStep(Math.min(app.index, g));
  showAutomaton();
}

// ---- the automaton ------------------------------------------------------

/**
 * Draw the automaton the specification denotes.
 *
 * A state is a circle, a leaf is its amplitude in a box, a 0-edge is dashed and a 1-edge
 * solid — all of it the same vocabulary the other page uses, so that a reader who knows
 * one picture can read the other. What is new is the junction: a state with more than one
 * transition has each of them drawn as a small square, because *which* transition a run
 * takes is a choice, and a choice is a thing rather than an absence.
 */
function drawAutomaton(layout, labels) {
  const xOf = (x) => GEO.padX + GEO.gutter + (x - layout.xMin) * GEO.colW;
  const yOf = (y) => GEO.padY + y * GEO.rowH;
  const width = xOf(layout.xMax) + GEO.padX + GEO.termW;
  const height = yOf(layout.height) + GEO.padY + GEO.termH;
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, class: 'aut-svg' });
  svg.style.width = `${width}px`;
  svg.style.height = `${height}px`;

  // The gutter: which qubit each row decides, and what the last row holds.
  for (let level = 0; level < layout.height; level++) {
    const t = svgEl('text', { class: 'gutter', x: GEO.padX + GEO.gutter - 18, y: yOf(level) });
    t.textContent = labels[level] ?? `q[${level}]`;
    svg.append(t);
  }
  const amp = svgEl('text', { class: 'gutter band', x: GEO.padX + GEO.gutter - 18, y: yOf(layout.height) });
  amp.textContent = 'AMPLITUDE';
  svg.append(amp);

  const at = new Map(layout.nodes.map((n) => [n.id, n]));
  const edges = svgEl('g');
  for (const e of layout.edges) {
    const a = at.get(e.from);
    const b = at.get(e.to);
    if (!a || !b) continue;
    const cls = e.kind === 'stem' ? 'aut-edge stem'
      : `aut-edge ${e.high ? 'high' : 'low'}`;
    edges.append(svgEl('path', {
      class: cls,
      d: `M ${xOf(a.x)} ${yOf(a.y) + (a.kind === 'junction' ? 5 : GEO.r)}`
        + ` L ${xOf(b.x)} ${yOf(b.y) - (b.terminal ? GEO.termH / 2 : GEO.r)}`,
    }));
  }
  svg.append(edges);

  for (const n of layout.nodes) {
    const g = svgEl('g', { class: `aut-node ${n.kind}${n.fresh ? ' fresh' : ''}` });
    if (n.kind === 'junction') {
      g.append(svgEl('rect', { class: 'aut-junction', x: xOf(n.x) - 4, y: yOf(n.y) - 4, width: 8, height: 8, rx: 1.5 }));
    } else if (n.terminal) {
      g.append(svgEl('rect', {
        class: 'aut-leaf', x: xOf(n.x) - GEO.termW / 2, y: yOf(n.y) - GEO.termH / 2,
        width: GEO.termW, height: GEO.termH, rx: 2,
      }));
      const t = svgEl('text', { class: 'aut-cap', x: xOf(n.x), y: yOf(n.y) });
      t.textContent = n.label;
      g.append(t);
    } else {
      g.append(svgEl('circle', { class: 'aut-state', cx: xOf(n.x), cy: yOf(n.y), r: GEO.r }));
    }
    svg.append(g);
  }
  return svg;
}

/** Read the specification and show what it denotes, or say why it cannot be read. */
function showAutomaton() {
  if (!app.circuit) return;
  const n = app.circuit.nqubits;
  try {
    const spec = parseHsl($('specText').value, n);
    const ta = new TA(P.Ring, n);
    const { root } = ta.fromVectors(spec.vectors.map((v) => toVector(v, P.Ring)));
    app.ta = ta;
    app.root = root;
    const layout = layoutAutomaton(ta, root, {
      formatValue: (v) => P.format(v, 'exact'),
      prevRank: app.rank,
    });
    app.rank = layout.rank;
    $('canvas').replaceChildren(drawAutomaton(layout,
      app.circuit.qubits.map((q) => q.label)));
    const states = ta.size(root);
    const inSet = spec.vectors.length;
    $('stats').textContent = `${n} qubit${n === 1 ? '' : 's'} · `
      + `${app.circuit.gates.length} gate${app.circuit.gates.length === 1 ? '' : 's'} · `
      + `${states} automaton state${states === 1 ? '' : 's'} · `
      + `${inSet} quantum state${inSet === 1 ? '' : 's'}`;
    if (spec.constraints.length) {
      $('error').textContent = `${spec.constraints.length} constraint`
        + `${spec.constraints.length === 1 ? '' : 's'} shown but not checked — `
        + 'that needs a solver';
    }
  } catch (e) {
    if (!(e instanceof HslError)) throw e;
    app.ta = null;
    app.root = null;
    $('error').textContent = `specification — ${e.message}`;
    showPlaceholder();
  }
}

/** What is not built yet, said plainly rather than left as an empty plate. */
function showPlaceholder() {
  const box = document.createElement('div');
  box.className = 'aut-placeholder';
  const h = document.createElement('h2');
  h.textContent = 'Nothing to draw';
  box.append(h);
  for (const text of [
    'The circuit or the specification beside it cannot be read, so there is no set of '
    + 'states to build an automaton from. The message under the specification says what '
    + 'stopped it.',
    'What is still to come is the middle of the story: the transformer that carries the '
    + 'automaton through each gate, so that stepping the circuit moves the picture.',
  ]) {
    const p = document.createElement('p');
    p.textContent = text;
    box.append(p);
  }
  $('canvas').replaceChildren(box);
}

// ---- examples -----------------------------------------------------------

/** The sizes this example offers, or none, in which case the picker goes away. */
function showSizes(example, chosen) {
  const picker = $('size');
  picker.replaceChildren();
  if (!example?.sizes) { picker.hidden = true; return; }
  picker.hidden = false;
  for (const n of example.sizes) picker.append(new Option(`${n} qubits`, String(n)));
  picker.value = String(chosen ?? example.defaultSize ?? example.sizes[0]);
}

function useExample(index, size) {
  const example = EXAMPLES[index];
  if (!example) return;
  const made = instantiate(example, size);
  $('qasm').value = made.qasm;
  $('specText').value = made.spec;
  // Set here rather than left to the caller: boot loads an example too, and the picker
  // has to say which one that is.
  $('example').value = String(index);
  showSizes(example, made.size);
  app.index = 0;
  compile();
}

/** Keep the picker honest: once the text is edited it no longer names an example. */
function showExample() {
  const found = identify($('qasm').value, $('specText').value);
  $('example').value = found ? String(EXAMPLES.indexOf(found.example)) : '';
  showSizes(found?.example, found?.size);
}

function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify({ qasm: $('qasm').value, spec: $('specText').value }));
  } catch { /* private windows are fine; the text is still on screen */ }
}

function load() {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (v && typeof v.qasm === 'string' && typeof v.spec === 'string') {
      $('qasm').value = v.qasm;
      $('specText').value = v.spec;
      return true;
    }
  } catch { /* a corrupt entry is not worth failing over */ }
  return false;
}

export function boot() {
  let stored = null;
  try { stored = localStorage.getItem(THEME_STORE); } catch { /* storage may be unavailable */ }
  applyTheme(THEMES.includes(stored) ? stored : 'auto');
  $('theme').addEventListener('click', () => {
    const now = $('theme').dataset.theme || 'auto';
    applyTheme(THEMES[(THEMES.indexOf(now) + 1) % THEMES.length]);
  });
  showVersion();

  $('example').append(new Option('custom', ''));
  EXAMPLES.forEach((ex, i) => $('example').append(new Option(ex.name, String(i))));
  $('example').addEventListener('change', (e) => {
    // 'custom' names no example, so the size picker beside it has nothing to size.
    if (e.target.value === '') { showSizes(null); return; }
    useExample(+e.target.value, undefined);
  });
  $('size').addEventListener('change', (e) => {
    if ($('example').value !== '') useExample(+$('example').value, +e.target.value);
  });

  for (const id of ['qasm', 'specText']) {
    $(id).addEventListener('input', () => { showExample(); compile(); });
  }
  $('prev').addEventListener('click', () => setStep(app.index - 1));
  $('next').addEventListener('click', () => setStep(app.index + 1));
  addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    // Alt+Left is Back and Cmd+Left is Home; a step of a circuit is not worth either.
    if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (e.key === 'ArrowLeft') setStep(app.index - 1);
    else if (e.key === 'ArrowRight') setStep(app.index + 1);
    else return;
    e.preventDefault();
  });

  if (load()) { showExample(); compile(); } else useExample(0, undefined);
}
