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
