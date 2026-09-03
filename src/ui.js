// The browser front end. Everything below this line touches the DOM; everything above
// it in the module graph runs headless and is tested that way.

import { MTBDD } from './dd.js';
import * as P from './poly.js';
import { simulate } from './sim.js';
import { parseQasm } from './qasm.js';
import { parseState, buildState, squaredNorm } from './state.js';
import { layoutFrames } from './layout.js';
import { EXAMPLES } from './examples.js';

const GEO = { gutter: 72, padTop: 46, levelH: 64, slotW: 82, r: 9, termH: 23, pad: 30 };
// Small diagrams are magnified, large ones shrunk, but never past these limits. The floor
// "Fit" really fits, however wide the diagram: it is the overview, and zooming is how you
// read the detail. The ceiling stops a two-node diagram from being blown up absurdly.
const SCALE_RANGE = [0.12, 1.5];
const ZOOM_RANGE = [0.15, 8];
const ZOOM_STEP = 1.25;
const BAND_LABEL = 'AMPLITUDE';
const MAX_DRAWN_NODES = 800;
const MAX_READOUT_LINES = 14;
const PLAY_MS = 750;
const SVG_NS = 'http://www.w3.org/2000/svg';

const app = {
  dd: null,
  circuit: null,
  frames: [],
  layout: null,
  index: 0,
  playing: false,
  timer: null,
  hideZero: false,
  expand: false,
  theme: 'auto',
  zoom: 'fit',
  scale: 1,
  nodeEls: new Map(),
  edgeEls: new Map(),
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
  app.layout = layoutFrames(dd, frames, {
    qubitLabels: circuit.qubits.map((q) => q.label),
    expand: app.expand,
  });
  app.index = Math.min(app.index, frames.length - 1);

  $('error').textContent = '';
  app.zoom = 'fit';
  // The unreduced tree has 2^(n+1)-1 nodes, so past a handful of qubits it is neither
  // drawable nor informative.
  const big = circuit.nqubits > 10;
  $('expand').disabled = big;
  $('expand').closest('label').title = big
    ? `the full tree for ${circuit.nqubits} qubits has ${2 ** (circuit.nqubits + 1) - 1} nodes`
    : 'draw the same state without sharing or skipped levels';
  resetCanvas();
  renderScore();
  setFrame(app.index);
  save();
}

function fail(e, where) {
  stop();
  $('error').textContent = `${where === 'state' ? 'input state' : 'circuit'} — ${e.message}`;
}

// ---- the score strip ----------------------------------------------------

function renderScore() {
  const score = $('score');
  score.replaceChildren();
  const barriers = new Set(app.circuit.barriers);
  app.layout.frames.forEach((f, i) => {
    const b = document.createElement('button');
    b.className = 'step' + (i === 0 ? ' input' : '') + (barriers.has(i) ? ' divider' : '');
    b.type = 'button';
    b.dataset.index = i;
    const op = document.createElement('span');
    op.className = 'op';
    op.textContent = f.gate ? f.gate.label : 'input';
    const args = document.createElement('span');
    args.className = 'args';
    args.textContent = f.gate ? f.gate.qubits.map((q) => app.circuit.qubits[q].label).join(' ') : 'state';
    b.append(op, args);
    b.addEventListener('click', () => { stop(); setFrame(i); });
    score.append(b);
  });
}

// ---- the plate ----------------------------------------------------------

