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
import { circuitStrip } from './circuit-view.js';
import { EXAMPLES, instantiate, identify } from './aut-examples.js';

const $ = (id) => document.getElementById(id);

const THEME_STORE = 'q-vis:theme';       // shared with the other page: one choice, both apps
const STORE = 'q-vis:aut';               // its own text, though — different second box
const THEMES = ['auto', 'light', 'dark'];
const THEME_GLYPH = { auto: '◐', light: '☀', dark: '☾' };

const app = {
  circuit: null,
  index: 0,
  columns: [],
};

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
}

/** What is not built yet, said plainly rather than left as an empty plate. */
function showPlaceholder() {
  const box = document.createElement('div');
  box.className = 'aut-placeholder';
  const h = document.createElement('h2');
  h.textContent = 'No automaton yet';
  box.append(h);
  for (const text of [
    'The circuit above is drawn and steppable, and the specification beside it says which '
    + 'set of states this run starts from. What is missing is the middle: the tree '
    + 'automaton that set compiles to, and the transformer that carries it through each '
    + 'gate.',
    'Until then the two boxes are a reference for the input languages — the circuits are '
    + 'the ones the decision-diagram page offers, so the same problem can be put side by '
    + 'side in both.',
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
