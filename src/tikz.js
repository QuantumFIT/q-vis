// TikZ output: the circuit as quantikz, the diagram as nodes and paths.
//
// An SVG is the wrong thing to put in a paper. It arrives as a foreign object with its own
// fonts at a size nobody controls, and it cannot be edited afterwards. TikZ arrives as
// text in the document's own fonts, and a reader who wants the arrow somewhere else can
// move it.
//
// Everything here is a pure function of the layout and the circuit — no DOM, no SVG — so
// it is testable in Node like the rest of the engine, and the output can be handed to
// pdflatex rather than eyeballed.

// ---- Unicode to LaTeX ----------------------------------------------------
//
// The labels in a layout are already formatted, in whichever amplitude notation is on
// screen: "1/√2", "ω²¹", "-I⊗Z⊗I", "0.7071∠45°". Rather than thread a second formatting
// mode through the whole layout, they are transliterated here. The map is total over what
// the formatters can actually emit — see tests/tikz.test.js, which sweeps every example in
// every notation in every view and asserts that nothing gets through unrecognised.

const LATEX = {
  ω: '\\omega',
  π: '\\pi',
  ψ: '\\psi',
  '∠': '\\angle',
  '°': '^\\circ',
  '·': '\\cdot',
  '⊗': '\\otimes',
  '†': '^\\dagger',
  '⟩': '\\rangle',
  '⟨': '\\langle',
  '‖': '\\|',
  '−': '-',
  '×': '\\times',
  '…': '\\dots',
};

const SUPERSCRIPT = {
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4',
  '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
};

/** ASCII that means something else to LaTeX. */
const ESCAPED = {
  _: '\\_', '#': '\\#', '%': '\\%', '&': '\\&', $: '\\$',
  '{': '\\{', '}': '\\}', '~': '\\sim{}', '^': '\\hat{}', '\\': '\\backslash{}',
};

/**
 * One formatted label as LaTeX, for use inside math mode.
 *
 * A character this has not been told about becomes `?`. That is deliberate: a visible
 * question mark in the output is a bug report, where a stray Unicode byte would be a
 * LaTeX error in someone else's document days later.
 */
export function toLatex(text) {
  const s = String(text ?? '');
  let out = '';
  // A control sequence ends where its name ends, so `\otimes` followed by `Z` is read as
  // one undefined `\otimesZ`. Anything appended after a word-shaped command gets a space
  // when it would otherwise be swallowed.
  const push = (piece) => {
    if (/\\[A-Za-z]+$/.test(out) && /^[A-Za-z]/.test(piece)) out += ' ';
    out += piece;
  };

  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '√') {
      // The radical binds to the run that follows, so √2 and √X are each one radical.
      let j = i + 1;
      while (j < s.length && /[0-9A-Za-z]/.test(s[j])) j++;
      push(`\\sqrt{${s.slice(i + 1, j)}}`);
      i = j;
    } else if (SUPERSCRIPT[ch]) {
      // A run of superscript digits is one exponent: ω²¹ is omega to the twenty-first.
      let digits = '';
      while (i < s.length && SUPERSCRIPT[s[i]]) { digits += SUPERSCRIPT[s[i]]; i++; }
      push(`^{${digits}}`);
    } else if (LATEX[ch]) {
      push(LATEX[ch]);
      i++;
    } else if (ESCAPED[ch]) {
      push(ESCAPED[ch]);
      i++;
    } else {
      const code = ch.charCodeAt(0);
      push(code >= 32 && code <= 126 ? ch : '?');
      i++;
    }
  }
  return out;
}

/**
 * An amplitude as LaTeX, set the way a paper sets one: over a rule, not on a slash.
 *
 * `1/√2` and `(1+ω)/(2√2)` are how the plate writes them, because a plate has one line to
 * write on. A figure does not, and a stacked fraction is both the convention and — since
 * it is as wide as its wider half rather than as wide as both halves and a slash — half
 * the width. That is the difference between a row of amplitudes that fits under the
 * diagram and one that spreads it across a page.
 *
 * Only a division at the top level is stacked: `a/(b/c)` would be ambiguous set that way
 * and is left as it was written, which is at worst what this always did.
 */
export function amplitudeLatex(text) {
  const s = String(text ?? '');
  let depth = 0;
  let at = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth += 1;
    else if (s[i] === ')') depth -= 1;
    else if (s[i] === '/' && depth === 0) {
      if (at >= 0) return toLatex(s);            // two of them: not a simple fraction
      at = i;
    }
  }
  if (at <= 0 || at === s.length - 1) return toLatex(s);
  const bare = (part) => (/^\((?:[^()]|\([^()]*\))*\)$/.test(part) ? part.slice(1, -1) : part);
  const top = bare(s.slice(0, at));
  const bottom = bare(s.slice(at + 1));
  if (!top || !bottom || bottom.includes('/')) return toLatex(s);
  return `\\frac{${toLatex(top)}}{${toLatex(bottom)}}`;
}

