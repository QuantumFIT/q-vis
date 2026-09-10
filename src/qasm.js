// A parser for the unitary fragment of OpenQASM 2.0.
//
// Supported: OPENQASM/include headers, qreg/creg declarations, gate applications from
// the exact gate table, `barrier` (recorded as a visual divider, not simulated),
// parameter-free `gate` definitions (inlined), and the phase gates u1/p/cu1/cp when
// their angle is a multiple of pi/4.
//
// Rejected with an explanation, not silently ignored: measure, reset, conditionals, and
// rotations whose angle leaves the ring Z[1/sqrt(2), i]. This tool visualises unitary
// evolution of a pure state, and an amplitude it cannot represent exactly is worse than
// an error message.

import { GATES, controlled, phaseGate } from './gates.js';
import { rxGate, ryGate, rzGate, rxxGate, rzzGate, uGate } from './gates.js';

export class QasmError extends Error {
  constructor(message, line) {
    super(line ? `line ${line}: ${message}` : message);
    this.name = 'QasmError';
    this.line = line;
  }
}

const TOKEN = /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|[A-Za-z_][A-Za-z0-9_]*|\d+\.\d*(?:[eE][-+]?\d+)?|\.\d+|\d+|->|==|[[\]{}();,+\-*/]|"[^"]*"/g;

function tokenize(src) {
  const out = [];
  let line = 1, pos = 0;
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(src)) !== null) {
    if (m.index !== pos) {
      const bad = src.slice(pos, m.index).trim();
      throw new QasmError(`unexpected character ${JSON.stringify(bad[0])}`, line);
    }
    const text = m[0];
    pos = m.index + text.length;
    const nl = (text.match(/\n/g) || []).length;
    if (!/^\s/.test(text) && !text.startsWith('//') && !text.startsWith('/*')) out.push({ text, line });
    line += nl;
  }
  if (pos !== src.length) throw new QasmError(`unexpected character ${JSON.stringify(src[pos])}`, line);
  return out;
}

class Parser {
  constructor(tokens) { this.t = tokens; this.i = 0; }
  get eof() { return this.i >= this.t.length; }
  peek(k = 0) { return this.t[this.i + k]; }
  get line() { return this.eof ? this.t[this.t.length - 1]?.line : this.peek().line; }
  next() {
    if (this.eof) throw new QasmError('unexpected end of input', this.t[this.t.length - 1]?.line);
    return this.t[this.i++];
  }
  at(text) { return !this.eof && this.peek().text === text; }
  eat(text) { if (this.at(text)) { this.i++; return true; } return false; }
  expect(text) {
    if (!this.at(text)) throw new QasmError(`expected '${text}', found '${this.eof ? '<eof>' : this.peek().text}'`, this.line);
    return this.next();
  }
  identifier() {
    const tok = this.next();
    if (!/^[A-Za-z_]/.test(tok.text)) throw new QasmError(`expected an identifier, found '${tok.text}'`, tok.line);
    return tok.text;
  }
  integer() {
    const tok = this.next();
    if (!/^\d+$/.test(tok.text)) throw new QasmError(`expected an integer, found '${tok.text}'`, tok.line);
    return parseInt(tok.text, 10);
  }
}

/** Evaluate an angle expression over pi, integers and + - * / ( ). */
function parseAngle(p) {
  const unary = () => {
    if (p.eat('-')) return -unary();
    if (p.eat('+')) return unary();
    if (p.eat('(')) { const v = expr(); p.expect(')'); return v; }
    const tok = p.next();
    if (tok.text === 'pi' || tok.text === 'PI') return Math.PI;
    if (/^[\d.]/.test(tok.text)) return parseFloat(tok.text);
    throw new QasmError(`cannot evaluate '${tok.text}' in an angle`, tok.line);
  };
  const term = () => {
    let v = unary();
    for (;;) {
      if (p.eat('*')) v *= unary();
      else if (p.eat('/')) v /= unary();
      else return v;
    }
  };
  const expr = () => {
    let v = term();
    for (;;) {
      if (p.eat('+')) v += term();
      else if (p.eat('-')) v -= term();
      else return v;
    }
  };
  return expr();
}

