import { bundlePaths, loadBundle, writeSnapshot, appendJournal, rotateJournal } from '../bundle/store.mjs';
import { emptyBundle } from '../bundle/schema.mjs';
import { normalizeHookPayload } from '../bundle/normalize.mjs';
import { snapshot as gitSnapshot } from '../git/snapshot.mjs';
import { dedupeKey } from '../util/ids.mjs';
import { safeReadJson } from '../util/fsx.mjs';
import { redactSecrets } from '../util/redact.mjs';
import { emitEnvelope, parseFlags, resolveRoot, usageError } from './shared.mjs';

// Snapshot rewrite throttle: journal append ALWAYS; the snapshot (and
// HANDOFF.md) re-render only on an important event type, >30 s since the last
// snapshot, or >=10 accreted events (plan §Checkpoint engine).
const ROUTINE_TYPES = new Set(['note', 'file.touch']);
const THROTTLE_WINDOW_MS = 30_000;
const THROTTLE_EVENT_COUNT = 10;

// Transcript tail bounds (plan §Transcript policy): last 10 messages, 8 KB cap,
// opt-in via baton.config.json capture.transcriptTail, PreCompact only.
const TAIL_MESSAGES = 10;
const TAIL_BYTES = 8192;

/**
 * Opt-in transcript-tail capture (gate-2 fix 10). Returns the bounded,
 * redacted tail or null when the gate is closed: config off (the default),
 * not a PreCompact payload, no usable transcript_path, or an unreadable /
 * symlinked file. The path comes from an untrusted hook payload — it is read
 * only under explicit opt-in, must lstat as a regular file, and its content
 * passes the secret-redaction filter before storage.
 * @param {string} root @param {any} raw parsed hook payload @param {any} io
 * @returns {string | null}
 */
function captureTranscriptTail(root, raw, io) {
  const cfg = safeReadJson(io.fs, `${root}/baton.config.json`);
  if (!cfg.ok || cfg.value?.capture?.transcriptTail !== true) return null;

  const eventName = raw && typeof raw === 'object' ? (raw.hook_event_name ?? raw.event) : null;
  if (typeof eventName !== 'string' || !/precompact/i.test(eventName)) return null;
  const path = raw.transcript_path;
  if (typeof path !== 'string' || path.length === 0) return null;

  try {
    if (!io.fs.lstatSync(path).isFile()) return null;
    const text = io.fs.readFileSync(path, 'utf8');
    const lines = text.split('\n').filter((/** @type {string} */ l) => l.trim() !== '');
    let tail = lines.slice(-TAIL_MESSAGES).join('\n');
    if (Buffer.byteLength(tail) > TAIL_BYTES) {
      tail = Buffer.from(tail).subarray(-TAIL_BYTES).toString('utf8');
    }
    return redactSecrets(tail);
  } catch {
    return null; // unreadable transcript is never a checkpoint failure
  }
}

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
  if (!platform) return usageError(io, flags, 'checkpoint', '--platform <claude-code|codex|cursor> is required');

  try {
    return await run(flags, platform, io);
  } catch (err) {
    const msg = /** @type {any} */ (err)?.message ?? String(err);
    if (flags.json) emitEnvelope(io, { ok: false, error: { code: 'checkpoint-failed', msg } });
    io.stderr.write(`baton checkpoint: ${msg}\n`);
    return strict ? 1 : 0;
  }
}

/**
 * @param {Record<string, string | boolean>} flags
 * @param {string} platform
 * @param {any} io
 * @returns {Promise<number>}
 */
async function run(flags, platform, io) {
  const strict = flags.strict === true;
  const root = resolveRoot(io, flags);
  const paths = bundlePaths(root);
  // The --json contract (gate-2 fix 11): exactly one envelope on stdout for
  // every exit path — the exit code stays governed by hook-safety.
  const finish = (/** @type {any} */ env, /** @type {number} */ code) => {
    if (flags.json) emitEnvelope(io, env);
    return code;
  };

  /** @type {any} */
  let raw;
  try {
    raw = JSON.parse(typeof io.stdin === 'string' ? io.stdin : '');
  } catch {
    io.stderr.write('baton checkpoint: stdin could not be parsed as JSON — input ignored\n');
    return finish({ ok: false, error: { code: 'bad-stdin', msg: 'stdin could not be parsed as JSON' } }, strict ? 1 : 0);
  }

  const session = { host: io.host, pid: io.pid, startTime: io.startTime };
  const events = normalizeHookPayload(raw, platform, session);
  if (events.length === 0) return finish({ ok: true, data: { events: 0, rewritten: false } }, 0);

  // Opt-in transcript tail (gate-2 fix 10): rides the journal as its own
  // IMPORTANT event so the snapshot rewrite below persists it, and purge can
  // strip it from every retained copy by its property name.
  const tail = captureTranscriptTail(root, raw, io);
  if (tail !== null) {
    events.push({
      type: 'transcript.set',
      payload: { transcript: { capturedAt: io.now(), tail } },
      source: platform,
      sessionHint: events[0]?.sessionHint,
      unstable: events[0]?.unstable ?? true,
    });
  }

  const { bundle, warnings, unsafe } = loadBundle(root, io);
  for (const w of warnings) io.stderr.write(`baton checkpoint: ${w}\n`);

  // An unsafe managed tree (symlinked .handoff — gate-2 fix 6) is NOT "no
  // bundle yet": seeding here would write through the link. Refuse everything;
  // hook-safety keeps the refusal soft outside --strict.
  if (unsafe === true) {
    io.stderr.write('baton checkpoint: managed tree failed the symlink/realpath jail — nothing written\n');
    return finish({ ok: false, error: { code: 'unsafe-tree', msg: warnings[0] ?? 'managed tree failed the jail check' } }, strict ? 1 : 0);
  }

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
      return finish({ ok: false, error: { code: 'foreign-session', msg: 'event from a foreign session/origin rejected; rerun with --take-over' } }, 0);
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

  let rewritten = false;
  if (mustRewrite || important || elapsed || accreted >= THROTTLE_EVENT_COUNT) {
    const merged = loadBundle(root, io).bundle;
    if (merged) {
      // Bounded git refresh on important checkpoints (gate-2 fix 10): the
      // mechanical checkpoint carries branch/HEAD/dirty; unavailability
      // degrades to the bundle's previous git state, never a failure.
      if (important) {
        const git = await gitSnapshot({ execFile: io.execFile, cwd: root, fs: io.fs });
        if (git !== null) merged.git = git;
      }
      writeSnapshot(root, merged, io);
      rewritten = true;
    }
  }
  return finish({ ok: true, data: { events: events.length, rewritten } }, 0);
}
