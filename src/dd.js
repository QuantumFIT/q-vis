// Multi-terminal binary decision diagram over a pluggable amplitude ring.
//
// A state on n qubits is a function {0,1}^n -> Ring. Qubit q is decided at level q,
// so qubit 0 is the root end of the diagram and the leftmost bit of the ket:
// the path 0,1,1 from the root leads to the amplitude of |011>. Terminals sit at
// level n and hold the amplitude.
//
// Reduction is eager and total: a node whose children coincide is never created, and
// identical nodes are shared through a unique table. Consequently *node identity is
// semantic equality* — two states are equal iff their root ids are equal, and the
// diagram after gate k automatically shares every unchanged node with the diagram
// after gate k-1. The visualiser gets frame-to-frame diffing for free out of this.
//
// Nodes are never mutated or freed, so memo caches stay valid for the lifetime of the
// manager and results are shared across all frames of an animation.

const TERMINAL = -1;

export class MTBDD {
  /**
   * @param {{zero:any, one:any, add:Function, mul:Function, isZero:Function, key:Function, format:Function}} ring
   * @param {number} nvars number of qubits
   */
  constructor(ring, nvars) {
    this.ring = ring;
    this.nvars = nvars;
    /** @type {Array<{level:number, low:number, high:number, value:any}>} */
    this.nodes = [];
    this.unique = new Map();
    this.caches = { add: new Map(), mul: new Map(), scale: new Map(), restrict: new Map() };
    this.zero = this.terminal(ring.zero);
    this.one = this.terminal(ring.one);
  }

  // ---- node access -------------------------------------------------------

  isTerminal(id) { return this.nodes[id].low === TERMINAL; }
  levelOf(id) { return this.nodes[id].level; }
  lowOf(id) { return this.nodes[id].low; }
  highOf(id) { return this.nodes[id].high; }
  valueOf(id) { return this.nodes[id].value; }

  /** @returns {number} id of the (unique) terminal holding `value` */
  terminal(value) {
    const k = `t:${this.ring.key(value)}`;
    const hit = this.unique.get(k);
    if (hit !== undefined) return hit;
    const id = this.nodes.length;
    this.nodes.push({ level: this.nvars, low: TERMINAL, high: TERMINAL, value });
    this.unique.set(k, id);
    return id;
  }

  /** The reduced node for `level` with the given children. */
  mk(level, low, high) {
    if (low === high) return low;                       // the variable is a don't-care here
    if (level >= this.levelOf(low) || level >= this.levelOf(high)) {
      throw new Error(`mk: children of level ${level} must live below it ` +
        `(got ${this.levelOf(low)}, ${this.levelOf(high)})`);
    }
    const k = `${level}:${low}:${high}`;
    const hit = this.unique.get(k);
    if (hit !== undefined) return hit;
    const id = this.nodes.length;
    this.nodes.push({ level, low, high, value: undefined });
    this.unique.set(k, id);
    return id;
  }

  // ---- pointwise operations ---------------------------------------------

  /** Pointwise sum of two states. */
  add(a, b) {
    if (a === this.zero) return b;
    if (b === this.zero) return a;
    if (a > b) { const t = a; a = b; b = t; }           // commutative: canonicalise the cache key
    const k = `${a},${b}`;
    const hit = this.caches.add.get(k);
    if (hit !== undefined) return hit;

    let res;
    if (this.isTerminal(a) && this.isTerminal(b)) {
      res = this.terminal(this.ring.add(this.valueOf(a), this.valueOf(b)));
    } else {
      const lev = Math.min(this.levelOf(a), this.levelOf(b));
      const [al, ah] = this.cofactors(a, lev);
      const [bl, bh] = this.cofactors(b, lev);
      res = this.mk(lev, this.add(al, bl), this.add(ah, bh));
    }
    this.caches.add.set(k, res);
    return res;
  }

  /** Pointwise product. Needed to mask a state by a cube; see sim.applyGate. */
  mul(a, b) {
    if (a === this.zero || b === this.zero) return this.zero;
    if (a === this.one) return b;
    if (b === this.one) return a;
    if (a > b) { const t = a; a = b; b = t; }
    const k = `${a},${b}`;
    const hit = this.caches.mul.get(k);
    if (hit !== undefined) return hit;

    let res;
    if (this.isTerminal(a) && this.isTerminal(b)) {
      res = this.terminal(this.ring.mul(this.valueOf(a), this.valueOf(b)));
    } else {
      const lev = Math.min(this.levelOf(a), this.levelOf(b));
      const [al, ah] = this.cofactors(a, lev);
      const [bl, bh] = this.cofactors(b, lev);
      res = this.mk(lev, this.mul(al, bl), this.mul(ah, bh));
    }
    this.caches.mul.set(k, res);
    return res;
  }

  /** Multiply every amplitude by the ring element `v`. */
  scale(v, a) {
    if (this.ring.isZero(v)) return this.zero;
    if (this.ring.eq && this.ring.eq(v, this.ring.one)) return a;
    const k = `${this.ring.key(v)}|${a}`;
    const hit = this.caches.scale.get(k);
    if (hit !== undefined) return hit;
    const res = this.isTerminal(a)
      ? this.terminal(this.ring.mul(v, this.valueOf(a)))
      : this.mk(this.levelOf(a), this.scale(v, this.lowOf(a)), this.scale(v, this.highOf(a)));
    this.caches.scale.set(k, res);
    return res;
  }

