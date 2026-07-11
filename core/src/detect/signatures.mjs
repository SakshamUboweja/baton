const PLATFORMS = ['claude-code', 'codex', 'cursor'];
const CLASSES = ['usage-limit', 'auth', 'throttle', 'other-error'];
const MATCHER_KINDS = ['substring', 'regex', 'json-field'];
const REGEX_MAX_LEN = 200;

/**
 * Lint one regex pattern. The runtime time-guard is by construction: patterns
 * that could backtrack catastrophically never pass this lint, so classify()
 * stays synchronous with no timers.
 * @param {string} id @param {string} pattern
 */
function lintRegex(id, pattern) {
  if (typeof pattern !== 'string' || pattern.length > REGEX_MAX_LEN) {
    throw new Error(`signature ${id}: regex pattern exceeds the ${REGEX_MAX_LEN}-char length cap (or is not a string)`);
  }
  if (/\\[1-9]/.test(pattern)) {
    throw new Error(`signature ${id}: regex backreferences are not allowed`);
  }
  if (/\((?:[^()\\]|\\.)*[+*]\)\s*[+*{]/.test(pattern)) {
    throw new Error(`signature ${id}: nested-quantifier construct rejected (pathological backtracking / non-linear-time risk)`);
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

/** @param {any} fs @param {string} path */
function readTable(fs, path) {
  const raw = fs.readFileSync(path, 'utf8');
  const table = JSON.parse(raw);
  if (table?.schema !== 'baton/signatures@1') {
    throw new Error(`signature table at ${path}: expected schema baton/signatures@1, got ${JSON.stringify(table?.schema)}`);
  }
  if (!Array.isArray(table.signatures)) throw new Error(`signature table at ${path}: signatures must be an array`);
  for (const s of table.signatures) lintSignature(s);
  return table;
}

/**
 * Load + validate the signature table, merging an optional overlay by id
 * (later wins — the drift-absorbing hot-patch surface).
 * @param {{builtinPath: string, overlayPath?: string}} paths @param {any} io
 */
export function loadSignatures({ builtinPath, overlayPath }, io) {
  const base = readTable(io.fs, builtinPath);
  if (!overlayPath) return base;

  const overlay = readTable(io.fs, overlayPath);
  const merged = [...base.signatures];
  for (const s of overlay.signatures) {
    const i = merged.findIndex((b) => b.id === s.id);
    if (i === -1) merged.push(s);
    else merged[i] = s;
  }
  return { ...base, updated: overlay.updated ?? base.updated, signatures: merged };
}
