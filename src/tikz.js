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
  '    ddnode/.style={circle, draw, minimum size=6mm, inner sep=0pt},',
  '    ddterm/.style={rectangle, rounded corners=1pt, draw, inner xsep=3pt, inner ysep=2pt},',
  '    dead/.style={draw=black!30, text=black!45},',
  '    low/.style={densely dashed},',
  '    high/.style={},',
  '    wt/.style={inner sep=1pt, fill=white, font=\\scriptsize},',
  '    gut/.style={anchor=east, font=\\scriptsize\\ttfamily, text=black!55},',
];

const coord = (v) => (Math.round(v * 1000) / 1000).toString();

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
  const left = layout.xMin - 1.1;

  lines.push('% The qubit each level decides, and the row the amplitudes sit on.');
  for (let q = 0; q < qubitLabels.length; q++) {
    lines.push(`  \\node[gut] at (${coord(left)},${q}) {${toLatex(qubitLabels[q])}};`);
  }
  if (nodes.some((nd) => nd.terminal)) {
    lines.push(`  \\node[gut] at (${coord(left)},${layout.height - 1}) {${toLatex(bandLabel)}};`);
  }

  lines.push('', '% Nodes. Internal ones carry no text: their level already names the qubit.');
  for (const nd of nodes) {
    const style = [nd.terminal ? 'ddterm' : 'ddnode', ...(nd.zero ? ['dead'] : [])].join(', ');
    const text = nd.terminal ? `$${toLatex(nd.label)}$` : '';
    lines.push(`  \\node[${style}] (n${nd.id}) at (${coord(nd.x)},${coord(nd.y)}) {${text}};`);
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
    const label = e.label ? ` node[wt, midway] {$${toLatex(e.label)}$}` : '';
    const path = pairs.get(`${e.from}>${e.to}`) > 1
      ? `to[bend ${e.high ? 'left' : 'right'}=12]`
      : '--';
    lines.push(`  \\draw[${style}] (n${e.from}) ${path}${label} (n${e.to});`);
  }

  const root = nodes.find((nd) => nd.id === frame.root);
  if (root) {
    lines.push('', '% The root, as decision diagrams are drawn on paper.');
    lines.push(`  \\draw[->] (${coord(root.x)},${coord(root.y - 0.9)}) -- (n${root.id});`);
    // Beside the arrow, not across it: a root weight can be as long as the whole label.
    if (frame.rootWeight && frame.rootWeight !== '1') {
      lines.push(`  \\node[wt, anchor=west] at (${coord(root.x + 0.12)},`
        + `${coord(root.y - 0.75)}) {$${toLatex(frame.rootWeight)}$};`);
    }
  }

  return [
    ...header('Decision diagram', 'tikz', { link }),
    '\\begin{tikzpicture}[x=1.15cm, y=-1.25cm,',
    ...STYLES,
    '  ]',
    ...lines,
    '\\end{tikzpicture}',
    ...footer,
  ].join('\n');
}

// ---- the automaton -------------------------------------------------------

