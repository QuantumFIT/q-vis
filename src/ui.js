// The browser front end. Everything below this line touches the DOM; everything above
// it in the module graph runs headless and is tested that way.

import { MTBDD } from './dd.js';
import * as P from './poly.js';
import { simulate } from './sim.js';
import { parseQasm } from './qasm.js';
import { parseState, buildState, squaredNorm, symbolicStateText } from './state.js';
import { layoutFrames, layoutEdgeValued, layoutEdgeValuedTree } from './layout.js';
import { EVDD, unitNormaliser, NORMALISERS } from './evdd.js';
import { LIMDD } from './limdd.js';
import { circuitTikz, diagramTikz } from './tikz.js';
import { tableauFrame, tableauText } from './tableau.js';
import * as Order from './order.js';
import * as Pauli from './pauli.js';
import * as Z from './zomega.js';
import { EXAMPLES, instantiate, identify } from './examples.js';
import { GATES } from './gates.js';

const GEO = { gutter: 72, padTop: 46, levelH: 64, slotW: 82, r: 9, termH: 23, pad: 30 };
// "Fit" really fits, however wide the diagram: it is the overview, and zooming is how the
// detail is read. The ceiling stops a two-node diagram from being blown up absurdly.
/**
 * How far `fit` may scale. The floor stops a diagram of a few hundred nodes shrinking to
 * illegibility — past it, it scrolls instead. The ceiling is expressed as the widest a
 * node may be drawn: a two-qubit diagram on a large screen would otherwise be scaled up
 * until its strokes looked like a magnified screenshot.
 */
const MAX_NODE_PX = 44;
const MIN_FIT_SCALE = 0.12;
const ZOOM_RANGE = [0.15, 8];
const ZOOM_STEP = 1.25;
const BAND_LABEL = 'AMPLITUDE';
const MAX_DRAWN_NODES = 800;
const MAX_READOUT_LINES = 14;
const PLAY_MS = 750;
const SVG_NS = 'http://www.w3.org/2000/svg';
const AMP_FORMATS = ['exact', 'rect', 'polar-deg', 'polar-rad', 'polar-pi', 'tuple'];
/** Links and stored settings written before the angle unit existed said just "polar". */
const normaliseFormat = (f) => (f === 'polar' ? 'polar-deg' : f);

const app = {
  dd: null,
  circuit: null,
  frames: [],
  layout: null,
  index: 0,
  playing: false,
  timer: null,
  hideZero: false,
  rep: 'reduced',    // reduced | edge-valued | limdd — what goes on the edges
  tree: false,       // the same representation with nothing shared
  canon: 'max',      // which edge an edge-valued diagram takes its factor from
  orderKind: 'written',   // written | reversed | paired | custom
  customOrder: null,      // the typed permutation, when orderKind is 'custom'
  orderInvalid: null,     // why the text in the field is not an order, when it is not
  order: [],              // atLevel: which qubit each level decides
  levelOf: [],            // its inverse: where each qubit sits
  theme: 'auto',
  ampFormat: 'exact',
  zoom: 'fit',
  scale: 1,
  nodeEls: new Map(),
  // The Pauli-LIMDD of the current build, when that is the view: it holds the cached
  // stabilizer groups the tableau reads.
  limdd: null,
  edgeEls: new Map(),
  edgeLabels: new Map(),
  exiting: new Map(),
};

