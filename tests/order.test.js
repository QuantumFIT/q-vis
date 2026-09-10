import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MTBDD } from '../src/dd.js';
import * as P from '../src/poly.js';
import { parseQasm } from '../src/qasm.js';
import { parseState, buildState, squaredNorm } from '../src/state.js';
import { simulate } from '../src/sim.js';
import { EXAMPLES, allInstances, instantiate } from '../src/examples.js';
import * as O from '../src/order.js';
import { LIMDD } from '../src/limdd.js';
import { unitNormaliser } from '../src/evdd.js';
import * as Z from '../src/zomega.js';
import * as Pauli from '../src/pauli.js';
import { nodeTableau } from '../src/tableau.js';
import { rng, randInt } from './helpers.js';

/** Run one instance under one order. */
function run(instance, order) {
  const circuit = parseQasm(instance.qasm);
  const n = circuit.nqubits;
  const levelOf = O.invert(order(n));
  const dd = new MTBDD(P.Ring, n);
  const frames = simulate(dd,
    buildState(dd, parseState(instance.state, n).entries, levelOf), circuit, levelOf);
  return { dd, frames, levelOf, n, root: frames[frames.length - 1].root };
}

const ORDERS = [['as written', O.identity], ['reversed', O.reversed], ['paired', O.paired]];

test('a permutation is a total order on the levels, both ways round', () => {
  for (const n of [1, 2, 3, 4, 5, 8, 12]) {
    for (const [, of] of ORDERS) {
      const order = of(n);
      assert.deepEqual([...order].sort((a, b) => a - b), O.identity(n),
        'every qubit exactly once');
      const levelOf = O.invert(order);
      order.forEach((q, level) => assert.equal(levelOf[q], level));
      // The two directions are inverse on strings, which is what the readout relies on.
      const bits = Array.from({ length: n }, (_, i) => String(i % 2)).join('');
      assert.equal(O.toQubits(O.toLevels(bits, levelOf), levelOf), bits);
    }
  }
  assert.deepEqual(O.paired(4), [0, 3, 1, 2]);
  assert.deepEqual(O.paired(5), [0, 4, 1, 3, 2]);
  assert.deepEqual(O.reversed(4), [3, 2, 1, 0]);
  assert.ok(O.isIdentity(O.identity(6)));
  assert.ok(!O.isIdentity(O.paired(6)));
});

test('reordering changes the diagram and never the state', () => {
  // The assertion the whole feature rests on. A different order may only move the rows:
  // every amplitude of every example has to come out the same, read in qubit order.
  const r = rng(20260909);
  for (const instance of allInstances()) {
    const where = `${instance.name}${instance.size ? ` on ${instance.size}` : ''}`;
    const base = run(instance, O.identity);
    // Past ten qubits the full sweep is 2^n per order per example; sample instead.
    const all = base.n <= 10;
    const probes = all
      ? Array.from({ length: 1 << base.n }, (_, b) => b)
      : Array.from({ length: 64 }, () => randInt(r, 0, (1 << base.n) - 1));

    for (const [name, of] of ORDERS.slice(1)) {
      const other = run(instance, of);
      for (const b of probes) {
        const bits = b.toString(2).padStart(base.n, '0');
        const want = base.dd.evaluate(base.root, O.toLevels(bits, base.levelOf));
        const got = other.dd.evaluate(other.root, O.toLevels(bits, other.levelOf));
        assert.ok(P.Ring.eq(want, got),
          `${where}, ${name}: |${bits}> is ${P.format(got, 'exact')}, not ${P.format(want, 'exact')}`);
      }
      const norm = squaredNorm(other.dd, other.root);
      if (norm !== null) assert.ok(Math.abs(norm - 1) < 1e-9, `${where}, ${name}: norm ${norm}`);
      assert.equal(other.frames.length, base.frames.length, `${where}, ${name}: frame count`);
    }
  }
});

