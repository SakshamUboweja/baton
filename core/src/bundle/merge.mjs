const RING_CAP = 500;

/**
 * Pure event reducer. Returns a new bundle; never mutates the input.
 * Idempotent: an event whose dedupeKey is still in the bundle's ring is a no-op.
 * Unknown event types degrade to a decision-log note — a checkpoint must never
 * fail because a newer adapter emitted something this core doesn't know.
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
      out.plan.steps = payload.steps;
      break;
    case 'plan.step': {
      const existing = out.plan.steps.find((/** @type {any} */ s) => s.id === payload.id);
      if (existing) Object.assign(existing, payload);
      else out.plan.steps.push(payload);
      break;
    }
    case 'file.touch': {
      const entry = { path: payload.path, op: payload.op, lastTs: ts };
      const i = out.files.touched.findIndex((/** @type {any} */ f) => f.path === payload.path);
      if (i === -1) out.files.touched.push(entry);
      else out.files.touched[i] = entry;
      break;
    }
    case 'roles.remap':
      out.roles.assignments = payload.assignments;
      break;
    case 'task.update':
      out.task = { ...out.task, ...payload };
      break;
    case 'git.update':
      out.git = payload;
      break;
    default:
      out.decisions.push({ seq, ts, summary: `[unhandled event type '${type}' recorded as note]` });
      break;
  }

  out.updatedAt = ts;
  out.journalSeq = Math.max(out.journalSeq, seq);
  out.dedupeRing.push(event.dedupeKey);
  if (out.dedupeRing.length > RING_CAP) out.dedupeRing.splice(0, out.dedupeRing.length - RING_CAP);

  return out;
}
