import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toLatex, qubitLatex, circuitTikz, diagramTikz } from '../src/tikz.js';
import { MTBDD } from '../src/dd.js';
import * as P from '../src/poly.js';
import * as Z from '../src/zomega.js';
import * as Pauli from '../src/pauli.js';
import { parseQasm } from '../src/qasm.js';
import { parseState, buildState } from '../src/state.js';
import { simulate } from '../src/sim.js';
import { layoutFrames, layoutEdgeValued, layoutEdgeValuedTree } from '../src/layout.js';
import { EVDD, unitNormaliser } from '../src/evdd.js';
import { LIMDD } from '../src/limdd.js';
import { allInstances, EXAMPLES, instantiate } from '../src/examples.js';

const FORMATS = ['exact', 'rect', 'polar-deg', 'polar-rad', 'polar-pi', 'tuple'];

/** One example laid out one way, as the app would do it. */
function laidOut(instance, { view = 'reduced', format = 'exact', tree = false } = {}) {
  const circuit = parseQasm(instance.qasm);
  const n = circuit.nqubits;
  const dd = new MTBDD(P.Ring, n);
  const frames = simulate(dd, buildState(dd, parseState(instance.state, n).entries), circuit);
  const qubitLabels = circuit.qubits.map((q) => q.label);
  const perFrame = (pick) => frames.map((f) => {
    let best = pick.base;
    for (const id of dd.reachable(f.root)) if (dd.isTerminal(id)) best = Math.max(best, pick.of(dd.valueOf(id)));
    return best;
  });
  const k = perFrame({ base: 0, of: P.denominatorPower });
  const level = perFrame({ base: 4, of: P.ringLevel });
  const show = (v, i) => P.format(v, format, { k: k[i], level: level[i] });

  let layout;
  if (view === 'limdd') {
    const li = new LIMDD(P.Ring, n, unitNormaliser(P, Z, 'low'));
    const memo = new Map();
    const built = frames.map((f) => ({ index: f.index, gate: f.gate, edge: li.fromMTBDD(dd, f.root, memo) }));
    const label = (e, i) => {
      const owed = Pauli.phaseShift(e);
      const w = owed ? P.mul(e.w, P.fromZ(Z.omegaPow(-2 * owed))) : e.w;
      const text = show(w, i);
      if (Pauli.isIdentityString(e) || P.isZero(w)) return text;
      return P.attachCoefficient(text, Pauli.formatString(e, n));
    };
    layout = tree ? layoutEdgeValuedTree(li, built, qubitLabels, label)
      : layoutEdgeValued(li, built, qubitLabels, label);
  } else if (view === 'edge-valued' && !tree) {
    const ev = new EVDD(P.Ring, n, unitNormaliser(P, Z, 'low'));
    const memo = new Map();
    layout = layoutEdgeValued(ev,
      frames.map((f) => ({ index: f.index, gate: f.gate, edge: ev.fromMTBDD(dd, f.root, memo) })),
      qubitLabels, (e, i) => show(e.w, i));
  } else {
    layout = layoutFrames(dd, frames, {
      qubitLabels,
      expand: tree,
      formatValue: show,
      weighting: view === 'edge-valued' ? { ring: P.Ring, normalise: unitNormaliser(P, Z, 'low') } : null,
    });
  }
  return { circuit, layout, qubitLabels };
}

// ---- the transliterator --------------------------------------------------

test('what the formatters emit is what the transliterator knows', () => {
  // The map has to be total over the labels the app can actually produce, and the only
  // honest way to know that is to produce them all. A '?' in the output means a notation
  // grew a character nobody told this about.
  let checked = 0;
  for (const instance of allInstances()) {
    const circuit = parseQasm(instance.qasm);
    if (circuit.nqubits > 5) continue;
    for (const format of FORMATS) {
      for (const view of ['reduced', 'edge-valued', 'limdd']) {
        for (const tree of [false, true]) {
          const { layout } = laidOut(instance, { view, format, tree });
          for (const frame of layout.frames) {
            const labels = [
              ...frame.nodes.map((nd) => nd.label),
              ...frame.edges.map((e) => e.label),
              frame.rootWeight,
            ];
            for (const label of labels) {
              if (!label) continue;
              const latex = toLatex(label);
              assert.ok(!latex.includes('?'),
                `${instance.name}/${format}/${view}: ${JSON.stringify(label)} -> ${latex}`);
              assert.ok(!/[^\u0020-\u007e]/.test(latex),
                `${instance.name}/${format}/${view}: ${JSON.stringify(latex)} is not ASCII`);
              checked++;
            }
          }
        }
      }
    }
  }
  assert.ok(checked > 5000, `only ${checked} labels swept`);
});