const $ = (id) => document.getElementById(id);
const svgEl = (name, attrs = {}) => {
  const e = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

// ---- compile ------------------------------------------------------------

/**
 * An edge label in the LIMDD view: the weight, then the Pauli string. The string is kept
 * as X^x Z^z internally but printed with Y, which owes the weight a factor of (-i) for
 * every Y — so the two are put back together before either is shown.
 */
function limLabel(e, i, n, show, levelOf = null) {
  const owed = Pauli.phaseShift(e);
  const w = owed ? P.mul(e.w, P.fromZ(Z.omegaPow(-2 * owed))) : e.w;
  const text = show(w, i);
  if (Pauli.isIdentityString(e)) return text;
  if (P.isZero(w)) return text;
  return P.attachCoefficient(text, Pauli.formatString(e, n, levelOf));
}

/** Parse both inputs, run the circuit, lay every frame out. Keeps the last good
 *  drawing on screen when the text is mid-edit and does not parse. */
function compile() {
  let circuit, parsedState;
  try {
    circuit = parseQasm($('qasm').value);
  } catch (e) {
    return fail(e, 'circuit');
  }
  try {
    parsedState = parseState($('stateText').value, circuit.nqubits);
  } catch (e) {
    return fail(e, 'state');
  }

  // The order has to be settled before anything is built: it decides which qubit each
  // level decides, and everything below is expressed in levels.
  let order;
  try {
    order = resolveOrder(circuit);
  } catch (e) {
    return fail(e, 'order');
  }
  app.order = order;
  app.levelOf = Order.invert(order);
  app.parsedState = parsedState;      // the sift re-simulates from it

  const dd = new MTBDD(P.Ring, circuit.nqubits);
  let frames;
  try {
    frames = simulate(dd, buildState(dd, parsedState.entries, app.levelOf), circuit, app.levelOf);
  } catch (e) {
    return fail(e, 'circuit');
  }

  app.dd = dd;
  app.circuit = circuit;
  app.frames = frames;
  // The algebraic tuple form writes a whole state over one power of sqrt(2), so that
  // power has to be known per frame before anything is laid out.
  app.commonK = frames.map((f) => {
    let k = 0;
    for (const id of dd.reachable(f.root)) {
      if (dd.isTerminal(id)) k = Math.max(k, P.denominatorPower(dd.valueOf(id)));
    }
    return k;
  });
  // Which root of unity this frame's amplitudes need. It is a footnote on the plate and
  // the width of a tuple, and it grows when the circuit asks for a phase finer than pi/4.
  app.commonLevel = frames.map((f) => {
    let d = 4;
    for (const id of dd.reachable(f.root)) {
      if (dd.isTerminal(id)) d = Math.max(d, P.ringLevel(dd.valueOf(id)));
    }
    return d;
  });
  // Indexed by level, which is what the layout and the TikZ exporter both want: the label
  // on a row is the qubit that row decides.
  const labels = app.order.map((q) => circuit.qubits[q].label);
  const show = (v, i) => P.format(v, app.ampFormat,
    { k: app.commonK[i], level: app.commonLevel[i] });
  // Kept so the tableau can format a weight the same way the diagram does.
  app.showAmp = show;

  // The unreduced tree has 2^(n+1)-1 nodes, so past a handful of qubits it is neither
  // drawable nor informative.
  const big = circuit.nqubits > 10;
  const tree = app.tree && !big;

  if (app.rep === 'limdd') {
    // The same states again, now shared up to a local Pauli as well as a scalar.
    const li = new LIMDD(P.Ring, circuit.nqubits, unitNormaliser(P, Z, app.canon));
    // Held on to: the stabilizer groups it computed while choosing labels are what the
    // tableau shows, and they are cached on the manager. Cleared in the other views so a
    // stale manager can never be read against a layout it did not build.
    app.limdd = li;
    const memo = new Map();
    const built = frames.map((f) => ({ index: f.index, gate: f.gate, edge: li.fromMTBDD(dd, f.root, memo) }));
    const label = (e, i) => limLabel(e, i, circuit.nqubits, show, app.levelOf);
    // The tree here is the diagram unfolded rather than rebuilt: which labels a LIMDD
    // chooses depends on the diagram it is building, so a tree computed on its own would
    // be a different thing wearing the same name. See layoutEdgeValuedTree.
    app.layout = tree
      ? layoutEdgeValuedTree(li, built, labels, label)
      : layoutEdgeValued(li, built, labels, label);
  } else if (app.rep === 'edge-valued' && !tree) {
    app.limdd = null;
    // Simulation stays on the MTBDD; this is the same states seen the other way, built
    // in one pass per frame. One manager for the whole run, so nodes shared between
    // frames stay the same nodes and the diagram morphs rather than being redrawn.
    const ev = new EVDD(P.Ring, circuit.nqubits, unitNormaliser(P, Z, app.canon));
    const memo = new Map();
    app.layout = layoutEdgeValued(ev,
      frames.map((f) => ({ index: f.index, gate: f.gate, edge: ev.fromMTBDD(dd, f.root, memo) })),
      labels, (e, i) => show(e.w, i));
  } else {
    app.limdd = null;
    app.layout = layoutFrames(dd, frames, {
      qubitLabels: labels,
      expand: tree,
      formatValue: show,
      // The unreduced tree drawn the edge-valued way: the same normalisation, with
      // nothing shared, which is the comparison worth having.
      weighting: app.rep === 'edge-valued'
        ? { ring: P.Ring, normalise: unitNormaliser(P, Z, app.canon) }
        : null,
    });
  }
  app.index = Math.min(app.index, frames.length - 1);

  $('error').textContent = '';
  app.zoom = 'fit';
  // One unknown per basis state, so it is only offered while that is a sane number.
  const tooMany = 2 ** circuit.nqubits > 256;
  $('symbolic').disabled = tooMany;
  $('symbolic').title = tooMany
    ? `${2 ** circuit.nqubits} basis states is too many to give each its own symbol`
    : 'give every basis state its own unknown amplitude';

  $('tree').disabled = big;
  $('tree').checked = tree;
  $('tree').title = big
    ? `a tree on ${circuit.nqubits} qubits is ${2 ** circuit.nqubits} leaves — too many to draw`
    : 'draw the same thing with nothing shared, so the sharing can be seen for what it saves';
  // The canonisation rule only means anything where there are edge weights.
  $('canon').style.display = app.rep === 'reduced' ? 'none' : '';
  // A stabilizer group is a property of the state, but it is the Pauli-LIMDD that uses
  // one, so that is the only view where offering it says anything.
  $('tableau').style.display = app.rep === 'limdd' ? '' : 'none';
  $('canon').title = NORMALISERS[app.canon].note;
  showOrder();
  resetCanvas();
  renderCircuit();
  setFrame(app.index);
  save();
}

/** The circuit's qubits, in circuit order — `['q[0]', 'q[1]', 'q[2]', 'b[0]']`. */
const qubitNames = () => (app.circuit ? app.circuit.qubits.map((q) => q.label) : []);

/**
 * The order the controls are asking for, as `atLevel`. Throws when a stored order does not
 * name every qubit exactly once, which `compile` reports like any other bad input.
 */
function resolveOrder(circuit) {
  const n = circuit.nqubits;
  if (app.orderKind === 'custom') {
    if (!app.customOrder || app.customOrder.length !== n) {
      // A custom order is a permutation of *these* qubits, so it cannot survive a change
      // of size or of register layout. Falling back beats refusing to draw anything.
      app.customOrder = Order.identity(n);
    }
    return Order.validate(app.customOrder, n, circuit.qubits.map((q) => q.label));
  }
  return (Order.PRESETS[app.orderKind] ?? Order.PRESETS.written).of(n);
}

/** Keep the order controls showing what is in force, folded away or not. */
function showOrder() {
  const custom = app.orderKind === 'custom';
  $('orderText').hidden = !custom;
  if (!custom) $('orderText').classList.remove('bad');
  const names = qubitNames();
  if (document.activeElement !== $('orderText')) {
    // In the circuit's own names, because a bare index says nothing about which qubit it
    // is once there is more than one register: `qreg q[3]; qreg b[1];` makes index 3 into
    // `b[0]`, and no reader should have to count that out.
    $('orderText').value = Order.format(app.order, names);
  }
  $('orderText').title = names.length
    ? `the qubits in the order you want them, top level first — ${names.join(' ')}`
    : 'the qubits in the order you want them, top level first';
  $('order').value = app.orderKind;

  // The field shows the order in force, except while it is being edited — so a refused
  // edit is never left sitting there once attention has moved on.
  const editing = document.activeElement === $('orderText');
  const invalid = !!app.orderInvalid && editing;
  if (!editing) app.orderInvalid = null;
  $('orderText').classList.toggle('bad', invalid);
  $('orderNote').classList.toggle('bad', invalid);
  if (invalid) $('orderNote').textContent = app.orderInvalid;

  // The summary says what is in force, so that folding the box away never hides the
  // reason the diagram's rows are not q[0] downwards — nor that an edit has not taken.
  const changed = app.order.length > 0 && !Order.isIdentity(app.order);
  const now = $('orderNow');
  now.textContent = changed ? Order.format(app.order, names) : 'as written';
  now.classList.toggle('changed', changed);
  now.title = changed ? 'the qubits, top level first' : '';
  const warn = $('orderBad');
  warn.hidden = !invalid;
  warn.title = invalid ? app.orderInvalid : '';
  const n = app.circuit ? app.circuit.nqubits : 0;
  $('sift').disabled = n < 3;
  $('sift').title = n < 3
    ? 'there is nothing to reorder below three qubits'
    : 'search for an order that makes the largest frame smaller';
}

/** The largest frame of a run under one order — what a sift is trying to make small. */
function widestUnder(order) {
  const levelOf = Order.invert(order);
  const dd = new MTBDD(P.Ring, app.circuit.nqubits);
  const frames = simulate(dd,
    buildState(dd, app.parsedState.entries, levelOf), app.circuit, levelOf);
  return Math.max(...frames.map((f) => f.size));
}

/**
 * Sifting: take each qubit in turn and try it at every position, keeping the best. One
 * pass, which is the usual formulation and bounds the work at about n^2/2 rebuilds.
 *
 * It measures on the cheap path — an MTBDD and `simulate`, whose sizes come for free —
 * and never builds a layout or an edge-valued diagram. Measured here that is the whole
 * difference between a second and a quarter of a minute: for QFT on 7 qubits `simulate`
 * is 21 ms against 484 ms for the conversion and layout on top of it.
 */
function sift() {
  if (!app.circuit || !app.parsedState) return;
  const n = app.circuit.nqubits;
  const note = $('orderNote');

  // Time the first rebuild and decide from that, rather than from a guessed qubit limit.
  const t0 = performance.now();
  let best = widestUnder(app.order);
  const each = performance.now() - t0;
  const projected = (each * n * n) / 2;
  if (projected > 3000) {
    note.textContent = `too slow to search: about ${Math.round(projected / 1000)}s`;
    return;
  }

  const before = best;
  let order = [...app.order];
  for (let q = 0; q < n; q++) {
    const from = order.indexOf(q);
    let bestOrder = order;
    for (let to = 0; to < n; to++) {
      if (to === from) continue;
      const trial = order.filter((x) => x !== q);
      trial.splice(to, 0, q);
      const width = widestUnder(trial);
      if (width < best) { best = width; bestOrder = trial; }
    }
    order = bestOrder;
  }

  // Say which number moved. The strip reports the frame on screen; this is the widest
  // frame of the whole run, which is what the plate is sized for and what was minimised.
  if (best < before) {
    app.orderKind = 'custom';
    app.customOrder = order;
    note.textContent = `widest frame ${before} → ${best}`;
    $('orderBox').open = true;
    compile();
  } else {
    note.textContent = `widest frame ${before}: no order tried was smaller`;
  }
  showOrder();
}

// ---- resizing -----------------------------------------------------------

const COL_MIN = 220;
const PANEL_MIN = 64;
const LAYOUT_STORE = 'q-vis.layout';

/**
 * The panel column's width, and the heights of the panels stacked in it.
 *
 * Two things are dragged and they work differently. The column is one number, the grid's
 * `--col`. A panel boundary is a *pair* of numbers — the panel above takes a fixed height
 * and the one below goes back to absorbing the slack — so the drag is expressed as "the
 * panel above is this tall" and the rest of the column follows from flex.
 *
 * Both are clamped so a panel can never be dragged out of existence, and both are stored,
 * because a layout you set and then lost on reload is worse than one you cannot set.
 */
function setColumn(px) {
  const max = Math.max(COL_MIN, window.innerWidth - 320);
  const w = Math.round(Math.max(COL_MIN, Math.min(px, max)));
  document.documentElement.style.setProperty('--col', `${w}px`);
  return w;
}

function setPanelHeight(panel, px) {
  const min = Number(panel.dataset.min) || PANEL_MIN;
  const h = Math.round(Math.max(min, px));
  panel.style.flex = `0 0 ${h}px`;
  // The circuit strip is capped by a max-height until someone drags it. An explicit
  // height has to beat that cap or the drag would stop dead at 190px.
  panel.style.maxHeight = 'none';
  return h;
}

/** What the panels are doing now, as something small enough to store. */
function layoutState() {
  const col = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--col'), 10);
  const heights = {};
  for (const id of ['panelCircuit', 'panelState', 'circuit']) {
    const m = /0 0 (\d+)px/.exec($(id).style.flex || '');
    if (m) heights[id] = +m[1];
  }
  // Which panels are folded is the reader's own choice, so it is kept like a size.
  return { col, heights, folded: { panelAmps: !$('panelAmps').open } };
}

function saveLayout() {
  try { localStorage.setItem(LAYOUT_STORE, JSON.stringify(layoutState())); }
  catch { /* private windows are fine; the layout is just not remembered */ }
}

function loadLayout() {
  let v;
  try { v = JSON.parse(localStorage.getItem(LAYOUT_STORE) || 'null'); } catch { return; }
  if (!v) return;
  if (Number.isFinite(v.col)) setColumn(v.col);
  for (const [id, h] of Object.entries(v.heights || {})) {
    if ($(id) && Number.isFinite(h)) setPanelHeight($(id), h);
  }
  for (const [id, shut] of Object.entries(v.folded || {})) {
    if ($(id)) $(id).open = !shut;
  }
}

/**
 * Put a boundary back the way it started. What "the way it started" is belongs to the
 * element rather than to this function, so each one that had a flex of its own says so in
 * `data-flex` and the rest go back to being sized by their content.
 */
function resetSplit(el) {
  if (el.id === 'vsplit') {
    document.documentElement.style.removeProperty('--col');
  } else {
    const target = el.previousElementSibling;
    target.style.flex = target.dataset.flex || '';
    target.style.maxHeight = '';
  }
  saveLayout();
  fitCanvas();
}

/**
 * Dragging, for both kinds of splitter. Pointer events rather than mouse events so a
 * trackpad, a touchscreen and a pen all work alike, and the move and release are listened
 * for on the window rather than on the handle: a drag that outruns the pointer then keeps
 * going instead of stopping wherever the cursor left the 8px strip. Pointer capture would
 * do the same thing and is the more obvious way to write it, but it can refuse — and a
 * splitter that silently does nothing is worse than one written the long way.
 */
function armSplitter(el) {
  const vertical = el.id === 'vsplit';
  let start = 0;
  let base = 0;
  let live = false;

  const move = (e) => {
    if (!live) return;
    const delta = (vertical ? e.clientX : e.clientY) - start;
    if (vertical) setColumn(base + delta);
    else setPanelHeight(el.previousElementSibling, base + delta);
    fitCanvas();
  };

  const finish = () => {
    if (!live) return;
    live = false;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', finish);
    document.body.classList.remove('dragging');
    document.body.style.cursor = '';
    saveLayout();
  };

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    live = true;
    start = vertical ? e.clientX : e.clientY;
    base = vertical
      ? $('inputs').getBoundingClientRect().width
      : el.previousElementSibling.getBoundingClientRect().height;
    document.body.classList.add('dragging');
    document.body.style.cursor = vertical ? 'col-resize' : 'row-resize';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  });

  el.addEventListener('dblclick', () => resetSplit(el));

  // A splitter is a separator, so the arrow keys move it — the one way to set a layout
  // without a pointer at all.
  el.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 40 : 10;
    const keys = vertical
      ? { ArrowLeft: -step, ArrowRight: step }
      : { ArrowUp: -step, ArrowDown: step };
    if (e.key === 'Home') { e.preventDefault(); resetSplit(el); return; }
    if (!(e.key in keys)) return;
    e.preventDefault();
    if (vertical) setColumn($('inputs').getBoundingClientRect().width + keys[e.key]);
    else {
      const panel = el.previousElementSibling;
      setPanelHeight(panel, panel.getBoundingClientRect().height + keys[e.key]);
    }
    saveLayout();
    fitCanvas();
  });
}

function fail(e, where) {
  stop();
  $('error').textContent = `${where === 'state' ? 'input state' : 'circuit'} — ${e.message}`;
}

// ---- the circuit -------------------------------------------------------
//
// Standard notation: a wire per qubit, a column per gate, filled dots for controls, a
// crossed circle for the target of an X, crossings for a swap, a box for everything else.
// One column per gate rather than the usual packing of independent gates into a shared
// moment, because a column here is also a step of the animation and the two must agree.

const CIRC = { rowH: 26, colW: 30, padY: 12, dot: 3.2, notR: 6.5, boxW: 21, boxH: 17 };

