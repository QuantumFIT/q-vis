// The automata app: sets of quantum states as tree automata, drawn as a circuit runs.
//
// This is the second page this repository builds, and it is deliberately a *page* rather
// than a mode of the first one. The two share `src/`, the bundler and the look; they
// share no engine. Nothing here reaches into the decision-diagram modules, and nothing
// there reaches in here — so neither can break the other by accident.
//
// Stage 1 is the plumbing: the page exists, is built and published at /aut/, and carries
// the version stamp its permalinks will need. The automaton itself arrives with
// `aut-ta.js`, the specification language with `aut-hsl.js`, and the picture with
// `aut-layout.js`. See the plan and docs/VERSIONS.md.
//
// It imports nothing on purpose. A single import of `ui.js` would pull the whole
// decision-diagram engine into this bundle, which is the one thing the split is for.

const $ = (id) => document.getElementById(id);

const THEME_STORE = 'q-vis:theme';       // shared with the other page: one choice, both apps
const THEMES = ['auto', 'light', 'dark'];
const THEME_GLYPH = { auto: '◐', light: '☀', dark: '☾' };

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

/**
 * What the masthead says about which build this is. A release names its tag; a preview
 * says so and offers the way back, since a draft is a place you arrive at from a link
 * and should be able to leave.
 */
function showVersion() {
  const chip = $('version');
  const v = version();
  if (v === 'preview') {
    chip.textContent = 'preview · open the current version';
    chip.href = '../../aut/';
  } else if (/^v\d+$/.test(v)) {
    chip.textContent = v;
    chip.removeAttribute('href');
  } else {
    chip.textContent = '';
  }
}

/** What is not built yet, said plainly rather than left as an empty plate. */
function showPlaceholder() {
  const box = document.createElement('div');
  box.className = 'aut-placeholder';
  const lines = [
    ['h', 'Nothing to draw yet'],
    ['p', 'This page is the second of the two this repository builds. Its plumbing is in '
      + 'place — it is built, published at /aut/, and stamped with the version its links '
      + 'will pin to — but the automaton, the specification language and the picture are '
      + 'still to come.'],
    ['p', 'What it will do: read a set of quantum states written in HSL, compile it to a '
      + 'tree automaton, and show that automaton change as a circuit is applied to it, '
      + 'gate by gate — the same transport as the decision-diagram page, over a set of '
      + 'states rather than one.'],
  ];
  for (const [kind, text] of lines) {
    const e = document.createElement(kind === 'h' ? 'h2' : 'p');
    e.textContent = text;
    box.append(e);
  }
  $('canvas').append(box);
  $('stats').textContent = 'stage 1 of 7 — the plumbing';
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
  showPlaceholder();
}