  /**
   * The two cofactors of `a` with respect to `level`, assuming `a` decides nothing
   * above `level`. A node that skips the level is its own cofactor on both branches.
   */
  cofactors(a, level) {
    return this.levelOf(a) === level ? [this.lowOf(a), this.highOf(a)] : [a, a];
  }

  /** `a` with variable `level` fixed to `bit`; the result no longer depends on it. */
  restrict(a, level, bit) {
    if (this.levelOf(a) > level) return a;
    if (this.levelOf(a) === level) return bit ? this.highOf(a) : this.lowOf(a);
    const k = `${a}|${level}|${bit}`;
    const hit = this.caches.restrict.get(k);
    if (hit !== undefined) return hit;
    const res = this.mk(this.levelOf(a),
      this.restrict(this.lowOf(a), level, bit),
      this.restrict(this.highOf(a), level, bit));
    this.caches.restrict.set(k, res);
    return res;
  }

  // ---- construction ------------------------------------------------------

  /** The 0/1 indicator of the partial assignment `levels[i] = bits[i]`. */
  cube(levels, bits) {
    const order = levels.map((l, i) => [l, bits[i]]).sort((x, y) => y[0] - x[0]);
    let cur = this.one;
    for (const [lev, bit] of order) {
      cur = bit ? this.mk(lev, this.zero, cur) : this.mk(lev, cur, this.zero);
    }
    return cur;
  }

  /** `amplitude * |bits>`, where `bits` is a string or array of n bits. */
  basisState(bits, amplitude) {
    const b = typeof bits === 'string' ? [...bits].map(Number) : bits;
    if (b.length !== this.nvars) throw new Error(`expected ${this.nvars} bits, got ${b.length}`);
    let cur = this.terminal(amplitude);
    for (let lev = this.nvars - 1; lev >= 0; lev--) {
      cur = b[lev] ? this.mk(lev, this.zero, cur) : this.mk(lev, cur, this.zero);
    }
    return cur;
  }

  /** Build a state from a sparse list of [basis string, amplitude] pairs. */
  fromAmplitudes(entries) {
    let acc = this.zero;
    for (const [bits, amp] of entries) acc = this.add(acc, this.basisState(bits, amp));
    return acc;
  }

  // ---- queries -----------------------------------------------------------

  /** The amplitude of one basis state. */
  evaluate(root, bits) {
    const b = typeof bits === 'string' ? [...bits].map(Number) : bits;
    let cur = root;
    while (!this.isTerminal(cur)) cur = b[this.levelOf(cur)] ? this.highOf(cur) : this.lowOf(cur);
    return this.valueOf(cur);
  }

  /** Every node reachable from `root`, roots first. */
  reachable(root) {
    const seen = new Set();
    const out = [];
    const stack = [root];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      if (!this.isTerminal(id)) stack.push(this.lowOf(id), this.highOf(id));
    }
    return out;
  }

  size(root) { return this.reachable(root).length; }

  /**
   * Non-zero paths, with '-' for a skipped (don't-care) qubit. Compact by design:
   * one path can stand for many basis states, which is the whole point of the diagram.
   * @returns {Generator<{path: string, value: any}>}
   */
  *paths(root) {
    const walk = function* (self, node, level, prefix) {
      if (node === self.zero) return;
      while (self.levelOf(node) > level && level < self.nvars) { prefix += '-'; level++; }
      if (level === self.nvars) { yield { path: prefix, value: self.valueOf(node) }; return; }
      yield* walk(self, self.lowOf(node), level + 1, prefix + '0');
      yield* walk(self, self.highOf(node), level + 1, prefix + '1');
    };
    yield* walk(this, root, 0, '');
  }

  /** Non-zero basis states, don't-cares expanded. Capped: this is exponential. */
  *amplitudes(root, limit = 4096) {
    let n = 0;
    for (const { path, value } of this.paths(root)) {
      const free = [...path].map((c, i) => (c === '-' ? i : -1)).filter((i) => i >= 0);
      for (let m = 0; m < (1 << free.length); m++) {
        if (++n > limit) return;
        const bits = [...path];
        free.forEach((pos, j) => { bits[pos] = String((m >> j) & 1); });
        yield { bits: bits.join(''), value };
      }
    }
  }

  /** Graphviz source, for eyeballing the engine without a UI. */
  toDot(root, { name = 'state' } = {}) {
    const ids = this.reachable(root);
    const byLevel = new Map();
    const lines = [`digraph ${name} {`, '  node [fontname="monospace"];'];
    for (const id of ids) {
      const lev = this.levelOf(id);
      if (!byLevel.has(lev)) byLevel.set(lev, []);
      byLevel.get(lev).push(id);
      if (this.isTerminal(id)) {
        lines.push(`  n${id} [shape=box, label="${this.ring.format(this.valueOf(id))}"];`);
      } else {
        lines.push(`  n${id} [shape=circle, label="q${lev}"];`);
        lines.push(`  n${id} -> n${this.lowOf(id)} [style=dashed];`);
        lines.push(`  n${id} -> n${this.highOf(id)};`);
      }
    }
    for (const [lev, group] of [...byLevel].sort((a, b) => a[0] - b[0])) {
      lines.push(`  { rank=same; ${group.map((i) => `n${i}`).join('; ')}; }  // level ${lev}`);
    }
    lines.push('}');
    return lines.join('\n');
  }
}