/** A register label: `q[0]` reads better as a subscript than as brackets. */
export function qubitLatex(label) {
  const m = /^([A-Za-z][A-Za-z0-9_]*)\[(\d+)\]$/.exec(String(label ?? ''));
  return m ? `${toLatex(m[1])}_{${m[2]}}` : toLatex(label);
}

/**
 * The comment block every snippet opens with.
 *
 * `link` is where the figure came from, which is worth carrying: a reader of the paper can
 * open the thing and step through it, and the author can come back to the exact state
 * months later. Two URLs, because they answer different questions and neither substitutes
 * for the other:
 *
 *   - `pinned` is the frozen copy of the build that made the figure. It keeps showing
 *     *this* figure whatever the tool becomes, which is what a printed citation needs.
 *   - `current` is the same view on whatever is current. A reader years later wants the
 *     tool as it is now, and the pinned link alone would never tell them a newer one
 *     exists. Its meaning can drift as the parameter format grows — which is exactly why
 *     the pinned one is there too.
 */
/**
 * The link block. Accepts either of the two URLs on their own, or a plain string, which is
 * read as the pinned one — the only kind that existed before.
 */
function linkLines(link) {
  if (!link) return [];
  const { pinned, current } = typeof link === 'string' ? { pinned: link } : link;
  const out = [];
  if (pinned) out.push('% The view this came from, in the build that made it:', `%   ${pinned}`);
  if (current && current !== pinned) {
    out.push(pinned ? '% The same view in the current version of the tool:' : '% The tool:',
      `%   ${current}`);
  }
  return out;
}

const header = (what, packages, { classOptions = 'border=4pt', link } = {}) => [
  `% ${what}, from q-vis.`,
  ...linkLines(link),
  '%',
  `% Needs \\usepackage{${packages}} in the preamble.`,
  '% To compile this file on its own, uncomment these four lines and the last one:',
  `% \\documentclass[${classOptions}]{standalone}`,
  `% \\usepackage{${packages}}`,
  '% \\begin{document}',
];

const footer = ['% \\end{document}'];

// ---- the circuit ---------------------------------------------------------

/** Columns per stave, so that a long circuit still fits across a page. */
const COLUMNS_PER_STAVE = 32;

/**
 * Cells past which pdflatex's default memory is worth warning about. quantikz is
 * expensive per cell and the limit is on the whole document, so breaking the circuit into
 * staves does not buy any: measured here, 7 x 125 compiles and 9 x 234 does not.
 */
const CELL_BUDGET = 900;

/**
 * The circuit as a quantikz environment: one row per qubit, one column per gate.
 *
 * Written in quantikz v1 style, with the `\qw` spelled out. quantikz2 accepts those too
 * and no longer needs them, so this compiles either way.
 *
 * The vertical connection is the only fiddly part. Taking the rows a gate touches in
 * order, each one gets its own symbol and every row but the last gets a downward offset to
 * the next. `\ctrl` and `\swap` carry that offset themselves; anything else needs `\vqw`.
 * One line through all the involved rows, whatever order the controls and targets are in,
 * and no special case for a gate with three of them.
 */
