import { snapshot as gitSnapshot } from '../git/snapshot.mjs';
import { prepare, commit } from '../receive/txn.mjs';
import { readProbeCache } from '../roles/availability.mjs';
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

  // Validate --reason-class against the class vocabulary BEFORE it is trusted as
  // explicit intake and bound into the receipt token (iter-3 F11): finalize
  // already does this, so receive must too — an out-of-enum class would seal a
  // meaningless reasonClass verbatim.
  const REASON_CLASSES = ['usage-limit', 'auth', 'throttle', 'other-error'];
  if (flags['reason-class'] !== undefined && !REASON_CLASSES.includes(/** @type {string} */ (flags['reason-class']))) {
    return usageError(io, flags, 'receive', `--reason-class must be one of ${REASON_CLASSES.join('|')}`);
  }

  const root = resolveRoot(io, flags);
  const git = await gitSnapshot({ execFile: io.execFile, cwd: root, fs: io.fs });
  const hasSession = typeof flags.session === 'string';
  const opts = {
    platform,
    origin: typeof flags.origin === 'string' ? flags.origin : 'unknown',
    reason: typeof flags.reason === 'string' ? flags.reason : 'unspecified',
    gitSnapshot: git,
    // The fresh probe cache is a bound token input (probesDigest): remap uses
    // it at prepare, and a cache change before commit is drift → re-prepare.
    probes: readProbeCache(root, io),
    // Explicit reason-class intake (gate-2 iter-2 M4): confirms a failover away
    // from a low-confidence-classified origin; bound into the token.
    ...(typeof flags['reason-class'] === 'string' ? { reasonClass: flags['reason-class'] } : {}),
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
    // --json wraps the prompt in the envelope (gate-2 iter-2 M6); the bare
    // form stays raw markdown — the adapter hook fallback path is unchanged.
    if (flags.json) emitEnvelope(io, { ok: true, data: { prompt: prepared.prompt, warnings: prepared.warnings } });
    else io.stdout.write(prepared.prompt);
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
