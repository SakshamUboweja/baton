import { bundlePaths, loadBundle, writeSnapshot, writeSnapshotIn, appendJournal, rotateJournal } from '../bundle/store.mjs';
import { withLock } from '../bundle/lock.mjs';
import { emptyBundle } from '../bundle/schema.mjs';
import { normalizeHookPayload } from '../bundle/normalize.mjs';
import { snapshot as gitSnapshot } from '../git/snapshot.mjs';
import { dedupeKey } from '../util/ids.mjs';
import { safeReadJson, ensureDir, atomicWriteJson } from '../util/fsx.mjs';
import { redactSecrets } from '../util/redact.mjs';
import { isContained } from '../util/pathnorm.mjs';
import { emitEnvelope, resolveRoot, usageError, parseFlagsStrict, platformError } from './shared.mjs';

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
    // Allowlist the transcript path (gate-2 iter-2 m1): the payload is
    // untrusted, so its resolved realpath must sit under the repo root, the
    // user's ~/.claude tree (where Claude Code actually writes transcripts),
    // or a configured capture.transcriptDir — never an arbitrary readable file.
    const fileReal = io.fs.realpathSync(path);
    // On POSIX a backslash is a LEGAL filename character, not a separator, so
    // normalizing '\\'→'/' in the containment check (isContained) could make an
    // out-of-tree sibling like '/repo\\evil/f' appear contained (iter-4 I9).
    // The transcript path is the one fully-untrusted path that reaches
    // containment, so refuse a backslash-bearing realpath off Windows.
    if (io.platform !== 'win32' && String(fileReal).includes('\\')) return null;
    /** @type {string[]} */
    const allowed = [root];
    const home = io.env?.HOME;
    if (typeof home === 'string' && home.length > 0) allowed.push(`${home}/.claude`);
    const dir = cfg.value?.capture?.transcriptDir;
    if (typeof dir === 'string' && dir.length > 0) allowed.push(dir);
    const under = (/** @type {string} */ base) => {
      let baseReal;
      try {
        baseReal = io.fs.realpathSync(base);
      } catch {
        baseReal = base;
      }
      // Compare on normalized forward-slash spellings (iter-3 F9): raw Windows
      // backslash realpaths never satisfy a forward-slash containment, so
      // opt-in capture would silently never fire.
      return isContained(baseReal, fileReal);
    };
    if (!allowed.some(under)) return null;

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

/** Event-shaped: an object carrying a string `type`. */
const isEventShaped = (/** @type {any} */ v) => v !== null && typeof v === 'object' && !Array.isArray(v) && typeof v.type === 'string';

/**
 * Tolerant stdin parse (live /baton:handoff failure: a model sent one event
 * per line and the whole narrative checkpoint silently failed). Accept the
 * canonical single JSON value, a bare array of events, or NDJSON where every
 * line is an event object or a {schema, events} wrapper. All-or-nothing: one
 * non-event element fails the whole parse — never a partial apply.
 * @param {string} text @returns {{ok: true, raw: any} | {ok: false, why?: string}}
 */
function parseStdin(text) {
  let single;
  let singleOk = false;
  try {
    single = JSON.parse(text);
    singleOk = true;
  } catch {
    singleOk = false;
  }
  if (singleOk) {
    if (Array.isArray(single)) {
      return single.every(isEventShaped) ? { ok: true, raw: { schema: 'baton/event@1', events: single } } : { ok: false };
    }
    // A closest-miss of the documented wrapper — an events array whose schema
    // key is missing or wrong — must ERROR, never silently degrade to a junk
    // note with ok:true (the model cannot self-correct from a success
    // envelope while its narrative was discarded).
    if (single !== null && typeof single === 'object' && Array.isArray(single.events) && single.schema !== 'baton/event@1') {
      return { ok: false, why: `stdin carries an events array but schema is ${single.schema === undefined ? 'missing' : JSON.stringify(single.schema)} — use {"schema":"baton/event@1","events":[…]}` };
    }
    // A single bare event object (string `type`, none of the raw-hook payload
    // markers) is one of the two most likely readings of "pipe events on
    // stdin" — accept it as that event instead of degrading it to a junk note.
    if (
      isEventShaped(single) &&
      single.schema === undefined &&
      !('hook_event_name' in single) &&
      !('session_id' in single) &&
      !('event' in single)
    ) {
      return { ok: true, raw: { schema: 'baton/event@1', events: [single] } };
    }
    return { ok: true, raw: single };
  }
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  if (lines.length === 0) return { ok: false };
  /** @type {any[]} */
  const events = [];
  for (const line of lines) {
    let v;
    try {
      v = JSON.parse(line);
    } catch {
      return { ok: false };
    }
    if (v && typeof v === 'object' && v.schema === 'baton/event@1' && Array.isArray(v.events)) {
      if (!v.events.every(isEventShaped)) return { ok: false };
      events.push(...v.events);
    } else if (isEventShaped(v)) {
      events.push(v);
    } else {
      return { ok: false };
    }
  }
  return { ok: true, raw: { schema: 'baton/event@1', events } };
}

