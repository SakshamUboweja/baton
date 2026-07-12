import { dirname } from 'node:path';
import { planInit } from '../scaffold/plan.mjs';
import { planHarnessInit } from '../scaffold/harness.mjs';
import { atomicWriteText, ensureDir } from '../util/fsx.mjs';
import { emitEnvelope, parseFlags } from './shared.mjs';

/**
 * `baton init` — two-phase scaffolder. The plan phase (planInit) is read-only;
 * `--dry-run` stops there. Apply writes each planned action atomically;
 * refusals (malformed settings, corrupt markers) warn and leave their file
 * untouched while the rest of the scaffold still lands.
 * @param {string[]} args @param {any} io
 * @returns {Promise<number>}
 */
export async function cmdInit(args, io) {
  const { flags } = parseFlags(args);

  /** @type {ReturnType<typeof planInit>} */
  let actions;
  try {
    actions = [
      ...planInit(io.cwd, { force: flags.force === true }, io),
      ...planHarnessInit(
        io.cwd,
        { codex: flags.codex === true, cursor: flags.cursor === true, withLegacyPrompts: flags['with-legacy-prompts'] === true },
        io,
      ),
    ];
  } catch (err) {
    const msg = /** @type {any} */ (err)?.message ?? String(err);
    if (flags.json) emitEnvelope(io, { ok: false, error: { code: 'plan-failed', msg } });
    else io.stderr.write(`baton init: ${msg}\n`);
    return 1;
  }

  const describe = (/** @type {any} */ a) =>
    a.op === 'write' ? `write ${a.path}` : a.op === 'skip' ? `skip  ${a.path} (${a.note})` : `REFUSE ${a.path} — ${a.note}`;

  if (flags['dry-run'] === true) {
    if (flags.json) {
      emitEnvelope(io, { ok: true, data: { dryRun: true, actions: actions.map(({ id, path, op, note }) => ({ id, path, op, note: note ?? null })) } });
    } else {
      io.stdout.write(`baton init plan (dry run — nothing written):\n${actions.map((a) => `  ${describe(a)}`).join('\n')}\n`);
    }
    return 0;
  }

  /** @type {string[]} */
  const warnings = [];
  for (const a of actions) {
    if (a.op === 'refuse') {
      warnings.push(a.note ?? `refused ${a.path}`);
      continue;
    }
    if (a.op !== 'write') continue;
    ensureDir(io.fs, dirname(a.path));
    atomicWriteText(io.fs, a.path, /** @type {string} */ (a.preview));
  }
  for (const w of warnings) io.stderr.write(`baton init: ${w} — left untouched\n`);

  if (flags.json) {
    emitEnvelope(io, {
      ok: true,
      data: { actions: actions.map(({ id, path, op, note }) => ({ id, path, op, note: note ?? null })) },
      warnings,
    });
  } else {
    io.stdout.write(`baton init:\n${actions.map((a) => `  ${describe(a)}`).join('\n')}\n`);
  }
  return 0;
}