function renderCircuit() {
  const circuit = app.circuit;
  const n = circuit.nqubits;
  const gates = circuit.gates;
  const gutter = Math.max(44, Math.round(Math.max(...circuit.qubits.map((q) => q.label.length)) * 6.4) + 16);
  const W = gutter + CIRC.colW * (gates.length + 1) + 10;
  const H = CIRC.padY * 2 + n * CIRC.rowH;
  const wireY = (q) => CIRC.padY + CIRC.rowH * (q + 0.5);
  const colX = (i) => gutter + CIRC.colW * (i + 1.5);   // column -1 is the input state

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'circuit-svg' });
  svg.style.width = `${W}px`;
  svg.style.height = `${H}px`;

  // The click strips go underneath, so that highlighting the current step tints the
  // column rather than painting over the gate it is pointing at. The drawing above them
  // ignores the pointer, so a click anywhere in a column still reaches its strip.
  const strips = svgEl('g', { class: 'cols' });
  const art = svgEl('g', { class: 'art' });
  svg.append(strips, art);

  for (let q = 0; q < n; q++) {
    art.append(svgEl('line', { class: 'wire', x1: gutter - 4, y1: wireY(q), x2: W - 6, y2: wireY(q) }));
    const label = svgEl('text', { class: 'wire-label', x: gutter - 12, y: wireY(q) });
    label.textContent = circuit.qubits[q].label;
    art.append(label);
  }

  for (const b of circuit.barriers) {
    art.append(svgEl('line', {
      class: 'barrier-mark', x1: colX(b) - CIRC.colW / 2, y1: CIRC.padY - 2,
      x2: colX(b) - CIRC.colW / 2, y2: H - CIRC.padY + 2,
    }));
  }

  gates.forEach((g, i) => {
    const draw = g.draw || { controls: 0, target: 'box', symbol: g.label };
    const x = colX(i);
    const ys = g.qubits.map(wireY);
    if (ys.length > 1) {
      art.append(svgEl('line', {
        class: 'link', x1: x, y1: Math.min(...ys), x2: x, y2: Math.max(...ys),
      }));
    }
    const controls = g.qubits.slice(0, draw.controls);
    const targets = g.qubits.slice(draw.controls);
    for (const q of controls) art.append(svgEl('circle', { class: 'ctrl', cx: x, cy: wireY(q), r: CIRC.dot }));

    if (draw.target === 'not') {
      const y = wireY(targets[0]);
      art.append(
        svgEl('circle', { class: 'notgate', cx: x, cy: y, r: CIRC.notR }),
        svgEl('line', { class: 'notgate-cross', x1: x - CIRC.notR, y1: y, x2: x + CIRC.notR, y2: y }),
        svgEl('line', { class: 'notgate-cross', x1: x, y1: y - CIRC.notR, x2: x, y2: y + CIRC.notR }),
      );
    } else if (draw.target === 'dot') {
      for (const q of targets) art.append(svgEl('circle', { class: 'ctrl', cx: x, cy: wireY(q), r: CIRC.dot }));
    } else if (draw.target === 'swap') {
      for (const q of targets) {
        const y = wireY(q);
        art.append(
          svgEl('line', { class: 'swapmark', x1: x - 5, y1: y - 5, x2: x + 5, y2: y + 5 }),
          svgEl('line', { class: 'swapmark', x1: x - 5, y1: y + 5, x2: x + 5, y2: y - 5 }),
        );
      }
      if (draw.symbol) {
        const t = svgEl('text', { class: 'gate-cap small', x: x + 9, y: Math.min(...ys) - 6 });
        t.textContent = draw.symbol;
        art.append(t);
      }
    } else {
      for (const q of targets) {
        const y = wireY(q);
        const symbol = draw.symbol || g.label;
        const w = Math.max(CIRC.boxW, symbol.length * 7 + 8);
        art.append(svgEl('rect', {
          class: 'gate-box', x: x - w / 2, y: y - CIRC.boxH / 2, width: w, height: CIRC.boxH, rx: 2,
        }));
        const t = svgEl('text', { class: 'gate-cap', x, y });
        t.textContent = symbol;
        art.append(t);
      }
    }
  });

  // One transparent strip per step, including the input before any gate, so the whole
  // column is a click target and can be highlighted as the current one.
  app.colEls = [];
  for (let i = -1; i < gates.length; i++) {
    const strip = svgEl('rect', {
      class: 'col', x: colX(i) - CIRC.colW / 2, y: 0, width: CIRC.colW, height: H,
    });
    strip.append(svgEl('title'));
    strip.querySelector('title').textContent = i < 0
      ? 'the input state, before any gate'
      : `step ${i + 1}: ${gates[i].label} on ${gates[i].qubits.map((q) => circuit.qubits[q].label).join(', ')}`;
    strip.addEventListener('click', () => { stop(); setFrame(i + 1); });
    strips.append(strip);
    app.colEls.push(strip);
  }

  $('circuit').replaceChildren(svg);
}

// ---- the plate ----------------------------------------------------------

function resetCanvas() {
  app.nodeEls.clear();
  app.edgeEls.clear();
  app.edgeLabels.clear();
  for (const t of app.exiting.values()) clearTimeout(t);
  app.exiting.clear();

  const n = app.dd.nvars;
  // The gutter has to fit the longest thing written in it — register names can be much
  // wider than "q[0]" — or the labels get clipped at the left edge of the plate.
  const longest = Math.max(BAND_LABEL.length, ...app.circuit.qubits.map((q) => q.label.length));
  const gutter = Math.max(GEO.gutter, Math.round(longest * 6.3) + 26);
  // Amplitude boxes are the widest things drawn, so they set the column width. Measured
  // over every frame, not just the current one, so stepping never rescales the plate.
  let widest = 0;
  for (const fr of app.layout.frames) {
    for (const nd of fr.nodes) if (nd.terminal) widest = Math.max(widest, termWidth(nd.label));
  }
  const slotW = Math.max(GEO.slotW, Math.round(widest) + 14);
  // A one-node diagram would otherwise get a stub of ruling that looks truncated rather
  // than deliberate, so the staff is never narrower than this.
  const slots = Math.max(5, app.layout.width);
  const contentW = slots * slotW;
  // The staff is never narrower than five slots, so a two-slot diagram has spare room in
  // it. Split that room evenly instead of leaving it all on the right, or a small diagram
  // sits against the gutter with the empty half of the plate beside it.
  const spare = (slots - app.layout.width) / 2;
  const originX = gutter + slotW / 2 + spare * slotW;
  const W = gutter + contentW + GEO.pad;
  const H = GEO.padTop + n * GEO.levelH + GEO.levelH + GEO.pad;
  app.geom = { W, H, gutter, slotW, originX };

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet' });
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'decision diagram of the quantum state');

  const rules = svgEl('g', { class: 'rules' });
  // Labels live in their own layer, drawn last and slid sideways as the plate scrolls, so
  // they stay readable when a wide diagram is panned. Everything that spans the width —
  // the rules themselves — stays put.
  const sticky = svgEl('g', { class: 'sticky' });
  sticky.append(
    svgEl('rect', { class: 'gutter-bg', x: 0, y: 0, width: gutter - 4, height: H }),
    // Shown only once the labels have left home, so that content passing under the strip
    // reads as a deliberate overlay rather than as clipping.
    svgEl('line', { class: 'gutter-edge', x1: gutter - 4, y1: 0, x2: gutter - 4, y2: H }),
  );
  app.sticky = sticky;
  app.ruleEls = new Map();
  for (let lev = 0; lev < n; lev++) {
    const y = yOf(lev);
    const line = svgEl('line', { class: 'level-rule', x1: gutter - 6, y1: y, x2: W - 8, y2: y });
    const t = svgEl('text', { class: 'gutter', x: gutter - 16, y });
    // The row is named for the qubit it decides, which under an order is not `lev`.
    t.textContent = app.circuit.qubits[app.order[lev]].label;
    rules.append(line);
    sticky.append(t);
    app.ruleEls.set(lev, [line, t]);   // marked per frame with the current gate's qubits
  }
  // The terminal row is a different kind of thing: give it a solid rule of its own.
  const bandY = yOf(n) - GEO.levelH / 2;
  rules.append(svgEl('line', { class: 'band-rule', x1: gutter - 6, y1: bandY, x2: W - 8, y2: bandY }));
  const bt = svgEl('text', { class: 'gutter band', x: gutter - 16, y: yOf(n) });
  bt.textContent = BAND_LABEL;
  sticky.append(bt);

  // Which line is dashed and which is solid is the one convention a reader cannot guess,
  // so the plate states it. Drawn with the same classes as real edges, so it survives
  // into an exported SVG and always matches what the diagram above it is doing.
  const ly = H - 13;
  const lc = svgEl('text', { class: 'gutter band', x: gutter - 16, y: ly });
  lc.textContent = 'EDGE';
  sticky.append(lc);
  let lx = gutter - 6;
  for (const [kind, value] of [['low', '0'], ['high', '1']]) {
    sticky.append(svgEl('path', { class: `edge ${kind}`, d: `M${lx},${ly} L${lx + 18},${ly}` }));
    const cap = svgEl('text', { class: 'gutter legend-cap', x: lx + 24, y: ly });
    cap.textContent = value;
    sticky.append(cap);
    lx += 48;
  }

  // Most amplitudes print in a familiar form, but a genuine root of unity has to be shown
  // as a power of w, and nothing else on screen says what w is — and w is not always the
  // same thing: a circuit with a pi/16 phase needs a finer root than a Clifford+T one.
  // Shown only on the frames where it appears, so it is a footnote rather than clutter.
  const omega = svgEl('text', { class: 'gutter legend-cap', x: lx + 16, y: ly });
  sticky.append(omega);
  app.omegaNote = omega;

  // The tuple form's common denominator, which changes from frame to frame.
  const tuple = svgEl('text', { class: 'gutter legend-cap', x: lx + 16, y: ly });
  sticky.append(tuple);
  app.tupleNote = tuple;

  // The arrow into the root, as decision diagrams are drawn on paper. It also shows
  // something worth seeing: the root is not always at level 0, because the top qubits
  // can become don't-cares.
  const marker = svgEl('g', { class: 'root-marker' });
  marker.append(
    svgEl('path', { class: 'stem', d: 'M0,-32 L0,-16' }),
    svgEl('path', { class: 'head', d: 'M-3.5,-17 L3.5,-17 L0,-10 Z' }),
  );
  const psi = svgEl('text', { x: -9, y: -25 });
  psi.textContent = '|ψ⟩';
  marker.append(psi);
  // In the edge-valued form the state's overall factor rides on the root edge, so it is
  // shown here rather than anywhere in the diagram.
  const rootW = svgEl('text', { class: 'root-weight', x: 9, y: -25 });
  marker.append(rootW);
  app.rootWeight = rootW;
  app.rootMarker = marker;

  svg.append(rules, svgEl('g', { class: 'edges' }), marker, svgEl('g', { class: 'nodes' }), sticky);
  $('canvas').replaceChildren(svg);
  app.svg = svg;
  fitCanvas();
}

/**
 * The slots the current frame actually occupies. The plate is as wide as the widest frame
 * of the whole run — that is what keeps a node in the same place as the diagram grows —
 * but fitting to *that* draws a nine-node opening frame at the scale a 255-node closing
 * one needs. So `fit` fits the frame in front of you.
 */
function frameSpan() {
  const all = app.layout?.frames[app.index]?.nodes ?? [];
  // A hidden zero subtree should not hold the view open around empty space.
  const nodes = app.hideZero ? all.filter((nd) => !nd.zero) : all;
  if (!nodes.length) return { from: app.layout?.xMin ?? 0, to: app.layout?.xMax ?? 0 };
  let from = Infinity;
  let to = -Infinity;
  for (const nd of nodes) {
    const half = (nd.terminal ? termWidth(nd.label) / 2 : GEO.r) / app.geom.slotW;
    from = Math.min(from, nd.x - half);
    to = Math.max(to, nd.x + half);
  }
  return { from, to };
}