export function circuitTikz(circuit, opts = {}) {
  const n = circuit.nqubits;
  const rows = Array.from({ length: n }, () => []);

  for (const gate of circuit.gates) {
    const draw = gate.draw || { controls: 0, target: 'box', symbol: gate.label };
    const involved = [...gate.qubits].sort((a, b) => a - b);
    const controls = new Set(gate.qubits.slice(0, draw.controls));
    const targets = gate.qubits.slice(draw.controls);
    // A swap only reads as a swap when it has no decoration to lose. iSWAP and anything
    // else that carries a symbol becomes a box, which cannot be mistaken for the plain one.
    const plainSwap = draw.target === 'swap' && !draw.symbol;
    const symbol = toLatex(draw.symbol || gate.label);

    const cells = new Map();
    involved.forEach((q, index) => {
      const next = involved[index + 1];
      const delta = next === undefined ? null : next - q;
      let cell;
      if (controls.has(q) || (draw.target === 'dot' && targets.includes(q))) {
        cell = delta === null ? '\\control{}' : `\\ctrl{${delta}}`;
      } else if (draw.target === 'not') {
        cell = '\\targ{}';
      } else if (plainSwap) {
        cell = delta === null ? '\\targX{}' : `\\swap{${delta}}`;
      } else {
        cell = `\\gate{${symbol}}`;
      }
      if (delta !== null && !/^\\(ctrl|swap)/.test(cell)) cell += `\\vqw{${delta}}`;
      cells.set(q, cell);
    });

    for (let q = 0; q < n; q++) rows[q].push(cells.get(q) ?? '\\qw');
  }

  // A few hundred columns in one environment exhausts TeX's memory, and would be
  // unreadable at any width anyway. Long circuits are broken into staves, which is how a
  // long circuit is drawn on paper.
  const stave = (from, to) => [
    '\\begin{quantikz}',
    rows.map((cells, q) => {
      const label = qubitLatex(circuit.qubits[q].label);
      const slice = cells.slice(from, to);
      return `  \\lstick{$${label}$} & ${[...slice, '\\qw'].join(' & ')}`;
    }).join(' \\\\\n'),
    '\\end{quantikz}',
  ];

  const columns = rows[0]?.length ?? 0;
  const staves = [];
  for (let from = 0; from < Math.max(1, columns); from += COLUMNS_PER_STAVE) {
    const to = from + COLUMNS_PER_STAVE;
    if (from > 0) staves.push('', `% continued, columns ${from + 1} onwards`);
    staves.push(...stave(from, to));
  }

  return [
    // varwidth so that the staves below stack as paragraphs instead of queueing up in a
    // single line, which is what plain standalone would do with them.
    ...header('Circuit', 'quantikz', { classOptions: 'border=4pt, varwidth', link: opts.link }),
    ...(circuit.barriers.length
      ? ['%', '% Barriers are not drawn: quantikz\'s \\slice would restructure the columns.']
      : []),
    ...(columns > COLUMNS_PER_STAVE
      ? ['%', `% ${columns} gates, so the circuit is broken into staves of `
        + `${COLUMNS_PER_STAVE} columns to fit a page.`]
      : []),
    ...(columns * n > CELL_BUDGET
      ? ['%',
        `% This is ${columns} x ${n} cells, which is a lot to ask of quantikz: pdflatex's`,
        '% default main memory gives out somewhere above a thousand of them, and the limit',
        '% is on the document rather than on one environment, so the staves do not help.',
        '% If it fails to compile, use lualatex, or keep only the staves you need.']
      : []),
    ...staves,
    ...footer,
  ].join('\n');
}

// ---- the diagram ---------------------------------------------------------

const STYLES = [
  // A state is drawn a shade heavier than the lines between states: the nodes are the
  // things, and the edges are what is said about them.
  '    ddnode/.style={circle, draw, semithick, minimum size=6mm, inner sep=0pt},',
  // An amplitude is set plainly, with no box around it. A box says "another node of the
  // same kind", which is exactly what a terminal is not, and five of them across the foot
  // of a figure is a heavy band under a light diagram. Without one the amplitudes read as
  // what the branches above them come to, which is what they are.
  '    ddterm/.style={anchor=north, inner xsep=1.5pt, inner ysep=1.5pt},',
  '    dead/.style={draw=black!30, text=black!45},',
  '    faint/.style={text=black!45},',
  '    low/.style={densely dashed},',
  '    high/.style={},',
  '    wt/.style={inner sep=1pt, fill=white, font=\\scriptsize},',
  // The row names are set the way the circuit beside them sets the same names — in maths,
  // as q_0 — rather than in the typewriter face the plate uses. On screen `q[0]` matches
  // the box the reader typed it into; in a paper it matches nothing, and a figure whose
  // qubits are called q_0 in one picture and q[0] in the next looks like two figures.
  '    gut/.style={anchor=east, font=\\scriptsize, text=black!60},',
  '    band/.style={anchor=north east, font=\\scriptsize\\itshape, text=black!60},',
];

const coord = (v) => (Math.round(v * 1000) / 1000).toString();

/**
 * Roughly how many glyphs wide a label sets, for choosing a column width.
 *
 * Counting the LaTeX source instead — which is what this used to do — counts `\omega` as
 * six and `\sqrt{2}` as eight, so a row of amplitudes asked for three times the room it
 * needed and the figure came out mostly gutter. A control sequence sets one glyph or
 * thereabouts, and braces set none.
 */
function glyphs(tex) {
  // A stacked fraction is as wide as its wider half, not as wide as both of them and a
  // rule. Counting it the flat way is what made an amplitude ask for twice the room it
  // takes, and a row of them twice the page.
  const frac = /\\frac\s*\{((?:[^{}]|\{[^{}]*\})*)\}\s*\{((?:[^{}]|\{[^{}]*\})*)\}/;
  let out = tex;
  for (let m = frac.exec(out); m; m = frac.exec(out)) {
    const wide = Math.max(1, Math.round(Math.max(glyphs(m[1]), glyphs(m[2]))));
    out = out.slice(0, m.index) + 'w'.repeat(wide) + out.slice(m.index + m[0].length);
  }
  return out.replace(/\\[a-zA-Z]+\s*/g, 'w').replace(/[{}]/g, '').length;
}

