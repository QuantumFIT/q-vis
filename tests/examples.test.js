import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXAMPLES, allInstances, instantiate, identify } from '../src/examples.js';
import { MTBDD } from '../src/dd.js';
import * as P from '../src/poly.js';
import * as Z from '../src/zomega.js';
import { parseQasm } from '../src/qasm.js';
import { parseState, buildState, squaredNorm } from '../src/state.js';
import { simulate } from '../src/sim.js';

/** Run an instance and hand back the diagram and its final root. */
function run(instance) {
  const circuit = parseQasm(instance.qasm);
  const dd = new MTBDD(P.Ring, circuit.nqubits);
  const frames = simulate(dd, buildState(dd, parseState(instance.state, circuit.nqubits).entries), circuit);
  return { dd, circuit, frames, root: frames[frames.length - 1].root };
}

const magnitude = (dd, root, bits) => {
  const { re, im } = Z.toComplex(P.asScalar(dd.evaluate(root, bits)));
  return re * re + im * im;
};

const families = () => EXAMPLES.filter((ex) => (ex.sizes?.length ?? 0) > 1);

test('every example builds at every size it offers, and stays a state', () => {
  for (const instance of allInstances()) {
    const where = `${instance.name}${instance.size ? ` on ${instance.size}` : ''}`;
    const { dd, root } = run(instance);
    const norm = squaredNorm(dd, root);
    if (norm === null) continue;                    // symbolic amplitudes have no norm yet
    assert.ok(Math.abs(norm - 1) < 1e-9, `${where}: norm is ${norm}, not 1`);
  }
});

test('a family says what it is at every size', () => {
  for (const family of families()) {
    for (const size of family.sizes) {
      const instance = instantiate(family, size);
      assert.ok(instance.note.length > 20, `${family.name} on ${size} has no note`);
      assert.equal(instance.size, size);
    }
    // An unknown size cannot produce a circuit that does not exist.
    assert.equal(instantiate(family, 99).size, family.defaultSize);
    assert.equal(instantiate(family).size, family.defaultSize);
    assert.ok(family.sizes.includes(family.defaultSize), `${family.name}'s default is not offered`);
  }
});

test('an example can be recognised again from its text alone', () => {
  // Which is how a permalink and a reloaded page put the two pickers back.
  for (const instance of allInstances()) {
    const hit = identify(instance.qasm, instance.state);
    assert.ok(hit, `${instance.name} on ${instance.size} was not recognised`);
    assert.equal(hit.name, instance.name);
    assert.equal(hit.size, instance.size);
  }
  assert.equal(identify('OPENQASM 2.0;\nqreg q[1];\nh q[0];\n', '|0> : 1'), null,
    'anything else is a circuit of your own');
});

test('no two examples are the same circuit', () => {
  // Recognition takes the first match, so a collision would quietly rename one of them.
  // GHZ starts at three qubits for exactly this reason: on two it is the Bell pair.
  const seen = new Map();
  for (const instance of allInstances()) {
    const key = `${instance.qasm}\u0000${instance.state}`;
    const where = `${instance.name}${instance.size ? ` on ${instance.size}` : ''}`;
    assert.ok(!seen.has(key), `${where} is the same circuit as ${seen.get(key)}`);
    seen.set(key, where);
  }
});

test('GHZ is two nodes per qubit at every size', () => {
  // The generator has to be right at n = 11 as well as at n = 5, and a wrong one shows up
  // here as a diagram of the wrong shape rather than as a wrong amplitude.
  const ghz = EXAMPLES.find((ex) => ex.name === 'GHZ');
  for (const n of ghz.sizes) {
    const { dd, root } = run(instantiate(ghz, n));
    assert.equal(dd.size(root), 2 * n + 1, `GHZ on ${n} qubits`);
    for (const bits of ['0'.repeat(n), '1'.repeat(n)]) {
      assert.ok(Math.abs(magnitude(dd, root, bits) - 0.5) < 1e-12, `GHZ on ${n}: |${bits}>`);
    }
  }
});

test('a uniform superposition is one node however wide it is', () => {
  const uniform = EXAMPLES.find((ex) => ex.name === 'Uniform superposition');
  for (const n of uniform.sizes) {
    const { dd, root } = run(instantiate(uniform, n));
    assert.equal(dd.size(root), 1, `${n} qubits: every level is a don't-care`);
  }
});

test('Grover finds what it is looking for, and gives its working qubits back', () => {
  const grover = EXAMPLES.find((ex) => ex.name === 'Grover');
  for (const n of grover.sizes) {
    const { dd, circuit, root } = run(instantiate(grover, n));
    const pad = '0'.repeat(circuit.nqubits - n);
    const marked = '1'.repeat(n) + pad;

    let best = 0;
    let stray = 0;
    for (let b = 0; b < 2 ** circuit.nqubits; b++) {
      const bits = b.toString(2).padStart(circuit.nqubits, '0');
      const p = magnitude(dd, root, bits);
      if (bits.slice(n).includes('1')) stray += p;
      else if (bits !== marked) best = Math.max(best, p);
    }
    assert.ok(magnitude(dd, root, marked) > 0.9, `Grover on ${n}: the mark did not grow`);
    assert.ok(magnitude(dd, root, marked) > best, `Grover on ${n}: something else is larger`);
    // Borrowed, not spent: the working register is exactly |0>, not nearly.
    assert.equal(stray, 0, `Grover on ${n}: the working qubits did not come home`);
  }
});

test('the sizes left out are left out for a reason', () => {
  // W on three would need an amplitude of 1/sqrt(3), and a fourth QFT qubit a phase of
  // pi/8. Neither is in the ring, which is why neither size is offered — so the reason
  // is worth pinning down, not just the consequence.
  const w = EXAMPLES.find((ex) => ex.name === 'W state');
  assert.deepEqual(w.sizes, [2, 4, 8], 'only the powers of two the splitter reaches');
  assert.throws(() => parseState('|000> : 1/sqrt(3)', 3), /only sqrt\(2\)/,
    'there is no sqrt(3) in this ring to divide by');

  const qft = EXAMPLES.find((ex) => ex.name === 'QFT');
  assert.deepEqual(qft.sizes, [3]);
  assert.throws(() => parseQasm('OPENQASM 2.0;\nqreg q[2];\ncu1(pi/8) q[1],q[0];\n'),
    /pi\/4|multiple/, 'the phase a fourth QFT qubit needs');
});
