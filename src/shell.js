// Panels you can resize: the column beside the plate, and the boundaries within it.
//
// Lifted out of `ui.js` unchanged, because a second page wanted the same behaviour and
// the alternative was a second copy of two hundred and fifty lines that had already been
// got right once. What the two pages do not share is which panels they have, so that is
// all `armPanels` asks for: where to keep the layout, whose heights to remember, which
// folds to remember, and what to call when something moved.
//
// It reaches for `#inputs` and the splitters by class, as the shell's own landmarks —
// the same names both pages' markup uses, and the same ones `app.css` styles.

const COL_MIN = 220;
const PANEL_MIN = 64;

/** Set by `armPanels`; the page's own answers to the questions above. */
let page = { store: 'q-vis.layout', sized: [], folds: [], onResize: () => {} };

const $ = (id) => document.getElementById(id);

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

/**
 * Measure how tall a panel would be if nothing held it back — content, padding, borders,
 * and the horizontal scrollbar if it has one — and remember the answer on the element.
 *
 * The measurement has to let the panel go first. `scrollHeight` is floored at the box's
 * own height, so a panel already taller than what it holds reports its own height, and a
 * cap taken from that is the height it already had: the reading would confirm whatever it
 * was asked to correct. Releasing the basis and the cap for the length of the measurement
 * is what makes the number about the content.
 *
 * Remembered because that release forces a layout, and a drag asks on every pointer move.
 * What it holds changes when the page redraws it, and `refit` is what the page calls then.
 */
function measureFit(el) {
  const { flex, maxHeight } = el.style;
  el.style.flex = '0 0 auto';
  el.style.maxHeight = 'none';
  const h = el.scrollHeight + (el.offsetHeight - el.clientHeight);
  el.style.flex = flex;
  el.style.maxHeight = maxHeight;
  el.dataset.fitAt = String(h);
  return h;
}

/** The remembered cap, measured now if nothing has measured it yet. */
const fitCap = (el) => Number(el.dataset.fitAt) || measureFit(el);

function setPanelHeight(panel, px) {
  const min = Number(panel.dataset.min) || PANEL_MIN;
  const h = Math.round(Math.max(min, px));
  // Shrink 1, not 0: a dragged panel keeps the height it was given while the column has
  // room for it, and gives way when it does not. With shrink 0 the panels below were
  // simply pushed out of the column — on a short window the folded Amplitudes bar ended
  // up drawn over the transport.
  panel.style.flex = `0 1 ${h}px`;
  // The circuit strip is capped by a max-height until someone drags it, and an explicit
  // height has to beat that cap or the drag would stop dead at 190px. `data-fit` asks for
  // a different cap rather than for none: a panel holding a drawing has nothing to gain
  // from being taller than the drawing, and every pixel past it is blank paper taken off
  // whatever is below. A panel holding text is not capped — a box taller than what is
  // typed in it is room to type.
  panel.style.maxHeight = 'fit' in panel.dataset ? `${fitCap(panel)}px` : 'none';
  return h;
}

/**
 * Recompute the content caps, for when what a panel holds has changed underneath it.
 *
 * The cap is a `max-height` rather than a smaller `flex-basis` so that the height the
 * reader dragged to survives a circuit that is too short to need it: a two-qubit strip is
 * two qubits tall, and the twelve-qubit one after it is back to whatever it was dragged
 * to. Only an explicitly sized panel has a cap to recompute — one left to the stylesheet
 * is already exactly as tall as what it holds.
 */
export function refit() {
  let moved = false;
  for (const el of document.querySelectorAll('[data-fit]')) {
    const want = `${measureFit(el)}px`;
    // A panel left to the stylesheet is already exactly as tall as what it holds; only
    // one carrying a dragged height has a cap that could now be the wrong one.
    if (!/\d+px/.test(el.style.flex || '')) continue;
    if (el.style.maxHeight === want) continue;
    el.style.maxHeight = want;
    moved = true;
  }
  if (moved) page.onResize();
}

/** A panel's own floor, whatever set it: the drag minimum or the stylesheet's. */
function panelFloor(panel) {
  const css = parseFloat(getComputedStyle(panel).minHeight);
  return Math.max(Number(panel.dataset.min) || PANEL_MIN, Number.isFinite(css) ? css : 0);
}