test('the transliterations are the ones a reader would write by hand', () => {
  assert.equal(toLatex('1/√2'), '1/\\sqrt{2}');
  assert.equal(toLatex('1/(2√2)'), '1/(2\\sqrt{2})');
  assert.equal(toLatex('√X'), '\\sqrt{X}');
  assert.equal(toLatex('ω'), '\\omega');
  assert.equal(toLatex('ω³'), '\\omega^{3}');
  assert.equal(toLatex('ω²¹'), '\\omega^{21}', 'a run of superscripts is one exponent');
  assert.equal(toLatex('(1-i)/2'), '(1-i)/2');
  assert.equal(toLatex('0.7071∠45°'), '0.7071\\angle45^\\circ');
  assert.equal(toLatex('1∠π'), '1\\angle\\pi');
  assert.equal(toLatex('T†'), 'T^\\dagger');
  assert.equal(toLatex('(0,0,0,1)'), '(0,0,0,1)');
  assert.equal(toLatex(''), '');
});

test('a control sequence is never left running into a letter', () => {
  // \otimes followed by Z is one undefined \otimesZ, which is a LaTeX error rather than a
  // wrong picture — found by compiling the output rather than by reading it.
  assert.equal(toLatex('-I⊗Z⊗I'), '-I\\otimes Z\\otimes I');
  assert.equal(toLatex('1/√2·Z⊗I'), '1/\\sqrt{2}\\cdot Z\\otimes I');
  assert.equal(toLatex('ω⊗X'), '\\omega\\otimes X');
  // and no space is wasted where none is needed
  assert.equal(toLatex('⊗1'), '\\otimes1');
  assert.equal(toLatex('ω/2'), '\\omega/2');
});

test('LaTeX\'s own special characters are escaped', () => {
  assert.equal(qubitLatex('my_reg[0]'), 'my\\_reg_{0}');
  assert.equal(toLatex('50%'), '50\\%');
  assert.equal(toLatex('a&b'), 'a\\&b');
});

test('a register label becomes a subscript', () => {
  assert.equal(qubitLatex('q[0]'), 'q_{0}');
  assert.equal(qubitLatex('anc[12]'), 'anc_{12}');
  assert.equal(qubitLatex('whatever'), 'whatever', 'anything else is left as it is');
});

// ---- the circuit ---------------------------------------------------------

/**
 * The cells of the emitted quantikz, row by row, without the \lstick column. Split on the
 * separator rather than matched: the label is `$q_{0}$`, whose braces nest.
 */
function cellsOf(tex) {
  return tex.split('\n')
    .filter((line) => line.startsWith('  \\lstick'))
    .map((line) => line.replace(/ \\\\$/, '').split(' & ').slice(1));
}

test('the circuit is one row per qubit and one column per gate', () => {
  for (const instance of allInstances()) {
    const circuit = parseQasm(instance.qasm);
    if (circuit.gates.length > 32) continue;              // single-stave cases only
    const rows = cellsOf(circuitTikz(circuit));
    assert.equal(rows.length, circuit.nqubits, instance.name);
    for (const row of rows) {
      assert.equal(row.length, circuit.gates.length + 1, `${instance.name}: trailing \\qw`);
    }
  }
});

test('every vertical offset lands on a row the gate actually touches', () => {
  // The connectors are the part with arithmetic in it, so they are the part to check: a
  // \ctrl{3} pointing at a row the gate does not use draws a line into someone else's wire.
  for (const instance of allInstances()) {
    const circuit = parseQasm(instance.qasm);
    if (circuit.gates.length > 32) continue;
    const rows = cellsOf(circuitTikz(circuit));
    circuit.gates.forEach((gate, column) => {
      const touched = new Set(gate.qubits);
      for (let q = 0; q < circuit.nqubits; q++) {
        const cell = rows[q][column];
        if (cell === '\\qw') {
          assert.ok(!touched.has(q), `${instance.name}: ${gate.name} left row ${q} bare`);
          continue;
        }
        assert.ok(touched.has(q), `${instance.name}: ${gate.name} wrote into row ${q}`);
        for (const [, delta] of cell.matchAll(/\\(?:ctrl|vqw|swap)\{(-?\d+)\}/g)) {
          assert.ok(touched.has(q + Number(delta)),
            `${instance.name}: ${gate.name} points from ${q} to ${q + Number(delta)}`);
        }
      }
    });
  }
});

test('a long circuit is broken into staves, and says why', () => {
  const grover = instantiate(EXAMPLES.find((ex) => ex.name === 'Grover'), 6);
  const tex = circuitTikz(parseQasm(grover.qasm));
  const staves = tex.match(/\\begin\{quantikz\}/g).length;
  assert.ok(staves > 1, 'broken up');
  assert.equal(tex.match(/\\end\{quantikz\}/g).length, staves, 'and each one closed');
  assert.match(tex, /broken into staves/);
  assert.match(tex, /cells, which is a lot to ask of quantikz/, 'and warns about the size');
  // Every stave still has a row per qubit.
  assert.equal(cellsOf(tex).length, parseQasm(grover.qasm).nqubits * staves);
});