/**
 * `baton checkpoint` — mechanical checkpoint from a hook payload on stdin.
 * Hook-safety rule: exit 0 on every soft failure so a checkpoint can never
 * break the host harness; `--strict` opts into hard failures (CI).
 * @param {string[]} args @param {any} io
 * @returns {Promise<number>}
 */
export async function cmdCheckpoint(args, io) {
  const parsed = parseFlagsStrict(args, { platform: 'string', model: 'string', trigger: 'string', debounce: 'string', strict: 'boolean', 'take-over': 'boolean' });
  if (parsed.error !== undefined) return usageError(io, parsed.flags, 'checkpoint', parsed.error);
  const flags = parsed.flags;
  const strict = flags.strict === true;
  const platform = typeof flags.platform === 'string' ? flags.platform : null;
  if (!platform) return usageError(io, flags, 'checkpoint', '--platform <claude-code|codex|cursor> is required');
  const pErr = platformError(platform);
  if (pErr) return usageError(io, flags, 'checkpoint', pErr);

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

  const parsed = parseStdin(typeof io.stdin === 'string' ? io.stdin : '');
  if (!parsed.ok) {
    const why = parsed.why ?? 'send one JSON value ({"schema":"baton/event@1","events":[…]}), a JSON array of events, or NDJSON event lines';
    io.stderr.write(`baton checkpoint: stdin could not be parsed — ${why}\n`);
    return finish({ ok: false, error: { code: 'bad-stdin', msg: why } }, strict ? 1 : 0);
  }
  const raw = parsed.raw;

  const session = { host: io.host, pid: io.pid, startTime: io.startTime };
  // The hook command declares which event it is (--trigger), so event identity
  // never depends on parsing each harness's payload shape (Cursor's stop payload
  // names the event nowhere normalize could find it).
  const explicitEvent = typeof flags.trigger === 'string' ? flags.trigger : undefined;
  const events = normalizeHookPayload(raw, platform, session, explicitEvent);
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

  // Opt-in debounce (gate-2 major 14; Cursor afterFileEdit fires per edit):
  // at most one real checkpoint per window, tracked by a per-platform stamp.
  // The read-and-set runs UNDER the repo lock (gate-2 iter-2 M5) so two
  // simultaneous afterFileEdit hooks can't both observe no stamp and both
  // checkpoint — exactly one wins the window.
  if (flags.debounce !== undefined) {
    const seconds = Number(flags.debounce);
    if (!Number.isFinite(seconds) || seconds <= 0) return usageError(io, flags, 'checkpoint', '--debounce <seconds> must be a positive number');
    const stampPath = `${paths.logDir}/debounce-${platform}.json`;
    const proceed = withLock(root, io, () => {
      const stamp = safeReadJson(io.fs, stampPath);
      if (stamp.ok && typeof stamp.value?.at === 'string' && Date.parse(io.now()) - Date.parse(stamp.value.at) < seconds * 1000) {
        return false;
      }
      ensureDir(io.fs, paths.logDir);
      atomicWriteJson(io.fs, stampPath, { at: io.now() });
      return true;
    });
    if (!proceed) return finish({ ok: true, data: { events: 0, rewritten: false, debounced: true } }, 0);
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

  if (hasStableOwner) {
    // Foreign = a different stable session, OR any platform mismatch — the
    // platform is provable even when the events carry no session hint (audit
    // finding: a hint-less /baton:handoff narrative from claude-code silently
    // merged into — then sealed — a codex-owned bundle, corrupting the origin
    // the receive-side role avoidance keys on).
    const incomingLabel = stableIncoming ? stableIncoming.sessionHint : '(no session hint)';
    const foreign = stableIncoming
      ? stableIncoming.sessionHint !== originHint || platform !== active.origin.platform
      : platform !== active.origin.platform;
    if (foreign && flags['take-over'] !== true) {
      io.stderr.write(
        `baton checkpoint: event from a foreign session/origin (${platform}/${incomingLabel} vs active ${active.origin.platform}/${originHint}) — rejected to keep sessions isolated; rerun with --take-over to archive the active bundle and start fresh\n`,
      );
      return finish({ ok: false, error: { code: 'foreign-session', msg: 'event from a foreign session/origin rejected; rerun with --take-over' } }, 0);
    }
    if (foreign) {
      rotateJournal(root, 'takeover', io);
      const fresh = emptyBundle(
        { platform, model: typeof flags.model === 'string' ? flags.model : 'unknown', goal: active.task?.goal ?? 'unknown' },
        io.now(),
      );
      if (stableIncoming) fresh.origin.sessionHint = stableIncoming.sessionHint;
      writeSnapshot(root, fresh, io);
      io.stderr.write(`baton checkpoint: took over — prior bundle archived to history/, fresh bundle owned by ${platform}/${incomingLabel}\n`);
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
    // Self-applying seed event (gate-2 iter-2 B6): a journal-only rebuild
    // (snapshot + .bak both lost) must restore the bundle's identity, not the
    // "unknown" placeholder resolveBase seeds. bundle.seed carries bundleId,
    // origin, task, and generation and is applied on replay.
    appendJournal(
      root,
      {
        ts: io.now(),
        type: 'bundle.seed',
        payload: {
          bundleId: active.bundleId,
          generation: active.generation,
          createdAt: active.createdAt,
          origin: active.origin,
          task: { goal: active.task.goal },
          text: `[seed] auto-seeded a new bundle on ${platform} (model ${active.origin.model})`,
        },
        writerId: [platform, io.pid, 'seed'].join('-'),
        dedupeKey: dedupeKey({ ts: io.now(), type: 'bundle.seed', bundleId: active.bundleId }),
      },
      io,
    );
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
    // Bounded git refresh on EVERY snapshot rewrite (gate-2 iter-2 M1): a
    // mechanical checkpoint carries branch/HEAD/dirty. Capture git BEFORE the
    // lock — it is async and must not straddle the lock — then do ONE atomic
    // read-modify-write UNDER the lock (iter-5 A1): reload the bundle inside the
    // lock, apply git, and write with the fencing token. The old code loaded
    // outside the lock, awaited git (yielding the event loop), then wrote the
    // stale bundle, so a concurrent --take-over during the await was clobbered
    // (origin rolled back, the new owner's event lost). Reloading inside the
    // lock guarantees the write is built from current state.
    const git = await gitSnapshot({ execFile: io.execFile, cwd: root, fs: io.fs });
    rewritten = withLock(root, io, (token) => {
      const merged = loadBundle(root, io).bundle;
      if (!merged) return false;
      if (git !== null) {
        merged.git = git;
      } else {
        // git refresh failed/timed out (iter-4 I2/F5): NEVER retain the prior
        // snapshot — stale HEAD/dirty presented as current corrupts the
        // receive-side evidence audit. Clear to explicit unavailable (null) and
        // warn; a repo that was never git (already null) warns nothing.
        if (merged.git !== null) {
          io.stderr.write('baton checkpoint: git refresh failed — clearing stale git state (marked unavailable; receive re-derives it live)\n');
        }
        merged.git = null;
      }
      writeSnapshotIn(root, merged, io, token);
      return true;
    });
  }
  return finish({ ok: true, data: { events: events.length, rewritten } }, 0);
}