/**
 * Freeze a column so that moving one divider moves one boundary, and report the pair of
 * panels the divider sits between.
 *
 * Flex does not do this on its own: every panel with a grow factor takes a share of
 * whatever the dragged panel gives up. Both the Circuit panel and an open Amplitudes
 * panel grow, so dragging the divider above Amplitudes resized the *Circuit* panel by
 * half the movement and Amplitudes by the other half — the reader grabs one boundary and
 * watches a different one move.
 *
 * So every other panel is pinned where it is, and the two either side of the divider are
 * then set explicitly by the drag, keeping their sum. Leaving the difference to flex does
 * not work even with the rest pinned: the absorbing panel needs a basis, and `auto` means
 * its *content* height rather than where it is actually sitting, so the column jumped the
 * moment a drag began.
 *
 * Returns null when there is nothing to trade with — a folded fold is only its own header
 * — and the drag then falls back to sizing the panel above on its own.
 */
function pinColumn(el) {
  if (!el.parentElement.classList.contains('inputs')) return null;
  const below = el.nextElementSibling;
  const above = el.previousElementSibling;
  if (!below || !above || (below.tagName === 'DETAILS' && !below.open)) return null;
  for (const panel of el.parentElement.children) {
    if (panel === below || panel === above || !panel.classList.contains('panel')) continue;
    panel.style.flex = `0 1 ${Math.round(panel.getBoundingClientRect().height)}px`;
    panel.style.maxHeight = 'none';
  }
  const top = above.getBoundingClientRect().height;
  const bottom = below.getBoundingClientRect().height;
  return {
    above, below, sum: top + bottom, lo: panelFloor(above), hi: top + bottom - panelFloor(below),
  };
}

/**
 * Make sure something in the column takes the leftover, or the panels stop short of the
 * bottom and the column ends in dead space. That is what folding Amplitudes did once
 * anything had been dragged: a drag gives a panel an exact height and no appetite for
 * more, so with the fold shut nothing was left that wanted the room.
 *
 * The bottom-most panel that is not a folded fold takes it. Its lower edge is the column's
 * own, so growing it is the only change that does not move a boundary the reader placed.
 * Nothing is taken away from a panel that already grows — by default the Circuit panel
 * does, and that is the layout the tool opens with.
 */
function fillColumn() {
  const panels = [...$('inputs').children].filter((e) => e.classList.contains('panel'));
  const sized = (p) => /\d+px/.test(p.style.flex || '');
  const appetite = (p, grow) => {
    p.style.flex = sized(p) ? p.style.flex.replace(/^\S+/, grow) : (grow === '1' ? '1 1 auto' : p.dataset.flex || '');
  };
  // Whoever was filling last time stops, so the choice below is made afresh rather than
  // against a panel that is already growing because of it.
  for (const p of panels) {
    if (p.dataset.filler === undefined) continue;
    delete p.dataset.filler;
    appetite(p, '0');
  }
  if (panels.some((p) => parseFloat(getComputedStyle(p).flexGrow) > 0)) return;
  const open = panels.filter((p) => !(p.tagName === 'DETAILS' && !p.open));
  const filler = open[open.length - 1];
  if (!filler) return;
  filler.dataset.filler = '1';
  appetite(filler, '1');
}

/** Put the boundary `pair` describes at `px`, as far as the two panels' floors allow. */
function setBoundary(pair, px) {
  const h = Math.round(Math.min(Math.max(px, pair.lo), Math.max(pair.lo, pair.hi)));
  setPanelHeight(pair.above, h);
  setPanelHeight(pair.below, pair.sum - h);
}

/** What the panels are doing now, as something small enough to store. */
function layoutState() {
  const col = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--col'), 10);
  const heights = {};
  for (const id of page.sized) {
    const m = /(\d+)px/.exec($(id)?.style.flex || '');
    if (m) heights[id] = +m[1];
  }
  // Which panels are folded is the reader's own choice, so it is kept like a size.
  const folded = {};
  for (const id of page.folds) if ($(id)) folded[id] = !$(id).open;
  return { col, heights, folded };
}

export function saveLayout() {
  try { localStorage.setItem(page.store, JSON.stringify(layoutState())); }
  catch { /* private windows are fine; the layout is just not remembered */ }
}

function loadLayout() {
  let v;
  try { v = JSON.parse(localStorage.getItem(page.store) || 'null'); } catch { return; }
  if (!v) return;
  if (Number.isFinite(v.col)) setColumn(v.col);
  for (const [id, h] of Object.entries(v.heights || {})) {
    if ($(id) && Number.isFinite(h)) setPanelHeight($(id), h);
  }
  for (const [id, shut] of Object.entries(v.folded || {})) {
    if ($(id)) $(id).open = !shut;
  }
  fillColumn();
}

