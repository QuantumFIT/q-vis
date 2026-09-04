// The browser front end. Everything below this line touches the DOM; everything above
// it in the module graph runs headless and is tested that way.

import { MTBDD } from './dd.js';
import * as P from './poly.js';
import { simulate } from './sim.js';
import { parseQasm } from './qasm.js';
import { parseState, buildState, squaredNorm, symbolicStateText } from './state.js';
import { layoutFrames, layoutEdgeValued } from './layout.js';
import { EVDD, unitNormaliser } from './evdd.js';
import * as Z from './zomega.js';
import { EXAMPLES } from './examples.js';
import { GATES } from './gates.js';

const GEO = { gutter: 72, padTop: 46, levelH: 64, slotW: 82, r: 9, termH: 23, pad: 30 };
// "Fit" really fits, however wide the diagram: it is the overview, and zooming is how the
// detail is read. The ceiling stops a two-node diagram from being blown up absurdly.
const SCALE_RANGE = [0.12, 1.5];
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
  view: 'reduced',   // reduced | tree | edge-valued
  theme: 'auto',
  ampFormat: 'exact',
  zoom: 'fit',
  scale: 1,
  nodeEls: new Map(),
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

  const dd = new MTBDD(P.Ring, circuit.nqubits);
  let frames;
  try {
    frames = simulate(dd, buildState(dd, parsedState.entries), circuit);
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
  const labels = circuit.qubits.map((q) => q.label);
  const show = (v, i) => P.format(v, app.ampFormat, { k: app.commonK[i] });
  if (app.view === 'edge-valued') {
    // Simulation stays on the MTBDD; this is the same states seen the other way, built
    // in one pass per frame. One manager for the whole run, so nodes shared between
    // frames stay the same nodes and the diagram morphs rather than being redrawn.
    const ev = new EVDD(P.Ring, circuit.nqubits, unitNormaliser(P, Z));
    const memo = new Map();
    app.layout = layoutEdgeValued(ev,
      frames.map((f) => ({ index: f.index, gate: f.gate, edge: ev.fromMTBDD(dd, f.root, memo) })),
      labels, show);
  } else {
    app.layout = layoutFrames(dd, frames, {
      qubitLabels: labels,
      expand: app.view === 'tree',
      formatValue: show,
    });
  }
  app.index = Math.min(app.index, frames.length - 1);

  $('error').textContent = '';
  app.zoom = 'fit';
  // The unreduced tree has 2^(n+1)-1 nodes, so past a handful of qubits it is neither
  // drawable nor informative.
  // One unknown per basis state, so it is only offered while that is a sane number.
  const tooMany = 2 ** circuit.nqubits > 256;
  $('symbolic').disabled = tooMany;
  $('symbolic').title = tooMany
    ? `${2 ** circuit.nqubits} basis states is too many to give each its own symbol`
    : 'give every basis state its own unknown amplitude';

  const big = circuit.nqubits > 10;
  const treeOption = $('view').querySelector('option[value="tree"]');
  treeOption.disabled = big;
  treeOption.textContent = big ? 'full tree (too many qubits)' : 'full tree';
  resetCanvas();
  renderCircuit();
  setFrame(app.index);
  save();
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
  const contentW = Math.max(5, app.layout.width) * slotW;
  const originX = gutter + slotW / 2;
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
    t.textContent = app.circuit.qubits[lev].label;
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

  // Most amplitudes print in a familiar form, but a genuine eighth root of unity has to
  // be shown as a power of w, and nothing else on screen says what w is. Shown only on
  // the frames where it actually appears, so it is a footnote rather than clutter.
  const omega = svgEl('text', { class: 'gutter legend-cap', x: lx + 16, y: ly });
  const sup = svgEl('tspan', { dy: -4, 'font-size': 8 });
  sup.textContent = 'iπ/4';
  omega.append('ω = e', sup);
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

/** The scale at which the whole diagram is visible at once. */
function fitScale() {
  const box = $('canvas');
  const { W, H } = app.geom;
  const raw = Math.min((box.clientWidth - 16) / W, (box.clientHeight - 16) / H);
  return Math.max(SCALE_RANGE[0], Math.min(raw || 1, SCALE_RANGE[1]));
}

/** Apply the current zoom — either the fitted scale or an explicit one. */
function fitCanvas() {
  if (!app.svg || !app.geom) return;
  const { W, H } = app.geom;
  const scale = app.zoom === 'fit' ? fitScale() : app.zoom;
  app.scale = scale;
  app.svg.style.width = `${Math.round(W * scale)}px`;
  app.svg.style.height = `${Math.round(H * scale)}px`;
  $('zoomLevel').textContent = app.zoom === 'fit' ? 'fit' : `${Math.round(scale * 100)}%`;
  updateSticky();
}

/** Hold the gutter labels at the left edge of the view while the plate scrolls under them. */
function updateSticky() {
  if (!app.sticky) return;
  const dx = $('canvas').scrollLeft / (app.scale || 1);
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
  const before = app.scale;
  app.zoom = next === 'fit' ? 'fit' : Math.max(ZOOM_RANGE[0], Math.min(next, ZOOM_RANGE[1]));
  const rect = app.svg.getBoundingClientRect();
  const ax = clientX === undefined ? rect.left + rect.width / 2 : clientX;
  const ay = clientY === undefined ? rect.top + rect.height / 2 : clientY;
  const contentX = (ax - rect.left) / before;
  const contentY = (ay - rect.top) / before;
  fitCanvas();
  box.scrollLeft += contentX * (app.scale - before);
  box.scrollTop += contentY * (app.scale - before);
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
 * @param {boolean} spread the node's two edges land on the same target, so pull them
 *   apart at the far end too — otherwise they coincide and read as one edge. Common in
 *   the edge-valued form, where children often differ only by their weights.
 */
function edgePath(from, to, high, spread) {
  const x1 = xOf(from) + (high ? 6 : -6);
  const y1 = nodeAnchor(from, false);
  const x2 = xOf(to) + (spread ? (high ? 6 : -6) : 0);
  const y2 = nodeAnchor(to, true);
  const bend = (y2 - y1) * 0.42;
  return `M${x1},${y1} C${x1},${y1 + bend} ${x2},${y2 - bend} ${x2},${y2}`;
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
  }
  renderReadout(f);
  renderStats(f);
}

function drawFrame(f) {
  const pos = new Map(f.nodes.map((n) => [n.id, n]));

  // Mark the qubits this gate acted on. Without it the score strip says "CX q[0] q[1]"
  // and the reader has to find those levels by counting.
  const touched = new Set(f.gate ? f.gate.qubits : []);
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

  app.omegaNote.style.display =
    f.nodes.some((nd) => nd.terminal && nd.label.includes('ω')) ? '' : 'none';
  const tupleMode = app.ampFormat === 'tuple';
  app.tupleNote.style.display = tupleMode ? '' : 'none';
  if (tupleMode) {
    app.tupleNote.replaceChildren(`(a,b,c,d) = aω³+bω²+cω+d, over √2`);
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
  const from = pos.get(e.from);
  const to = pos.get(e.to);
  const off = e.high ? 6 : -6;
  const x = (xOf(from) + off + xOf(to) + (spread ? off : 0)) / 2;
  const y = (nodeAnchor(from, false) + nodeAnchor(to, true)) / 2;
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
    coef.textContent = P.format(value, app.ampFormat, { k: app.commonK[f.index] });
    const ket = document.createElement('span');
    ket.className = 'amp-ket';
    ket.textContent = `|${path}⟩`;
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
  if (f.index > 0 && app.view === 'tree' && f.changed) {
    // An unreduced tree never changes shape, so the leaves are the only news.
    parts.push(`<span class="delta">${f.changed} amplitude${f.changed === 1 ? '' : 's'} changed</span>`);
  }
  parts.push(norm === null ? 'symbolic' : `‖ψ‖² = ${norm.toFixed(4).replace(/0+$/, '0')}`);
  $('stats').innerHTML = parts.join(' · ');
  $('stats').title = app.view === 'tree'
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
    'Only angles that are multiples of π/4, which is exactly when the phase stays exact. '
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

  body.append(el('h3', null, 'Refused, and why'));
  body.append(helpTable([
    ['rx(0.3) q[0];', 'an arbitrary rotation leaves the exact ring, so it cannot be represented'],
    ['u1(pi/3) q[0];', 'the same reason: π/3 is not a multiple of π/4'],
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

function permalink() {
  const p = new URLSearchParams();
  p.set('c', encodeText($('qasm').value));
  p.set('s', encodeText($('stateText').value));
  if (app.index) p.set('i', String(app.index));
  if (app.view !== 'reduced') p.set('t', app.view === 'tree' ? '1' : 'e');
  if (app.hideZero) p.set('z', '1');
  if (app.ampFormat !== 'exact') p.set('f', app.ampFormat);
  return `${location.href.split('#')[0]}#${p}`;
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
  app.view = { 1: 'tree', e: 'edge-valued' }[p.get('t')] || 'reduced';
  app.hideZero = p.get('z') === '1';
  const f = normaliseFormat(p.get('f'));
  if (AMP_FORMATS.includes(f) && f !== 'exact') app.ampFormat = f;
  $('view').value = app.view;
  $('hideZero').checked = app.hideZero;
  $('ampFormat').value = app.ampFormat;
  app.index = Math.max(0, parseInt(p.get('i') || '0', 10) || 0);
  const match = EXAMPLES.findIndex((ex) => ex.qasm === $('qasm').value && ex.state === $('stateText').value);
  $('example').value = match >= 0 ? String(match) : '';
  if (match >= 0) $('note').textContent = EXAMPLES[match].note;
  compile();
  setFrame(Math.min(app.index, app.layout.frames.length - 1));
  return true;
}

async function copyPermalink() {
  const url = permalink();
  history.replaceState(null, '', url);   // so the address bar can be copied from too
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

/** 'auto' follows the system; the other two pin it. Kept per viewer, not in the file. */
function applyTheme(name) {
  app.theme = name;
  if (name === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', name);
  $('theme').textContent = name;
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

function useExample(i) {
  const ex = EXAMPLES[i];
  $('qasm').value = ex.qasm;
  $('stateText').value = ex.state;
  $('note').textContent = ex.note;
  app.index = 0;
  compile();
}

export function boot() {
  new ResizeObserver(fitCanvas).observe($('canvas'));
  $('canvas').addEventListener('scroll', updateSticky, { passive: true });
  const picker = $('example');
  // A blank entry so the picker can stop claiming to show an example once the text has
  // been edited into something else.
  picker.append(new Option('custom', ''));
  EXAMPLES.forEach((ex, i) => picker.append(new Option(ex.name, String(i))));
  picker.addEventListener('change', () => { if (picker.value !== '') useExample(+picker.value); });

  let timer = null;
  const onEdit = () => {
    clearTimeout(timer);
    stop();
    picker.value = '';
    $('note').textContent = '';
    timer = setTimeout(compile, 350);
  };
  $('qasm').addEventListener('input', onEdit);
  $('stateText').addEventListener('input', onEdit);

  $('prev').addEventListener('click', () => { stop(); step(-1); });
  $('next').addEventListener('click', () => { stop(); step(1); });
  $('play').addEventListener('click', play);
  $('export').addEventListener('click', exportSvg);
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
    app.view = e.target.value;
    compile();
  });
  $('hideZero').addEventListener('change', (e) => {
    app.hideZero = e.target.checked;
    // Only a redraw: hiding the sink changes nothing about where anything sits, so
    // rebuilding the plate would make every node re-enter for no reason.
    drawFrame(app.layout.frames[app.index]);
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'TEXTAREA' || e.metaKey || e.ctrlKey) return;
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
    const match = EXAMPLES.findIndex((ex) => ex.qasm === saved.qasm && ex.state === saved.state);
    picker.value = match >= 0 ? String(match) : '';
    if (match >= 0) $('note').textContent = EXAMPLES[match].note;
    compile();
  } else {
    picker.value = '0';
    useExample(0);
  }
}