/**
 * The part of the plate `fit` shows: the current frame, with room on the left for the
 * gutter strip that overlays it and a margin either side.
 *
 * Fitting the frame while still *sizing the element* to the whole plate is what the
 * previous version did, and it meant a narrow opening frame was drawn at a scale whose
 * plate was half again wider than the window — a scrollbar, on a diagram that was
 * entirely visible. Worse, the horizontal scrollbar it produced took height away from
 * the box, which fed back into the scale, which changed the width: at the size where
 * that flips back and forth, the plate flickers. Windowing the viewBox instead means the
 * fitted view is exactly as wide as it needs to be, so there is nothing to scroll.
 */
function frameWindow() {
  const { W, H, gutter, slotW, originX } = app.geom;
  const { from, to } = frameSpan();
  const left = originX + (from - app.layout.xMin) * slotW;
  const right = originX + (to - app.layout.xMin) * slotW;
  const width = Math.min(W, gutter + (right - left) + 2 * GEO.pad);
  const x = Math.max(0, Math.min(left - gutter - GEO.pad, W - width));
  return { x, width, height: H };
}

/** Apply the current zoom — either the fitted scale or an explicit one. */
function fitCanvas() {
  if (!app.svg || !app.geom) return;
  const box = $('canvas');
  const { W, H } = app.geom;
  // In `fit` the viewBox is a window on the plate and the element is that window, drawn
  // as large as the box allows. At an explicit zoom it is the whole plate, and the box
  // scrolls over it.
  const view = app.zoom === 'fit' ? frameWindow() : { x: 0, width: W, height: H };
  let scale;
  if (app.zoom === 'fit') {
    const raw = Math.min((box.clientWidth - 16) / view.width, (box.clientHeight - 16) / H);
    scale = Math.max(MIN_FIT_SCALE, Math.min(raw || 1, MAX_NODE_PX / (2 * GEO.r)));
  } else {
    scale = app.zoom;
  }
  app.scale = scale;
  app.viewX = view.x;
  app.svg.setAttribute('viewBox', `${view.x} 0 ${view.width} ${view.height}`);
  app.svg.style.width = `${Math.round(view.width * scale)}px`;
  app.svg.style.height = `${Math.round(view.height * scale)}px`;
  // Counter the magnification for the furniture — rules, gutter labels — so zooming in
  // grows the diagram and not its annotations. Only above 1: see the note in app.css.
  app.svg.style.setProperty('--unzoom', String(1 / Math.max(1, scale)));
  $('zoomLevel').textContent = app.zoom === 'fit' ? 'fit' : `${Math.round(scale * 100)}%`;
  if (app.zoom === 'fit') box.scrollLeft = 0;
  updateSticky();
}

/** Hold the gutter labels at the left edge of the view while the plate scrolls under them. */
function updateSticky() {
  if (!app.sticky) return;
  // Two ways the view can sit away from the plate's left edge: a windowed viewBox when
  // fitted, a scroll offset when zoomed. Only one is ever non-zero, but adding them costs
  // nothing and says plainly that the labels track the view, not the scrollbar.
  const dx = (app.viewX || 0) + $('canvas').scrollLeft / (app.scale || 1);
  app.sticky.setAttribute('transform', `translate(${dx},0)`);
  app.sticky.classList.toggle('floating', dx > 0.5);
}

/**
 * Zoom, keeping the point under `clientX/clientY` fixed — otherwise zooming in on a
 * detail throws it off screen and the reader has to hunt for it again.
 * @param {number|'fit'} next
 */
