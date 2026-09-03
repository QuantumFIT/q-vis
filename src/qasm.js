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

/** An angle is usable iff it is a multiple of pi/4; returns that multiple. */
function quarterTurns(theta, name, line) {
  const m = theta / (Math.PI / 4);
  const r = Math.round(m);
  if (Math.abs(m - r) > 1e-9) {
    throw new QasmError(
      `${name}(${theta.toFixed(6)}) is not expressible in Z[1/sqrt(2), i]: the angle must be a ` +
      `multiple of pi/4 (this tool keeps amplitudes exact, so arbitrary rotations are not supported)`, line);
  }
  return r;
}

const REJECTED = {
  measure: 'measurement is not a unitary gate; this tool visualises unitary evolution only',
  reset: 'reset is not a unitary gate; this tool visualises unitary evolution only',
  if: 'classical control is not supported; this tool visualises unitary evolution only',
  opaque: 'opaque gates have no matrix to apply',
};

const ROTATIONS = new Set(['rx', 'ry', 'rz', 'u', 'u1', 'u2', 'u3', 'p', 'crz', 'cu1', 'cp', 'cu3', 'rxx', 'rzz']);

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

  const emit = (name, matrix, label, qs, line) => {
    if (new Set(qs).size !== qs.length) {
      throw new QasmError(`gate '${name}' applied to a repeated qubit`, line);
    }
    if (matrix.length !== (1 << qs.length)) {
      throw new QasmError(`gate '${name}' takes ${Math.log2(matrix.length)} qubit(s), got ${qs.length}`, line);
    }
    gates.push({ name, label, qubits: qs, matrix, line });
  };

  /** Resolve one gate application, expanding user-defined gates. */
  const applyOp = (name, angles, args, line, depth = 0) => {
    if (depth > 32) throw new QasmError(`gate '${name}' expands recursively`, line);

    if (macros.has(name)) {
      const macro = macros.get(name);
      if (args.length !== macro.qargs.length) {
        throw new QasmError(`gate '${name}' takes ${macro.qargs.length} qubit(s), got ${args.length}`, line);
      }
      const bind = new Map(macro.qargs.map((q, i) => [q, args[i]]));
      for (const call of macro.body) {
        applyOp(call.name, call.angles, call.args.map((a) => bind.get(a)), line, depth + 1);
      }
      return;
    }

    if (ROTATIONS.has(name)) {
      // The only rotations in the ring are phases by a multiple of pi/4.
      if ((name === 'u1' || name === 'p') && angles.length === 1) {
        const m = quarterTurns(angles[0], name, line);
        emit(name, phaseGate(m), phaseLabel(m, ''), args, line);
        return;
      }
      if ((name === 'cu1' || name === 'cp') && angles.length === 1) {
        const m = quarterTurns(angles[0], name, line);
        emit(name, controlled(phaseGate(m)), phaseLabel(m, 'C'), args, line);
        return;
      }
      throw new QasmError(
        `'${name}' is a parametrised rotation and is not supported: its matrix entries leave ` +
        `Z[1/sqrt(2), i]. Use the exact gates (h, s, sdg, t, tdg, z, ...) or a phase u1/p with ` +
        `an angle that is a multiple of pi/4`, line);
    }

    const g = GATES[name];
    if (!g) throw new QasmError(`unknown gate '${name}'`, line);
    if (angles.length) throw new QasmError(`gate '${name}' takes no parameters`, line);
    emit(name, g.matrix, g.label, args, line);
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
      const body = [];
      while (!p.eat('}')) {
        const callLine = p.line;
        const callee = p.identifier();
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
      while (!p.at(';')) { p.next(); }
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

function phaseLabel(m, prefix) {
  const r = ((m % 8) + 8) % 8;
  const names = { 0: 'I', 2: 'S', 4: 'Z', 6: 'S†', 1: 'T', 7: 'T†' };
  return prefix + (names[r] !== undefined ? names[r] : `P(${m}π/4)`);
}