/**
 * How wide a box holding this label comes out, in centimetres.
 *
 * Measured off compiled figures rather than guessed: the rule and the padding come to
 * about 2mm and a glyph at 10pt to about 2.6mm. Good to a millimetre or so, which is all
 * that is asked of it — everything below adds air on top.
 */
export const boxWidth = (tex) => 0.2 + 0.26 * glyphs(tex);

/** How much clear paper two boxes want between them. */
const AIR = 0.4;

/**
 * How wide the grid the *states* sit on has to be, in centimetres.
 *
 * Only what is written between two columns decides this — in the edge-valued view a
 * weight on an edge, otherwise nothing, in which case the states keep the 1.15cm they
 * have always been drawn at. The amplitudes at the bottom are not in it: they are far
 * wider than anything else in the picture, and letting them set the grid pulled a diagram
 * four nodes wide across half a page — a sparse scatter of small circles joined by long
 * diagonals, with the reader's eye doing all the work. They get their own spacing below.
 *
 * @param {{tex: string, small?: boolean}[]} labels
 */
function columnWidth(labels) {
  const widest = Math.max(0, ...labels.map((l) => glyphs(l.tex) * (l.small ? 0.7 : 1)));
  return Math.max(GRID.x, Math.round((0.6 + 0.26 * widest) * 100) / 100);
}

/**
 * The grid a figure is drawn on, in centimetres, for a state 6mm across.
 *
 * Taken from the plate's own proportions, which were chosen by looking at pictures: it
 * gives a state three times its own width of room across and three and a half times down.
 * These were 1.15 and 1.25 — under twice the width — and that was most of what made the
 * figures look cramped next to the thing they were exported from. A diagram wants air
 * between its nodes or it reads as a blot rather than as a shape.
 */
const GRID = { x: 1.5, y: 1.75 };

/**
 * Where the gutter labels sit, in column units: a centimetre clear of the widest box on
 * the row they name, rather than a centimetre from its centre — which put the word
 * `amplitude` on top of the first amplitude.
 */
const gutterAt = (xMin, xUnit, widest) => xMin - (0.6 + widest / 2) / xUnit;

/**
 * Where each node sits across the page, in column units, once the amplitudes at the
 * bottom have been given the room they need.
 *
 * Two rows of one picture want two different spacings and used to get one. The states
 * keep their compact grid; the bottom row is opened out until its boxes fit.
 *
 * Opened pair by pair, and only where it is needed. How much room two boxes want is a
 * fact about *those two* — `0` beside `0` wants a few millimetres, two long amplitudes
 * want three centimetres — so one spacing for a whole row is wrong at both ends. Taking
 * the widest pair's answer and using it everywhere left a lone `0` a hand's width from
 * anything it touched and did nothing for the crowded middle. A gap the layout already
 * made wide enough is left exactly as it was.
 *
 * Then the row is centred under the states rather than left wherever it started, so the
 * amplitudes sit beneath the diagram instead of off to one side of it, with the reader
 * crossing an empty half-page to get from one to the other.
 *
 * @param {{id: number, x: number, terminal?: boolean}[]} nodes
 * @param {(node: object) => string} texOf the label a node is drawn with, as LaTeX
 * @param {number} xUnit centimetres to the column
 * @returns {(node: object) => number}
 */
function placeX(nodes, texOf, xUnit) {
  const row = nodes.filter((nd) => nd.terminal).sort((a, b) => a.x - b.x);
  if (row.length < 2) return (nd) => nd.x;

  const half = row.map((nd) => boxWidth(texOf(nd)) / 2);
  const put = [row[0].x];
  for (let i = 1; i < row.length; i++) {
    const want = (half[i - 1] + half[i] + AIR) / xUnit;
    put.push(put[i - 1] + Math.max(want, row[i].x - row[i - 1].x));
  }

  const states = nodes.filter((nd) => !nd.terminal).map((nd) => nd.x);
  const centre = states.length
    ? (Math.min(...states) + Math.max(...states)) / 2
    : (put[0] + put[put.length - 1]) / 2;
  const shift = centre - (put[0] + put[put.length - 1]) / 2;

  const at = new Map(row.map((nd, i) => [nd.id, put[i] + shift]));
  return (nd) => (at.has(nd.id) ? at.get(nd.id) : nd.x);
}

