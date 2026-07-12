import { jailRelPath } from '../util/jail.mjs';

const RING_CAP = 500;

/** Audit note for a refused payload — visible in the decision log, never a throw. */
const refusalNote = (/** @type {string} */ type, /** @type {any} */ detail) =>
  `[${type} with invalid payload refused: ${JSON.stringify(detail).slice(0, 120)}]`;

/**
 * Pure event reducer. Returns a new bundle; never mutates the input.
 * Idempotent: an event whose dedupeKey is still in the bundle's ring is a no-op.
 * Unknown event types degrade to a decision-log note — a checkpoint must never
 * fail because a newer adapter emitted something this core doesn't know — and
 * journal payloads are untrusted (gate-2 fix 6): malformed shapes degrade to a
 * refusal note and repository paths are jailed before storage.
 * @param {any} bundle
 * @param {{seq: number, ts: string, type: string, dedupeKey: string, writerId?: string, source?: string, payload: any}} event
 */
export function applyEvent(bundle, event) {
  // Journal lines are untrusted (gate-2 iter-2 B4): a parseable null/number/
  // string is a valid JSON line but not an event envelope — degrade to a
  // no-op rather than crash replay. The store's load loop also pre-filters and
  // warns; this is the last-line guard for any direct caller.
  if (event === null || typeof event !== 'object' || Array.isArray(event)) return bundle;
  if (bundle.dedupeRing.includes(event.dedupeKey)) return bundle;

  const out = structuredClone(bundle);
  const { seq, ts, type, payload = {} } = structuredClone(event);

  switch (type) {
    case 'decision': {
      /** @type {{seq: number, ts: string, summary: any, detail?: any}} */
      const entry = { seq, ts, summary: payload.summary };
      if (payload.detail !== undefined) entry.detail = payload.detail;
      out.decisions.push(entry);
      break;
    }
    case 'note':
      out.decisions.push({ seq, ts, summary: payload.text });
      // A structured StopFailure rate_limit note marks the open bundle
      // limit-hit (gate-2 fix 3): the unsealed limit death must be visible to
      // the next SessionStart on any platform, not buried in the decision log.
      if (payload.structured?.kind === 'stop-failure' && payload.errorType === 'rate_limit' && out.handoff.status === 'open') {
        out.handoff = { ...out.handoff, reason: out.handoff.reason ?? payload.text ?? null, reasonClass: 'usage-limit' };
      }
      break;
    case 'plan.set':
      if (Array.isArray(payload.steps) && payload.steps.every((/** @type {any} */ s) => s !== null && typeof s === 'object')) {
        out.plan.steps = payload.steps;
      } else {
        out.decisions.push({ seq, ts, summary: refusalNote('plan.set', payload?.steps) });
      }
      break;
    case 'plan.step': {
      if (payload === null || typeof payload !== 'object' || typeof payload.id !== 'string') {
        out.decisions.push({ seq, ts, summary: refusalNote('plan.step', payload) });
        break;
      }
      const existing = out.plan.steps.find((/** @type {any} */ s) => s.id === payload.id);
      if (existing) Object.assign(existing, payload);
      else out.plan.steps.push(payload);
      break;
    }
    case 'file.touch': {
      const safePath = jailRelPath(payload?.path);
      if (safePath === null) {
        out.decisions.push({ seq, ts, summary: refusalNote('file.touch', payload?.path) });
        break;
      }
      const entry = { path: safePath, op: typeof payload.op === 'string' ? payload.op : 'touch', lastTs: ts };
      const i = out.files.touched.findIndex((/** @type {any} */ f) => f.path === safePath);
      if (i === -1) out.files.touched.push(entry);
      else out.files.touched[i] = entry;
      break;
    }
    case 'roles.remap':
      if (payload?.assignments !== null && typeof payload?.assignments === 'object' && !Array.isArray(payload.assignments)) {
        out.roles.assignments = payload.assignments;
      } else {
        out.decisions.push({ seq, ts, summary: refusalNote('roles.remap', payload?.assignments) });
      }
      break;
    case 'task.update': {
      /** @type {Record<string, any>} */
      const patch = {};
      if (typeof payload?.goal === 'string') patch.goal = payload.goal;
      if (Array.isArray(payload?.constraints) && payload.constraints.every((/** @type {any} */ c) => typeof c === 'string')) {
        patch.constraints = payload.constraints;
      }
      if (Array.isArray(payload?.acceptance)) patch.acceptance = payload.acceptance;
      if (Object.keys(patch).length === 0) {
        out.decisions.push({ seq, ts, summary: refusalNote('task.update', payload) });
        break;
      }
      out.task = { ...out.task, ...patch };
      break;
    }
    case 'git.update':
      if (payload === null || typeof payload === 'object') out.git = payload;
      else out.decisions.push({ seq, ts, summary: refusalNote('git.update', payload) });
      break;
    case 'bundle.seed':
      // Self-applying identity (gate-2 iter-2 B6): the auto-seed emits this as
      // the journal's first event so a journal-only rebuild (snapshot + .bak
      // both gone) restores the bundle's identity/origin/task instead of the
      // "unknown" placeholder resolveBase seeds. Replayed first (lowest seq),
      // so later events layer on top; on normal replay its seq is below the
      // snapshot's journalSeq and it is skipped.
      if (payload && typeof payload === 'object') {
        if (typeof payload.bundleId === 'string') out.bundleId = payload.bundleId;
        if (typeof payload.generation === 'number') out.generation = payload.generation;
        if (typeof payload.createdAt === 'string') out.createdAt = payload.createdAt;
        // Restore identity ONLY (platform/model) — never sessionHint/unstable.
        // Session ownership is adopted AFTER the seed (a snapshot-only mutation),
        // so replaying the seed must not clobber a later-adopted hint back to
        // its seed-time null (gate-2 iter-2: caught by the adoption test).
        if (payload.origin && typeof payload.origin === 'object') {
          if (typeof payload.origin.platform === 'string') out.origin.platform = payload.origin.platform;
          if (typeof payload.origin.model === 'string') out.origin.model = payload.origin.model;
        }
        if (payload.task && typeof payload.task === 'object' && typeof payload.task.goal === 'string') {
          out.task.goal = payload.task.goal;
        }
      }
      break;
    case 'transcript.set':
      // Opt-in transcript tail (plan §Transcript policy): stored under the
      // literal property name `transcript` so purge-transcript strips it from
      // every retained copy. Render never includes it.
      if (payload?.transcript !== null && typeof payload?.transcript === 'object' && typeof payload.transcript.tail === 'string') {
        out.transcript = {
          capturedAt: typeof payload.transcript.capturedAt === 'string' ? payload.transcript.capturedAt : ts,
          tail: payload.transcript.tail,
        };
      } else {
        out.decisions.push({ seq, ts, summary: refusalNote('transcript.set', 'malformed payload') });
      }
      break;
    default:
      out.decisions.push({ seq, ts, summary: `[unhandled event type '${type}' recorded as note]` });
      break;
  }

  out.updatedAt = ts;
  // Harden against foreign/keyless entries (gate-2 fix): a missing seq must
  // never poison journalSeq to NaN, and an absent dedupeKey must never enter
  // the ring (undefined in the ring dedupes every later keyless event).
  if (typeof seq === 'number' && Number.isFinite(seq)) out.journalSeq = Math.max(out.journalSeq, seq);
  if (typeof event.dedupeKey === 'string' && event.dedupeKey.length > 0) {
    out.dedupeRing.push(event.dedupeKey);
    if (out.dedupeRing.length > RING_CAP) out.dedupeRing.splice(0, out.dedupeRing.length - RING_CAP);
  }

  return out;
}