function setZoom(next, clientX, clientY) {
  if (!app.svg) return;
  const box = $('canvas');
  // Both measured before the view changes under us.
  const rect = app.svg.getBoundingClientRect();
  const boxRect = box.getBoundingClientRect();
  const before = app.scale;
  const beforeX = app.viewX || 0;
  const ax = clientX === undefined ? rect.left + rect.width / 2 : clientX;
  const ay = clientY === undefined ? rect.top + rect.height / 2 : clientY;
  // The point of the plate under the pointer, in plate coordinates — which is what has to
  // be put back under the pointer, however the view is expressed. Leaving `fit` swaps a
  // windowed viewBox for a scroll offset, so a delta on scrollLeft is not enough.
  const plateX = beforeX + (ax - rect.left) / before;
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

const yOf = (level) => GEO.padTop + level * GEO.levelH;
// Every frame shares one grid, anchored at the layout's leftmost slot, so a node's
// position depends only on where it sits — never on which frame is showing.
const xOf = (node) => app.geom.originX + (node.x - app.layout.xMin) * app.geom.slotW;
const termWidth = (label) => Math.max(34, label.length * 7.1 + 16);
const edgeKey = (e) => `${e.from}>${e.to}${e.high ? 'H' : 'L'}`;

function nodeAnchor(node, top) {
  const half = node.terminal ? GEO.termH / 2 : GEO.r;
  return yOf(node.level) + (top ? -half : half);
}

/**
 * Where an edge starts and ends.
 * @param {boolean} spread the node's two edges land on the same target, so pull them
 *   apart at the far end too — otherwise they coincide and read as one edge. Common in
 *   the edge-valued form, where children often differ only by their weights.
 */
function edgeEnds(from, to, high, spread) {
  return {
    x1: xOf(from) + (high ? 6 : -6),
    y1: nodeAnchor(from, false),
    x2: xOf(to) + (spread ? (high ? 6 : -6) : 0),
    y2: nodeAnchor(to, true),
  };
}

function edgePath(from, to, high, spread) {
  const { x1, y1, x2, y2 } = edgeEnds(from, to, high, spread);
  const bend = (y2 - y1) * 0.42;
  return `M${x1},${y1} C${x1},${y1 + bend} ${x2},${y2 - bend} ${x2},${y2}`;
}

/**
 * Where to write an edge's weight. The curve's own midpoint is the straight midpoint —
 * the bend cancels there — so writing the label at it puts the line through the text.
 * It goes beside the edge instead, on the outward side: to the left of a low edge and
 * the right of a high one, which also says which of a parallel pair it belongs to.
 */
const LABEL_OFFSET = 11;
function edgeLabelPoint(from, to, high, spread) {
  const { x1, y1, x2, y2 } = edgeEnds(from, to, high, spread);
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const side = high ? 1 : -1;
  return {
    x: (x1 + x2) / 2 + (dy / len) * LABEL_OFFSET * side,
    y: (y1 + y2) / 2 - (dx / len) * LABEL_OFFSET * side,
  };
}

function setFrame(i) {
  app.index = i;
  const f = app.layout.frames[i];

  app.colEls.forEach((el, k) => el.classList.toggle('current', k === i));
  const cur = app.colEls[i];
  if (cur) cur.scrollIntoView({ block: 'nearest', inline: 'nearest' });

  if (f.nodes.length > MAX_DRAWN_NODES) {
    $('canvas').replaceChildren(Object.assign(document.createElement('p'), {
      className: 'note',
      textContent: `${f.nodes.length} nodes is too many to draw legibly. Try fewer qubits, ` +
        `or step to a point where the diagram is smaller.`,
    }));
    app.nodeEls.clear();
    app.edgeEls.clear();
  } else {
    if (!app.svg || !app.svg.isConnected) resetCanvas();
    drawFrame(f);
    // In fit mode the scale follows the frame, so it has to be recomputed as the diagram
    // grows and shrinks under it.
    if (app.zoom === 'fit') fitCanvas();
  }
  renderReadout(f);
  renderStats(f);
}

function drawFrame(f) {
  const pos = new Map(f.nodes.map((n) => [n.id, n]));

  // Mark the qubits this gate acted on. Without it the score strip says "CX q[0] q[1]"
  // and the reader has to find those levels by counting.
  // Frames keep the gate as written, so its qubits have to be found on the plate.
  const touched = new Set(f.gate ? f.gate.qubits.map((q) => app.levelOf[q]) : []);
  for (const [lev, els] of app.ruleEls) {
    for (const el of els) el.classList.toggle('acting', touched.has(lev));
  }

  const nodesG = app.svg.querySelector('.nodes');
  const edgesG = app.svg.querySelector('.edges');

  // What counts as a zero depends on the representation: the reduced diagram has a 0
  // terminal to hide, while the edge-valued form has no zero node at all — a zero
  // subfunction is a zero-weighted *edge*. One control covers both.
  const hidden = (node) => app.hideZero && node.zero;
  const hiddenEdge = (e) => app.hideZero && (e.toZero || hidden(pos.get(e.to)));
  // Both edges of a node landing on the same target have to be drawn apart.
  const seenTarget = new Map();
  const parallel = new Set();
  for (const e of f.edges) {
    if (seenTarget.get(e.from) === e.to) parallel.add(e.from);
    seenTarget.set(e.from, e.to);
  }
  const wantEdges = new Map();
  for (const e of f.edges) {
    if (hiddenEdge(e)) continue;
    wantEdges.set(edgeKey(e), e);
  }
  for (const [k, el] of app.edgeEls) {
    if (wantEdges.has(k)) continue;
    el.remove();
    app.edgeEls.delete(k);
    const label = app.edgeLabels.get(k);
    if (label) { label.remove(); app.edgeLabels.delete(k); }
  }
  for (const [k, e] of wantEdges) {
    let el = app.edgeEls.get(k);
    if (!el) {
      el = svgEl('path', { class: 'edge' });
      app.edgeEls.set(k, el);
      edgesG.append(el);
    }
    el.setAttribute('d', edgePath(pos.get(e.from), pos.get(e.to), e.high, parallel.has(e.from)));
    el.setAttribute('class', 'edge' + (e.high ? ' high' : ' low') +
      (e.toZero ? ' to-zero' : '') + (pos.get(e.from).fresh ? ' fresh' : ''));
    setEdgeLabel(k, e, pos, parallel.has(e.from));
  }

  const reached = new Set([f.root]);
  for (const e of wantEdges.values()) reached.add(e.to);
  const visible = (node) => pos.has(node.id) && !hidden(node) && reached.has(node.id);

  for (const [id, el] of app.nodeEls) {
    if ((pos.has(id) && visible(pos.get(id))) || app.exiting.has(id)) continue;
    el.classList.add('leaving');
    app.exiting.set(id, setTimeout(() => {
      el.remove();
      app.nodeEls.delete(id);
      app.exiting.delete(id);
    }, 300));
  }

  const level = app.commonLevel[f.index];
  const showsOmega = f.nodes.some((nd) => nd.terminal && nd.label.includes('ω'))
    || f.edges?.some((e) => e.label?.includes('ω'));
  app.omegaNote.style.display = showsOmega ? '' : 'none';
  if (showsOmega) {
    const sup = svgEl('tspan', { dy: -4, 'font-size': 8 });
    sup.textContent = `iπ/${level}`;
    app.omegaNote.replaceChildren('ω = e', sup);
  }

  const tupleMode = app.ampFormat === 'tuple';
  app.tupleNote.style.display = tupleMode ? '' : 'none';
  if (tupleMode) {
    // At the base level the tuple has the four names the literature gives it; above that
    // it is as wide as the level and only an index will do.
    app.tupleNote.replaceChildren(level === 4
      ? '(a,b,c,d) = aω³+bω²+cω+d, over √2'
      : `(c${level - 1}…c0) = Σ cjωʲ, over √2`);
    const sup = svgEl('tspan', { dy: -4, 'font-size': 8 });
    sup.textContent = String(app.commonK[f.index]);
    app.tupleNote.append(sup);
  }

  const rootNode = pos.get(f.root);
  app.rootMarker.setAttribute('transform', `translate(${xOf(rootNode)},${yOf(rootNode.level)})`);
  // A state that is zero everywhere hides its own root; the arrow must not outlive it.
  app.rootMarker.style.display = hidden(rootNode) ? 'none' : '';
  app.rootWeight.textContent = f.rootWeight && f.rootWeight !== '1' ? f.rootWeight : '';

  for (const node of f.nodes) {
    if (!visible(node)) continue;
    let el = app.nodeEls.get(node.id);
    if (app.exiting.has(node.id)) {          // it came back before the fade finished
      clearTimeout(app.exiting.get(node.id));
      app.exiting.delete(node.id);
      el.classList.remove('leaving');
    }
    if (!el) {
      el = makeNode(node);
      app.nodeEls.set(node.id, el);
      nodesG.append(el);
      requestAnimationFrame(() => el.classList.remove('entering'));
    } else {
      const cap = el.querySelector('.cap');
      if (node.terminal && cap && cap.textContent !== node.label) updateNodeShape(el, node);
    }
    el.setAttribute('transform', `translate(${xOf(node)},${yOf(node.level)})`);
    el.classList.toggle('fresh', node.fresh);
    el.classList.toggle('zero', node.zero);
  }
}

/** The weight on an edge, drawn at its midpoint. Absent when the weight is 1. */
function setEdgeLabel(key, e, pos, spread) {
  const existing = app.edgeLabels.get(key);
  if (!e.label) {
    if (existing) { existing.remove(); app.edgeLabels.delete(key); }
    return;
  }
  const { x, y } = edgeLabelPoint(pos.get(e.from), pos.get(e.to), e.high, spread);
  let el = existing;
  if (!el) {
    el = svgEl('text', { class: 'edge-label' });
    app.edgeLabels.set(key, el);
    app.svg.querySelector('.edges').append(el);
  }
  el.setAttribute('x', x);
  el.setAttribute('y', y);
  if (el.textContent !== e.label) el.textContent = e.label;
}

function makeNode(node) {
  const g = svgEl('g', { class: 'node entering' });
  g.dataset.id = node.id;
  g.setAttribute('transform', `translate(${xOf(node)},${yOf(node.level)})`);
  g.append(svgEl('title'));
  updateNodeShape(g, node);
  g.addEventListener('mouseenter', () => highlight(node.id));
  g.addEventListener('mouseleave', clearHighlight);
  return g;
}

function updateNodeShape(g, node) {
  for (const old of [...g.children]) if (old.tagName !== 'title') old.remove();
  const shape = node.terminal
    ? svgEl('rect', {
        class: 'shape', rx: 2,
        x: -termWidth(node.label) / 2, y: -GEO.termH / 2,
        width: termWidth(node.label), height: GEO.termH,
      })
    : svgEl('circle', { class: 'shape', r: GEO.r });
  g.classList.toggle('terminal', node.terminal);
  g.append(shape);
  // Internal nodes carry no text: the level they sit on already names the qubit, and
  // repeating it in every circle just crowds the diagram.
  if (node.terminal) {
    const cap = svgEl('text', { class: 'cap' });
    cap.textContent = node.label;
    g.append(cap);
  }
  g.querySelector('title').textContent = node.terminal
    ? `amplitude ${node.label}`
    : `${node.label} — decides qubit ${node.level}`;
}

/** Hovering a node dims everything that is not on a path through it. */
function highlight(id) {
  const f = app.layout.frames[app.index];
  const down = new Map(), up = new Map();
  for (const e of f.edges) {
    if (!down.has(e.from)) down.set(e.from, []);
    down.get(e.from).push(e.to);
    if (!up.has(e.to)) up.set(e.to, []);
    up.get(e.to).push(e.from);
  }
  const keep = new Set([id]);
  const walk = (start, adj) => {
    const stack = [start];
    while (stack.length) {
      for (const nx of adj.get(stack.pop()) || []) if (!keep.has(nx)) { keep.add(nx); stack.push(nx); }
    }
  };
  walk(id, down);
  walk(id, up);
  for (const [nid, el] of app.nodeEls) el.classList.toggle('dimmed', !keep.has(nid));
  for (const [k, el] of app.edgeEls) {
    const [from, rest] = k.split('>');
    const to = rest.slice(0, -1);
    el.classList.toggle('dimmed', !(keep.has(+from) && keep.has(+to)));
  }
}

function clearHighlight() {
  for (const el of app.nodeEls.values()) el.classList.remove('dimmed');
  for (const el of app.edgeEls.values()) el.classList.remove('dimmed');
}

// ---- readout and stats --------------------------------------------------

function renderReadout(f) {
  const out = $('readout');
  out.replaceChildren();
  let shown = 0, more = 0;
  // The engine's root, not the layout's: in tree mode the layout renumbers nodes and its
  // root id means nothing to the diagram this readout describes.
  const root = app.frames[f.index].root;
  for (const { path, value } of app.dd.paths(root)) {
    if (shown >= MAX_READOUT_LINES) { more++; continue; }
    const line = document.createElement('div');
    line.className = 'amp-line';
    const coef = document.createElement('span');
    coef.className = 'amp-coef';
    coef.textContent = P.format(value, app.ampFormat,
      { k: app.commonK[f.index], level: app.commonLevel[f.index] });
    const ket = document.createElement('span');
    ket.className = 'amp-ket';
    // `paths` walks the diagram, so its strings are in level order; a ket is written in
    // qubit order, whatever the diagram is doing.
    ket.textContent = `|${Order.toQubits(path, app.levelOf)}⟩`;
    line.append(coef, ket);
    out.append(line);
    shown++;
  }
  if (!shown) {
    const line = document.createElement('div');
    line.className = 'amp-more';
    line.textContent = 'the state is zero everywhere';
    out.append(line);
  }
  if (more) {
    const line = document.createElement('div');
    line.className = 'amp-more';
    line.textContent = `+ ${more} more`;
    out.append(line);
  }
}

function renderStats(f) {
  const frame = app.frames[f.index];
  const norm = squaredNorm(app.dd, frame.root);
  const parts = [`<b>${f.nodes.length}</b> node${f.nodes.length === 1 ? '' : 's'}`];
  // Frame 0 is the state as given, so "+4 −0" there would be counting it against nothing.
  // No node churn count: which nodes this gate created is already on the plate, in the
  // only colour it uses.
  if (f.index > 0 && app.tree && f.changed) {
    // An unreduced tree never changes shape, so the leaves are the only news.
    const what = app.rep === 'reduced' ? 'amplitude' : 'node';
    parts.push(`<span class="delta">${f.changed} ${what}${f.changed === 1 ? '' : 's'} changed</span>`);
  }
  parts.push(norm === null ? 'symbolic' : `‖ψ‖² = ${norm.toFixed(4).replace(/0+$/, '0')}`);
  $('stats').innerHTML = parts.join(' · ');
  $('stats').title = app.tree
    ? 'Nodes in the tree, and how many amplitudes this gate changed. An unreduced tree '
      + 'never changes shape, so the leaves are the only thing that can differ.'
    : 'Nodes reachable from the root. The ones this gate created are marked on the plate.';
  $('position').textContent = `${f.index} / ${app.layout.frames.length - 1}`;
  $('prev').disabled = f.index === 0;
  $('next').disabled = f.index === app.layout.frames.length - 1;
}

// ---- the gate reference -------------------------------------------------

const ARITY_HEADINGS = { 1: 'One qubit', 2: 'Two qubits', 3: 'Three qubits', 4: 'Four qubits' };

const el = (tag, className, text) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** A row of `code` / plain-English pairs. */
function helpTable(rows) {
  const table = el('table', 'help-table');
  for (const [code, text] of rows) {
    const tr = el('tr');
    tr.append(el('td', 'help-code', code), el('td', 'help-what', text));
    table.append(tr);
  }
  return table;
}

/**
 * Built from the gate table itself rather than written out, so it cannot drift away from
 * what the tool actually accepts. Built once, on first opening.
 */
function buildHelp() {
  const body = $('helpBody');
  if (body.dataset.built) return;
  body.dataset.built = '1';

  const byArity = new Map();
  for (const [name, g] of Object.entries(GATES)) {
    if (!byArity.has(g.arity)) byArity.set(g.arity, []);
    byArity.get(g.arity).push([name, g]);
  }

  for (const [arity, gates] of [...byArity].sort((a, b) => a[0] - b[0])) {
    body.append(el('h3', null, ARITY_HEADINGS[arity] || `${arity} qubits`));
    const args = Array.from({ length: arity }, (_, i) => `q[${i}]`).join(',');
    body.append(helpTable(gates
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, g]) => [`${name} ${args};`, g.doc])));
  }

  body.append(el('h3', null, 'Phases'));
  body.append(el('p', 'help-note',
    'Any angle that is π times a dyadic rational — π/4, π/8, π/256 — which is exactly when '
    + 'the phase stays exact. A finer phase moves the amplitude ring up a level rather than '
    + 'rounding it, so ω means e^(iπ/4) in a Clifford+T circuit and e^(iπ/16) in one that '
    + 'asked for π/16. The plate says which. '
    + 'Enough to write a QFT.'));
  body.append(helpTable([
    ['u1(pi/4) q[0];', 'multiplies |1> by e^(iπ/4); p is a synonym'],
    ['cu1(pi/2) q[0],q[1];', 'the same phase, applied when the control is 1; cp is a synonym'],
  ]));

  body.append(el('h3', null, 'The input state'));
  body.append(el('p', 'help-note',
    'One line per basis pattern. Amplitudes are built from integers, i, sqrt2, omega and '
    + 'free symbols with + - * / ^, and division must stay exact.'));
  body.append(helpTable([
    ['|01> : 1/sqrt(2)', 'one basis state; the bars and ket are optional'],
    ['0-1 : 1/2', "'-' matches either value of that qubit — two states, one line, no extra nodes"],
    ['|00> : a', 'a free symbol, carried through the circuit unevaluated'],
    ['-- : ?', "'?' gives every matched state its own symbol: a, b, c, d"],
    ['--0-- : ?', 'past the letters, each is named after its basis state: a00000, a00001, ...'],
    ['-- : x?', 'a chosen prefix forces that naming; ?/2 halves each of them'],
  ]));

  body.append(el('h3', null, 'Circuit syntax'));
  body.append(helpTable([
    ['qreg q[3];', 'declare qubits; several registers are laid end to end'],
    ['h q;', 'apply a one-qubit gate to every qubit of a register'],
    ['gate flip a,b { x a; cx a,b; }', 'define a gate; calls to it are inlined'],
    ['barrier q;', 'a section marker in the strip above; it does not change the state'],
    ['// note', 'comment, as is /* ... */'],
  ]));

  body.append(el('h3', null, 'The views'));
  body.append(el('p', 'help-note',
    'The same state, drawn with more and more taken off the nodes and put on the edges. '
    + 'Each shares a subfunction under a wider notion of sameness, so each is at most as '
    + 'large as the one above it. "full tree" draws whichever you are looking at with '
    + 'nothing shared, which is what the sharing saves.'));
  body.append(helpTable([
    ['MTBDD', 'amplitudes in the terminals; two subfunctions share a node when they are equal'],
    ['EVDD', 'amplitudes on the edges; subfunctions share when they are equal up to a scalar'],
    ['Pauli-LIMDD', 'and up to a local Pauli: an edge reads w·X⊗Z⊗I, meaning w times X on '
      + 'the first qubit, Z on the second, nothing on the third. Every stabilizer state is a tower.'],
  ]));

  body.append(el('h3', null, 'The layout'));
  body.append(helpTable([
    ['drag a boundary', 'the input column against the plate, one panel against the next, '
      + 'or the circuit against the diagram. Double-click to put it back; focus it and the '
      + 'arrow keys move it, Home resets it'],
    ['Amplitudes', 'folds away by its own header, and gives its space back to the circuit'],
    ['', 'sizes and folds are remembered, so a layout you set once stays set'],
  ]));

  body.append(el('h3', null, 'The qubit order'));
  body.append(helpTable([
    ['order', 'which qubit each level of the diagram decides. The single biggest lever on '
      + 'how big a diagram gets — Nested Bell pairs on eight qubits is 47 nodes as written '
      + 'and 14 when paired. Only the rows move: a ket and a Pauli string are always '
      + 'written in qubit order'],
    ['custom…', 'the qubits in the order you want them, top level first, in the circuit\'s '
      + 'own names: q[0] q[2] q[1] b[0]. Bare indices into the flattened run of qubits work '
      + 'too, and mean the same thing — but with more than one register only the names say '
      + 'which qubit is which'],
    ['sift', 'search for an order that makes the widest frame of the run smaller. Refuses, '
      + 'with an estimate, when the search would take more than a few seconds'],
  ]));

  body.append(el('h3', null, 'Taking a figure away'));
  body.append(helpTable([
    ['copy link', 'the whole view in a URL: circuit, input, step and how it is drawn'],
    ['export SVG', 'the diagram as it stands, for a slide'],
    ['TikZ diagram', 'the same diagram as TikZ nodes and paths, for a paper — the styles '
      + 'come with it, so every low edge or terminal can be restyled in one place'],
    ['TikZ circuit', 'the circuit as quantikz. Amplitudes are translated to LaTeX on the '
      + 'way (√2 becomes \\sqrt{2}, ω³ becomes \\omega^{3}), which is why the code is shown '
      + 'before it is copied'],
    ['tableau', 'Pauli-LIMDD only: the stabilizer group of every node in this step, as '
      + 'signed check vectors. A node whose rank matches the qubits below it is a '
      + 'stabilizer state, which is why the diagram is a tower there'],
  ]));

  body.append(el('h3', null, 'Refused, and why'));
  body.append(helpTable([
    ['rx(0.3) q[0];', 'an arbitrary rotation leaves the exact ring, so it cannot be represented'],
    ['u1(pi/3) q[0];', 'the same reason: π/3 is not π times a dyadic rational, at any level'],
    ['measure q -> c;', 'not unitary; this tool shows unitary evolution of a pure state'],
    ['reset q[0];', 'likewise not unitary'],
    ['if (c==1) x q[0];', 'classical control needs a measurement to control on'],
  ]));
}

