// The automata app: sets of quantum states as tree automata, drawn as a circuit runs.
//
// This is the second page this repository builds, and it is deliberately a *page* rather
// than a mode of the first one. The two share `src/`, the bundler, the look, the circuit
// parser and the circuit drawing; they share no engine. Nothing here reaches into the
// decision diagram, and a test fails if it ever does.
//
// What is here now: the circuit, drawn and steppable; the worked examples of the other
// page restated as sets; the automaton the specification denotes; and the gates, which
// carry it through the circuit so that stepping moves the picture. What is not: sharing
// a view (permalinks, SVG, TikZ), reading AutoQ's own `.aut` files, and the choice sets
// of a level-synchronized automaton. See the plan.

import { parseQasm, QasmError } from './qasm.js';
import { circuitStrip, svgEl } from './circuit-view.js';
import { armDialog, armPanels, showCode } from './shell.js';
import { EXAMPLES, SPECIALS, instantiate, identify } from './aut-examples.js';
import { HslError, MAX_STATES, parseHsl, toVector } from './aut-hsl.js';
import { simulate } from './aut-gates.js';
import { fanAngles, layoutAutomaton, spread } from './aut-layout.js';
import { automatonTikz, circuitTikz } from './tikz.js';
import { TA } from './aut-ta.js';
import * as P from './poly.js';

const $ = (id) => document.getElementById(id);

const THEME_STORE = 'q-vis:theme';       // shared with the other page: one choice, both apps
const STORE = 'q-vis:aut';               // its own text, though — different second box
const THEMES = ['auto', 'light', 'dark'];
const THEME_GLYPH = { auto: '◐', light: '☀', dark: '☾' };

/**
 * How far `fit` may scale, and how far the buttons may go.
 *
 * The same numbers and the same reasoning as the other page. The floor stops a large
 * automaton shrinking into illegibility — past it, it scrolls instead. The ceiling is
 * expressed as the widest a state may be drawn, so a two-qubit automaton on a large
 * screen is not blown up until its strokes look like a magnified screenshot.
 */
const MAX_NODE_PX = 52;
const MIN_FIT_SCALE = 0.12;
// The floor of an explicit zoom is the floor of `fit`, and it has to be: with a higher
// floor, an automaton fitted below it answers the − button by getting *bigger* — the
// clamp raising 0.096 to the floor — and then sticks there. The other page carries the
// two apart, at 0.12 and 0.15, and is wrong in the same way when its plate is tall
// enough against a short window.
const ZOOM_RANGE = [MIN_FIT_SCALE, 8];
const ZOOM_STEP = 1.25;

const app = {
  circuit: null,
  index: 0,
  columns: [],
  ta: null,
  frames: [],           // the automaton before the circuit, and after each gate of it
  layouts: [],          // one per frame, laid out in order so a survivor stays put
  svg: null,            // the plate, once there is one to zoom
  sticky: null,         // the gutter strip, held at the left edge of the view
  plate: null,          // its size in its own coordinates
  zoom: 'fit',
  scale: 1,
};

/**
 * The plate's geometry, in the same spirit as the other page's.
 *
 * An edge leaves its state straight, along the ray it was given, before it bends toward
 * the child over a handle of `handle`. The straight part is what the arc joining a
 * transition's two edges is drawn across — inside the run, so the arc's ends land exactly
 * on the two edges rather than near them.
 */
const GEO = {
  // padY leaves room above the first row for the arrow into the root, as padTop does on
  // the other page.
  rowH: 78, colW: 66, padX: 34, padY: 44, gutter: 62, r: 11, termW: 46, termH: 22,
  handle: 12,
};

/**
 * How far the straight run reaches, for a state with `k` edges leaving it.
 *
 * It grows with the fan, and the reason is the arc: the more transitions a state has the
 * narrower each one's sector, and an arc of a narrow sector is only long enough to read
 * if it is drawn further out.
 */
const runOf = (k) => Math.min(30, 16 + 2.2 * (k - 2));

/** Where a gutter label sits on the plate: right-aligned, just left of the first column. */
const GUTTER_X = 78;

