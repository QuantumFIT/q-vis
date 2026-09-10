// A level-synchronized tree automaton over the perfect binary trees that are n-qubit
// quantum states.
//
// The encoding of a *state* is the PLDI'23 one and has not changed: a tree of depth n,
// an internal node at level i decides qubit i, a leaf holds an amplitude, and every
// branch is a computational basis state. What has changed is what an automaton may say
// about a *set* of them.
//
// A plain tree automaton reads the two children of a node independently, and that one
// fact is what it cannot get past. Applying a gate that mixes siblings — H, and every
// rotation — needs the two halves of a transformed node to agree on which choice the
// other made, and two sibling subtrees of a TA cannot agree on anything. The only exact
// answer was to take the set apart into its members, transform each, and put it back:
// correct, and it threw away every bit of sharing the automaton had.
//
// A level-synchronized automaton fixes exactly that, and does it with one idea. Every
// transition carries a set of **colours**, and a run picks **one colour per level** that
// every node on that level must admit:
//
//     q --{red, blue}--> f(q0, q1)
//
// So the choices are no longer local to a node. Two subtrees that both carry the red and
// blue alternatives are forced to take the same one, and that is the correlation a gate
// needs. It is also what the pictures in the papers draw as coloured dots, and what this
// page draws on the arc over a transition.
//
// The rest follows from that single change, and it follows *cheaply*:
//
//   - Two automata are combined by pairing their transitions and intersecting the
//     colours — `add`, `mul` and the rest of `aut-gates.js` are all that product, so the
//     gate equation is unchanged and no member is ever expanded.
//   - `fromVectors` gives each member a colour and paints every transition with the
//     members that use it, so the correlation is there from the start.
//   - The colours are quotiented by `recolour` down to the fewest a level can tell apart,
//     which keeps the sets small and the picture readable.
//
// A state is still interned on its transitions — now including their colours — so
// identity is still semantic equality, and a frame diff is still a set difference over
// ids.

/** A choice set that constrains nothing: this transition is fine under any colour. */
export const ANY = null;

/** Colour sets, as sorted arrays of small integers, or `ANY`. */
export const meet = (a, b) => {
  if (a === ANY) return b;
  if (b === ANY) return a;
  const other = new Set(b);
  return a.filter((c) => other.has(c));
};

export const join = (a, b) => {
  if (a === ANY || b === ANY) return ANY;
  return [...new Set([...a, ...b])].sort((x, y) => x - y);
};

const colourKey = (c) => (c === ANY ? '*' : c.join('.'));
const stepKey = (t) => `${t[0]},${t[1]}:${colourKey(t[2])}`;

export class LSTA {
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

  /** The `[low, high, choice]` steps this state may take, sorted and deduplicated. */
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
   * The state at `level` whose transitions are `steps`, each `[low, high]` or
   * `[low, high, choice]`.
   *
   * Two steps to the same pair of children are one step under the colours of both: they
   * were never telling anything apart. What is left is sorted and interned, so the same
   * set written in any order is the same state.
   */
  state(level, steps) {
    if (level < 0 || level >= this.nvars) {
      throw new Error(`level ${level} is not one of the ${this.nvars} variables`);
    }
    const seen = new Map();
    for (const [low, high, choice = ANY] of steps) {
      for (const child of [low, high]) {
        if (this.states[child] === undefined) throw new Error(`no such state ${child}`);
        if (this.levelOf(child) !== level + 1) {
          throw new Error(`a child of a level-${level} state must be at level ${level + 1}`);
        }
      }
      if (choice !== ANY && !choice.length) continue;    // admitted under no colour at all
      const key = `${low},${high}`;
      const had = seen.get(key);
      seen.set(key, had ? [low, high, join(had[2], choice)] : [low, high, choice]);
    }
    const transitions = [...seen.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (!transitions.length) throw new Error('a state with no transitions accepts nothing');
    return this.#intern(`N|${level}|${transitions.map(stepKey).join(';')}`,
      () => ({ level, transitions }));
  }

