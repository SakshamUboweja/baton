import { bundlePaths, loadBundle, writeSnapshot, appendJournal, rotateJournal } from '../bundle/store.mjs';
import { emptyBundle } from '../bundle/schema.mjs';
import { normalizeHookPayload } from '../bundle/normalize.mjs';
import { dedupeKey } from '../util/ids.mjs';
import { safeReadJson } from '../util/fsx.mjs';
import { parseFlags, resolveRoot } from './shared.mjs';

// Snapshot rewrite throttle: journal append ALWAYS; the snapshot (and
// HANDOFF.md) re-render only on an important event type, >30 s since the last
// snapshot, or >=10 accreted events (plan §Checkpoint engine).
const ROUTINE_TYPES = new Set(['note', 'file.touch']);
const THROTTLE_WINDOW_MS = 30_000;
const THROTTLE_EVENT_COUNT = 10;

/**
 * `baton checkpoint` — mechanical checkpoint from a hook payload on stdin.
 * Hook-safety rule: exit 0 on every soft failure so a checkpoint can never
 * break the host harness; `--strict` opts into hard failures (CI).
 * @param {string[]} args @param {any} io
 * @returns {Promise<number>}
 */
export async function cmdCheckpoint(args, io) {
  const { flags } = parseFlags(args);
  const strict = flags.strict === true;
  const platform = typeof flags.platform === 'string' ? flags.platform : null;
  if (!platform) {
    io.stderr.write('baton checkpoint: --platform <claude-code|codex|cursor> is required\n');
    return 2;
  }

  try {
    return run(flags, platform, io);
  } catch (err) {
    const msg = /** @type {any} */ (err)?.message ?? String(err);
    io.stderr.write(`baton checkpoint: ${msg}\n`);
    return strict ? 1 : 0;
  }
}

/**
 * @param {Record<string, string | boolean>} flags
 * @param {string} platform
 * @param {any} io
 * @returns {number}
 */
function run(flags, platform, io) {
  const strict = flags.strict === true;
  const root = resolveRoot(io, flags);
  const paths = bundlePaths(root);

  /** @type {any} */
  let raw;
  try {
    raw = JSON.parse(typeof io.stdin === 'string' ? io.stdin : '');
  } catch {
    io.stderr.write('baton checkpoint: stdin could not be parsed as JSON — input ignored\n');
    return strict ? 1 : 0;
  }

  const session = { host: io.host, pid: io.pid, startTime: io.startTime };
  const events = normalizeHookPayload(raw, platform, session);
  if (events.length === 0) return 0;

  const { bundle, warnings } = loadBundle(root, io);
  for (const w of warnings) io.stderr.write(`baton checkpoint: ${w}\n`);

  let active = bundle;
  let mustRewrite = false;

  // Semantic isolation (plan §Concurrency): a stable foreign session or a
  // mismatched origin platform must not merge into the active bundle. Checked
  // before ANY write so a rejection leaves the whole tree untouched.
  const originHint = active?.origin?.sessionHint;
  const hasStableOwner = active !== null && typeof originHint === 'string' && originHint.length > 0 && active.origin.unstable !== true;
  const stableIncoming = events.find(
    (/** @type {any} */ e) => typeof e.sessionHint === 'string' && e.sessionHint.length > 0 && e.unstable === false,
  );
  const unstableIncoming = events.some((/** @type {any} */ e) => e.unstable === true);

  if (hasStableOwner && stableIncoming) {
    const foreign = stableIncoming.sessionHint !== originHint || platform !== active.origin.platform;
    if (foreign && flags['take-over'] !== true) {
      io.stderr.write(
        `baton checkpoint: event from a foreign session/origin (${platform}/${stableIncoming.sessionHint} vs active ${active.origin.platform}/${originHint}) — rejected to keep sessions isolated; rerun with --take-over to archive the active bundle and start fresh\n`,
      );
      return 0;
    }
    if (foreign) {
      rotateJournal(root, 'takeover', io);
      const fresh = emptyBundle(
        { platform, model: typeof flags.model === 'string' ? flags.model : 'unknown', goal: active.task?.goal ?? 'unknown' },
        io.now(),
      );
      fresh.origin.sessionHint = stableIncoming.sessionHint;
      writeSnapshot(root, fresh, io);
      io.stderr.write(`baton checkpoint: took over — prior bundle archived to history/, fresh bundle owned by ${platform}/${stableIncoming.sessionHint}\n`);
      active = fresh;
      mustRewrite = true;
    }
  }

  if (unstableIncoming) {
    io.stderr.write('baton checkpoint: event carries an unstable (generated) session hint — ownership unverifiable; applied with this warning only\n');
  }

  if (active === null) {
    active = emptyBundle(
      { platform, model: typeof flags.model === 'string' ? flags.model : 'unknown', goal: 'unknown' },
      io.now(),
    );
    writeSnapshot(root, active, io);
    io.stderr.write('baton checkpoint: no bundle found — auto-seeded a new one at .handoff/bundle.json\n');
    mustRewrite = true;
  }

  // Ownership adoption (gate-2 fix 2): a bundle whose owner is unverified — a
  // fresh seed (null hint) or a receive that defaulted to an unstable hint —
  // adopts the first STABLE same-platform session as its owner, so semantic
  // isolation engages from then on instead of never.
  const ownerUnverified = active.origin.sessionHint === null || active.origin.unstable === true;
  if (ownerUnverified && stableIncoming && active.origin.platform === platform) {
    active = { ...active, origin: { ...active.origin, sessionHint: stableIncoming.sessionHint, unstable: false } };
    writeSnapshot(root, active, io);
    io.stderr.write(`baton checkpoint: adopted ${platform}/${stableIncoming.sessionHint} as the bundle owner (first verified session)\n`);
    mustRewrite = true;
  }

  let lastSeq = 0;
  for (const ev of events) {
    const ts = typeof ev.ts === 'string' ? ev.ts : io.now();
    const entry = {
      ...ev,
      ts,
      dedupeKey:
        typeof ev.dedupeKey === 'string' && ev.dedupeKey.length > 0
          ? ev.dedupeKey
          : dedupeKey({ ts, type: ev.type, payload: ev.payload, source: ev.source, sessionHint: ev.sessionHint }),
      writerId: [platform, io.pid, ev.sessionHint ?? 'local'].join('-'),
    };
    lastSeq = appendJournal(root, entry, io);
  }

  const snap = safeReadJson(io.fs, paths.snapshot);
  const snapSeq = snap.ok && typeof snap.value?.journalSeq === 'number' ? snap.value.journalSeq : 0;
  const snapUpdated = snap.ok && typeof snap.value?.updatedAt === 'string' ? Date.parse(snap.value.updatedAt) : 0;
  const important = events.some((/** @type {any} */ e) => !ROUTINE_TYPES.has(e.type));
  const elapsed = Date.parse(io.now()) - snapUpdated > THROTTLE_WINDOW_MS;
  const accreted = lastSeq - snapSeq;

  if (mustRewrite || important || elapsed || accreted >= THROTTLE_EVENT_COUNT) {
    const merged = loadBundle(root, io).bundle;
    if (merged) writeSnapshot(root, merged, io);
  }
  return 0;
}
