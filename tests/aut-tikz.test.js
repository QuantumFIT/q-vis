import { test } from 'node:test';
import assert from 'node:assert/strict';
import { automatonTikz, boxWidth, circuitTikz } from '../src/tikz.js';
import { fanAngles, layoutAutomaton, spread } from '../src/aut-layout.js';
import { simulate } from '../src/aut-gates.js';
import { parseHsl, toVector } from '../src/aut-hsl.js';
import { SPECIALS } from '../src/aut-examples.js';
import { LSTA } from '../src/aut-lsta.js';
import { parseQasm } from '../src/qasm.js';
import * as P from '../src/poly.js';

const ring = P.Ring;

/** One run, laid out, the way the page does it. */
function run(n, spec, qasm) {
  const ta = new LSTA(ring, n);
  const parsed = parseHsl(spec, n);
  const { root } = ta.fromVectors(parsed.vectors.map((v) => toVector(v, ring)));
  const circuit = parseQasm(qasm);
  const frames = simulate(ta, root, circuit);
  let rank = new Map();
  const layouts = frames.map((frame) => {
    const layout = layoutAutomaton(ta, frame.root, {
      formatValue: (v) => P.format(v, 'exact'),
      prevRank: rank,
    });
    rank = layout.rank;
    return layout;
  });
  return { ta, circuit, frames, layouts };
}

const draw = (layout, circuit) => automatonTikz(layout, {
  qubitLabels: circuit.qubits.map((q) => q.label),
  bandLabel: 'amplitude',
  fanAngles,
  spread,
});

const BELL = 'OPENQASM 2.0;\ninclude "qelib1.inc";\nqreg q[3];\n\nh q[0];\ncx q[0],q[1];\nt q[2];\n';

test('every state is drawn once, and no edge goes into thin air', () => {
  const { circuit, layouts } = run(3, SPECIALS.basis.spec(3), BELL);
  for (const layout of layouts) {
    const tex = draw(layout, circuit);
    const declared = new Set([...tex.matchAll(/\\node\[aut(?:term)?\] \(s(\d+)\)/g)].map((m) => m[1]));
    assert.equal(declared.size, layout.nodes.length, 'one node each');
    for (const nd of layout.nodes) assert.ok(declared.has(String(nd.id)), `s${nd.id} is missing`);

    const drawn = [...tex.matchAll(
      /\\draw\[(low|high)\] \(s(\d+)\.[-\d]+\) -- \+\+\([^)]+\) \.\. controls [^;]+ \.\. ([^;]+);$/gm)];
    assert.equal(drawn.length, layout.edges.length, 'one edge each');
    for (const [, , from, to] of drawn) {
      assert.ok(declared.has(from), `an edge leaves an undeclared s${from}`);
      // The end of an edge is a point on a state's own border and nothing else. It used
      // to be an offset in millimetres from the top of a terminal box, guessed from the
      // label — and the guess was wide enough that the arrow ended in the margin beside
      // the box it was pointing at. A border angle cannot miss: TikZ walks the ray out to
      // wherever the border turned out to be.
      assert.match(to, /^\(s\d+\.-?\d+\)$/, `an edge ends at '${to}', which is not a border`);
      const target = /s(\d+)\./.exec(to)[1];
      assert.ok(declared.has(target), `an edge arrives at an undeclared s${target}`);
    }
  }
});

test('every transition is spanned by exactly one arc', () => {
  // The one thing this picture says that a decision diagram never has to. A transition
  // takes both children at once, and the arc is what says so.
  const { ta, circuit, frames, layouts } = run(3, SPECIALS.basis.spec(3), BELL);
  layouts.forEach((layout, i) => {
    const arcs = [...draw(layout, circuit).matchAll(/\\draw\[trans\] \(s(\d+)\) \+\+/g)];
    const transitions = ta.reachable(frames[i].root)
      .reduce((k, id) => k + ta.transitionsOf(id).length, 0);
    assert.equal(arcs.length, transitions, `frame ${i}`);
  });
});