/**
 * Put a boundary back the way it started. What "the way it started" is belongs to the
 * element rather than to this function, so each one that had a flex of its own says so in
 * `data-flex` and the rest go back to being sized by their content.
 */
function resetSplit(el) {
  if (el.id === 'vsplit') {
    document.documentElement.style.removeProperty('--col');
  } else if (el.parentElement.classList.contains('inputs')) {
    // Dragging pins the rest of the column, so evening out means releasing all of it —
    // putting one panel back while its neighbours stay pinned is not a layout anyone asked
    // for. Each panel that had a flex of its own says so in `data-flex`.
    for (const panel of el.parentElement.children) {
      if (!panel.classList.contains('panel')) continue;
      panel.style.flex = panel.dataset.flex || '';
      panel.style.maxHeight = '';
      delete panel.dataset.filler;
    }
    fillColumn();
  } else {
    const target = el.previousElementSibling;
    target.style.flex = target.dataset.flex || '';
    target.style.maxHeight = '';
  }
  saveLayout();
  page.onResize();
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
  let pair = null;
  let live = false;

  const move = (e) => {
    if (!live) return;
    const delta = (vertical ? e.clientX : e.clientY) - start;
    if (vertical) setColumn(base + delta);
    else if (pair) setBoundary(pair, base + delta);
    else setPanelHeight(el.previousElementSibling, base + delta);
    page.onResize();
  };

  const finish = () => {
    if (!live) return;
    live = false;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', finish);
    document.body.classList.remove('dragging');
    document.body.style.cursor = '';
    fillColumn();
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
    pair = vertical ? null : pinColumn(el);
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
      const pair = pinColumn(el);
      const panel = el.previousElementSibling;
      const now = panel.getBoundingClientRect().height;
      if (pair) setBoundary(pair, now + keys[e.key]);
      else setPanelHeight(panel, now + keys[e.key]);
    }
    fillColumn();
    saveLayout();
    page.onResize();
  });
}

/**
 * Make a page's panels draggable, and put back the layout it was left in.
 *
 * @param {object} opts
 * @param {string} opts.store       where to keep the layout for this page
 * @param {string[]} opts.sized     ids whose dragged height is worth remembering
 * @param {string[]} [opts.folds]   ids of foldable panels whose open state is remembered
 * @param {() => void} [opts.onResize] run after anything moves — a plate that fits its
 *   box has to be told the box changed
 */
export function armPanels({ store, sized, folds = [], onResize = () => {} }) {
  page = { store, sized, folds, onResize };
  for (const el of document.querySelectorAll('.vsplit, .hsplit, .psplit')) armSplitter(el);
  for (const el of document.querySelectorAll('.panel.foldable')) {
    el.addEventListener('toggle', () => {
      // A drag leaves an explicit height behind, and it would otherwise survive the fold
      // and hold a folded panel open over an empty box. Folded and open sizing belongs to
      // the stylesheet, so give it back.
      el.style.flex = '';
      el.style.maxHeight = '';
      delete el.dataset.filler;
      fillColumn();
      saveLayout();
    });
  }
  loadLayout();
}

// ---- the dialog ----------------------------------------------------------
//
// One dialog per page, and everything worth reading before it is taken goes through it:
// a TikZ figure, an automaton's specification, a tableau. It is here rather than on
// either page because both wanted it and neither wanted a copy.

/** What the copy button would take — the text, even when what is shown is drawn. */
let code = '';

/** Text worth reading before it is taken. */
export function showCode(title, text) {
  code = text;
  $('codeTitle').textContent = title;
  $('codeBody').textContent = text;
  $('codeBody').hidden = false;
  if ($('codeRich')) $('codeRich').hidden = true;
  $('codeBody').scrollTop = 0;
  $('codeDialog').showModal();
}

/** The same dialog, showing something drawn. `text` is what the copy button takes. */
export function showRich(title, node, text) {
  code = text;
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
    await navigator.clipboard.writeText(code || '');
  } catch {
    ok = false;   // no permission, or an insecure context such as file://
  }
  button.textContent = ok ? 'copied' : 'select and copy';
  setTimeout(() => { button.textContent = 'copy'; }, 1800);
}

/** Wire the dialog's own buttons, and the backdrop, which is the dialog outside its box. */
export function armDialog() {
  $('codeCopy').addEventListener('click', copyCode);
  $('codeClose').addEventListener('click', () => $('codeDialog').close());
  $('codeDialog').addEventListener('click', (e) => {
    if (e.target === $('codeDialog')) $('codeDialog').close();
  });
}
