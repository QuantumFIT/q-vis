import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomCircuit, GATE_SETS } from '../src/random.js';
import { parseQasm } from '../src/qasm.js';
import { parseState, buildState, squaredNorm } from '../src/state.js';
import { MTBDD } from '../src/dd.js';
import { LIMDD } from '../src/limdd.js';
import { unitNormaliser } from '../src/evdd.js';
import { simulate } from '../src/sim.js';
import * as P from '../src/poly.js';
import * as Z from '../src/zomega.js';

const SETS = Object.keys(GATE_SETS);

/** Run one generated circuit all the way through, as the tool would. */
function run(made) {
  const circuit = parseQasm(made.qasm);
  const n = circuit.nqubits;
  const dd = new MTBDD(P.Ring, n);
  const root = buildState(dd, parseState(made.state, n).entries);
  const frames = simulate(dd, root, circuit);
  return { dd, n, circuit, frames, root: frames[frames.length - 1].root };
}

test('every gate set generates circuits the parser accepts and the engine runs', () => {
  // The generator writes source, so the only thing that makes it correct is that the
  // parser takes it — a gate drawn with the wrong arity, a repeated qubit, or an angle
  // off the dyadic grid would all be caught here and nowhere else.
  let total = 0;
  for (const set of SETS) {
    for (let i = 1; i <= 25; i++) {
      const made = randomCircuit(i * 7919, { set });
      const where = `${set} at seed ${made.seed}`;
      assert.equal(made.set, set, `${where}: asked for a set and got one`);
      const { dd, n, circuit, root } = run(made);
      assert.ok(circuit.gates.length > 0, `${where}: produced no gates`);
      assert.equal(n, made.n, `${where}: declared ${made.n} qubits`);

      // A unitary circuit on a normalised state stays normalised. This is the one check
      // that would notice a gate built with the wrong matrix.
      const norm = squaredNorm(dd, root);
      assert.ok(norm !== null && Math.abs(norm - 1) < 1e-9, `${where}: norm ${norm}`);
      total++;
    }
  }
  assert.ok(total === SETS.length * 25, `${total} circuits run`);
});

test('a Clifford circuit comes out a stabilizer state, every time', () => {
  // Theorem 1 of the Pauli-LIMDD paper: a state is a stabilizer state exactly when its
  // LIMDD is a tower of n + 1 nodes. So this asserts two things at once — that the
  // 'clifford' pool really is Clifford, and that the diagram still recognises one.
  // Measured over these seeds: 60 of 60 towers for Clifford, against 1 of 60 for the
  // diagonal set, so the property is discriminating rather than vacuous.
  for (let i = 1; i <= 40; i++) {
    const made = randomCircuit(i * 7919, { set: 'clifford' });
    const { dd, n, root } = run(made);
    const li = new LIMDD(P.Ring, n, unitNormaliser(P, Z, 'low'));
    assert.equal(li.size(li.fromMTBDD(dd, root)), n + 1,
      `Clifford at seed ${made.seed} on ${n} qubits is not a tower`);
  }
});

test('a diagonal circuit moves no amplitude between basis states', () => {
  // What that set exists to show. The prelude spreads the state over every basis state,
  // and after that a diagonal circuit may only turn the phases: every magnitude stays
  // 1/sqrt(2^n). A gate that was not diagonal would change one.
  for (let i = 1; i <= 20; i++) {
    const made = randomCircuit(i * 104729, { set: 'diagonal' });
    const { dd, n, root } = run(made);
    const want = 1 / 2 ** n;
    for (let b = 0; b < 2 ** n; b++) {
      const v = P.evaluate(dd.evaluate(root, b.toString(2).padStart(n, '0')), {});
      assert.ok(Math.abs((v.re * v.re + v.im * v.im) - want) < 1e-12,
        `diagonal at seed ${made.seed}: |${b.toString(2).padStart(n, '0')}> changed magnitude`);
    }
  }
});

test('the same seed gives the same circuit, and different seeds do not', () => {
  // The seed is written into the circuit, which is only worth doing if it gets it back.
  for (const set of SETS) {
    assert.equal(randomCircuit(4242, { set }).qasm, randomCircuit(4242, { set }).qasm, set);
  }
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(randomCircuit(i).qasm);
  assert.ok(seen.size > 190, `200 seeds gave only ${seen.size} distinct circuits`);
});

test('what is asked for is what is generated', () => {
  for (const set of SETS) {
    const made = randomCircuit(99, { set, qubits: 4, gates: 12 });
    assert.equal(made.n, 4, set);
    assert.equal(parseQasm(made.qasm).nqubits, 4, set);
    // The prelude is a gate too, so a set with one has more than it was asked for.
    const extra = (GATE_SETS[set].prelude ?? []).length * 4;
    assert.equal(parseQasm(made.qasm).gates.length, 12 + extra, set);
  }
  // Nothing wider than the circuit is drawn: a three-qubit gate needs three qubits.
  for (const set of SETS) {
    for (let i = 0; i < 20; i++) {
      const made = randomCircuit(i * 31, { set, qubits: 3 });
      for (const g of parseQasm(made.qasm).gates) {
        assert.ok(g.qubits.length <= 3, `${set}: ${g.name} on ${g.qubits.length} of 3 qubits`);
        assert.equal(new Set(g.qubits).size, g.qubits.length, `${set}: ${g.name} on a repeated qubit`);
      }
    }
  }
});

test('the circuit says which set it came from and how to get it back', () => {
  for (const set of SETS) {
    const made = randomCircuit(123456, { set });
    // A plain string, not a pattern: 'Clifford+T' would read as a regex and match nothing.
    assert.ok(made.qasm.includes(`Random circuit — ${GATE_SETS[set].label},`), set);
    assert.match(made.qasm, /Seed [0-9a-z]+\./, set);
    assert.ok(made.qasm.includes(GATE_SETS[set].watch.slice(0, 30)), set);
  }
});