  /**
   * The automaton accepting exactly the given states, each an array of 2^n amplitudes.
   *
   * Every member gets a colour, and every transition is painted with the members that
   * use it. A run that picks member m's colour at every level walks m's tree; one that
   * changes colour partway can only do so where the members it moves between agree,
   * because a state's transitions are painted with the members that pass through *it*.
   *
   * Doing this here rather than leaving the colours for later is what makes the whole
   * pipeline work: `reduce` merges transitions and the colours come along, and a gate
   * intersects them. Nothing downstream ever has to invent a colour.
   */
  fromVectors(vectors) {
    const roots = [];
    for (const amplitudes of vectors) {
      if (amplitudes.length !== 2 ** this.nvars) {
        throw new Error(`a state of ${this.nvars} qubits has ${2 ** this.nvars} amplitudes`);
      }
      roots.push(this.#tree(amplitudes, 0, 0));
    }

    // Which members each uncoloured state belongs to. A state is a subtree, so a member
    // uses it exactly when it is one of that member's own subtrees.
    const used = new Map();
    roots.forEach((r, m) => {
      for (const id of this.reachable(r)) {
        if (!used.has(id)) used.set(id, []);
        used.get(id).push(m);
      }
    });

    // Repaint bottom-up, because a coloured state is a different state from the one it
    // was painted from and its parents have to point at the new one.
    const painted = new Map();
    const paint = (id) => {
      if (this.isLeaf(id)) return id;
      const had = painted.get(id);
      if (had !== undefined) return had;
      const [low, high] = this.transitionsOf(id)[0];
      const made = this.state(this.levelOf(id), [[paint(low), paint(high), used.get(id)]]);
      painted.set(id, made);
      return made;
    };

    const top = this.state(0, roots.map((r, m) => {
      const [low, high] = this.transitionsOf(r)[0];
      return [paint(low), paint(high), [m]];
    }));
    return { root: top, roots };
  }

  /** The single tree an amplitude vector is, as states, before any colour is put on. */
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
   * The colours a run has to choose between, level by level.
   *
   * Only the ones some transition actually names: a colour no transition mentions is
   * admitted by every transition that mentions none, and so tells nothing apart. A level
   * where nothing is named has one nominal colour, which is the plain-automaton case.
   */
  palette(root) {
    const out = Array.from({ length: this.nvars }, () => new Set());
    for (const id of this.reachable(root)) {
      if (this.isLeaf(id)) continue;
      for (const [, , choice] of this.transitionsOf(id)) {
        if (choice !== ANY) for (const c of choice) out[this.levelOf(id)].add(c);
      }
    }
    return out.map((s) => (s.size ? [...s].sort((a, b) => a - b) : [ANY]));
  }

  /**
   * Every quantum state this automaton accepts, as amplitude vectors.
   *
   * Level by level rather than colouring by colouring. A *frontier* is the states one
   * level holds, left to right; a colour is chosen for the level, every state on the
   * frontier takes a transition admitting it, and the children are the next frontier. At
   * the bottom a frontier is a row of leaves, which is a vector.
   *
   * Going down rather than trying every colouring is what makes this usable before the
   * colours have been quotiented: a set of thirty-two members starts with thirty-two
   * colours a level, and all but one of them is refused by the first state that does not
   * name it. Exponential by nature all the same — it is the independent answer the
   * engine is checked against, and `cap` stops it running away.
   */
  language(root, cap = 4096) {
    const admits = (choice, colour) => choice === ANY || colour === ANY || choice.includes(colour);
    let frontiers = [[root]];
    for (let level = 0; level < this.nvars; level++) {
      const next = new Map();
      for (const frontier of frontiers) {
        const named = new Set();
        for (const id of frontier) {
          for (const [, , choice] of this.transitionsOf(id)) {
            if (choice !== ANY) for (const c of choice) named.add(c);
          }
        }
        for (const colour of (named.size ? named : [ANY])) {
          const options = frontier.map((id) => this.transitionsOf(id)
            .filter(([, , choice]) => admits(choice, colour)));
          if (options.some((o) => !o.length)) continue;   // no run under this colour
          // Every way the frontier can take a step, all under the one colour.
          let rows = [[]];
          for (const options_i of options) {
            const grown = [];
            for (const row of rows) {
              for (const [low, high] of options_i) grown.push([...row, low, high]);
            }
            rows = grown;
            if (rows.length > cap) throw new Error(`more than ${cap} runs to follow`);
          }
          for (const row of rows) next.set(row.join(','), row);
          if (next.size > cap) throw new Error(`more than ${cap} states in the language`);
        }
      }
      frontiers = [...next.values()];
    }
    return frontiers.map((row) => row.map((id) => this.valueOf(id)));
  }

  /** Is this tree one of the ones the automaton accepts? */
  accepts(root, amplitudes) {
    return this.language(root).some((v) => v.length === amplitudes.length
      && v.every((x, i) => this.ring.eq(x, amplitudes[i])));
  }
}
