import { test } from 'node:test';
import assert from 'node:assert/strict';
import { automatonTikz, circuitTikz } from '../src/tikz.js';
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

    const drawn = [...tex.matchAll(/\\draw\[(low|high)\] \(s(\d+)\.[-\d]+\) -- (.*);$/gm)];
    assert.equal(drawn.length, layout.edges.length, 'one edge each');
    for (const [, , from, to] of drawn) {
      assert.ok(declared.has(from), `an edge leaves an undeclared s${from}`);
      const target = /s(\d+)[).]/.exec(to)[1];
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
  assert.match(tex, /\\node\[gut\] at \([-\d.]+,0\) \{q\[0\]\}/);
  assert.match(tex, /\\node\[gut\] at \([-\d.]+,2\) \{amplitude\}/, 'the last row is the amplitudes');
  assert.equal((tex.match(/\\begin\{tikzpicture\}/g) || []).length, 1);
  assert.equal((tex.match(/\\end\{tikzpicture\}/g) || []).length, 1);
  const open = (tex.match(/(?<!\\)\{/g) || []).length;
  const shut = (tex.match(/(?<!\\)\}/g) || []).length;
  assert.equal(open, shut, 'braces balance');
});

test('a column is wide enough for the widest amplitude in it', () => {
  // Two amplitude boxes on neighbouring columns collided at 1.15cm — `(1+i)/2` is wider
  // than that — so the column is sized from the label rather than fixed.
  const narrow = run(2, SPECIALS.zero.spec(2), 'OPENQASM 2.0;\ninclude "qelib1.inc";\nqreg q[2];\n\nx q[0];\n');
  const wide = run(3, SPECIALS.basis.spec(3), BELL);
  const unit = (tex) => Number(/x=([\d.]+)cm/.exec(tex)[1]);
  const thin = unit(draw(narrow.layouts.at(-1), narrow.circuit));
  const fat = unit(draw(wide.layouts.at(-1), wide.circuit));
  assert.equal(thin, 1.15, 'a picture of 0 and 1 keeps the default');
  assert.ok(fat > thin, `${fat} should be wider than ${thin}`);
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