/** How far around a state's rim an edge may arrive, and how far apart two arrivals sit. */
const ENTRY_LIMIT = 66;
const ENTRY_GAP = 36;

/**
 * How far out the edge straightens for its final approach.
 *
 * Spreading arrivals around the rim is only half the job. An edge that has been pushed
 * round to the side of a state still has to *get* there, and if its last stretch aimed
 * straight from where it left its parent it would cut across the circle and land pointing
 * outwards — the arrowhead marking a state it had already passed through. So the last
 * stretch is radial: the curve is steered onto the line through the middle of what it is
 * entering, and comes in along it. That is also what makes every arrowhead point at the
 * state it enters, wherever on the rim it lands.
 */
const APPROACH = 15;

/**
 * The arrowhead every edge ends in.
 *
 * A transition is written `q → f(q₁, q₂)` and the picture is drawn the same way round —
 * the root on top, a run descending — so an arrow points from a state into a child.
 * `refX` at the tip puts that tip exactly where the edge ends, on the rim of the state
 * it is entering rather than eight pixels past it.
 */
function arrowhead() {
  const marker = svgEl('marker', {
    id: 'aut-arrow',
    viewBox: '0 0 8 5.4',
    refX: 8,
    refY: 2.7,
    markerWidth: 7.3,
    markerHeight: 4.9,
    // In multiples of the stroke width, so that zooming in — which holds a stroke at a
    // hairline through `--unzoom` — holds the head it ends in at its size too. In
    // absolute units the arrows would grow with the diagram and swamp the lines.
    markerUnits: 'strokeWidth',
    orient: 'auto',
  });
  marker.append(svgEl('path', { class: 'aut-head', d: 'M 0 0 L 8 2.7 L 0 5.4 Z' }));
  const defs = svgEl('defs');
  defs.append(marker);
  return defs;
}

const DEG = 180 / Math.PI;

/** A point on a circle, by angle from straight down, positive to the right. */
function onCircle(cx, cy, r, deg) {
  const t = deg / DEG;
  return [cx + r * Math.sin(t), cy + r * Math.cos(t)];
}

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
  const was = app.index;
  app.index = Math.max(0, Math.min(i, last));
  app.columns.forEach((col, k) => col.classList.toggle('current', k === app.index));
  $('position').textContent = `${app.index} / ${last}`;
  $('prev').disabled = app.index === 0;
  $('next').disabled = app.index === last;
  if (app.index !== was && app.layouts.length) showFrame(app.index);
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
  // Back to fit on every recompile, as the other page does: the automaton a new
  // specification denotes can be a different size entirely, and holding a zoom chosen
  // for the old one would leave the new one half off the plate.
  app.zoom = 'fit';
  const { svg, columns } = circuitStrip(app.circuit, (i) => setStep(i + 1));
  app.columns = columns;
  $('circuit').replaceChildren(svg);
  const n = app.circuit.nqubits;
  const g = app.circuit.gates.length;
  // Every basis state is 2^n of them and each is a transition of the root, so past the
  // cap the button is turned off rather than left to walk the reader into a refusal.
  const all = 2 ** n;
  const tooMany = all > MAX_STATES;
  $('specBasis').disabled = tooMany;
  $('specBasis').title = tooMany
    ? `${all} basis states on ${n} qubits is more than the ${MAX_STATES} this page will draw`
    : `the set of every computational basis state — ${all} of them, one per input`;
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
 * one picture can read the other.
 *
 * Two things it says that a decision diagram never has to. Edges leave a state at
 * *different points* on its circle, fanned around the bottom, rather than all from the
 * one spot underneath it. And the two edges of each transition are joined by an arc close
 * to the state — the notation the tree-automata papers use, and the one AND/OR graphs
 * have used for far longer. Without it a state with three transitions is six loose lines
 * and nothing on the page says which go together.
 *
 * The arc is drawn on a deterministic state too, where there is nothing to tell apart.
 * What it marks is not the ambiguity but the transition: `q → f(q₀, q₁)` takes *both*
 * children at once, and that is as true of a state with one transition as of a state
 * with five. A picture that only drew it where it was strictly needed would be teaching
 * that an arc means nondeterminism, which is not what it means.
 */