// ---- transport ----------------------------------------------------------

function step(d) {
  const i = Math.min(app.layout.frames.length - 1, Math.max(0, app.index + d));
  if (i !== app.index) setFrame(i);
  return i;
}

function play() {
  if (app.playing) return stop();
  if (app.index === app.layout.frames.length - 1) setFrame(0);
  app.playing = true;
  $('play').textContent = '❚❚';
  app.timer = setInterval(() => {
    if (step(1) === app.layout.frames.length - 1) stop();
  }, PLAY_MS);
}

function stop() {
  app.playing = false;
  clearInterval(app.timer);
  const b = $('play');
  if (b) b.textContent = '▶';
}

// ---- export -------------------------------------------------------------

/** The plate as a standalone SVG file, for dropping into a paper or slide. */
function exportSvg() {
  if (!app.svg) return;
  const cs = getComputedStyle(document.documentElement);
  const v = (name) => cs.getPropertyValue(name).trim();
  const clone = app.svg.cloneNode(true);
  clone.setAttribute('xmlns', SVG_NS);
  clone.setAttribute('width', app.geom.W);
  clone.setAttribute('height', app.geom.H);
  // `fit` leaves a window on the plate in the viewBox; a figure is the whole plate.
  clone.setAttribute('viewBox', `0 0 ${app.geom.W} ${app.geom.H}`);
  // The figure is written at its natural size, so nothing is countering a magnification.
  clone.style.setProperty('--unzoom', '1');
  for (const el of clone.querySelectorAll('.dimmed')) el.classList.remove('dimmed');
  // The exported figure is not scrolled, so the labels belong back in the gutter.
  clone.querySelector('.sticky')?.removeAttribute('transform');
  const style = document.createElementNS(SVG_NS, 'style');
  style.textContent = `
    svg { background: ${v('--plate')} }
    .level-rule { stroke: ${v('--rule-soft')}; stroke-width: 1; stroke-dasharray: 1 5 }
    .band-rule { stroke: ${v('--rule')}; stroke-width: 1 }
    .gutter-bg { fill: ${v('--plate')} }
    .gutter-edge { stroke: none }
    .gutter { fill: ${v('--ink-faint')}; font: 10px monospace; text-anchor: end; dominant-baseline: middle }
    .gutter.band { font: 9px sans-serif; letter-spacing: .1em }
    .gutter.legend-cap { text-anchor: start }
    .level-rule.acting { stroke: ${v('--accent')}; opacity: .55 }
    .gutter.acting { fill: ${v('--accent')} }
    .edge { fill: none; stroke: ${v('--ink')}; stroke-width: 1.1; opacity: .62 }
    .edge.low { stroke-dasharray: 3.5 2.5 }
    .edge.to-zero { opacity: .22 }
    .edge.fresh { stroke: ${v('--accent')}; opacity: .9 }
    .node .shape { fill: ${v('--plate')}; stroke: ${v('--ink')}; stroke-width: 1.2 }
    .node.fresh .shape { stroke: ${v('--accent')}; stroke-width: 1.8 }
    .node .cap { fill: ${v('--ink')}; font: 10.5px monospace; text-anchor: middle; dominant-baseline: central }
    .node.terminal .cap { font: 12px serif }
    .node.fresh .cap { fill: ${v('--accent')} }
    .node.zero { opacity: .5 }
    .root-marker .stem { fill: none; stroke: ${v('--ink-soft')}; stroke-width: 1.1 }
    .root-marker .head { fill: ${v('--ink-soft')}; stroke: none }
    .root-marker text { fill: ${v('--ink-soft')}; font: 11px serif; text-anchor: end }
    .root-marker .root-weight { text-anchor: start; fill: ${v('--ink')} }
    .edge-label { fill: ${v('--ink')}; font: 10px serif; text-anchor: middle;
      dominant-baseline: central; paint-order: stroke; stroke: ${v('--plate')}; stroke-width: 3px }
  `;
  clone.prepend(style);
  const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mtbdd-step-${app.index}.svg`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/**
 * The current view as TikZ, in a dialog so it can be read before it is taken. An SVG is
 * the wrong thing to put in a paper; this is the right one, and seeing it first matters
 * because the amplitudes have been through a Unicode-to-LaTeX pass on the way.
 */
function showTikz(what) {
  if (!app.layout || !app.circuit) return;
  // The same link the copy-link button gives, so the figure carries the live view it came
  // from — pinned to this build, so it keeps showing this figure.
  const link = permalinkPair();
  const text = what === 'circuit'
    ? circuitTikz(app.circuit, { link })
    : diagramTikz(app.layout, app.index, {
      qubitLabels: app.order.map((q) => app.circuit.qubits[q].label),
      bandLabel: BAND_LABEL.toLowerCase(),
      hideZero: app.hideZero,
      link,
    });
  showCode(what === 'circuit'
    ? 'TikZ · circuit, as quantikz'
    : `TikZ · diagram, step ${app.index} of ${app.layout.frames.length - 1}`, text);
}

/**
 * The stabilizer group of every node in the current frame. The diagram already computed
 * these to choose its labels; the tableau is where a reader can check them, and where the
 * rank says why the diagram has the shape it has — full rank is a stabilizer state, which
 * is a tower, which is the whole point of the representation.
 *
 * Drawn as a table rather than dumped as text, since that is what it is; the copy button
 * still hands over the aligned text, which is what a paper or a test fixture wants.
 */
function showTableau() {
  if (!app.limdd || !app.layout || !app.circuit) return;
  const opts = {
    qubitLabels: app.order.map((q) => app.circuit.qubits[q].label),
    names: app.circuit.qubits.map((q) => q.label),
    levelOf: app.levelOf,
    order: app.order,
    formatWeight: (w) => app.showAmp(w, app.index),
  };
  const f = tableauFrame(app.limdd, app.layout, app.index, opts);
  showRich(`Pauli-LIMDD · stabilizers, step ${f.step} of ${f.last}`,
    tableauDom(f, opts.formatWeight),
    tableauText(app.limdd, app.layout, app.index, opts));
}

/** The tableau as elements. Pure over the structure `tableauFrame` returns. */
function tableauDom(f, formatWeight) {
  const box = el('div');

  const lead = el('div', 'tab-lead');
  lead.append(el('b', null, f.distinct === f.positions
    ? `${f.distinct} node${f.distinct === 1 ? '' : 's'}`
    : `${f.distinct} distinct nodes`));
  lead.append(document.createTextNode(f.distinct === f.positions
    ? `, on ${f.qubits} qubits.`
    : `, standing in ${f.positions} places in the tree — the group belongs to the node, not to where it sits.`));
  // Columns are in qubit order whatever the diagram is doing, so where the two differ the
  // reader is told both rather than left to assume they are the same.
  lead.append(document.createTextNode(` Columns read ${f.names.join(', ')}, qubit 0 first.`));
  if (f.reordered) {
    lead.append(document.createTextNode(` The diagram's rows are ${f.qubitLabels.join(', ')}.`));
  }
  box.append(lead);

  // The bits are the point, so they are drawn rather than written: an inked 1 against a
  // faint 0 makes each generator a shape before it is a number.
  const bits = (s) => {
    const span = el('span', 'tab-bits');
    for (const c of s) span.append(el('span', c === '1' ? 'on' : 'off', c));
    return span;
  };
  const letters = (list) => {
    const span = el('span', 'tab-string');
    list.forEach((ch, i) => {
      if (i) span.append(document.createTextNode('⊗'));
      span.append(el('span', ch === 'I' ? 'i' : null, ch));
    });
    return span;
  };

  for (const t of f.nodes) {
    const head = el('div', 'tab-head');
    head.append(el('span', 'tab-id', `node ${t.id}`), el('span', 'tab-where', t.where));
    const rank = el('span', 'tab-rank');
    rank.append(document.createTextNode('rank '), el('b', null, String(t.rank)),
      document.createTextNode(` of ${t.span}`));
    head.append(rank);
    if (t.terminal) head.append(el('span', 'tab-badge quiet', 'trivial'));
    else if (t.full) head.append(el('span', 'tab-badge', 'stabilizer state'));
    box.append(head);

    if (!t.rows.length) {
      box.append(el('p', 'tab-empty', 'The identity alone.'));
      continue;
    }
    const table = el('table', 'tab-grid');
    const hr = el('tr');
    for (const h of ['sign', 'x', 'z', 'generator']) hr.append(el('th', null, h));
    table.append(hr);
    // Which column is which qubit. Single digits only: past ten the indices would need
    // two characters and would no longer line up with the bits above them, and the
    // generator column spells the qubits out in any case.
    if (f.qubits <= 10) {
      const ruler = el('tr', 'tab-ruler');
      const digits = () => {
        const span = el('span', 'tab-bits');
        for (let q = 0; q < f.qubits; q++) span.append(el('span', 'off', String(q)));
        return span;
      };
      const blank = el('td');
      const rx = el('td');
      rx.append(digits());
      const rz = el('td');
      rz.append(digits());
      ruler.append(blank, rx, rz, el('td'));
      table.append(ruler);
    }
    for (const r of t.rows) {
      const tr = el('tr');
      tr.append(el('td', 'tab-sign', r.sign ?? formatWeight(r.weight)));
      const tx = el('td');
      tx.append(bits(r.x));
      const tz = el('td');
      tz.append(bits(r.z));
      const tg = el('td');
      tg.append(letters(r.letters));
      tr.append(tx, tz, tg);
      table.append(tr);
    }
    box.append(table);
  }

  if (f.omitted) {
    box.append(el('p', 'tab-note', `… and ${f.omitted} more nodes, not listed.`));
  }
  if (f.short) {
    box.append(el('p', 'tab-note', 'Every generator above fixes its node. The search can '
      + 'still miss some, so full rank proves a stabilizer state and less than full rank '
      + 'proves nothing.'));
  }
  return box;
}