test('an arc spans its own pair of edges and no others', () => {
  // What keeps the arc readable: the two angles it runs between are the two its
  // transition's edges leave on, and nothing else leaves between them.
  const { circuit, layouts } = run(3, SPECIALS.basis.spec(3), BELL);
  const tex = draw(layouts.at(-1), circuit);
  const exits = new Map();
  for (const m of tex.matchAll(/\\draw\[(?:low|high)\] \(s(\d+)\.(-?\d+)\)/g)) {
    if (!exits.has(m[1])) exits.set(m[1], []);
    exits.get(m[1]).push(Number(m[2]));
  }
  const spanned = new Map();
  for (const m of tex.matchAll(/\\draw\[trans\] \(s(\d+)\) \+\+\((-?\d+):4\.2mm\) arc \((-?\d+):(-?\d+):/g)) {
    assert.equal(m[2], m[3], 'the arc starts where it says it starts');
    if (!spanned.has(m[1])) spanned.set(m[1], []);
    spanned.get(m[1]).push([Number(m[3]), Number(m[4])]);
  }
  for (const [state, arcs] of spanned) {
    const angles = exits.get(state);
    for (const [lo, hi] of arcs) {
      assert.ok(angles.includes(lo) && angles.includes(hi), `s${state}: ${lo}..${hi} is not a pair`);
      const inside = angles.filter((a) => a > lo && a < hi);
      assert.equal(inside.length, 0, `s${state}: ${inside} sits inside another transition's arc`);
    }
  }
});

test('the root is marked, the rows are named, and the picture closes', () => {
  const { circuit, layouts } = run(2, SPECIALS.zero.spec(2),
    'OPENQASM 2.0;\ninclude "qelib1.inc";\nqreg q[2];\n\nh q[0];\n');
  const tex = draw(layouts[0], circuit);
  assert.match(tex, /\{\$R\$\}/, 'the root state says it is one');
  assert.match(tex, /\\node\[gut\] at \([-\d.]+,0\) \{\$q_\{0\}\$\}/, 'named as the circuit names it');
  assert.match(tex, /\\node\[band\] at \([-\d.]+,2\) \{amplitude\}/, 'the last row is the amplitudes');
  assert.equal((tex.match(/\\begin\{tikzpicture\}/g) || []).length, 1);
  assert.equal((tex.match(/\\end\{tikzpicture\}/g) || []).length, 1);
  const open = (tex.match(/(?<!\\)\{/g) || []).length;
  const shut = (tex.match(/(?<!\\)\}/g) || []).length;
  assert.equal(open, shut, 'braces balance');
});

test('the amplitudes get the room they need, and the states keep their own grid', () => {
  // Two rows of one picture want two different spacings. Letting the amplitudes set both
  // pulled the states apart until the diagram was a scatter of circles across half a
  // page; letting the states set both had the amplitudes overlapping into a smear. So the
  // states are on a fixed grid whatever is written below them, and the row of amplitudes
  // is opened out pair by pair until each one has room.
  const narrow = run(2, SPECIALS.zero.spec(2),
    'OPENQASM 2.0;\ninclude "qelib1.inc";\nqreg q[2];\n\nx q[0];\n');
  const wide = run(3, SPECIALS.basis.spec(3), BELL);
  const plain = draw(narrow.layouts.at(-1), narrow.circuit);
  const busy = draw(wide.layouts.at(-1), wide.circuit);

  const unit = (tex) => Number(/x=([\d.]+)cm/.exec(tex)[1]);
  assert.equal(unit(plain), unit(busy), 'the states are on the same grid in both');

  // No two amplitudes overlap, and the room between any two is what *those two* need:
  // half of each plus air. One spacing for a whole row was wrong at both ends — it left
  // the crowded middle crowded and threw the far ones off the side of the picture.
  const row = (tex) => [...tex.matchAll(
    /\\node\[autterm[^\]]*\] \(s\d+\) at \((-?[\d.]+),[^)]*\) \{\$(.*)\$\};/g)]
    .map((m) => ({ x: Number(m[1]) * unit(tex), w: boxWidth(m[2]) }))
    .sort((a, b) => a.x - b.x);
  for (const [what, tex] of [['|0..0>', plain], ['every basis state', busy]]) {
    const boxes = row(tex);
    assert.ok(boxes.length >= 2, `${what}: only ${boxes.length} amplitudes to space`);
    for (let i = 1; i < boxes.length; i++) {
      const clear = (boxes[i].x - boxes[i - 1].x) - (boxes[i].w + boxes[i - 1].w) / 2;
      assert.ok(clear > 0.2,
        `${what}: ${clear.toFixed(2)}cm of paper between two amplitudes is not enough`);
      assert.ok(clear < 3, `${what}: ${clear.toFixed(2)}cm between two amplitudes is a hole`);
    }
  }
});

test('the circuit goes through the other page\'s exporter, unchanged', () => {
  // No second quantikz writer: a circuit is a circuit, and this page parses it with the
  // same parser. If the two ever differed it would be a bug in one of them.
  const circuit = parseQasm(BELL);
  assert.equal(circuitTikz(circuit), circuitTikz(circuit));
  assert.match(circuitTikz(circuit), /\\begin\{quantikz\}/);
});

test('a figure says which of the two automata it is, and carries only the styles it uses', () => {
  // The dots are the notation, so their absence is notation too: a picture with none is
  // a plain tree automaton and one with them is level-synchronized, and the comment at
  // the top of the figure says so rather than leaving it to be inferred. The six colour
  // styles go with them — six unused definitions in a preamble are six lines for the
  // figure's author to read and then delete.
  const spec = SPECIALS.basis.spec(3);
  const circuit = parseQasm(BELL);

  const forModel = (colours) => {
    const ta = new LSTA(ring, 3, { colours });
    const parsed = parseHsl(spec, 3);
    const { root } = ta.fromVectors(parsed.vectors.map((v) => toVector(v, ring)));
    const frames = simulate(ta, root, circuit);
    const last = frames[frames.length - 1];
    return draw(layoutAutomaton(ta, last.root, { formatValue: (v) => P.format(v, 'exact') }),
      circuit);
  };

  const painted = forModel(true);
  assert.match(painted, /% Level-synchronized tree automaton, from q-vis\./);
  assert.match(painted, /choice0\/\.style=/, 'the hues it puts on the arcs');
  assert.match(painted, /\\fill\[choice\d\]/, 'and dots that use them');

  const plain = forModel(false);
  assert.match(plain, /% Tree automaton, from q-vis\./);
  assert.ok(!/Level-synchronized/.test(plain), 'which it is not');
  assert.ok(!/choice/.test(plain), 'no colours, so no dots and no styles for them');
  assert.match(plain, /\\draw\[trans\]/, 'but the arcs that pair up a transition are still there');
});