test('the nested pairs example is exponential as written and linear when paired', () => {
  // What the example is for. Pinned, so that it cannot quietly stop being true — if the
  // generator or the ordering changed and this still passed, the example would be lying.
  const ex = EXAMPLES.find((e) => e.name === 'Nested Bell pairs');
  const size = (instance, of) => {
    const { dd, frames } = run(instance, of);
    return Math.max(...frames.map((f) => f.size));
  };
  for (const n of ex.sizes) {
    const instance = instantiate(ex, n);
    const written = size(instance, O.identity);
    const paired = size(instance, O.paired);
    // 3 * 2^(n/2) - 1 against 3n/2 + 2: the middle of the diagram has to hold every
    // assignment of the first half before the second half can be decided.
    assert.equal(written, 3 * 2 ** (n / 2) - 1, `${n} qubits, as written`);
    assert.equal(paired, 1.5 * n + 2, `${n} qubits, paired`);
    if (n >= 4) assert.ok(paired < written, `${n} qubits: pairing should help`);
  }
  // The one it exists to be looked at: 47 nodes down to 14.
  assert.equal(size(instantiate(ex, 8), O.identity), 47);
  assert.equal(size(instantiate(ex, 8), O.paired), 14);
  assert.deepEqual(ex.sizes.filter((n) => n % 2), [], 'odd sizes have an unpaired qubit');
});