test('a snippet carries the view it came from, when there is one to carry', () => {
  // A figure in a paper that links back to the live thing is worth more than one that
  // does not, and the link is pinned to a frozen build so it keeps showing this figure.
  const instance = instantiate(EXAMPLES.find((ex) => ex.name === 'Bell pair'));
  const { circuit, layout, qubitLabels } = laidOut(instance);
  const link = 'https://quantum.fit.vut.cz/q-vis/v/v14/#c=abc&s=def&i=1';

  for (const tex of [circuitTikz(circuit, { link }),
    diagramTikz(layout, 1, { qubitLabels, link })]) {
    assert.ok(tex.includes(link), 'the link is there, whole and on one line');
    assert.match(tex, /% The view this came from, in the build that made it:/);
    // Every line of the preamble is a comment; a bare URL would be a LaTeX error.
    const head = tex.split('\\begin{')[0].trim().split('\n');
    assert.ok(head.every((line) => line.startsWith('%')), 'and it is commented out');
  }

  // A pinned link cannot tell a reader that a newer version exists, so the snippet also
  // carries the current page — both, because neither answers the other's question.
  const current = 'https://quantum.fit.vut.cz/q-vis/#c=abc&s=def&i=1';
  const both = circuitTikz(circuit, { link: { pinned: link, current } });
  assert.ok(both.includes(link), 'the pinned link survives');
  assert.ok(both.includes(current), 'and so does the current one');
  assert.match(both, /% The same view in the current version of the tool:/);
  const bothHead = both.split('\\begin{')[0].trim().split('\n');
  assert.ok(bothHead.every((line) => line.startsWith('%')), 'both still commented out');

  // Nothing is repeated when the page is its own current version.
  const same = circuitTikz(circuit, { link: { pinned: link, current: null } });
  assert.equal(same.split(link).length - 1, 1, 'one link, mentioned once');
  assert.doesNotMatch(same, /current version of the tool/);

  // Without one, the snippet simply does not mention it.
  const plain = circuitTikz(circuit);
  assert.ok(!plain.includes('this came from'), 'no empty promise of a link');
  assert.match(plain, /^% Circuit, from q-vis\.\n%\n/, 'and no blank comment line either');
});

// ---- the diagram ---------------------------------------------------------

test('the diagram draws every node once and no edge into thin air', () => {
  for (const view of ['reduced', 'edge-valued', 'limdd']) {
    const instance = instantiate(EXAMPLES.find((ex) => ex.name === 'Cluster state'), 4);
    const { layout, qubitLabels } = laidOut(instance, { view });
    const last = layout.frames.length - 1;
    const tex = diagramTikz(layout, last, { qubitLabels });
    const frame = layout.frames[last];

    const declared = [...tex.matchAll(/\\node\[[^\]]*\] \(n(\d+)\)/g)].map((m) => m[1]);
    assert.deepEqual([...declared].sort(), frame.nodes.map((nd) => String(nd.id)).sort(),
      `${view}: one node each, no more and no fewer`);

    const named = new Set(declared);
    for (const [, from, to] of tex.matchAll(/\\draw\[[^\]]*\] \(n(\d+)\) (?:--|to\[[^\]]*\])[^(]*\(n(\d+)\)/g)) {
      assert.ok(named.has(from) && named.has(to), `${view}: edge ${from}->${to} has no node`);
    }
    assert.match(tex, /\\begin\{tikzpicture\}/);
    assert.match(tex, /\\end\{tikzpicture\}/);
  }
});

test('hiding zeros hides them in the output too', () => {
  // What the button gives you is what the plate is showing, which is the whole point of
  // it being an export rather than a dump.
  const instance = instantiate(EXAMPLES.find((ex) => ex.name === 'GHZ'), 4);
  const { layout, qubitLabels } = laidOut(instance);
  const last = layout.frames.length - 1;
  const shown = diagramTikz(layout, last, { qubitLabels, hideZero: false });
  const hidden = diagramTikz(layout, last, { qubitLabels, hideZero: true });

  const nodes = (tex) => (tex.match(/\\node\[(?:ddnode|ddterm)/g) || []).length;
  assert.ok(nodes(hidden) < nodes(shown), 'the zero terminal and its subtree go');
  assert.ok(!/dead/.test(hidden.split('% Edges')[1] ?? ''), 'and no dead edge is left over');
});

test('parallel edges are bent apart, since a tower is nothing but those', () => {
  const instance = instantiate(EXAMPLES.find((ex) => ex.name === 'Cluster state'), 4);
  const { layout, qubitLabels } = laidOut(instance, { view: 'limdd' });
  const tex = diagramTikz(layout, layout.frames.length - 1, { qubitLabels });
  assert.match(tex, /to\[bend left=/);
  assert.match(tex, /to\[bend right=/);
});
