import { normSep, joinNorm } from '../util/pathnorm.mjs';

/**
 * The --json contract: exactly one compact envelope line on stdout, nothing else.
 * @param {any} io
 * @param {{ok: boolean, data?: any, warnings?: any[], error?: {code: string, msg: string} | null}} env
 */
export function emitEnvelope(io, env) {
  const full = { ok: env.ok, data: env.data ?? null, warnings: env.warnings ?? [], error: env.error ?? null };
  io.stdout.write(JSON.stringify(full) + '\n');
}

/**
 * Centralized usage-error emission (gate-2 fix 11): with --json the envelope
 * contract holds even for bad invocations; otherwise a one-line stderr
 * message. Always returns the usage exit code 2.
 * @param {any} io @param {Record<string, string | boolean>} flags
 * @param {string} cmd @param {string} msg
 * @returns {number}
 */
export function usageError(io, flags, cmd, msg) {
  if (flags.json === true) emitEnvelope(io, { ok: false, error: { code: 'usage', msg } });
  else io.stderr.write(`baton ${cmd}: ${msg}\n`);
  return 2;
}

/**
 * Repo-root discovery (plan §Root discovery): `--root` wins; else the nearest
 * ancestor of io.cwd carrying `.handoff/` or `baton.config.json`; else the
 * nearest ancestor carrying `.git` (the repo toplevel — and a boundary the
 * walk never crosses, so a nested repo resolves to itself); else io.cwd.
 * @param {any} io @param {Record<string, string | boolean>} flags
 * @returns {string}
 */
export function resolveRoot(io, flags) {
  if (typeof flags.root === 'string' && flags.root.length > 0) return flags.root;
  // Normalize separators up front (gate-2 iter-2 M2): a Windows cwd arrives
  // backslash-separated, but Node fs accepts forward slashes, so the ascent
  // and the marker checks work in one forward-slash space. The last separator
  // is either kind; the loop stops at a drive/UNC or filesystem root.
  const start = normSep(io.cwd);
  let dir = start;
  while (true) {
    try {
      if (io.fs.existsSync(joinNorm(dir, '.handoff')) || io.fs.existsSync(joinNorm(dir, 'baton.config.json'))) return dir;
      if (io.fs.existsSync(joinNorm(dir, '.git'))) return dir; // repo toplevel; never walk past a .git boundary
    } catch {
      break;
    }
    const cut = dir.lastIndexOf('/');
    if (cut < 0) break;
    const parent = cut === 0 ? '/' : dir.slice(0, cut);
    // At a drive-relative ceiling ("C:") examine the drive ROOT ("C:/") once —
    // a repo can live directly at C:/ (iter-3 F6) — then stop.
    if (/^[A-Za-z]:$/.test(parent)) {
      const driveRoot = `${parent}/`;
      if (driveRoot !== dir) {
        dir = driveRoot;
        continue;
      }
      break;
    }
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

/**
 * True when this process is a loop-supervised child (BATON_SUPERVISED_CHILD
 * set to any non-empty value). Supervised children must never read or write
 * any bundle and never receive resume context — hook-invoked commands check
 * this BEFORE flag parsing and silently no-op (exit 0, empty output) so the
 * supervisor never has to filter child output or nonzero exits.
 * @param {any} io
 * @returns {boolean}
 */
export function isSupervisedChild(io) {
  const v = io?.env?.BATON_SUPERVISED_CHILD;
  return typeof v === 'string' && v.length > 0;
}

/** The supported platform enum, validated wherever a platform id is intake. */
export const PLATFORMS = ['claude-code', 'codex', 'cursor'];

/**
 * Validate a platform id against the enum (surface-audit fold): a typo'd
 * platform used to silently seed persistent state whose bogus origin then
 * rejected the REAL platform's checkpoints as foreign.
 * @param {string | boolean | undefined} value
 * @returns {string | null} an error message, or null when valid/absent
 */
export function platformError(value) {
  if (value === undefined) return null;
  if (typeof value === 'string' && PLATFORMS.includes(value)) return null;
  return `platform must be one of ${PLATFORMS.join('|')} (got ${JSON.stringify(value)})`;
}

/**
 * Strict flag parser (surface-audit fold; docs/design/core.md §tooling always
 * specified strict parsing). spec maps each flag name to 'string' | 'boolean';
 * `json` and `root` are implied common flags. Errors — unknown flag, stray
 * positional, missing string-flag value — return {error} so the command exits
 * 2 instead of silently losing intent: the lenient parser let a stray token
 * flip SAFETY flags off (checkpoint/doctor --strict, remap --native-only,
 * receive --print-prompt all read fail-dangerous exit 0).
 * @param {string[]} args
 * @param {Record<string, 'string' | 'boolean'>} spec
 * @returns {{flags: Record<string, string | boolean>, error?: string}}
 */
export function parseFlagsStrict(args, spec) {
  /** @type {Record<string, 'string' | 'boolean'>} */
  const full = { json: 'boolean', root: 'string', ...spec };
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!a.startsWith('--')) return { flags, error: `unexpected argument '${a}' — flags are --name [value]` };
    const key = a.slice(2);
    const kind = full[key];
    if (kind === undefined) return { flags, error: `unknown flag --${key}` };
    if (kind === 'boolean') {
      // A following token that is not a flag would have been this flag's
      // silent "value" under the lenient parser; reject it loudly.
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        return { flags, error: `unexpected token '${next}' after --${key} (a bare flag takes no value)` };
      }
      flags[key] = true;
      continue;
    }
    const next = args[i + 1];
    // A string flag consumes the next token unless it is itself a KNOWN flag
    // (so `--commit --origin x` errors instead of eating '--origin').
    if (next === undefined || (next.startsWith('--') && full[next.slice(2)] !== undefined)) {
      return { flags, error: `--${key} requires a value` };
    }
    flags[key] = next;
    i += 1;
  }
  return { flags };
}

/**
 * Minimal flag parser: `--key value` pairs (value = next token not starting
 * with --), bare `--key` booleans, positionals collected in order.
 * @param {string[]} args
 * @returns {{flags: Record<string, string | boolean>, positionals: string[]}}
 */
export function parseFlags(args) {
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  /** @type {string[]} */
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  return { flags, positionals };
}
