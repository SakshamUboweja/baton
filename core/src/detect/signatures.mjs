import { probeRegexSafe } from './probe.mjs';

const PLATFORMS = ['claude-code', 'codex', 'cursor'];
const CLASSES = ['usage-limit', 'auth', 'throttle', 'other-error'];
const MATCHER_KINDS = ['substring', 'regex', 'json-field'];
const REGEX_MAX_LEN = 200;

/**
 * Is a quantified group's body ambiguous? Alternation, another quantifier, or
 * any nested group inside a `(…)+`/`(…)*`/`(…){` makes backtracking
 * super-linear in the worst case — conservatively rejected (gate-2 fix 6:
 * the old lint accepted `(a|aa)+$` and the `(a|a)*x` live repro).
 * @param {string} body
 */
function riskyGroupBody(body) {
  // Strip a non-capture/lookaround/named marker so `(?:abc)+` reads as `abc`.
  const b = body.replace(/^\?(?:<=|<!|:|=|!|<[^>]*>)/, '');
  let inClass = false;
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') {
      inClass = true;
      continue;
    }
    if (c === '|' || c === '+' || c === '*' || c === '{' || c === '?' || c === '(' || c === ')') return true;
  }
  return false;
}

/**
 * Structural scan: walk the pattern (class- and escape-aware), and for every
 * group followed by an unbounded quantifier check its full body — any nesting
 * depth — for ambiguity. Returns a problem string or null.
 * @param {string} pattern
 */
function scanQuantifiedGroups(pattern) {
  /** @type {number[]} */
  const opens = [];
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') {
      inClass = true;
      continue;
    }
    if (c === '(') {
      opens.push(i);
      continue;
    }
    if (c === ')') {
      const start = opens.pop();
      if (start === undefined) continue; // unbalanced — new RegExp() reports it
      const next = pattern[i + 1];
      if (next === '+' || next === '*' || next === '{') {
        const body = pattern.slice(start + 1, i);
        if (riskyGroupBody(body)) {
          return `quantified group "(${body})" contains alternation, another quantifier, or a nested group`;
        }
      }
    }
  }
  return null;
}

/**
 * Approximate character-set overlap between two simple-atom alphabets.
 * Descriptors: {all:true} (dot / broad negated shorthand) | {sh:'d'|'w'|'s'} |
 * {lit:Set<string>}. Returns true unless the two sets are PROVABLY disjoint —
 * conservative for untrusted overlays (iter-4 I4).
 * @param {any} a @param {any} b
 */
function alphasOverlap(a, b) {
  if (!a || !b) return false;
  if (a.all || b.all) return true;
  if (a.sh && b.sh) {
    if (a.sh === b.sh) return true;
    // \s is disjoint from \d and \w; \d ⊂ \w so they overlap.
    return !(a.sh === 's' || b.sh === 's');
  }
  if (a.lit && b.lit) {
    for (const c of a.lit) if (b.lit.has(c)) return true;
    return false;
  }
  const sh = a.sh ? a.sh : b.sh;
  const lit = a.lit ? a.lit : b.lit;
  for (const c of lit) {
    if (sh === 'd' && c >= '0' && c <= '9') return true;
    if (sh === 'w' && /[A-Za-z0-9_]/.test(c)) return true;
    if (sh === 's' && /\s/.test(c)) return true;
  }
  return false;
}

/**
 * Structural scan for a run of ≥2 CONSECUTIVE atoms, each with an UNBOUNDED
 * quantifier (`*`, `+`, `{n,}`), whose alphabets overlap — `.*.*…`, `\d*\d*…`,
 * `\(*\(*…`, `\n*\n*…`, `[a-z]*[a-z]*…`. Such a chain partitions the same input
 * combinatorially and backtracks super-linearly, yet is invisible to the
 * quantified-GROUP scan; and because a finite probe alphabet cannot guarantee a
 * non-matching tail for every atom (`.` accepts almost everything), rejecting
 * the STRUCTURE at load is the reliable guard (iter-4 I4, reviewer-a #7 /
 * reviewer-b #3). Groups reset the run (the group scan covers quantified groups;
 * a group's overlap with a simple atom is not decided here). Returns a problem
 * string or null.
 * @param {string} pattern
 * @returns {string | null}
 */
