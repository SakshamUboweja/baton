import { snapshot as gitSnapshot } from '../git/snapshot.mjs';
import { prepare, commit } from '../receive/txn.mjs';
import { emitEnvelope, parseFlags, resolveRoot, usageError } from './shared.mjs';

/**
 * `baton receive` — the two-phase resume flow. `--print-prompt` and
 * `--prepare` are read-only (prepare mutates nothing); `--commit <token>`
 * performs the atomic transition. The receiving session hint defaults to a
 * host-stable value so prepare and commit issued by separate CLI processes
 * still derive the same token; adapters pass `--session` with their real id.
 * @param {string[]} args @param {any} io
 * @returns {Promise<number>}
 */
export async function cmdReceive(args, io) {
  const { flags } = parseFlags(args);
  const platform = typeof flags.platform === 'string' ? flags.platform : null;
  if (!platform) return usageError(io, flags, 'receive', '--platform <claude-code|codex|cursor> is required');

  const root = resolveRoot(io, flags);
  const git = await gitSnapshot({ execFile: io.execFile, cwd: root, fs: io.fs });
  const hasSession = typeof flags.session === 'string';
  const opts = {
    platform,
    origin: typeof flags.origin === 'string' ? flags.origin : 'unknown',
    reason: typeof flags.reason === 'string' ? flags.reason : 'unspecified',
    gitSnapshot: git,
    probes: null,
    sessionHint: hasSession ? /** @type {string} */ (flags.session) : `cli:${io.host}`,
    // A defaulted host-derived hint is NOT the harness session id — mark it
    // unstable so the receiving session's first real hook checkpoint adopts
    // ownership instead of being rejected as foreign (gate-2 fix 2).
    sessionUnstable: !hasSession,
  };

  if (typeof flags.commit === 'string') {
    try {
      const res = commit(root, flags.commit, opts, io);
      if (flags.json) emitEnvelope(io, { ok: true, data: res });
      else io.stdout.write(`received — generation ${res.generation} open on ${platform}; archived ${res.archivedTo}\n`);
      return 0;
    } catch (err) {
      const msg = /** @type {any} */ (err)?.message ?? String(err);
      if (flags.json) emitEnvelope(io, { ok: false, error: { code: 'commit-rejected', msg } });
      else io.stderr.write(`baton receive: ${msg}\n`);
      return 1;
    }
  }

  /** @type {ReturnType<typeof prepare>} */
  let prepared;
  try {
    prepared = prepare(root, opts, io);
  } catch (err) {
    const msg = /** @type {any} */ (err)?.message ?? String(err);
    if (flags.json) emitEnvelope(io, { ok: false, error: { code: 'prepare-failed', msg } });
    else io.stderr.write(`baton receive: ${msg}\n`);
    return 1;
  }

  if (flags['print-prompt'] === true) {
    io.stdout.write(prepared.prompt);
    return 0;
  }

  if (flags.json) {
    emitEnvelope(io, {
      ok: true,
      data: { token: prepared.token, prompt: prepared.prompt, assignments: prepared.assignments, warnings: prepared.warnings },
    });
  } else {
    for (const w of prepared.warnings) io.stderr.write(`baton receive: ${w}\n`);
    io.stderr.write(`baton receive: token ${prepared.token}\n`);
    io.stdout.write(prepared.prompt);
  }
  return 0;
}
