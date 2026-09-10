// The circuit, in standard notation — shared by both pages this repository builds.
//
// A wire per qubit, a column per gate, filled dots for controls, a crossed circle for the
// target of an X, crossings for a swap, a box for everything else. One column per gate
// rather than the usual packing of independent gates into a shared moment, because a
// column here is also a step of the animation and the two must agree.
//
// It knows nothing about what it is drawing *for*: no diagram, no automaton, no state. It
// takes a parsed circuit and a callback, and returns elements.

const SVG_NS = 'http://www.w3.org/2000/svg';

/** An SVG element with attributes, since createElementNS takes neither. */
export const svgEl = (name, attrs = {}) => {
  const e = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};


const CIRC = { rowH: 26, colW: 30, padY: 12, dot: 3.2, notR: 6.5, boxW: 21, boxH: 17 };

/** How wide the box around a gate's cap has to be. */
const capWidth = (symbol) => Math.max(CIRC.boxW, symbol.length * 7 + 8);

/**
 * Draw a circuit, and hand back the click targets so the caller can decide what a column
 * means. Both pages this repository builds show the same circuit the same way; only what
 * happens when you pick a column differs, so that is the one thing passed in.
 *
 * @param {object} circuit as `parseQasm` returns it
 * @param {(step: number) => void} onPick called with the gate index a column stands for,
 *   or -1 for the column before any gate
 * @returns {{svg: SVGElement, columns: SVGElement[]}} the drawing, and one transparent
 *   strip per step in step order, for the caller to highlight as it likes
 */
export function circuitStrip(circuit, onPick) {
  const n = circuit.nqubits;
  const gates = circuit.gates;
  const gutter = Math.max(44, Math.round(Math.max(...circuit.qubits.map((q) => q.label.length)) * 6.4) + 16);
  const H = CIRC.padY * 2 + n * CIRC.rowH;
  const wireY = (q) => CIRC.padY + CIRC.rowH * (q + 0.5);

  // Columns are only as wide as what they hold. A fixed width was enough while the widest
  // cap was 'S†'; a rotation writes its angle in the box, so 'U(π/2,0,π)' is three times
  // that and the boxes overlapped. Widening every column to the widest would push a long
  // circuit off the plate for the sake of one gate, so each is measured on its own.
  const boxWidth = (g) => {
    const draw = g.draw || { controls: 0, target: 'box', symbol: g.label };
    if (draw.target !== 'box') return CIRC.colW;
    return Math.max(CIRC.colW, capWidth(draw.symbol || g.label) + 6);
  };
  const widths = [CIRC.colW, ...gates.map(boxWidth)];   // column -1 is the input state
  const starts = [];
  let edge = gutter;
  for (const w of widths) { starts.push(edge); edge += w; }
  const W = edge + 10;
  const colX = (i) => starts[i + 1] + widths[i + 1] / 2;
  const colLeft = (i) => (i + 1 < starts.length ? starts[i + 1] : edge);

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
      class: 'barrier-mark', x1: colLeft(b), y1: CIRC.padY - 2,
      x2: colLeft(b), y2: H - CIRC.padY + 2,
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
        const w = capWidth(symbol);
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
  const columns = [];
  for (let i = -1; i < gates.length; i++) {
    const strip = svgEl('rect', {
      class: 'col', x: colLeft(i), y: 0, width: widths[i + 1], height: H,
    });
    strip.append(svgEl('title'));
    strip.querySelector('title').textContent = i < 0
      ? 'the input state, before any gate'
      : `step ${i + 1}: ${gates[i].label} on ${gates[i].qubits.map((q) => circuit.qubits[q].label).join(', ')}`;
    strip.addEventListener('click', () => onPick(i));
    strips.append(strip);
    columns.push(strip);
  }

  return { svg, columns };
}