/**
 * One frame of the diagram as a tikzpicture. Positions come straight from the layout, so
 * the figure is the one on screen; the styles are declared in the picture itself, so a
 * reader can restyle every low edge or every terminal in one place.
 *
 * @param {object} layout the whole layout, for its extent
 * @param {number} index which frame
 * @param {{qubitLabels: string[], bandLabel?: string, hideZero?: boolean, link?: string}} opts
 */
export function diagramTikz(layout, index, opts = {}) {
  const frame = layout.frames[index];
  const { qubitLabels = [], bandLabel = 'amplitude', hideZero = false, link } = opts;

  // What the plate is showing: with zeros hidden, a zero edge goes and so does anything
  // only reachable through one.
  let edges = frame.edges;
  let nodes = frame.nodes;
  if (hideZero) {
    edges = edges.filter((e) => !e.toZero && !nodes.find((nd) => nd.id === e.to)?.zero);
    const reached = new Set([frame.root]);
    for (const e of edges) reached.add(e.to);
    nodes = nodes.filter((nd) => reached.has(nd.id) && !nd.zero);
    edges = edges.filter((e) => reached.has(e.from) && reached.has(e.to));
  }

  const lines = [];

  // A column has to be wide enough for the widest amplitude, or the boxes at the bottom
  // of the picture sit on top of one another. It used to be a flat 1.15cm, which is fine
  // for `0` and `1` and nowhere near enough for `(1+omega)/(2 sqrt 2)` — that figure came
  // out with three amplitudes overlapping into one unreadable smear.
  // The states sit on a grid wide enough for the weights written along their edges — in
  // the edge-valued view that is the widest thing between two columns by a long way, and
  // leaving it out had `1` and `1-omega` written on top of each other. The amplitudes at
  // the bottom get their own, wider spacing.
  const xUnit = columnWidth(edges.filter((e) => e.label)
    .map((e) => ({ tex: amplitudeLatex(e.label), small: true })));
  const tex = (nd) => amplitudeLatex(nd.label);
  const px = placeX(nodes, tex, xUnit);
  const widest = Math.max(0, ...nodes.filter((nd) => nd.terminal).map((nd) => boxWidth(tex(nd))));
  const left = gutterAt(Math.min(layout.xMin, ...nodes.map(px)), xUnit, widest);

  lines.push('% The qubit each level decides, and the row the amplitudes sit on.');
  for (let q = 0; q < qubitLabels.length; q++) {
    lines.push(`  \\node[gut] at (${coord(left)},${q}) {$${qubitLatex(qubitLabels[q])}$};`);
  }
  if (nodes.some((nd) => nd.terminal)) {
    lines.push(`  \\node[band] at (${coord(left)},${layout.height - 1}) {${toLatex(bandLabel)}};`);
  }

  lines.push('', '% Nodes. Internal ones carry no text: their level already names the qubit.');
  for (const nd of nodes) {
    // `dead` greys a node's outline as well as its text, which is what a zero *node*
    // wants and not what a zero amplitude does: the amplitudes have no outline, so it
    // drew one for that one alone and the row came out with a single box in it.
    const style = (nd.terminal
      ? ['ddterm', ...(nd.zero ? ['faint'] : [])]
      : ['ddnode', ...(nd.zero ? ['dead'] : [])]).join(', ');
    const text = nd.terminal ? `$${tex(nd)}$` : '';
    lines.push(`  \\node[${style}] (n${nd.id}) at (${coord(px(nd))},${coord(nd.y)}) {${text}};`);
  }

  // Both edges of a node can land on the same child — a tower is nothing but that — and
  // drawn straight they would lie on top of each other.
  const pairs = new Map();
  for (const e of edges) {
    const key = `${e.from}>${e.to}`;
    pairs.set(key, (pairs.get(key) ?? 0) + 1);
  }

  lines.push('', '% Edges: dashed for 0, solid for 1.');
  for (const e of edges) {
    const style = [e.high ? 'high' : 'low', ...(e.toZero ? ['dead'] : [])].join(', ');
    const parallel = pairs.get(`${e.from}>${e.to}`) > 1;
    // Two edges between the same pair bow apart, and their weights are written on the
    // outside of each bow rather than across it. A bend of 12 degrees over a row's height
    // separates the two midpoints by about a millimetre, which is nothing next to a label
    // like `1-omega`: the two sat on top of one another and neither could be read.
    const path = parallel ? `to[bend ${e.high ? 'left' : 'right'}=30]` : '--';
    const side = parallel
      ? `, anchor=${e.high ? 'west' : 'east'}, xshift=${e.high ? '' : '-'}0.8mm`
      : '';
    const label = e.label ? ` node[wt, midway${side}] {$${amplitudeLatex(e.label)}$}` : '';
    lines.push(`  \\draw[${style}] (n${e.from}) ${path}${label} (n${e.to});`);
  }

  const root = nodes.find((nd) => nd.id === frame.root);
  if (root) {
    lines.push('', '% The root, as decision diagrams are drawn on paper.');
    lines.push(`  \\draw[->] (${coord(px(root))},${coord(root.y - 0.9)}) -- (n${root.id});`);
    // Beside the arrow, not across it: a root weight can be as long as the whole label.
    if (frame.rootWeight && frame.rootWeight !== '1') {
      lines.push(`  \\node[wt, anchor=west] at ([xshift=1.4mm]${coord(px(root))},`
        + `${coord(root.y - 0.75)}) {$${amplitudeLatex(frame.rootWeight)}$};`);
    }
  }

  return [
    ...header('Decision diagram', 'tikz', { link }),
    `\\begin{tikzpicture}[x=${xUnit}cm, y=-${GRID.y}cm,`,
    ...STYLES,
    '  ]',
    ...lines,
    '\\end{tikzpicture}',
    ...footer,
  ].join('\n');
}