const AUT_STYLES = [
  '    aut/.style={circle, draw, minimum size=6mm, inner sep=0pt},',
  '    autterm/.style={rectangle, rounded corners=1pt, draw, inner xsep=3pt, inner ysep=2pt},',
  '    low/.style={densely dashed, ->, >=stealth, shorten >=1pt},',
  '    high/.style={->, >=stealth, shorten >=1pt},',
  '    trans/.style={semithick},',
  '    gut/.style={anchor=east, font=\\scriptsize\\ttfamily, text=black!55},',
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
const AUT_ASPECT = { y: 1.25 };

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
  const left = layout.xMin - 1.1;

  // A column has to be wide enough for the widest amplitude, or two of them collide at
  // the bottom of the picture. Estimated from the label, because the only thing that
  // knows the real width is LaTeX and it is not here yet.
  const widest = Math.max(0, ...layout.nodes.filter((nd) => nd.terminal)
    .map((nd) => toLatex(nd.label).length));
  const xUnit = Math.max(1.15, Math.round((0.45 + 0.18 * widest) * 100) / 100);

  lines.push('% The qubit each level decides, and the row the amplitudes sit on.');
  for (let q = 0; q < qubitLabels.length; q++) {
    lines.push(`  \\node[gut] at (${coord(left)},${q}) {${toLatex(qubitLabels[q])}};`);
  }
  if (layout.nodes.some((nd) => nd.terminal)) {
    lines.push(`  \\node[gut] at (${coord(left)},${layout.height}) {${toLatex(bandLabel)}};`);
  }

  lines.push('', '% States, and the amplitudes they end in.');
  for (const nd of layout.nodes) {
    const text = nd.terminal ? `$${toLatex(nd.label)}$` : '';
    lines.push(`  \\node[${nd.terminal ? 'autterm' : 'aut'}] (s${nd.id}) `
      + `at (${coord(nd.x)},${coord(nd.y)}) {${text}};`);
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
    if (b.terminal) {
      // A box takes its arrivals along the top, so what each one wants is an offset in
      // millimetres — how far the state it comes from sits to one side — and not an
      // angle. Kept clear of the corners by the limit.
      const room = Math.max(2, 1.6 * widest);
      const wanted = incoming.map((e) => (at.get(e.from).x - b.x) * xUnit * 10);
      const given = spread(wanted, { limit: room, gap: 2.2 });
      incoming.forEach((e, i) => {
        meets.set(e, `([xshift=${coord(Math.round(given[i] * 10) / 10)}mm]s${to}.north)`);
      });
    } else {
      // A circle takes an angle. TikZ measures from east and the plate from straight up,
      // positive to the right, so the two run opposite ways about 90.
      const wanted = incoming.map((e) => {
        const a = at.get(e.from);
        return (180 / Math.PI) * Math.atan2((a.x - b.x) * xUnit, (b.y - a.y) * AUT_ASPECT.y);
      });
      const given = spread(wanted, entry);
      incoming.forEach((e, i) => { meets.set(e, `(s${to}.${Math.round(90 - given[i])})`); });
    }
  }

  lines.push('', '% Transitions: dashed for 0, solid for 1, and an arc over each pair.');
  for (const [from, out] of leaving) {
    const a = at.get(from);
    const groups = [];
    for (const e of out) {
      if (!groups[e.transition]) groups[e.transition] = [];
      groups[e.transition].push(e);
    }
    const wanted = groups.map((pair) => pair.map((e) => {
      const b = at.get(e.to);
      return (180 / Math.PI) * Math.atan2((b.x - a.x) * xUnit, (b.y - a.y) * AUT_ASPECT.y);
    }));
    const given = fanAngles(wanted);
    groups.forEach((pair, t) => {
      pair.forEach((e, i) => {
        lines.push(`  \\draw[${e.high ? 'high' : 'low'}] `
          + `(s${from}.${anchor(given[t][i])}) -- ${meets.get(e) ?? `(s${e.to})`};`);
      });
      if (pair.length === 2) {
        const lo = anchor(Math.min(given[t][0], given[t][1]));
        const hi = anchor(Math.max(given[t][0], given[t][1]));
        lines.push(`  \\draw[trans] (s${from}) ++(${lo}:4.2mm) arc (${lo}:${hi}:4.2mm);`);
        // The colours that admit the transition, as dots on the arc that marks it.
        const colours = pair[0].colours ?? [];
        const inset = Math.min(6, (hi - lo) / 4);
        const span = Math.max(0, hi - lo - 2 * inset);
        colours.forEach((c, i) => {
          const at = colours.length === 1
            ? lo + inset + span / 2
            : lo + inset + (span * i) / (colours.length - 1);
          lines.push(`  \\fill[choice${c % 6}] (s${from}) `
            + `++(${coord(Math.round(at * 10) / 10)}:4.2mm) circle (0.62mm);`);
        });
      }
    });
  }

  const root = layout.nodes.find((nd) => nd.root);
  if (root) {
    lines.push('', '% The root state: a run accepts the tree it read when it ends in one.');
    lines.push(`  \\draw[->, >=stealth] (${coord(root.x)},${coord(root.y - 0.9)}) -- (s${root.id});`);
    lines.push(`  \\node[anchor=east, font=\\footnotesize] at `
      + `(${coord(root.x - 0.08)},${coord(root.y - 0.78)}) {$R$};`);
  }

  // A picture with a dot on it is level-synchronized and one without it is a plain tree
  // automaton, and the caption of a figure is a poor place to leave that to inference.
  const synchronized = (layout.palette ?? []).some((k) => k > 0);
  return [
    ...header(synchronized ? 'Level-synchronized tree automaton' : 'Tree automaton',
      'tikz', { link }),
    `\\begin{tikzpicture}[x=${xUnit}cm, y=-1.25cm,`,
    ...AUT_STYLES,
    ...(synchronized ? AUT_CHOICE_STYLES : []),
    '  ]',
    ...lines,
    '\\end{tikzpicture}',
    ...footer,
  ].join('\n');
}