function drawAutomaton(layout, labels) {
  // Half a terminal box of margin on each side, or the leftmost amplitude sits on top of
  // the gutter label naming its row.
  const xOf = (x) => GEO.padX + GEO.gutter + GEO.termW / 2 + (x - layout.xMin) * GEO.colW;
  const yOf = (y) => GEO.padY + y * GEO.rowH;
  const width = xOf(layout.xMax) + GEO.termW / 2 + GEO.padX;
  const height = yOf(layout.height) + GEO.padY + GEO.termH;
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, class: 'aut-svg' });
  svg.append(arrowhead());

  // The gutter: which qubit each row decides, and what the last row holds. It is held at
  // the left edge of the view while the plate scrolls under it, so a zoomed-in reader can
  // still see which row they are looking at, and appended last so it floats over what
  // slides beneath.
  //
  // Labels with a halo, not a strip on a background. The other page backs its gutter with
  // an opaque band, and that band is measured in the plate's own units — so it grows with
  // the zoom while the labels on it do not. There the plate is many columns wide and the
  // band is a margin; here an automaton is often one or two columns, the band would be a
  // third of the picture, and past about 7x on a laptop it covers the whole view. A halo
  // costs nothing and hides nothing.
  const sticky = svgEl('g', { class: 'sticky' });
  for (let level = 0; level < layout.height; level++) {
    const t = svgEl('text', { class: 'gutter', x: GUTTER_X, y: yOf(level) });
    t.textContent = labels[level] ?? `q[${level}]`;
    sticky.append(t);
  }
  const amp = svgEl('text', { class: 'gutter band', x: GUTTER_X, y: yOf(layout.height) });
  amp.textContent = 'AMPLITUDE';
  sticky.append(amp);

  const at = new Map(layout.nodes.map((n) => [n.id, n]));
  const arcs = svgEl('g');
  const edges = svgEl('g');

  // Both ends of an edge depend on what else is at that end — the fan on how many edges
  // leave the state, the arrival on how many reach it — so the whole picture is planned
  // and only then drawn.
  const leaving = new Map();
  for (const e of layout.edges) {
    if (!at.has(e.from) || !at.has(e.to)) continue;
    if (!leaving.has(e.from)) leaving.set(e.from, []);
    leaving.get(e.from).push(e);
  }

  const plan = new Map();
  for (const [from, out] of leaving) {
    const a = at.get(from);
    const cx = xOf(a.x);
    const cy = yOf(a.y);

    // Grouped by transition, in the order the automaton holds them, so that the arc and
    // the edges it spans are the same pair.
    const groups = [];
    for (const e of out) {
      if (!groups[e.transition]) groups[e.transition] = [];
      groups[e.transition].push(e);
    }
    const wanted = groups.map((pair) => pair.map((e) => {
      const b = at.get(e.to);
      return DEG * Math.atan2(xOf(b.x) - cx, yOf(b.y) - cy);
    }));
    const given = fanAngles(wanted);
    const run = runOf(out.length);

    groups.forEach((pair, t) => {
      pair.forEach((e, i) => {
        const angle = given[t][i];
        plan.set(e, {
          leave: onCircle(cx, cy, GEO.r, angle),
          turn: onCircle(cx, cy, GEO.r + run, angle),
          handle: onCircle(cx, cy, GEO.r + run + GEO.handle, angle),
        });
      });
      if (pair.length === 2) {
        const lo = Math.min(given[t][0], given[t][1]);
        const hi = Math.max(given[t][0], given[t][1]);
        const r = GEO.r + run - 5;
        const [sx, sy] = onCircle(cx, cy, r, lo);
        const [ex, ey] = onCircle(cx, cy, r, hi);
        arcs.append(svgEl('path', {
          class: 'aut-arc',
          d: `M ${sx} ${sy} A ${r} ${r} 0 0 0 ${ex} ${ey}`,
        }));
      }
    });
  }

  // Where each edge arrives. Every edge used to end at the one point on top of whatever
  // it pointed at, so edges reaching the same state piled onto each other and the ones
  // coming from the side grazed the circle on their way in. Now each ends on the rim
  // facing where it came from, spread apart from its neighbours — so it arrives head-on
  // and its arrowhead points at the middle of the state it is entering.
  const arriving = new Map();
  for (const e of layout.edges) {
    if (!plan.has(e)) continue;
    if (!arriving.has(e.to)) arriving.set(e.to, []);
    arriving.get(e.to).push(e);
  }
  for (const [to, incoming] of arriving) {
    const b = at.get(to);
    const bx = xOf(b.x);
    const by = yOf(b.y);
    if (b.terminal) {
      // An amplitude is a box, not a circle, so its edges land along the top of it, and
      // come straight down onto it.
      const given = spread(incoming.map((e) => plan.get(e).handle[0] - bx),
        { limit: GEO.termW / 2 - 7, gap: 9 });
      incoming.forEach((e, i) => {
        const where = plan.get(e);
        where.meet = [bx + given[i], by - GEO.termH / 2];
        where.approach = [bx + given[i], by - GEO.termH / 2 - APPROACH];
      });
    } else {
      const given = spread(incoming.map((e) => {
        const [hx, hy] = plan.get(e).handle;
        return DEG * Math.atan2(hx - bx, by - hy);
      }), { limit: ENTRY_LIMIT, gap: ENTRY_GAP });
      incoming.forEach((e, i) => {
        const t = given[i] / DEG;
        const where = plan.get(e);
        where.meet = [bx + GEO.r * Math.sin(t), by - GEO.r * Math.cos(t)];
        where.approach = [bx + (GEO.r + APPROACH) * Math.sin(t),
          by - (GEO.r + APPROACH) * Math.cos(t)];
      });
    }
  }

  for (const [e, where] of plan) {
    // Straight out along the ray it left on, then one cubic between two handles — the
    // first continuing that ray, the second on the ray it arrives along. So an edge
    // leaves radially, which is what makes two exit points read as two, and arrives
    // radially, which is what keeps it off the circle it is pointing at.
    const [px, py] = where.leave;
    const [sx, sy] = where.turn;
    const [hx, hy] = where.handle;
    const [ax, ay] = where.approach;
    const [mx, my] = where.meet;
    edges.append(svgEl('path', {
      class: `aut-edge ${e.high ? 'high' : 'low'}`,
      'marker-end': 'url(#aut-arrow)',
      d: `M ${px} ${py} L ${sx} ${sy} C ${hx} ${hy} ${ax} ${ay} ${mx} ${my}`,
    }));
  }
  svg.append(edges, arcs);

  for (const n of layout.nodes) {
    const g = svgEl('g', { class: `aut-node ${n.kind}${n.fresh ? ' fresh' : ''}` });
    if (n.terminal) {
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
    if (n.root) svg.append(rootMarker(xOf(n.x), yOf(n.y)));
  }
  svg.append(sticky);
  return { svg, sticky, width, height };
}

