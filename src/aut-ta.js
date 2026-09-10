// A tree automaton over the perfect binary trees that are n-qubit quantum states.
//
// The encoding is the one the PLDI'23 paper uses. A state of n qubits is a perfect binary
// tree of depth n: an internal node at level i decides qubit i, its two children are the
// subtrees for that qubit being 0 and 1, and a leaf holds an amplitude. Every branch is a
// computational basis state and the leaf at its end is that state's amplitude. An
// automaton over such trees accepts a *set* of them, which is a set of quantum states.
//
// Written next to `dd.js` rather than on top of it, and the difference is exactly one
// thing: a decision diagram node has one low child and one high child, and an automaton
// state has a *set* of (low, high) pairs it may take. With one pair everywhere the two
// coincide — an MTBDD is a deterministic bottom-up tree automaton accepting one tree.
//
// The one design decision worth stating: **a state is interned on its set of outgoing
// transitions**, exactly as `dd.js` hash-conses on (level, low, high). Three things follow
// at once and they are why it is done this way:
//
//   - states are bottom-up minimal by construction, since two states with the same
//     transitions are the same state and never both exist;
//   - state identity is semantic equality, so comparing two automata is comparing two
//     numbers;
//   - a frame diff is a set difference over ids, which is what makes the picture stable
//     from one gate to the next.
//
// Transitions carry a `choices` field that nothing reads yet. It is the single hook a
// level-synchronized automaton needs, and leaving room for it now costs nothing.

/** A transition: which pair of child states, and (unused yet) which choices allow it. */
const pairKey = (t) => `${t[0]},${t[1]}`;

export class TA {
  /**
   * @param {object} ring the amplitude ring — `poly.js`'s `Ring`, so leaves may be
   *   symbolic. Only zero/one/add/mul/eq/key/isZero are used.
   * @param {number} nvars how many qubits, so how deep the trees are
   */
  constructor(ring, nvars) {
    this.ring = ring;
    this.nvars = nvars;
    this.states = [];              // id -> { level, value } | { level, transitions }
    this.interned = new Map();     // canonical key -> id
  }

  // ---- reading a state --------------------------------------------------

  isLeaf(id) { return this.states[id].transitions === undefined; }

  levelOf(id) { return this.states[id].level; }

  /** The amplitude at a leaf. Meaningless for an internal state. */
  valueOf(id) { return this.states[id].value; }

  /** The (low, high) pairs this state may take, as a sorted, deduplicated array. */
  transitionsOf(id) { return this.states[id].transitions ?? []; }

  // ---- building ---------------------------------------------------------

  /** Intern under `key`, or return the state already standing for it. */
  #intern(key, make) {
    const found = this.interned.get(key);
    if (found !== undefined) return found;
    const id = this.states.length;
    this.states.push(make());
    this.interned.set(key, id);
    return id;
  }

  /** The state accepting exactly the leaf `value`. */
  leaf(value) {
    return this.#intern(`L|${this.ring.key(value)}`,
      () => ({ level: this.nvars, value }));
  }

  /**
   * The state at `level` whose transitions are `pairs`, each `[low, high]`.
   *
   * The pairs are sorted and deduplicated before interning, so the same set written in
   * any order is the same state — which is what makes identity semantic rather than
   * historical.
   */
  state(level, pairs) {
    if (level < 0 || level >= this.nvars) {
      throw new Error(`level ${level} is not one of the ${this.nvars} variables`);
    }
    for (const [low, high] of pairs) {
      for (const child of [low, high]) {
        if (this.states[child] === undefined) throw new Error(`no such state ${child}`);
        if (this.levelOf(child) !== level + 1) {
          throw new Error(`a child of a level-${level} state must be at level ${level + 1}`);
        }
      }
    }
    const seen = new Map();
    for (const t of pairs) seen.set(pairKey(t), [t[0], t[1]]);
    const transitions = [...seen.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (!transitions.length) throw new Error('a state with no transitions accepts nothing');
    return this.#intern(`N|${level}|${transitions.map(pairKey).join(';')}`,
      () => ({ level, transitions }));
  }

  /**
   * The automaton accepting exactly the given states, each an array of 2^n amplitudes.
   *
   * Each vector becomes its own tree, and the root takes one transition per vector — so
   * no combination of one vector's left subtree with another's right can be run, and the
   * language is exactly what was asked for. Sharing still happens underneath, wherever
   * two vectors agree on a subtree, because interning cannot help but notice.
   */
  fromVectors(vectors) {
    const roots = [];
    for (const amplitudes of vectors) {
      if (amplitudes.length !== 2 ** this.nvars) {
        throw new Error(`a state of ${this.nvars} qubits has ${2 ** this.nvars} amplitudes`);
      }
      roots.push(this.#tree(amplitudes, 0, 0));
    }
    // One root taking every vector's first transition, so the set is a union.
    const top = roots.length === 1 ? roots[0]
      : this.state(0, roots.flatMap((r) => this.transitionsOf(r)));
    return { root: top, roots };
  }

  /** The single tree an amplitude vector is, as states. */
  #tree(amplitudes, level, offset) {
    if (level === this.nvars) return this.leaf(amplitudes[offset]);
    const span = 2 ** (this.nvars - level - 1);
    const low = this.#tree(amplitudes, level + 1, offset);
    const high = this.#tree(amplitudes, level + 1, offset + span);
    return this.state(level, [[low, high]]);
  }

  // ---- asking about it --------------------------------------------------

  /** Every state reachable from `root`, roots first. */
  reachable(root) {
    const seen = new Set();
    const out = [];
    const walk = (id) => {
      if (seen.has(id)) return;
      seen.add(id);
      out.push(id);
      for (const [low, high] of this.transitionsOf(id)) { walk(low); walk(high); }
    };
    walk(root);
    return out;
  }

  size(root) { return this.reachable(root).length; }

  /**
   * Every quantum state this automaton accepts, as amplitude vectors.
   *
   * Exponential in the nondeterminism by nature — a state with two transitions doubles
   * what is below it — so it is for small automata and for the tests, where it is the
   * independent answer the engine is checked against. `cap` stops it running away.
   */
  language(root, cap = 4096) {
    const memo = new Map();
    const of = (id) => {
      const had = memo.get(id);
      if (had) return had;
      let out;
      if (this.isLeaf(id)) {
        out = [[this.valueOf(id)]];
      } else {
        out = [];
        for (const [low, high] of this.transitionsOf(id)) {
          for (const l of of(low)) {
            for (const h of of(high)) {
              if (out.length >= cap) throw new Error(`more than ${cap} states in the language`);
              out.push([...l, ...h]);
            }
          }
        }
      }
      memo.set(id, out);
      return out;
    };
    return of(root);
  }

  /** Is this automaton's language the one tree `amplitudes` describes, and nothing else? */
  accepts(root, amplitudes) {
    return this.language(root).some((v) => v.length === amplitudes.length
      && v.every((x, i) => this.ring.eq(x, amplitudes[i])));
  }
}