// ---- the automaton -------------------------------------------------------

const AUT_STYLES = [
  '    aut/.style={circle, draw, semithick, minimum size=6mm, inner sep=0pt},',
  '    autterm/.style={anchor=north, inner xsep=1.5pt, inner ysep=1.5pt},',
  '    low/.style={densely dashed, ->, >=stealth, shorten >=1pt},',
  '    high/.style={->, >=stealth, shorten >=1pt},',
  // A transition, as one mark rather than a hairline: a soft band spanning the two edges
  // where they leave, drawn under them so they read over it. This is the notation the
  // papers use, and it says what a thin arc could only hint at — that these two edges are
  // one step and are taken together. Butt caps so the band ends square on the edges.
  '    trans/.style={line width=3.2mm, black!12, line cap=butt},',
  '    gut/.style={anchor=east, font=\\scriptsize, text=black!60},',
  '    band/.style={anchor=north east, font=\\scriptsize\\itshape, text=black!60},',
];

/**
 * Six hues for the colours a transition is admitted under, as the papers draw them.
 *
 * Emitted only for a picture that has dots on it. A plain tree automaton has none, and
 * six unused styles in the preamble of a figure is six lines for its author to read and
 * then delete.
 */
const AUT_CHOICE_STYLES = [
  '    choice0/.style={fill=blue!65!black},',
  '    choice1/.style={fill=orange!80!black},',
  '    choice2/.style={fill=green!55!black},',
  '    choice3/.style={fill=violet},',
  '    choice4/.style={fill=cyan!70!black},',
  '    choice5/.style={fill=brown},',
];

/** The row spacing the picture is drawn at; the column spacing is worked out per figure. */
const AUT_ASPECT = { y: GRID.y };

/**
 * The plate's proportions, in millimetres against a 3mm state.
 *
 * On screen a state has an 11px radius, an edge runs *straight* out to 27px before it
 * bends at all, and the arc marking a transition is drawn at 22px — inside that straight
 * run. That ordering is the whole trick, and it was missing here: the edge was one curve
 * from the border, so by the time it reached the arc's radius it had already bent away,
 * and the arc's two ends stuck out past it on both sides like whiskers instead of landing
 * on the two edges it was drawn to tie together.
 *
 * So an edge leaves straight for `RUN`, the arc is drawn at `ARC` within that, and only
 * then does the edge curve — with a handle `BEND` further along the same ray, and one
 * `APPROACH` out along the ray it arrives on, so it comes into the next state head-on.
 *
 * `ARC` sits out near the end of the run rather than tucked against the state. Tucked in,
 * the tie is shorter than the state is wide and reads as a tick on the rim; out where the
 * two edges have had room to separate, it reads as what it is — one mark saying that
 * these two edges are one transition — and the dots on it are big enough to count.
 */
const RUN = 4;
const ARC = 4.8;
const BEND = 3;
const APPROACH = 3.4;

/**
 * An exit angle, as TikZ measures them: from east, and whole.
 *
 * Whole because `(s3.247.027)` is a node name, a dot and an anchor of `247.027`, and
 * asking a reader to trust that parse for a fifteenth of a degree is a poor trade.
 */
const anchor = (fromBelow) => Math.round(270 + fromBelow);