/** The finest phase the ring is asked to hold: pi/512, which is level 512. */
const FINEST_LEVEL = 512;

/**
 * An angle is usable iff it is pi times a dyadic rational — pi/4, pi/8, pi/256. Returns
 * it as `{ j, d }` meaning pi*j/d with d a power of two, which is exactly the level of
 * the ring that holds it. An angle like pi/3 has no form here at any level.
 */
function dyadicTurns(theta, name, line, finest = FINEST_LEVEL) {
  for (let d = 4; d <= finest; d *= 2) {
    const j = (theta * d) / Math.PI;
    const r = Math.round(j);
    // The tolerance is the representational noise in `j` itself, never a fraction of it.
    // A relative tolerance grows with the angle until it exceeds half a grid step, at
    // which point *every* value looks like an integer and a large angle is silently
    // rounded to an arbitrary phase: u1(1000000000*pi/3) was accepted as P(5pi/4), an
    // amplitude off by 0.26, by a tool whose whole promise is exactness. Past the point
    // where the noise swamps the grid the angle cannot be placed on it at all, so it is
    // refused rather than guessed at.
    const noise = Math.max(1e-9, Math.abs(j) * Number.EPSILON * 8);
    if (noise < 0.5 && Math.abs(j - r) < noise) return { j: r, d };
  }
  throw new QasmError(
    `${name}(${theta.toFixed(6)}) is not expressible exactly: the angle must be pi times a ` +
    `dyadic rational — pi/4, pi/8, pi/16 and so on down to pi/${finest} (this tool keeps ` +
    `amplitudes exact, so an angle like pi/3 is not supported at all)`, line);
}

/**
 * A gate that takes half its angle needs the ring one level finer than the angle itself,
 * so the grid it may be placed on is half as coarse: rx goes down to pi/256 where u1
 * goes down to pi/512. The limit is stated in the error rather than left to be inferred.
 */
const halfTurns = (theta, name, line) => dyadicTurns(theta, name, line, FINEST_LEVEL / 2);

/** pi*j/d in lowest terms, as text: "0", "π/2", "-3π/4", "2π". */
function angleText(j, d) {
  if (j === 0) return '0';
  let num = j;
  let den = d;
  while (num % 2 === 0 && den % 2 === 0) { num /= 2; den /= 2; }
  const mag = Math.abs(num);
  const head = `${num < 0 ? '-' : ''}${mag === 1 ? '' : mag}π`;
  return den === 1 ? head : `${head}/${den}`;
}

const REJECTED = {
  measure: 'measurement is not a unitary gate; this tool visualises unitary evolution only',
  reset: 'reset is not a unitary gate; this tool visualises unitary evolution only',
  if: 'classical control is not supported; this tool visualises unitary evolution only',
  opaque: 'opaque gates have no matrix to apply',
};

/** The phase gates: an angle used as a phase, not rotated through. */
const PHASE_GATES = { u1: { controls: 0 }, p: { controls: 0 }, cu1: { controls: 1 }, cp: { controls: 1 } };

/** u2's fixed first angle: U2(p, l) is U(pi/2, p, l). */
const QUARTER = { j: 2, d: 4 };

/**
 * The parametrised gates of qelib1 whose angle is genuinely rotated through rather than
 * used as a phase — everything but u1/p/cu1/cp, which are handled separately because
 * their labels name S, T and friends.
 *
 * `half` is how many leading angles the gate takes half of (one, always, when it takes
 * any): those are the ones that need the finer level. `cap` is what the box is labelled
 * with, before the angles are appended.
 */