/**
 * The arrow into a root state, as automata are drawn on paper.
 *
 * `R` because that is what the set is called — in the PLDI'23 paper, and in the `%Root`
 * line of the `.aut` files AutoQ reads and writes. A run over a tree accepts it when it
 * ends in one of these, so without the mark the picture does not say what it accepts:
 * the top state is only the top state because of where it happens to have been drawn.
 */
function rootMarker(cx, cy) {
  const g = svgEl('g', { class: 'aut-root', transform: `translate(${cx},${cy})` });
  g.append(
    svgEl('path', { class: 'stem', d: `M 0 -34 L 0 ${-GEO.r - 8}` }),
    svgEl('path', {
      class: 'head',
      d: `M -3.6 ${-GEO.r - 9} L 3.6 ${-GEO.r - 9} L 0 ${-GEO.r - 1} Z`,
    }),
  );
  const cap = svgEl('text', { x: -8, y: -26 });
  cap.textContent = 'R';
  g.append(cap);
  return g;
}

// ---- the zoom -----------------------------------------------------------

/**
 * Apply the current zoom, and say what it is.
 *
 * Simpler than the other page's: there the plate is as wide as the widest frame of a
 * whole run, so `fit` has to window the viewBox onto the frame in front of you. Here
 * there is one picture and the viewBox is all of it, so fitting is one division.
 */