function scanChainedQuantifiedAtoms(pattern) {
  const p = pattern;
  /** @type {any} */
  let prev = null; // alpha of the previous atom IF it carried an unbounded quantifier, else null

  for (let i = 0; i < p.length; ) {
    const c = p[i];
    // Chain-breakers: alternation and anchors end any run.
    if (c === '|' || c === '^' || c === '$') {
      prev = null;
      i += 1;
      continue;
    }
    /** @type {any} */
    let alpha = null;
    let isGroup = false;
    if (c === '\\') {
      const n = p[i + 1];
      // decode length of the escape token
      let len = 2;
      if (n === 'x') len = 4;
      else if (n === 'u') len = p[i + 2] === '{' ? (p.indexOf('}', i) - i + 1) : 6;
      if (n === 'd' || n === 'w' || n === 's') alpha = { sh: n };
      else if (n === 'D' || n === 'W' || n === 'S' || n === 'b' || n === 'B') alpha = { all: true }; // broad/negated or anchor-ish → conservative
      else alpha = { lit: new Set([decodeEscape(p.slice(i, i + len))]) }; // \(, \n, \t, \xNN, \uNNNN → the literal char
      i += Math.max(2, len);
    } else if (c === '[') {
      const end = classEnd(p, i);
      const body = p.slice(i + 1, end);
      alpha = body.startsWith('^') ? { all: true } : classAlpha(body);
      i = end + 1;
    } else if (c === '(') {
      // Skip the whole group (balance-aware); recurse into its body for chains.
      const end = groupEnd(p, i);
      const inner = scanChainedQuantifiedAtoms(p.slice(i + 1, end));
      if (inner) return inner;
      isGroup = true;
      i = end + 1;
    } else if (c === '.') {
      alpha = { all: true };
      i += 1;
    } else {
      alpha = { lit: new Set([c]) };
      i += 1;
    }

    // Read an optional quantifier and classify it as unbounded or not.
    let unbounded = false;
    const q = p[i];
    if (q === '*' || q === '+') {
      unbounded = true;
      i += 1;
    } else if (q === '{') {
      const close = p.indexOf('}', i);
      if (close !== -1) {
        const spec = p.slice(i + 1, close);
        // {n,} (no upper bound) is unbounded; {n} and {n,m} are bounded.
        unbounded = /^\d+,\s*$/.test(spec);
        i = close + 1;
      }
    } else if (q === '?') {
      i += 1;
    }
    // consume a lazy/possessive modifier if present
    if (p[i] === '?' || p[i] === '+') i += 1;

    if (isGroup) {
      // A group breaks the simple-atom run.
      prev = null;
      continue;
    }
    // prev + current = a run of ≥2 CONSECUTIVE overlapping unbounded-quantified
    // atoms → super-linear backtracking. Reject.
    if (unbounded && prev && alphasOverlap(prev, alpha)) {
      return 'chained overlapping unbounded quantifiers (e.g. `.*.*`, `\\d*\\d*`, `\\(*\\(*`) backtrack super-linearly';
    }
    prev = unbounded ? alpha : null;
  }
  return null;
}

/** Decode a single-char escape token (`\(`, `\n`, `\t`, `\xNN`, `\uNNNN`, `\u{...}`) to its literal char. @param {string} tok */
function decodeEscape(tok) {
  const rest = tok.slice(1);
  if (rest[0] === 'x') return String.fromCharCode(parseInt(rest.slice(1, 3), 16));
  if (rest[0] === 'u') {
    const h = rest[1] === '{' ? rest.slice(2, rest.indexOf('}')) : rest.slice(1, 5);
    try {
      return String.fromCodePoint(parseInt(h, 16));
    } catch {
      return rest[0];
    }
  }
  const named = { n: '\n', t: '\t', r: '\r', f: '\f', v: '\v', 0: '\0' };
  return named[/** @type {'n'} */ (rest[0])] ?? rest[0];
}

/** Index of the `]` closing a class opened at `open` (a `]` immediately after `[`/`[^` is a literal). @param {string} p @param {number} open */
function classEnd(p, open) {
  let i = open + 1;
  if (p[i] === '^') i += 1;
  if (p[i] === ']') i += 1; // leading ] is literal
  for (; i < p.length; i++) {
    if (p[i] === '\\') {
      i += 1;
      continue;
    }
    if (p[i] === ']') return i;
  }
  return p.length - 1;
}

/** Index of the `)` closing a group opened at `open` (balance-aware, class/escape-safe). @param {string} p @param {number} open */
function groupEnd(p, open) {
  let depth = 0;
  let inClass = false;
  for (let i = open; i < p.length; i++) {
    const c = p[i];
    if (c === '\\') {
      i += 1;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return p.length - 1;
}

/** Approximate alphabet of a (non-negated) class body: literals + range endpoints + shorthands. @param {string} body */
function classAlpha(body) {
  if (/\\[dwsDWS]/.test(body) || /\\[DWS]/.test(body)) return { all: true }; // shorthand inside a class → treat broadly
  /** @type {Set<string>} */
  const lit = new Set();
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\') {
      lit.add(decodeEscape(body.slice(i, i + 2)));
      i += 1;
      continue;
    }
    // range a-z: add endpoints (a run of an endpoint char backtracks the same)
    if (body[i + 1] === '-' && body[i + 2] !== undefined) {
      lit.add(body[i]);
      lit.add(body[i + 2]);
      i += 2;
      continue;
    }
    lit.add(body[i]);
  }
  return { lit };
}

const ALLOWED_FLAGS = 'dgimsuvy';

/**
 * Validate a regex flags string (gate-2 iter-2 B3): every char must be an
 * allowed JS flag with no duplicates, so a flags value that compiles nowhere
 * (`z`, `ii`) is rejected at LOAD, not left to throw later inside classify().
 * @param {string} id @param {string} flags
 */