/** Text worth reading before it is taken, in the one dialog both such things share. */
function showCode(title, text) {
  app.code = text;
  $('codeTitle').textContent = title;
  $('codeBody').textContent = text;
  $('codeBody').hidden = false;
  $('codeRich').hidden = true;
  $('codeBody').scrollTop = 0;
  $('codeDialog').showModal();
}

/** The same dialog, showing something drawn. `text` is what the copy button takes. */
function showRich(title, node, text) {
  app.code = text;
  $('codeTitle').textContent = title;
  $('codeBody').hidden = true;
  const rich = $('codeRich');
  rich.hidden = false;
  rich.replaceChildren(node);
  rich.scrollTop = 0;
  $('codeDialog').showModal();
}

async function copyCode() {
  const button = $('codeCopy');
  let ok = true;
  try {
    await navigator.clipboard.writeText(app.code || '');
  } catch {
    ok = false;   // no permission, or an insecure context such as file://
  }
  button.textContent = ok ? 'copied' : 'select and copy';
  setTimeout(() => { button.textContent = 'copy'; }, 1800);
}

// ---- wiring -------------------------------------------------------------

// ---- permalinks ---------------------------------------------------------
//
// The whole state of a view — circuit, input state, which gate, and how it is drawn —
// goes in the URL fragment, so a specific step can be linked from lecture notes or a
// paper. base64url rather than percent-encoding because QASM is full of characters
// (brackets, semicolons, newlines) that percent-encoding triples in length.

function encodeText(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeText(code) {
  const bin = atob(code.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/**
 * Which build this is. Injected by tools/build.mjs into the meta tag; 'dev' in the dev
 * loop and in any build made outside the release workflow. Read on demand, so that this
 * module still evaluates outside a browser.
 */
let versionSeen = '';
function version() {
  if (!versionSeen) {
    versionSeen = document.querySelector('meta[name="q-vis-version"]')?.content || 'dev';
  }
  return versionSeen;
}

/** A released version is archived under /v/<version>/ and never changes again. */
const RELEASE = /^v\d+$/;

/** Where a build that is not the current one lives, relative to the site root. */
const elsewhere = (version) => (version === 'preview' ? 'preview/' : `v/${version}/`);

/**
 * Where a copied link should point: the frozen copy of this build, so that a link keeps
 * showing what it showed when it was made, whatever the tool becomes later. Null when
 * there is nothing frozen to point at — an unreleased build, a page opened from a file,
 * or a page that is already the archived copy.
 */
export function archiveUrl(href, version) {
  if (!RELEASE.test(version)) return null;      // 'preview' has no frozen copy either
  let url;
  try { url = new URL(href); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.pathname.includes(`/v/${version}/`)) return null;
  return new URL(`v/${version}/`, url).href;
}

/**
 * The way back to whatever is current, from a page that is not it — an archived release
 * or the preview. Null when this page is the current one, which is when there is nowhere
 * to go.
 */
export function liveUrl(href, version) {
  if (!RELEASE.test(version) && version !== 'preview') return null;
  let url;
  try { url = new URL(href); } catch { return null; }
  const at = elsewhere(version);
  if (!url.pathname.includes(`/${at}`)) return null;
  return new URL('../'.repeat(at.split('/').length - 1), url).href;
}

/**
 * How a view is spelled in a link. One code for the representation and whether it is
 * drawn as a tree, spelled as it always was, so that a link written by an older build
 * still says the same thing to this one and the other way round.
 */
const VIEW_CODES = { reduced: ['', '1'], 'edge-valued': ['e', 'te'], limdd: ['l', 'tl'] };

export const viewCode = (rep, tree) => (VIEW_CODES[rep] || VIEW_CODES.reduced)[tree ? 1 : 0];

export function viewFromCode(code) {
  for (const [rep, codes] of Object.entries(VIEW_CODES)) {
    const tree = codes.indexOf(code);
    if (tree >= 0 && code !== '') return [rep, tree === 1];
  }
  return ['reduced', false];
}

function permalink() {
  const p = new URLSearchParams();
  p.set('c', encodeText($('qasm').value));
  p.set('s', encodeText($('stateText').value));
  if (app.index) p.set('i', String(app.index));
  const code = viewCode(app.rep, app.tree);
  if (code) p.set('t', code);
  if (app.canon !== 'max') p.set('n', app.canon);
  if (app.hideZero) p.set('z', '1');
  if (app.ampFormat !== 'exact') p.set('f', app.ampFormat);
  // Only when it is not the identity, so every link already written keeps its meaning.
  if (app.order.length && !Order.isIdentity(app.order)) p.set('o', Order.formatIndices(app.order));
  const here = location.href.split('#')[0];
  const base = archiveUrl(location.href, version()) || here;
  return `${base}#${p}`;
}

/**
 * The same view as two links, for anything that embeds one in text rather than putting it
 * on the clipboard.
 *
 * `pinned` is what `permalink` gives: the frozen copy of this build, so the link keeps
 * meaning what it meant. `current` is the same view on whatever the site serves now — the
 * thing a pinned link can never tell you about, because by construction it does not know
 * a newer version exists. On an archived page the two swap roles, and on an unreleased
 * build there is only one, so it is reported once.
 */
function permalinkPair() {
  const pinned = permalink();
  const fragment = pinned.slice(pinned.indexOf('#'));
  const here = location.href.split('#')[0];
  const live = liveUrl(location.href, version()) || here;
  const current = `${live}${fragment}`;
  return { pinned, current: current === pinned ? null : current };
}

/** @returns {boolean} whether a link was found and applied */
function applyPermalink() {
  if (!location.hash.startsWith('#c=')) return false;
  let p;
  try {
    p = new URLSearchParams(location.hash.slice(1));
    $('qasm').value = decodeText(p.get('c'));
    $('stateText').value = decodeText(p.get('s') || '');
  } catch {
    return false;   // a mangled link should not stop the app from starting
  }
  [app.rep, app.tree] = viewFromCode(p.get('t'));
  if (NORMALISERS[p.get('n')]) app.canon = p.get('n');
  app.hideZero = p.get('z') === '1';
  // A link carries the order itself rather than which preset produced it: a preset is a
  // way of typing one, and what matters is the permutation.
  if (p.get('o')) {
    try {
      app.customOrder = p.get('o').split('-').map(Number);
      app.orderKind = 'custom';
      // Arriving with an order set, unfold: it is not the reader's own choice yet, and
      // they should see it rather than wonder why the rows are shuffled.
      $('orderBox').open = true;
    } catch { /* a malformed order is no order */ }
  }
  const f = normaliseFormat(p.get('f'));
  if (AMP_FORMATS.includes(f) && f !== 'exact') app.ampFormat = f;
  $('view').value = app.rep;
  $('tree').checked = app.tree;
  $('canon').value = app.canon;
  $('hideZero').checked = app.hideZero;
  $('ampFormat').value = app.ampFormat;
  app.index = Math.max(0, parseInt(p.get('i') || '0', 10) || 0);
  showExample($('qasm').value, $('stateText').value);
  compile();
  setFrame(Math.min(app.index, app.layout.frames.length - 1));
  return true;
}

async function copyPermalink() {
  const url = permalink();
  // The address bar keeps this page and gains only the settings: pointing it at the
  // archived copy would mean a reload quietly left the current version behind.
  history.replaceState(null, '', `#${url.split('#')[1] || ''}`);
  const button = $('permalink');
  let ok = true;
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    ok = false;   // no clipboard permission, or an insecure context such as file://
  }
  button.textContent = ok ? 'link copied' : 'link in address bar';
  setTimeout(() => { button.textContent = 'copy link'; }, 1800);
}

const STORE = 'q-vis:v1';
const THEME_STORE = 'q-vis:theme';
const AMP_STORE = 'q-vis:amplitudes';
const THEMES = ['auto', 'light', 'dark'];
// A symbol rather than the word: the control is a single glyph among other controls, and
// the word for the current state reads like a label for what clicking will do.
const THEME_GLYPH = { auto: '◐', light: '☀', dark: '☾' };

/** 'auto' follows the system; the other two pin it. Kept per viewer, not in the file. */
function applyTheme(name) {
  app.theme = name;
  if (name === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', name);
  const button = $('theme');
  button.textContent = THEME_GLYPH[name];
  button.title = `theme: ${name} — click to cycle through auto, light and dark`;
  button.setAttribute('aria-label', `theme: ${name}`);
  try { localStorage.setItem(THEME_STORE, name); } catch { /* storage may be unavailable */ }
}

function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify({ qasm: $('qasm').value, state: $('stateText').value }));
  } catch { /* private windows and disabled storage are fine; the inputs are still on screen */ }
}