function fitCanvas() {
  const has = Boolean(app.svg && app.plate);
  for (const id of ['zoomIn', 'zoomOut', 'zoomLevel']) $(id).disabled = !has;
  if (!has) { $('zoomLevel').textContent = 'fit'; return; }
  const box = $('canvas');
  const { width: W, height: H } = app.plate;
  let scale;
  if (app.zoom === 'fit') {
    const raw = Math.min((box.clientWidth - 16) / W, (box.clientHeight - 16) / H);
    scale = Math.max(MIN_FIT_SCALE, Math.min(raw || 1, MAX_NODE_PX / (2 * GEO.r)));
  } else {
    scale = app.zoom;
  }
  app.scale = scale;
  app.svg.style.width = `${Math.round(W * scale)}px`;
  app.svg.style.height = `${Math.round(H * scale)}px`;
  // Counter the magnification for the furniture — gutter labels, strokes, arrowheads —
  // so zooming in grows the automaton and not its annotations. Only above 1: below it
  // everything shrinks together, as it should.
  app.svg.style.setProperty('--unzoom', String(1 / Math.max(1, scale)));
  $('zoomLevel').textContent = app.zoom === 'fit' ? 'fit' : `${Math.round(scale * 100)}%`;
  if (app.zoom === 'fit') box.scrollLeft = 0;
  updateSticky();
}

/**
 * Hold the gutter at the left edge of the view while the plate scrolls under it.
 *
 * A label sits `GUTTER_X` into the plate, and that offset is magnified along with
 * everything else — so simply undoing the scroll would leave the label `GUTTER_X * scale`
 * from the edge of the view, which at 8x is most of the way across it. The extra term
 * takes that magnification back out, so a floating label lands the same distance from the
 * edge whatever the zoom. Clamped at zero, because before anything has scrolled the label
 * belongs where it was drawn, in the plate's own left margin.
 */
function updateSticky() {
  if (!app.sticky) return;
  const scale = app.scale || 1;
  const unzoom = 1 / Math.max(1, scale);
  const dx = Math.max(0, $('canvas').scrollLeft / scale - GUTTER_X * (1 - unzoom));
  app.sticky.setAttribute('transform', `translate(${dx},0)`);
  app.sticky.classList.toggle('floating', dx > 0.5);
}

/**
 * Zoom, keeping the point under `clientX/clientY` fixed — otherwise zooming in on a
 * detail throws it off screen and the reader has to hunt for it again.
 * @param {number|'fit'} next
 */
function setZoom(next, clientX, clientY) {
  if (!app.svg || !app.plate) return;
  const box = $('canvas');
  // Both measured before the view changes under us.
  const rect = app.svg.getBoundingClientRect();
  const boxRect = box.getBoundingClientRect();
  const before = app.scale;
  const ax = clientX === undefined ? rect.left + rect.width / 2 : clientX;
  const ay = clientY === undefined ? rect.top + rect.height / 2 : clientY;
  // The point of the plate under the pointer, in the plate's own coordinates, which is
  // what has to be put back under the pointer once the scale has changed.
  const plateX = (ax - rect.left) / before;
  const plateY = (ay - rect.top) / before;
  app.zoom = next === 'fit' ? 'fit' : Math.max(ZOOM_RANGE[0], Math.min(next, ZOOM_RANGE[1]));
  fitCanvas();
  if (app.zoom !== 'fit') {
    box.scrollLeft = plateX * app.scale - (ax - boxRect.left);
    box.scrollTop = plateY * app.scale - (ay - boxRect.top);
    updateSticky();
  }
}

const zoomBy = (factor) => setZoom(app.scale * factor);
const zoomAt = (factor, x, y) => setZoom(app.scale * factor, x, y);

/**
 * Read the specification, run the circuit over it, and lay out every step.
 *
 * All of them, up front, and in order — which is the whole reason a state that survives
 * a gate stays where it was. Each layout is handed the one before it, so where a state
 * sits is decided by the run and not by the order the reader happened to step through
 * it. Stepping back and forth then shows the same picture each time.
 */