test('an order typed in is accepted or refused with a reason', () => {
  assert.deepEqual(O.parse('0 3 1 2', 4), [0, 3, 1, 2]);
  assert.deepEqual(O.parse('0,3,1,2', 4), [0, 3, 1, 2], 'any separator');
  assert.deepEqual(O.parse(' 10 0 1 2 3 4 5 6 7 8 9 ', 11), [10, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    'two-digit qubits');
  for (const [text, why] of [
    ['0 1 2', /3 qubits listed, the circuit has 4/],
    ['0 1 2 3 4', /5 qubits listed, the circuit has 4/],
    ['0 1 2 9', /there is no qubit 9: this circuit has 4, 0 to 3/],
    ['0 1 1 2', /qubit 1 appears twice/],
    ['', /give the qubits in the order you want them/],
    ['   ', /give the qubits/],
  ]) {
    assert.throws(() => O.parse(text, 4), why, JSON.stringify(text));
  }
  assert.equal(O.format([0, 3, 1, 2]), '0 3 1 2');
  assert.equal(O.formatIndices([0, 3, 1, 2]), '0-3-1-2');
  // What is formatted is what parses back.
  for (const n of [2, 5, 11]) {
    const order = O.paired(n);
    assert.deepEqual(O.parse(O.format(order), n), order);
    assert.deepEqual(O.parse(O.formatIndices(order), n), order);
  }
});

test('an order is written in the circuit\'s own qubit names', () => {
  // A bare index says nothing about which qubit it is once a circuit declares more than
  // one register: `qreg q[3]; qreg b[1];` flattens to four qubits and index 3 is b[0].
  const circuit = parseQasm('OPENQASM 2.0;\ninclude "qelib1.inc";\nqreg q[3];\nqreg b[1];\nh q[0];\n');
  const names = circuit.qubits.map((q) => q.label);
  assert.deepEqual(names, ['q[0]', 'q[1]', 'q[2]', 'b[0]']);

  assert.equal(O.format([0, 2, 1, 3], names), 'q[0] q[2] q[1] b[0]');
  assert.equal(O.formatIndices([0, 2, 1, 3]), '0-2-1-3', 'a link stays on indices');

  // Names, indices, a mixture, and the dashes a link uses all mean the same order.
  for (const text of ['q[0] q[2] q[1] b[0]', '0 2 1 3', 'q[0], 2, q[1], b[0]', '0-2-1-3']) {
    assert.deepEqual(O.parse(text, 4, names), [0, 2, 1, 3], text);
  }
  assert.deepEqual(O.parse('Q[0] Q[2] Q[1] B[0]', 4, names), [0, 2, 1, 3], 'case is not the point');

  // A name that is not a qubit of this circuit says so, and says what is.
  assert.throws(() => O.parse('q[0] q[1] q[2] q[3]', 4, names),
    /'q\[3\]' is not a qubit of this circuit\. It has q\[0\] q\[1\] q\[2\] b\[0\]/);
  assert.throws(() => O.parse('q[0] q[0] q[1] b[0]', 4, names), /q\[0\] appears twice/);
  assert.throws(() => O.parse('q[0] q[1]', 4, names), /2 qubits listed, the circuit has 4/);
  // Out of range by index, reported in the names the reader can see.
  assert.throws(() => O.validate([0, 1, 2, 9], 4, names),
    /there is no qubit 9: this circuit has 4, q\[0\] to b\[0\]/);

  // With one register the two spellings coincide, which is why this went unnoticed.
  const plain = parseQasm('OPENQASM 2.0;\ninclude "qelib1.inc";\nqreg q[4];\nh q[0];\n')
    .qubits.map((q) => q.label);
  assert.equal(O.format([0, 2, 1, 3], plain), 'q[0] q[2] q[1] q[3]');
  assert.deepEqual(O.parse('0 2 1 3', 4, plain), [0, 2, 1, 3]);
});

const HEADER = (n) => `OPENQASM 2.0;\ninclude "qelib1.inc";\nqreg q[${n}];\n`;
const zeros = (n) => `|${'0'.repeat(n)}> : 1`;
const ghz = (n) => ({
  qasm: HEADER(n) + 'h q[0];\n'
    + Array.from({ length: n - 1 }, (_, i) => `cx q[${i}],q[${i + 1}];\n`).join(''),
  state: zeros(n),
});
const cluster = (n) => ({
  qasm: HEADER(n) + Array.from({ length: n }, (_, i) => `h q[${i}];\n`).join('')
    + Array.from({ length: n - 1 }, (_, i) => `cz q[${i}],q[${i + 1}];\n`).join(''),
  state: zeros(n),
});

/** The same instance as a LIMDD, under one order. */
function asLimdd(instance, order) {
  const circuit = parseQasm(instance.qasm);
  const n = circuit.nqubits;
  const levelOf = O.invert(order(n));
  const dd = new MTBDD(P.Ring, n);
  const frames = simulate(dd,
    buildState(dd, parseState(instance.state, n).entries, levelOf), circuit, levelOf);
  const li = new LIMDD(P.Ring, n, unitNormaliser(P, Z, 'low'));
  const edge = li.fromMTBDD(dd, frames[frames.length - 1].root);
  return { li, edge, levelOf, n };
}

test('a stabilizer state is a tower whatever the order', () => {
  // Permuting qubits is a relabelling, so a stabilizer state stays one and Theorem 1 still
  // applies. If reordering broke the Pauli side this is where it would show.
  for (const make of [ghz, cluster]) {
    for (const n of [3, 4, 5, 6]) {
      const instance = make(n);
      for (const [name, of] of ORDERS) {
        const { li, edge } = asLimdd(instance, of);
        assert.equal(li.size(edge), n + 1, `${n} qubits, ${name}`);
      }
    }
  }
});

test('generators come out in qubit order, and still fix their node', () => {
  // The check vectors are indexed by level and printed by qubit. Getting that backwards
  // would give a table that looks fine and means something else, so the definition is
  // checked through the printed form: the letters, read as qubits, must stabilize.
  const letterToMask = (letters, n) => {
    let x = 0;
    let z = 0;
    letters.forEach((ch, q) => {
      if (ch === 'X' || ch === 'Y') x |= 1 << q;
      if (ch === 'Z' || ch === 'Y') z |= 1 << q;
    });
    return { x, z };
  };

  for (const make of [ghz, cluster]) {
    for (const [name, of] of ORDERS) {
      const { li, edge, levelOf, n } = asLimdd(make(4), of);
      // The node's state as a dense vector, in qubit order.
      const bare = { w: P.one, x: 0, z: 0, node: edge.node };
      const vec = Array.from({ length: 1 << n }, (_, b) => {
        const bits = b.toString(2).padStart(n, '0');
        return li.evaluate(bare, O.toLevels(bits, levelOf));
      });
      for (const row of nodeTableau(li, edge.node, levelOf).rows) {
        const { x, z } = letterToMask(row.letters, n);
        const w = row.sign === '−' ? P.Ring.neg(P.one) : P.one;
        // Y = i X Z, so a printed Y owes the weight an i back.
        const ys = row.letters.filter((c) => c === 'Y').length;
        let weight = w;
        for (let k = 0; k < ys; k++) weight = P.mul(weight, P.fromZ(Z.I));
        Pauli.apply(P.Ring, { w: weight, x, z }, vec).forEach((v, b) => {
          assert.ok(P.Ring.eq(v, vec[b]),
            `${name}: ${row.string} does not fix the root at |${b.toString(2).padStart(n, '0')}>`);
        });
      }
    }
  }
});