function load() {
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return v && typeof v.qasm === 'string' && typeof v.state === 'string' ? v : null;
  } catch { return null; }
}

/**
 * The size control, holding whatever sizes the chosen example can be built at. A family
 * with one size has nothing to choose, so it shows nothing rather than a select with a
 * single entry.
 */
function showSizes(example, size) {
  const el = $('size');
  const sizes = example?.sizes ?? [];
  el.style.display = sizes.length > 1 ? '' : 'none';
  if (sizes.length < 2) return;
  el.replaceChildren(...sizes.map((n) => new Option(`${n}q`, String(n))));
  el.value = String(size ?? example.defaultSize);
}

function useExample(i, size) {
  const ex = instantiate(EXAMPLES[i], size);
  $('qasm').value = ex.qasm;
  $('stateText').value = ex.state;
  $('note').textContent = ex.note;
  showSizes(EXAMPLES[i], ex.size);
  app.index = 0;
  compile();
}

/** Point the example and size controls at whatever the text in the boxes turns out to be. */
function showExample(qasm, state) {
  const hit = identify(qasm, state);
  $('example').value = hit ? String(EXAMPLES.indexOf(hit.example)) : '';
  $('note').textContent = hit ? hit.note : '';
  showSizes(hit?.example, hit?.size);
}

/**
 * The version chip in the masthead. An archived copy says which one it is and offers the
 * way back; the current build says nothing, because there is nowhere to go.
 */
function showVersion() {
  const back = liveUrl(location.href, version());
  if (!back) return;
  const chip = $('version');
  chip.textContent = `${version()} · open the current version`;
  chip.href = back;
  chip.title = version() === 'preview'
    ? 'this is a preview: it changes without warning and is not what the site serves'
    : 'this is a frozen copy, kept so that older links keep working';
}

export function boot() {
  showVersion();
  new ResizeObserver(fitCanvas).observe($('canvas'));
  $('canvas').addEventListener('scroll', updateSticky, { passive: true });
  const picker = $('example');
  // A blank entry so the picker can stop claiming to show an example once the text has
  // been edited into something else.
  picker.append(new Option('custom', ''));
  EXAMPLES.forEach((ex, i) => picker.append(new Option(ex.name, String(i))));
  picker.addEventListener('change', () => { if (picker.value !== '') useExample(+picker.value); });
  $('size').addEventListener('change', (e) => {
    if (picker.value !== '') useExample(+picker.value, +e.target.value);
  });

  let timer = null;
  const onEdit = () => {
    clearTimeout(timer);
    stop();
    picker.value = '';
    $('note').textContent = '';
    showSizes(null);
    timer = setTimeout(compile, 350);
  };
  $('qasm').addEventListener('input', onEdit);
  $('stateText').addEventListener('input', onEdit);

  $('prev').addEventListener('click', () => { stop(); step(-1); });
  $('next').addEventListener('click', () => { stop(); step(1); });
  $('play').addEventListener('click', play);
  $('export').addEventListener('click', exportSvg);
  $('tikzDiagram').addEventListener('click', () => showTikz('diagram'));
  $('tikzCircuit').addEventListener('click', () => showTikz('circuit'));
  $('tableau').addEventListener('click', showTableau);

  for (const [key, preset] of Object.entries(Order.PRESETS)) {
    $('order').append(new Option(preset.name, key));
  }
  $('order').append(new Option('custom…', 'custom'));
  $('order').addEventListener('change', (e) => {
    app.orderKind = e.target.value;
    // Entering custom starts from whatever is on screen, so the field is never blank and
    // the diagram never jumps at the moment of switching.
    if (app.orderKind === 'custom') app.customOrder = [...app.order];
    $('orderNote').textContent = '';
    compile();
  });
  $('orderText').addEventListener('input', () => {
    try {
      app.customOrder = Order.parse($('orderText').value, app.circuit.nqubits, qubitNames());
      app.orderInvalid = null;
      $('orderNote').textContent = '';
      compile();
    } catch (err) {
      // Keep the last good drawing, as the circuit box does, and say what is wrong — in
      // the field, in the note, and in the summary, since the box can be folded away.
      app.orderInvalid = err.message;
      showOrder();
    }
  });
  // Leaving the field puts back the order actually in force, written in the circuit's
  // names. That covers two things: a refused permutation left on screen would read as the
  // one being drawn, and `0 2 1 3` typed as indices is normalised to `q[0] q[2] q[1] b[0]`
  // — which is the same order said in a way that does not have to be counted out.
  $('orderText').addEventListener('blur', () => {
    if (app.orderInvalid) {
      app.orderInvalid = null;
      $('orderNote').textContent = '';
    }
    showOrder();
  });
  $('sift').addEventListener('click', sift);

  for (const el of document.querySelectorAll('.vsplit, .hsplit, .psplit')) armSplitter(el);
  for (const el of document.querySelectorAll('.panel.foldable')) {
    el.addEventListener('toggle', saveLayout);
  }
  loadLayout();
  $('codeCopy').addEventListener('click', copyCode);
  $('codeClose').addEventListener('click', () => $('codeDialog').close());
  $('codeDialog').addEventListener('click', (e) => {
    if (e.target === $('codeDialog')) $('codeDialog').close();
  });
  $('permalink').addEventListener('click', copyPermalink);
  $('symbolic').addEventListener('click', () => {
    // From the circuit as currently typed, not the last one that compiled: after editing
    // the register the old state no longer parses, and that is exactly when this is used.
    let nqubits;
    try {
      nqubits = parseQasm($('qasm').value).nqubits;
    } catch {
      if (!app.circuit) return;
      nqubits = app.circuit.nqubits;
    }
    $('stateText').value = symbolicStateText(nqubits);
    picker.value = '';
    $('note').textContent = '';
    app.index = 0;
    compile();
  });
  $('help').addEventListener('click', () => { buildHelp(); $('helpDialog').showModal(); });
  $('helpClose').addEventListener('click', () => $('helpDialog').close());
  // Clicking the backdrop, which is the dialog element itself outside its own box.
  $('helpDialog').addEventListener('click', (e) => {
    if (e.target === $('helpDialog')) $('helpDialog').close();
  });
  $('ampFormat').addEventListener('change', (e) => {
    app.ampFormat = e.target.value;
    try { localStorage.setItem(AMP_STORE, app.ampFormat); } catch { /* storage may be unavailable */ }
    // Only the labels change, so hold the current zoom rather than snapping back to fit.
    const held = app.zoom;
    compile();
    app.zoom = held;
    fitCanvas();
  });
  $('zoomIn').addEventListener('click', () => zoomBy(ZOOM_STEP));
  $('zoomOut').addEventListener('click', () => zoomBy(1 / ZOOM_STEP));
  $('zoomLevel').addEventListener('click', () => setZoom('fit'));

  // Wheel scrolls, ctrl/⌘ + wheel zooms — which is also what a trackpad pinch sends.
  $('canvas').addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    zoomAt(Math.exp(-e.deltaY / 300), e.clientX, e.clientY);
  }, { passive: false });

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

  $('theme').addEventListener('click', () => {
    applyTheme(THEMES[(THEMES.indexOf(app.theme) + 1) % THEMES.length]);
  });
  $('view').addEventListener('change', (e) => {
    app.rep = e.target.value;
    // The Pauli rules assume the low edge has been emptied, which is what 'low edge'
    // does as far as this ring allows. Any other rule leaves weights on the low edges
    // that then have to match for two nodes to merge, and the diagram stops collapsing.
    if (app.rep === 'limdd' && app.canon !== 'low') {
      app.canon = 'low';
      $('canon').value = 'low';
    }
    compile();
  });
  $('tree').addEventListener('change', (e) => {
    app.tree = e.target.checked;
    compile();
  });
  for (const [kind, rule] of Object.entries(NORMALISERS)) {
    $('canon').append(new Option(`factor: ${rule.label}`, kind));
  }
  $('canon').value = app.canon;
  $('canon').addEventListener('change', (e) => {
    app.canon = e.target.value;
    compile();
  });
  $('hideZero').addEventListener('change', (e) => {
    app.hideZero = e.target.checked;
    // Only a redraw: hiding the sink changes nothing about where anything sits, so
    // rebuilding the plate would make every node re-enter for no reason.
    drawFrame(app.layout.frames[app.index]);
  });

  /**
   * Anything the reader is typing into keeps its own keys. The shortcuts are single
   * characters — space plays, `0` fits, `-` zooms out, the arrows step — and the order
   * field is typed with digits, spaces and dashes, so every character of a custom order
   * was a shortcut. A `select` is included because its arrow keys are its own too.
   */
  const typing = (el) => el instanceof HTMLElement
    && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

  document.addEventListener('keydown', (e) => {
    if (typing(e.target) || e.metaKey || e.ctrlKey) return;
    const zoomKeys = {
      '+': () => zoomBy(ZOOM_STEP), '=': () => zoomBy(ZOOM_STEP),
      '-': () => zoomBy(1 / ZOOM_STEP), '0': () => setZoom('fit'),
    };
    if (zoomKeys[e.key]) { e.preventDefault(); zoomKeys[e.key](); return; }
    const keys = {
      ArrowRight: () => step(1), ArrowLeft: () => step(-1),
      Home: () => setFrame(0), End: () => setFrame(app.layout.frames.length - 1),
    };
    if (e.key === ' ') { e.preventDefault(); play(); return; }
    if (keys[e.key]) { e.preventDefault(); stop(); keys[e.key](); }
  });

  let theme = 'auto';
  try {
    const stored = localStorage.getItem(THEME_STORE);
    if (THEMES.includes(stored)) theme = stored;
  } catch { /* storage may be unavailable */ }
  applyTheme(theme);

  try {
    const amp = localStorage.getItem(AMP_STORE);
    if (AMP_FORMATS.includes(normaliseFormat(amp))) app.ampFormat = normaliseFormat(amp);
  } catch { /* storage may be unavailable */ }
  $('ampFormat').value = app.ampFormat;

  // A link wins over whatever this browser happened to be looking at last.
  if (applyPermalink()) return;

  const saved = load();
  if (saved) {
    $('qasm').value = saved.qasm;
    $('stateText').value = saved.state;
    showExample(saved.qasm, saved.state);
    compile();
  } else {
    picker.value = '0';
    useExample(0);
  }
}