function showAutomaton() {
  if (!app.circuit) return;
  const n = app.circuit.nqubits;
  try {
    const spec = parseHsl($('specText').value, n);
    const ta = new TA(P.Ring, n);
    const { root } = ta.fromVectors(spec.vectors.map((v) => toVector(v, P.Ring)));
    app.ta = ta;
    // Each frame is already the reduced automaton: `simulate` expands the root to push a
    // gate through it and reduces what comes out, so the next gate starts from the small
    // form and the picture is the object the run actually carries.
    app.frames = simulate(ta, root, app.circuit);
    let rank = new Map();
    app.layouts = app.frames.map((frame) => {
      const layout = layoutAutomaton(ta, frame.root, {
        formatValue: (v) => P.format(v, 'exact'),
        prevRank: rank,
      });
      rank = layout.rank;
      return layout;
    });
    app.constraints = spec.constraints;
    showFrame(Math.min(app.index, app.frames.length - 1));
  } catch (e) {
    app.ta = null;
    app.frames = [];
    app.layouts = [];
    app.constraints = [];
    if (e instanceof HslError) {
      $('error').textContent = `specification — ${e.message}`;
    } else {
      // Everything the engine refuses on purpose — a gate it cannot apply, a run that
      // outgrew its budget — arrives here as a plain Error and is shown. So would a
      // defect, and that must not be dressed up as a refusal: the console keeps the
      // stack so it can be told from one.
      console.error(e);
      $('error').textContent = `the circuit could not be run — ${e.message}`;
    }
    showPlaceholder();
  }
}

/** Draw one step of the run, and say what it holds. */
function showFrame(index) {
  const layout = app.layouts[index];
  if (!layout) return;
  const frame = app.frames[index];
  const n = app.circuit.nqubits;
  const drawn = drawAutomaton(layout, app.circuit.qubits.map((q) => q.label));
  app.svg = drawn.svg;
  app.sticky = drawn.sticky;
  app.plate = { width: drawn.width, height: drawn.height };
  $('canvas').replaceChildren(drawn.svg);
  fitCanvas();

  const gates = app.circuit.gates.length;
  const grew = index > 0 ? frame.size - app.frames[index - 1].size : 0;
  const saved = frame.expanded - frame.size;
  $('stats').textContent = `${n} qubit${n === 1 ? '' : 's'} · `
    + `${gates} gate${gates === 1 ? '' : 's'} · `
    + `${frame.size} automaton state${frame.size === 1 ? '' : 's'}`
    + `${grew ? ` (${grew > 0 ? '+' : ''}${grew})` : ''}`
    + `${saved > 0 ? ` · reduced from ${frame.expanded}` : ''} · `
    + `${frame.members} quantum state${frame.members === 1 ? '' : 's'}`;
  if (app.constraints?.length) {
    $('error').textContent = `${app.constraints.length} constraint`
      + `${app.constraints.length === 1 ? '' : 's'} shown but not checked — `
      + 'that needs a solver';
  }
}

/**
 * The current view as TikZ, in a dialog so it can be read before it is taken.
 *
 * An SVG is the wrong thing to put in a paper and this is the right one — and seeing it
 * first matters, because the amplitudes have been through a Unicode-to-LaTeX pass on the
 * way. The circuit goes through the other page's exporter unchanged; the automaton has
 * its own, because a decision diagram's node has one pair of children and needs no arc
 * to say so.
 */
function showTikz(what) {
  if (!app.circuit) return;
  if (what === 'circuit') {
    showCode('TikZ · circuit, as quantikz', circuitTikz(app.circuit));
    return;
  }
  const layout = app.layouts[app.index];
  if (!layout) return;
  showCode(`TikZ · automaton, step ${app.index} of ${app.circuit.gates.length}`,
    automatonTikz(layout, {
      qubitLabels: app.circuit.qubits.map((q) => q.label),
      bandLabel: 'amplitude',
      fanAngles,
      spread,
      entry: { limit: ENTRY_LIMIT, gap: ENTRY_GAP },
    }));
}