function lintFlags(id, flags) {
  if (typeof flags !== 'string') throw new Error(`signature ${id}: regex flags must be a string`);
  const seen = new Set();
  for (const c of flags) {
    if (!ALLOWED_FLAGS.includes(c)) throw new Error(`signature ${id}: unsupported regex flag "${c}" (allowed: ${ALLOWED_FLAGS})`);
    if (seen.has(c)) throw new Error(`signature ${id}: duplicate regex flag "${c}"`);
    seen.add(c);
  }
}

/**
 * Lint one regex pattern together with its flags. With the load-time worker
 * probe on overlay tables (see probe.mjs), the runtime time-guard is by
 * construction: patterns that could backtrack catastrophically never reach
 * classify(), which stays synchronous with no timers.
 * @param {string} id @param {string} pattern @param {string} [flags]
 */
function lintRegex(id, pattern, flags = '') {
  if (typeof pattern !== 'string' || pattern.length > REGEX_MAX_LEN) {
    throw new Error(`signature ${id}: regex pattern exceeds the ${REGEX_MAX_LEN}-char length cap (or is not a string)`);
  }
  if (/\\[1-9]/.test(pattern)) {
    throw new Error(`signature ${id}: regex backreferences are not allowed`);
  }
  lintFlags(id, flags);
  const problem = scanQuantifiedGroups(pattern) || scanChainedQuantifiedAtoms(pattern);
  if (problem) {
    throw new Error(`signature ${id}: ${problem} (pathological backtracking / non-linear-time risk)`);
  }
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern, flags);
  } catch (err) {
    throw new Error(`signature ${id}: invalid regex pattern/flags (${/** @type {any} */ (err)?.message ?? 'syntax error'})`);
  }
}

/** @param {any} s */
function lintSignature(s) {
  if (typeof s.id !== 'string' || s.id.length === 0) throw new Error('signature with missing id');
  if (!PLATFORMS.includes(s.platform)) {
    throw new Error(`signature ${s.id}: unknown platform "${s.platform}" (expected ${PLATFORMS.join('|')})`);
  }
  if (!CLASSES.includes(s.class)) throw new Error(`signature ${s.id}: unknown class "${s.class}"`);
  if (!s.matcher || !MATCHER_KINDS.includes(s.matcher.kind)) {
    throw new Error(`signature ${s.id}: unknown matcher kind "${s.matcher?.kind}" (expected ${MATCHER_KINDS.join('|')})`);
  }
  if (s.matcher.kind === 'regex') lintRegex(s.id, s.matcher.pattern, s.matcher.flags ?? '');
  if (s.matcher.kind === 'substring' && typeof s.matcher.value !== 'string') {
    throw new Error(`signature ${s.id}: substring matcher needs a string value`);
  }
  if (s.matcher.kind === 'json-field' && typeof s.matcher.path !== 'string') {
    throw new Error(`signature ${s.id}: json-field matcher needs a dotted string path`);
  }
  if (s.resetHint !== undefined) lintRegex(s.id, s.resetHint);
}

/** @param {any} fs @param {string} path @param {{probe?: boolean}} [opts] */
function readTable(fs, path, opts = {}) {
  const raw = fs.readFileSync(path, 'utf8');
  const table = JSON.parse(raw);
  if (table?.schema !== 'baton/signatures@1') {
    throw new Error(`signature table at ${path}: expected schema baton/signatures@1, got ${JSON.stringify(table?.schema)}`);
  }
  if (!Array.isArray(table.signatures)) throw new Error(`signature table at ${path}: signatures must be an array`);
  for (const s of table.signatures) {
    lintSignature(s);
    // Overlay tables are untrusted: the structural lint cannot see group-free
    // pathological shapes (chained stars), so every overlay regex additionally
    // runs against adversarial inputs in a worker with a hard deadline.
    if (opts.probe === true) {
      for (const pattern of [s.matcher?.kind === 'regex' ? s.matcher.pattern : null, s.resetHint ?? null]) {
        if (typeof pattern !== 'string') continue;
        const verdict = probeRegexSafe(pattern, s.matcher?.flags ?? '');
        if (!verdict.safe) throw new Error(`signature ${s.id}: ${verdict.reason}`);
      }
    }
  }
  return table;
}

/**
 * Load + validate the signature table, merging an optional overlay by id
 * (later wins — the drift-absorbing hot-patch surface). Builtin patterns are
 * package-shipped and statically linted; overlay patterns are additionally
 * probe-guarded at load.
 * @param {{builtinPath: string, overlayPath?: string}} paths @param {any} io
 */
export function loadSignatures({ builtinPath, overlayPath }, io) {
  const base = readTable(io.fs, builtinPath);
  if (!overlayPath) return base;

  const overlay = readTable(io.fs, overlayPath, { probe: true });
  const merged = [...base.signatures];
  for (const s of overlay.signatures) {
    const i = merged.findIndex((b) => b.id === s.id);
    if (i === -1) merged.push(s);
    else merged[i] = s;
  }
  return { ...base, updated: overlay.updated ?? base.updated, signatures: merged };
}