function resetCanvas() {
  app.nodeEls.clear();
  app.edgeEls.clear();
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
  app.ruleEls = new Map();
  for (let lev = 0; lev < n; lev++) {
    const y = yOf(lev);
    const line = svgEl('line', { class: 'level-rule', x1: gutter - 6, y1: y, x2: W - 8, y2: y });
    const t = svgEl('text', { class: 'gutter', x: gutter - 16, y });
    t.textContent = app.circuit.qubits[lev].label;
    rules.append(line, t);
    app.ruleEls.set(lev, [line, t]);   // marked per frame with the current gate's qubits
  }
  // The terminal row is a different kind of thing: give it a solid rule of its own.
  const bandY = yOf(n) - GEO.levelH / 2;
  rules.append(svgEl('line', { class: 'band-rule', x1: gutter - 6, y1: bandY, x2: W - 8, y2: bandY }));
  const bt = svgEl('text', { class: 'gutter band', x: gutter - 16, y: yOf(n) });
  bt.textContent = BAND_LABEL;
  rules.append(bt);

  // Which line is dashed and which is solid is the one convention a reader cannot guess,
  // so the plate states it. Drawn with the same classes as real edges, so it survives
  // into an exported SVG and always matches what the diagram above it is doing.
  const ly = H - 13;
  const lc = svgEl('text', { class: 'gutter band', x: gutter - 16, y: ly });
  lc.textContent = 'EDGE';
  rules.append(lc);
  let lx = gutter - 6;
  for (const [kind, value] of [['low', '0'], ['high', '1']]) {
    rules.append(svgEl('path', { class: `edge ${kind}`, d: `M${lx},${ly} L${lx + 18},${ly}` }));
    const cap = svgEl('text', { class: 'gutter legend-cap', x: lx + 24, y: ly });
    cap.textContent = value;
    rules.append(cap);
    lx += 48;
  }

  // Most amplitudes print in a familiar form, but a genuine eighth root of unity has to
  // be shown as a power of w, and nothing else on screen says what w is. Shown only on
  // the frames where it actually appears, so it is a footnote rather than clutter.
  const omega = svgEl('text', { class: 'gutter legend-cap', x: lx + 16, y: ly });
  const sup = svgEl('tspan', { dy: -4, 'font-size': 8 });
  sup.textContent = 'iπ/4';
  omega.append('ω = e', sup);
  rules.append(omega);
  app.omegaNote = omega;

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
  app.rootMarker = marker;

  svg.append(rules, svgEl('g', { class: 'edges' }), marker, svgEl('g', { class: 'nodes' }));
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

function edgePath(from, to, high) {
  const x1 = xOf(from) + (high ? 6 : -6);
  const y1 = nodeAnchor(from, false);
  const x2 = xOf(to);
  const y2 = nodeAnchor(to, true);
  const bend = (y2 - y1) * 0.42;
  return `M${x1},${y1} C${x1},${y1 + bend} ${x2},${y2 - bend} ${x2},${y2}`;
}

function setFrame(i) {
  app.index = i;
  const f = app.layout.frames[i];

  for (const el of $('score').children) el.setAttribute('aria-current', String(+el.dataset.index === i));
  const cur = $('score').children[i];
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

  const hidden = (node) => app.hideZero && node.zero;
  const wantEdges = new Map();
  for (const e of f.edges) {
    if (hidden(pos.get(e.to))) continue;
    wantEdges.set(edgeKey(e), e);
  }
  for (const [k, el] of app.edgeEls) {
    if (!wantEdges.has(k)) { el.remove(); app.edgeEls.delete(k); }
  }
  for (const [k, e] of wantEdges) {
    let el = app.edgeEls.get(k);
    if (!el) {
      el = svgEl('path', { class: 'edge' });
      app.edgeEls.set(k, el);
      edgesG.append(el);
    }
    el.setAttribute('d', edgePath(pos.get(e.from), pos.get(e.to), e.high));
    el.setAttribute('class', 'edge' + (e.high ? ' high' : ' low') +
      (e.toZero ? ' to-zero' : '') + (pos.get(e.from).fresh ? ' fresh' : ''));
  }

  for (const [id, el] of app.nodeEls) {
    if ((pos.has(id) && !hidden(pos.get(id))) || app.exiting.has(id)) continue;
    el.classList.add('leaving');
    app.exiting.set(id, setTimeout(() => {
      el.remove();
      app.nodeEls.delete(id);
      app.exiting.delete(id);
    }, 300));
  }

  app.omegaNote.style.display =
    f.nodes.some((nd) => nd.terminal && nd.label.includes('ω')) ? '' : 'none';

  const rootNode = pos.get(f.root);
  app.rootMarker.setAttribute('transform', `translate(${xOf(rootNode)},${yOf(rootNode.level)})`);
  // A state that is zero everywhere hides its own root; the arrow must not outlive it.
  app.rootMarker.style.display = hidden(rootNode) ? 'none' : '';

  for (const node of f.nodes) {
    if (hidden(node)) continue;
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
    coef.textContent = P.format(value);
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
  if (f.index > 0) {
    if (app.expand && f.changed) {
      // An unreduced tree never changes shape, so the only news is which amplitudes moved.
      parts.push(`<span class="delta">${f.changed} amplitude${f.changed === 1 ? '' : 's'} changed</span>`);
    } else if (!app.expand && (frame.added.length || frame.removed.length)) {
      parts.push(`<span class="delta">+${frame.added.length} −${frame.removed.length}</span>`);
    }
  }
  parts.push(norm === null ? 'symbolic' : `‖ψ‖² = ${norm.toFixed(4).replace(/0+$/, '0')}`);
  $('stats').innerHTML = parts.join(' · ');
  $('position').textContent = `${f.index} / ${app.layout.frames.length - 1}`;
  $('prev').disabled = f.index === 0;
  $('next').disabled = f.index === app.layout.frames.length - 1;
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
  const style = document.createElementNS(SVG_NS, 'style');
  style.textContent = `
    svg { background: ${v('--plate')} }
    .level-rule { stroke: ${v('--rule-soft')}; stroke-width: 1; stroke-dasharray: 1 5 }
    .band-rule { stroke: ${v('--rule')}; stroke-width: 1 }
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

const STORE = 'quantum-vis:v1';
const THEME_STORE = 'quantum-vis:theme';
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
  $('expand').addEventListener('change', (e) => {
    app.expand = e.target.checked;
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
