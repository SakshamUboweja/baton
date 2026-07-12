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
 * Lint one regex pattern. Together with the load-time worker probe on overlay
 * tables (see probe.mjs), the runtime time-guard is by construction: patterns
 * that could backtrack catastrophically never reach classify(), which stays
 * synchronous with no timers.
 * @param {string} id @param {string} pattern
 */
function lintRegex(id, pattern) {
  if (typeof pattern !== 'string' || pattern.length > REGEX_MAX_LEN) {
    throw new Error(`signature ${id}: regex pattern exceeds the ${REGEX_MAX_LEN}-char length cap (or is not a string)`);
  }
  if (/\\[1-9]/.test(pattern)) {
    throw new Error(`signature ${id}: regex backreferences are not allowed`);
  }
  const problem = scanQuantifiedGroups(pattern);
  if (problem) {
    throw new Error(`signature ${id}: ${problem} (pathological backtracking / non-linear-time risk)`);
  }
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern);
  } catch (err) {
    throw new Error(`signature ${id}: invalid regex pattern (${/** @type {any} */ (err)?.message ?? 'syntax error'})`);
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
  if (s.matcher.kind === 'regex') lintRegex(s.id, s.matcher.pattern);
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
