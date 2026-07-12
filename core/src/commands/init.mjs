import { dirname } from 'node:path';
import { planInit } from '../scaffold/plan.mjs';
import { planHarnessInit } from '../scaffold/harness.mjs';
import { atomicWriteText, ensureDir } from '../util/fsx.mjs';
import { emitEnvelope, parseFlags, resolveRoot } from './shared.mjs';

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
  const root = resolveRoot(io, flags);

  // Fail-safe read for the two READ-ONLY mode flags: presence wins. parseFlags
  // consumes the next token as a flag's value, so a stray trailing token (a
  // pasted `# comment`, a typo) used to flip `=== true` false and silently run
  // a REAL init where the user asked for a preview. Warn and stay read-only.
  const readOnlyFlag = (/** @type {string} */ name) => {
    if (flags[name] === undefined) return false;
    if (flags[name] !== true) io.stderr.write(`baton init: ignoring unexpected value after --${name} (treated as a bare flag)\n`);
    return true;
  };
  const checkMode = readOnlyFlag('check');
  const dryRun = readOnlyFlag('dry-run');

  /** @type {ReturnType<typeof planInit>} */
  let actions;
  try {
    const base = planInit(root, { force: flags.force === true }, io);
    // Feed the harness writer the gitignore text AS THE BASE SCAFFOLD LEAVES IT
    // (planned write, else current file) so its own ignore lines chain on top —
    // two independent reads would make the later write clobber the earlier one.
    const gi = base.find((a) => a.id === 'gitignore');
    /** @type {string | null} */
    let gitignoreBase = null;
    if (gi?.op === 'write') {
      gitignoreBase = /** @type {string} */ (gi.preview);
    } else {
      try {
        gitignoreBase = io.fs.readFileSync(`${root}/.gitignore`, 'utf8');
      } catch {
        gitignoreBase = null;
      }
    }
    actions = [
      ...base,
      ...planHarnessInit(
        root,
        { codex: flags.codex === true, cursor: flags.cursor === true, withLegacyPrompts: flags['with-legacy-prompts'] === true, gitignoreBase },
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

  // --check (gate-2 fix 9): the CI drift gate. Read-only — a scaffolded tree
  // where init would change nothing passes; anything init would write or
  // refuse is drift and fails the check.
  if (checkMode) {
    const drift = actions.filter((a) => a.op !== 'skip');
    if (flags.json) {
      emitEnvelope(io, {
        ok: drift.length === 0,
        data: { drift: drift.map(({ id, path, op, note }) => ({ id, path, op, note: note ?? null })) },
      });
    } else if (drift.length === 0) {
      io.stdout.write('baton init --check: no drift — rendered files match template output\n');
    } else {
      io.stderr.write(`baton init --check: drift detected — init would write:\n${drift.map((a) => `  ${describe(a)}`).join('\n')}\n`);
    }
    return drift.length === 0 ? 0 : 1;
  }

  if (dryRun) {
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