/**
 * One step of the automaton as a tikzpicture.
 *
 * The same picture the plate draws, and for the same reasons — a state is a circle, a
 * leaf is its amplitude in a box, a 0-edge is dashed and a 1-edge solid, and the two
 * edges of a transition are joined by an arc near the state they leave. The arc is why
 * this cannot be `diagramTikz` with different labels: a decision diagram's node has one
 * pair of children and needs nothing to say so.
 *
 * Exit angles come from `fanAngles`, the same function the renderer uses, so a transition
 * owns the same contiguous sector on the page as it does on screen. TikZ measures from
 * east and the plate measures from straight down, hence the 270.
 *
 * A transition's colours become dots on its arc, which is the notation the papers use
 * and the one the plate draws: two transitions carrying the same dot are two halves of
 * one choice, because a run picks one colour per level and every state on that level has
 * to admit it.
 *
 * Arrivals are spread too, the same way and for the same reason: several edges reaching
 * one state used to land on the one point at the top of it, and one coming from the side
 * grazed the circle rather than entering it.
 *
 * `fanAngles`, `spread` and the entry limits are passed in rather than imported, because
 * this module is shared with the decision-diagram page and must not drag the automaton's
 * layout into that bundle to draw a picture it never asks for.
 *
 * @param {object} layout from `layoutAutomaton`
 * @param {{qubitLabels: string[], bandLabel?: string, link?: string,
 *          fanAngles: Function, spread: Function, entry?: {limit: number, gap: number}}} opts
 */