const ROTATION_GATES = {
  rx: { angles: 1, half: 1, controls: 0, cap: 'Rx', make: (a) => rxGate(a[0]) },
  ry: { angles: 1, half: 1, controls: 0, cap: 'Ry', make: (a) => ryGate(a[0]) },
  rz: { angles: 1, half: 1, controls: 0, cap: 'Rz', make: (a) => rzGate(a[0]) },
  crx: { angles: 1, half: 1, controls: 1, cap: 'Rx', make: (a) => controlled(rxGate(a[0])) },
  cry: { angles: 1, half: 1, controls: 1, cap: 'Ry', make: (a) => controlled(ryGate(a[0])) },
  crz: { angles: 1, half: 1, controls: 1, cap: 'Rz', make: (a) => controlled(rzGate(a[0])) },
  rxx: { angles: 1, half: 1, controls: 0, cap: 'Rxx', make: (a) => rxxGate(a[0]) },
  rzz: { angles: 1, half: 1, controls: 0, cap: 'Rzz', make: (a) => rzzGate(a[0]) },
  u: { angles: 3, half: 1, controls: 0, cap: 'U', make: (a) => uGate(a[0], a[1], a[2]) },
  u3: { angles: 3, half: 1, controls: 0, cap: 'U', make: (a) => uGate(a[0], a[1], a[2]) },
  cu3: { angles: 3, half: 1, controls: 1, cap: 'U', make: (a) => controlled(uGate(a[0], a[1], a[2])) },
  u2: { angles: 2, half: 0, controls: 0, cap: 'U2', make: (a) => uGate(QUARTER, a[0], a[1]) },
};

/**
 * @param {string} src
 * @returns {{nqubits:number, qubits:{label:string}[], gates:{name:string,label:string,qubits:number[],matrix:any[][]}[], barriers:number[], registers:object[], source:string}}
 */
