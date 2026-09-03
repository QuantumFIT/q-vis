// Applying a unitary gate to a state MTBDD, and recording one frame per gate.

import { GATES } from './gates.js';

/**
 * Apply a k-qubit unitary to a state diagram.
 *
 * The state is split into the 2^k cofactors obtained by fixing the gate's qubits to
 * each assignment, the cofactors are recombined by the matrix, and the qubits are put
 * back by masking each new cofactor with the cube that selects its assignment:
 *
 *     psi'  =  sum_r  cube(qubits = r) * ( sum_c M[r][c] * psi|_{qubits = c} )
 *
 * This is not the fastest formulation — a matrix-DD multiply, recursing over the gate
 * and the state together, avoids building the intermediate cubes. It was chosen because
 * it is one readable equation that is manifestly the definition of matrix-vector
 * multiplication, and it handles any qubit ordering, interleaving, and control pattern
 * with no special cases. At the scale this tool visualises (tens of qubits, diagrams of
 * a few hundred nodes) the difference is invisible.
 *
 * @param {import('./dd.js').MTBDD} dd
 * @param {number} root
 * @param {number[]} qubits gate qubits, first one is the most significant matrix index
 * @param {Array<Array<any>>} matrix 2^k x 2^k over the *scalar* ring
 */
export function applyGate(dd, root, qubits, matrix) {
  const k = qubits.length;
  const dim = 1 << k;
  if (matrix.length !== dim) throw new Error(`gate on ${k} qubits needs a ${dim}x${dim} matrix`);
  if (new Set(qubits).size !== k) throw new Error(`repeated qubit in ${JSON.stringify(qubits)}`);
  for (const q of qubits) {
    if (!Number.isInteger(q) || q < 0 || q >= dd.nvars) throw new Error(`qubit ${q} out of range`);
  }

  const bitsOf = (i) => qubits.map((_, j) => (i >> (k - 1 - j)) & 1);
  // Gate entries are scalars; lift them into the terminal ring once up front.
  const M = matrix.map((row) => row.map((e) => dd.ring.fromScalar(e)));

  const cof = [];
  for (let c = 0; c < dim; c++) {
    let cur = root;
    const bits = bitsOf(c);
    for (let j = 0; j < k; j++) cur = dd.restrict(cur, qubits[j], bits[j]);
    cof.push(cur);
  }

  let res = dd.zero;
  for (let r = 0; r < dim; r++) {
    let acc = dd.zero;
    for (let c = 0; c < dim; c++) {
      if (cof[c] === dd.zero || dd.ring.isZero(M[r][c])) continue;
      acc = dd.add(acc, dd.scale(M[r][c], cof[c]));
    }
    if (acc === dd.zero) continue;
    res = dd.add(res, dd.mul(dd.cube(qubits, bitsOf(r)), acc));
  }
  return res;
}

/** Look up a named gate and apply it. */
export function applyNamed(dd, root, name, qubits) {
  const g = GATES[name];
  if (!g) throw new Error(`unknown gate '${name}'`);
  if (qubits.length !== g.arity) {
    throw new Error(`gate '${name}' takes ${g.arity} qubit(s), got ${qubits.length}`);
  }
  return applyGate(dd, root, qubits, g.matrix);
}

/**
 * @typedef {object} Frame
 * @property {number} index          0 for the input state, i+1 after the i-th gate
 * @property {?object} gate          the gate just applied (null for the input state)
 * @property {number} root           root node id of the state after that gate
 * @property {number} size           nodes reachable from the root
 * @property {number[]} added        nodes present now but not in the previous frame
 * @property {number[]} removed      nodes present in the previous frame but not now
 */

/**
 * Run a circuit, keeping every intermediate diagram.
 *
 * Nothing is ever freed, and the manager hash-conses, so frames share all their
 * unchanged nodes: keeping the whole history costs only the genuinely new nodes,
 * and the diff between consecutive frames is a set difference over node ids.
 *
 * @returns {Frame[]} one frame for the input state plus one per gate
 */
export function simulate(dd, initialRoot, circuit) {
  /** @type {Frame[]} */
  const frames = [];
  let prev = new Set();
  let root = initialRoot;

  const push = (index, gate) => {
    const now = new Set(dd.reachable(root));
    frames.push({
      index,
      gate,
      root,
      size: now.size,
      added: [...now].filter((n) => !prev.has(n)),
      removed: [...prev].filter((n) => !now.has(n)),
    });
    prev = now;
  };

  push(0, null);
  circuit.gates.forEach((g, i) => {
    root = applyNamed(dd, root, g.name, g.qubits);
    push(i + 1, g);
  });
  return frames;
}