/** What is not built yet, said plainly rather than left as an empty plate. */
function showPlaceholder() {
  app.svg = null;
  app.sticky = null;
  app.plate = null;
  const box = document.createElement('div');
  box.className = 'aut-placeholder';
  const h = document.createElement('h2');
  h.textContent = 'Nothing to draw';
  box.append(h);
  for (const text of [
    'The circuit or the specification beside it cannot be read, so there is no set of '
    + 'states to build an automaton from. The message under the specification says what '
    + 'stopped it.',
    'With both of them readable, the plate holds the automaton accepting the set the '
    + 'specification names, and the transport carries it through the circuit a gate at '
    + 'a time.',
  ]) {
    const p = document.createElement('p');
    p.textContent = text;
    box.append(p);
  }
  $('canvas').replaceChildren(box);
  fitCanvas();
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
  // The two sets worth one click: where a circuit starts, and every input at once.
  for (const [id, which] of [['specZero', 'zero'], ['specBasis', 'basis']]) {
    $(id).addEventListener('click', () => {
      if (!app.circuit) return;
      $('specText').value = SPECIALS[which].spec(app.circuit.nqubits);
      showExample();
      app.index = 0;
      compile();
    });
  }

  $('prev').addEventListener('click', () => setStep(app.index - 1));
  $('next').addEventListener('click', () => setStep(app.index + 1));

  $('zoomIn').addEventListener('click', () => zoomBy(ZOOM_STEP));
  $('zoomOut').addEventListener('click', () => zoomBy(1 / ZOOM_STEP));
  $('zoomLevel').addEventListener('click', () => setZoom('fit'));

  // Wheel scrolls, ctrl/⌘ + wheel zooms — which is also what a trackpad pinch sends.
  $('canvas').addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    zoomAt(Math.exp(-e.deltaY / 300), e.clientX, e.clientY);
  }, { passive: false });
  $('canvas').addEventListener('scroll', updateSticky);

  // Drag anywhere on the plate to pan, which beats hunting for a scrollbar.
  const box = $('canvas');
  let panning = null;
  box.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    panning = { x: e.clientX, y: e.clientY, left: box.scrollLeft, top: box.scrollTop };
    box.setPointerCapture(e.pointerId);
    box.classList.add('panning');
  });
  box.addEventListener('pointermove', (e) => {
    if (!panning) return;
    box.scrollLeft = panning.left - (e.clientX - panning.x);
    box.scrollTop = panning.top - (e.clientY - panning.y);
  });
  for (const ev of ['pointerup', 'pointercancel']) {
    box.addEventListener(ev, () => { panning = null; box.classList.remove('panning'); });
  }

  // Fit follows the box: a fitted plate is fitted to whatever size the box now is.
  new ResizeObserver(() => { if (app.zoom === 'fit') fitCanvas(); }).observe(box);

  // The panels are the other page's, and so is the behaviour: drag a splitter, or put
  // the focus on one and use the arrow keys; double-click puts a boundary back.
  $('tikzAutomaton').addEventListener('click', () => showTikz('automaton'));
  $('tikzCircuit').addEventListener('click', () => showTikz('circuit'));
  armDialog();

  armPanels({
    store: 'q-vis:aut.layout',
    sized: ['panelCircuit', 'panelSpec', 'circuit'],
    onResize: fitCanvas,
  });

  addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    // ctrl and ⌘ belong to the browser. Shift does not: on most layouts `+` *is* shift
    // and `=`, so a guard that turned Shift away turned away the one key the button
    // advertises, while its undocumented twin `=` went on working.
    if (e.metaKey || e.ctrlKey) return;
    const zooms = {
      '+': () => zoomBy(ZOOM_STEP), '=': () => zoomBy(ZOOM_STEP),
      '-': () => zoomBy(1 / ZOOM_STEP), 0: () => setZoom('fit'),
    };
    if (zooms[e.key]) { e.preventDefault(); zooms[e.key](); return; }
    // Alt+Left is Back and Shift+Left extends a selection; a step is not worth either.
    if (e.altKey || e.shiftKey) return;
    if (e.key === 'ArrowLeft') setStep(app.index - 1);
    else if (e.key === 'ArrowRight') setStep(app.index + 1);
    else return;
    e.preventDefault();
  });

  if (load()) { showExample(); compile(); } else useExample(0, undefined);
}
