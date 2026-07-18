import { defaultLoopSpec } from '../loop/spec.mjs';
import { atomicWriteJson, ensureDir } from '../util/fsx.mjs';
import { emitEnvelope, usageError, parseFlagsStrict, resolveRoot } from './shared.mjs';

// Flags that consume a value — needed to split positionals from flag tokens
// without mistaking a flag's value for a positional. Keep in sync with the
// strict spec below plus the implied common string flag (--root).
const STRING_FLAGS = new Set(['root']);

/**
 * `baton loop <subcommand>` — the Layer-2 goal-loop surface. v1 subcommands:
 * `init "<goal>"` (scaffold loop.json; two-phase, idempotent, dry-run-able).
 * Supervisor-side by design: the BATON_SUPERVISED_CHILD guard deliberately
 * does NOT apply here.
 * @param {string[]} args @param {any} io
 * @returns {Promise<number>}
 */
export async function cmdLoop(args, io) {
  /** @type {string[]} */
  const positionals = [];
  /** @type {string[]} */
  const flagTokens = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (typeof a === 'string' && a.startsWith('--')) {
      flagTokens.push(a);
      if (STRING_FLAGS.has(a.slice(2)) && i + 1 < args.length) {
        i += 1;
        flagTokens.push(args[i]);
      }
    } else {
      positionals.push(a);
    }
  }

  const parsed = parseFlagsStrict(flagTokens, { 'dry-run': 'boolean' });
  if (parsed.error !== undefined) return usageError(io, parsed.flags, 'loop', parsed.error);
  const flags = parsed.flags;

  const sub = positionals[0];
  if (sub === undefined) return usageError(io, flags, 'loop', 'a subcommand is required — try: baton loop init "<goal>"');
  if (sub !== 'init') return usageError(io, flags, 'loop', `unknown subcommand '${sub}' (supported: init)`);

  const goal = positionals[1];
  if (goal === undefined) return usageError(io, flags, 'loop', 'loop init requires a goal — baton loop init "<goal>"');
  if (positionals.length > 2) return usageError(io, flags, 'loop', `unexpected argument '${positionals[2]}'`);

  const root = resolveRoot(io, flags);
  const path = `${root}/loop.json`;

  const finish = (/** @type {any} */ data, /** @type {string} */ human) => {
    if (flags.json) emitEnvelope(io, { ok: true, data });
    else io.stdout.write(`${human}\n`);
    return 0;
  };

  // Idempotent: an existing spec is the user's — never overwritten.
  if (io.fs.existsSync(path)) {
    return finish({ created: false, path }, `baton loop init: ${path} already exists — left untouched`);
  }
  if (flags['dry-run'] === true) {
    return finish(
      { created: false, path, dryRun: true },
      `baton loop init (dry-run): would write ${path} — the default baton/loop@1 spec with goal "${goal}"`,
    );
  }
  ensureDir(io.fs, root);
  atomicWriteJson(io.fs, path, defaultLoopSpec(goal));
  return finish({ created: true, path }, `baton loop init: wrote ${path} (goal "${goal}") — edit constraints/smoke, then run baton loop run`);
}