export function parseQasm(src) {
  const p = new Parser(tokenize(src));

  /** @type {Map<string, {base:number, size:number}>} */
  const qregs = new Map();
  const cregs = new Map();
  const macros = new Map();

  /** Is this a gate name that already means something? */
  const known = (name) => macros.has(name) || Object.hasOwn(GATES, name)
    || Object.hasOwn(ROTATION_GATES, name) || Object.hasOwn(PHASE_GATES, name);
  const qubits = [];
  const gates = [];
  const barriers = [];

  const resolveArg = (arg, line) => {
    const reg = qregs.get(arg.reg);
    if (!reg) {
      if (cregs.has(arg.reg)) throw new QasmError(`'${arg.reg}' is a classical register`, line);
      throw new QasmError(`unknown register '${arg.reg}'`, line);
    }
    if (arg.index === null) return null;                      // whole-register (broadcast)
    if (arg.index >= reg.size) {
      throw new QasmError(`${arg.reg}[${arg.index}] is out of range (size ${reg.size})`, line);
    }
    return reg.base + arg.index;
  };

  const emit = (name, matrix, label, qs, line, draw) => {
    if (new Set(qs).size !== qs.length) {
      throw new QasmError(`gate '${name}' applied to a repeated qubit`, line);
    }
    if (matrix.length !== (1 << qs.length)) {
      throw new QasmError(`gate '${name}' takes ${Math.log2(matrix.length)} qubit(s), got ${qs.length}`, line);
    }
    gates.push({ name, label, qubits: qs, matrix, line, draw });
  };

  /** Resolve one gate application, expanding user-defined gates. */
  const applyOp = (name, angles, args, line, depth = 0) => {
    if (depth > 32) throw new QasmError(`gate '${name}' expands recursively`, line);

    if (macros.has(name)) {
      const macro = macros.get(name);
      if (args.length !== macro.qargs.length) {
        throw new QasmError(`gate '${name}' takes ${macro.qargs.length} qubit(s), got ${args.length}`, line);
      }
      // Checked here rather than left to `emit`, which only sees the gates the body
      // happens to expand to: `g q[0],q[0]` was an error for a body of `cx a,b` and not
      // for one of `h a; h b;`, though the call is equally meaningless either way.
      if (new Set(args).size !== args.length) {
        throw new QasmError(`gate '${name}' applied to a repeated qubit`, line);
      }
      const bind = new Map(macro.qargs.map((q, i) => [q, args[i]]));
      for (const call of macro.body) {
        applyOp(call.name, call.angles, call.args.map((a) => bind.get(a)), line, depth + 1);
      }
      return;
    }

    if (Object.hasOwn(ROTATION_GATES, name)) {
      const spec = ROTATION_GATES[name];
      if (angles.length !== spec.angles) {
        throw new QasmError(`gate '${name}' takes ${spec.angles} angle(s), got ${angles.length}`, line);
      }
      const turns = angles.map((t, i) => (i < spec.half ? halfTurns(t, name, line)
        : dyadicTurns(t, name, line)));
      const text = `${spec.cap}(${turns.map(({ j, d }) => angleText(j, d)).join(',')})`;
      emit(name, spec.make(turns), (spec.controls ? 'C' : '') + text, args, line,
        { controls: spec.controls, target: 'box', symbol: text });
      return;
    }

    // The phase gates are apart from the table above because their label names the gate
    // it happens to be — S, T, Z — rather than the angle.
    if (Object.hasOwn(PHASE_GATES, name)) {
      const { controls } = PHASE_GATES[name];
      if (angles.length !== 1) {
        throw new QasmError(`gate '${name}' takes 1 angle, got ${angles.length}`, line);
      }
      const { j, d } = dyadicTurns(angles[0], name, line);
      const gate = controls ? controlled(phaseGate(j, d)) : phaseGate(j, d);
      emit(name, gate, phaseLabel(j, d, controls ? 'C' : ''), args, line,
        { controls, target: 'box', symbol: phaseLabel(j, d, '') });
      return;
    }

    const g = Object.hasOwn(GATES, name) ? GATES[name] : null;
    if (!g) throw new QasmError(`unknown gate '${name}'`, line);
    if (angles.length) throw new QasmError(`gate '${name}' takes no parameters`, line);
    emit(name, g.matrix, g.label, args, line, g.draw);
  };

  while (!p.eof) {
    const tok = p.peek();
    const line = tok.line;
    const word = tok.text;

    if (word === 'OPENQASM') {
      p.next();
      const v = p.next().text;
      if (!/^2(\.\d+)?$/.test(v)) {
        throw new QasmError(`this parser implements OpenQASM 2.0, not ${v}`, line);
      }
      p.expect(';');
      continue;
    }
    if (word === 'include') { p.next(); p.next(); p.expect(';'); continue; }

    if (word === 'qreg' || word === 'creg') {
      p.next();
      const name = p.identifier();
      p.expect('[');
      const size = p.integer();
      p.expect(']');
      p.expect(';');
      if (size <= 0) throw new QasmError(`register '${name}' must have a positive size`, line);
      if (qregs.has(name) || cregs.has(name)) throw new QasmError(`register '${name}' redeclared`, line);
      if (word === 'creg') { cregs.set(name, { size }); continue; }
      qregs.set(name, { base: qubits.length, size });
      for (let i = 0; i < size; i++) qubits.push({ label: `${name}[${i}]`, reg: name, index: i });
      continue;
    }

    if (REJECTED[word]) throw new QasmError(REJECTED[word], line);

    if (word === 'gate') {
      p.next();
      const name = p.identifier();
      const params = [];
      if (p.eat('(')) {
        while (!p.eat(')')) { params.push(p.identifier()); p.eat(','); }
      }
      if (params.length) {
        throw new QasmError(`parametrised gate definitions are not supported ('${name}')`, line);
      }
      const qargs = [];
      while (!p.at('{')) { qargs.push(p.identifier()); if (!p.eat(',')) break; }
      p.expect('{');
      // A gate may not be redefined, and a body may only call gates that already exist.
      // Together these make a body mean the same thing wherever it is read: names used to
      // resolve when the gate was *called*, so defining `h` later silently changed what
      // every earlier macro did.
      if (known(name)) throw new QasmError(`gate '${name}' is already defined`, line);

      const body = [];
      while (!p.eat('}')) {
        const callLine = p.line;
        const callee = p.identifier();
        if (REJECTED[callee]) throw new QasmError(REJECTED[callee], callLine);
        // The gate being defined counts as known, so a self-call is still a recursion
        // error when it is reached rather than an unknown name here.
        if (!known(callee) && callee !== name) {
          throw new QasmError(`unknown gate '${callee}'`, callLine);
        }
        const angles = [];
        if (p.eat('(')) {
          while (!p.eat(')')) { angles.push(parseAngle(p)); p.eat(','); }
        }
        const callArgs = [];
        while (!p.at(';')) {
          const a = p.identifier();
          if (!qargs.includes(a)) throw new QasmError(`'${a}' is not a parameter of gate '${name}'`, callLine);
          callArgs.push(a);
          if (!p.eat(',')) break;
        }
        p.expect(';');
        body.push({ name: callee, angles, args: callArgs, line: callLine });
      }
      macros.set(name, { qargs, body });
      continue;
    }

    if (word === 'barrier') {
      p.next();
      // Nothing is applied, but the arguments are still checked: `barrier nope;` and an
      // out-of-range index used to be swallowed whole, unlike everywhere else.
      while (!p.at(';')) {
        const reg = p.identifier();
        let index = null;
        if (p.eat('[')) { index = p.integer(); p.expect(']'); }
        resolveArg({ reg, index }, line);
        if (!p.eat(',')) break;
      }
      p.expect(';');
      barriers.push(gates.length);
      continue;
    }

    // Anything else is a gate application.
    const name = p.identifier();
    const angles = [];
    if (p.eat('(')) {
      while (!p.eat(')')) { angles.push(parseAngle(p)); p.eat(','); }
    }
    const rawArgs = [];
    while (!p.at(';')) {
      const reg = p.identifier();
      let index = null;
      if (p.eat('[')) { index = p.integer(); p.expect(']'); }
      rawArgs.push({ reg, index });
      if (!p.eat(',')) break;
    }
    p.expect(';');
    if (!rawArgs.length) throw new QasmError(`gate '${name}' needs at least one qubit`, line);

    const resolved = rawArgs.map((a) => resolveArg(a, line));
    if (resolved.some((q) => q === null)) {
      // Whole-register form, e.g. `h q;`. QASM 2 broadcasts this over the register.
      if (resolved.length !== 1) {
        throw new QasmError(
          `whole-register arguments are only supported for single-qubit gates; ` +
          `write '${name} ${rawArgs.map((a) => `${a.reg}[i]`).join(', ')}' instead`, line);
      }
      const reg = qregs.get(rawArgs[0].reg);
      for (let i = 0; i < reg.size; i++) applyOp(name, angles, [reg.base + i], line);
      continue;
    }
    applyOp(name, angles, resolved, line);
  }

  if (!qubits.length) throw new QasmError('no qreg declared: there is no state to visualise');
  return { nqubits: qubits.length, qubits, gates, barriers, registers: [...qregs], source: src };
}

/** The phases with names of their own, as the reduced fraction num/den of pi. */
const PHASE_NAMES = { '0/1': 'I', '1/1': 'Z', '1/2': 'S', '3/2': 'S†', '1/4': 'T', '7/4': 'T†' };

function phaseLabel(j, d, prefix) {
  // Reduce pi*j/d to lowest terms first, so that a phase written as 4*pi/8 is still S.
  let num = ((j % (2 * d)) + 2 * d) % (2 * d);
  let den = d;
  while (num % 2 === 0 && den % 2 === 0) { num /= 2; den /= 2; }
  if (num === 0) den = 1;
  const named = PHASE_NAMES[`${num}/${den}`];
  if (named !== undefined) return prefix + named;
  return `${prefix}P(${num === 1 ? '' : num}π/${den})`;
}