export function automatonTikz(layout, opts = {}) {
  const {
    qubitLabels = [], bandLabel = 'amplitude', link, fanAngles, spread,
    entry = { limit: 66, gap: 36 },
  } = opts;
  const at = new Map(layout.nodes.map((nd) => [nd.id, nd]));
  const lines = [];

  // A column has to be wide enough for the widest amplitude, or two of them collide at
  // the bottom of the picture. The same rule the decision diagram uses, for the same
  // reason and out of the same function.
  // The states sit on the compact grid; the amplitudes below get the room they need.
  const xUnit = columnWidth([]);
  const tex = (nd) => amplitudeLatex(nd.label);
  const px = placeX(layout.nodes, tex, xUnit);
  const widest = Math.max(0, ...layout.nodes.filter((nd) => nd.terminal)
    .map((nd) => boxWidth(tex(nd))));
  const left = gutterAt(Math.min(layout.xMin, ...layout.nodes.map(px)), xUnit, widest);

  lines.push('% The qubit each level decides, and the row the amplitudes sit on.');
  for (let q = 0; q < qubitLabels.length; q++) {
    lines.push(`  \\node[gut] at (${coord(left)},${q}) {$${qubitLatex(qubitLabels[q])}$};`);
  }
  if (layout.nodes.some((nd) => nd.terminal)) {
    lines.push(`  \\node[band] at (${coord(left)},${layout.height}) {${toLatex(bandLabel)}};`);
  }

  lines.push('', '% States, and the amplitudes they end in.');
  for (const nd of layout.nodes) {
    const text = nd.terminal ? `$${tex(nd)}$` : '';
    lines.push(`  \\node[${nd.terminal ? 'autterm' : 'aut'}] (s${nd.id}) `
      + `at (${coord(px(nd))},${coord(nd.y)}) {${text}};`);
  }

  // Grouped by the state they leave and then by transition, because where an edge leaves
  // depends on what leaves with it — exactly as on the plate.
  const leaving = new Map();
  for (const e of layout.edges) {
    if (!at.has(e.from) || !at.has(e.to)) continue;
    if (!leaving.has(e.from)) leaving.set(e.from, []);
    leaving.get(e.from).push(e);
  }

  // Where each edge arrives, spread around the top of what it enters. A state is a
  // circle and takes an angle; an amplitude is a box and takes a place along its top.
  const arriving = new Map();
  for (const e of layout.edges) {
    if (!at.has(e.from) || !at.has(e.to)) continue;
    if (!arriving.has(e.to)) arriving.set(e.to, []);
    arriving.get(e.to).push(e);
  }
  const meets = new Map();
  for (const [to, incoming] of arriving) {
    const b = at.get(to);
    // Every arrival is a border angle, whatever shape it lands on. A rectangle answers to
    // one exactly as a circle does — TikZ walks the ray out to wherever the border is —
    // so the figure needs no idea how wide the box actually came out. Asking instead for
    // an offset in millimetres along the top, which is what this did, meant guessing that
    // width from the label; the guess was three times too large and the arrows ended in
    // mid-air beside the box they were pointing at.
    //
    // An amplitude set without a box is about as tall as it is wide, so the top of it owns
    // roughly 55 to 125 degrees; a state has more room than that. Arrivals at an amplitude
    // stay well inside the narrower window, which keeps every one of them on a top edge
    // rather than creeping around a corner.
    const limit = Math.min(entry.limit, b.terminal ? 28 : 66);
    const wanted = incoming.map((e) => {
      const a = at.get(e.from);
      return (180 / Math.PI) * Math.atan2((px(a) - px(b)) * xUnit, (b.y - a.y) * AUT_ASPECT.y);
    });
    const given = spread(wanted, { limit, gap: Math.min(entry.gap, 2 * limit) });
    // TikZ measures from east and the plate from straight up, positive to the right, so
    // the two run opposite ways about 90.
    incoming.forEach((e, i) => {
      const angle = Math.round(90 - given[i]);
      meets.set(e, { at: `(s${to}.${angle})`, out: angle });
    });
  }

  // Exit angles first, for every state, because the bands go down before any edge does:
  // a band is behind the pair it marks, and TikZ paints in the order it is given.
  const fanned = new Map();
  for (const [from, out] of leaving) {
    const a = at.get(from);
    const groups = [];
    for (const e of out) {
      if (!groups[e.transition]) groups[e.transition] = [];
      groups[e.transition].push(e);
    }
    const wanted = groups.map((pair) => pair.map((e) => {
      const b = at.get(e.to);
      return (180 / Math.PI) * Math.atan2((px(b) - px(a)) * xUnit, (b.y - a.y) * AUT_ASPECT.y);
    }));
    fanned.set(from, { groups, given: fanAngles(wanted) });
  }

  lines.push('', '% One band per transition, marking the two edges that are taken together.');
  for (const [from, { groups, given }] of fanned) {
    groups.forEach((pair, t) => {
      if (pair.length !== 2) return;
      const lo = anchor(Math.min(given[t][0], given[t][1]));
      const hi = anchor(Math.max(given[t][0], given[t][1]));
      lines.push(`  \\draw[trans] (s${from}) ++(${lo}:${coord(ARC)}mm) `
        + `arc (${lo}:${hi}:${coord(ARC)}mm);`);
    });
  }

  lines.push('', '% Transitions: dashed for the 0-child, solid for the 1-child.');
  for (const [from, { groups, given }] of fanned) {
    groups.forEach((pair, t) => {
      pair.forEach((e, i) => {
        const leaves = anchor(given[t][i]);
        const meet = meets.get(e);
        // One cubic, with a handle on the ray it leaves along and another on the ray it
        // arrives along — so an edge goes straight out of its state before it bends, and
        // comes straight into the next one. Drawn as a plain segment, as it was, an edge
        // left at whatever angle its target happened to be at, which made two exit points
        // read as one and left the arc marking them spanning nothing.
        lines.push(`  \\draw[${e.high ? 'high' : 'low'}] (s${from}.${leaves}) `
          + `-- ++(${leaves}:${coord(RUN)}mm) `
          + `.. controls +(${leaves}:${coord(BEND)}mm) and `
          + `+(${meet ? meet.out : 90}:${coord(APPROACH)}mm) .. `
          + `${meet ? meet.at : `(s${e.to})`};`);
      });
    });
  }

  lines.push('', '% The colours each transition is admitted under, as dots on its band.');
  for (const [from, { groups, given }] of fanned) {
    groups.forEach((pair, t) => {
      const colours = pair.length === 2 ? pair[0].colours ?? [] : [];
      if (!colours.length) return;
      const lo = anchor(Math.min(given[t][0], given[t][1]));
      const hi = anchor(Math.max(given[t][0], given[t][1]));
      const inset = Math.min(6, (hi - lo) / 4);
      const span = Math.max(0, hi - lo - 2 * inset);
      colours.forEach((c, i) => {
        const where = colours.length === 1
          ? lo + inset + span / 2
          : lo + inset + (span * i) / (colours.length - 1);
        lines.push(`  \\fill[choice${c % 6}] (s${from}) `
          + `++(${coord(Math.round(where * 10) / 10)}:${coord(ARC)}mm) circle (0.75mm);`);
      });
    });
  }

  const root = layout.nodes.find((nd) => nd.root);
  if (root) {
    lines.push('', '% The root state: a run accepts the tree it read when it ends in one.');
    lines.push(`  \\draw[->, >=stealth] (${coord(px(root))},${coord(root.y - 0.9)}) `
      + `-- (s${root.id});`);
    lines.push(`  \\node[anchor=east, font=\\footnotesize] at `
      + `([xshift=-1.2mm]${coord(px(root))},${coord(root.y - 0.78)}) {$R$};`);
  }

  // A picture with a dot on it is level-synchronized and one without it is a plain tree
  // automaton, and the caption of a figure is a poor place to leave that to inference.
  const synchronized = (layout.palette ?? []).some((k) => k > 0);
  return [
    ...header(synchronized ? 'Level-synchronized tree automaton' : 'Tree automaton',
      'tikz', { link }),
    `\\begin{tikzpicture}[x=${xUnit}cm, y=-${AUT_ASPECT.y}cm,`,
    ...AUT_STYLES,
    ...(synchronized ? AUT_CHOICE_STYLES : []),
    '  ]',
    ...lines,
    '\\end{tikzpicture}',
    ...footer,
  ].join('\n');
}
