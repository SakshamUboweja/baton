import { newBundleId } from '../util/ids.mjs';

export const BUNDLE_SCHEMA = 'baton/bundle@1';
const HANDOFF_STATUSES = ['open', 'sealed', 'received'];

/**
 * A fresh open bundle at generation 1.
 * @param {{platform: string, model: string, goal: string}} input
 * @param {string} nowIso
 */
export function emptyBundle({ platform, model, goal }, nowIso) {
  return {
    schema: BUNDLE_SCHEMA,
    bundleId: newBundleId(),
    generation: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
    origin: { platform, model, sessionHint: null, unstable: false },
    task: { goal, constraints: [], acceptance: [] },
    plan: { steps: [] },
    decisions: [],
    files: { touched: [] },
    roles: { assignments: {} },
    git: null,
    handoff: {
      status: 'open',
      reason: null,
      reasonClass: null,
      toPlatformHint: null,
      finalizedAt: null,
      receive_log: [],
    },
    journalSeq: 0,
    compaction: { droppedDecisions: 0, note: null },
    dedupeRing: [],
  };
}

/**
 * Structural validation. Accumulates one {path, msg} per problem; unknown extra
 * fields are tolerated everywhere (forward compatibility).
 * @param {any} obj
 * @returns {{ok: boolean, errors: {path: string, msg: string}[]}}
 */
export function validateBundle(obj) {
  /** @type {{path: string, msg: string}[]} */
  const errors = [];
  const err = (/** @type {string} */ path, /** @type {string} */ msg) => errors.push({ path, msg });

  if (obj === null || typeof obj !== 'object') {
    return { ok: false, errors: [{ path: '', msg: 'bundle must be an object' }] };
  }

  if (obj.schema !== BUNDLE_SCHEMA) err('schema', `expected "${BUNDLE_SCHEMA}", got ${JSON.stringify(obj.schema)}`);
  if (typeof obj.bundleId !== 'string') err('bundleId', 'must be a string');
  if (typeof obj.generation !== 'number') err('generation', 'must be a number');
  if (typeof obj.createdAt !== 'string') err('createdAt', 'must be an ISO string');
  if (typeof obj.updatedAt !== 'string') err('updatedAt', 'must be an ISO string');
  if (typeof obj.journalSeq !== 'number') err('journalSeq', 'must be a number');
  if (!Array.isArray(obj.decisions)) err('decisions', 'must be an array');
  if (!Array.isArray(obj.dedupeRing)) err('dedupeRing', 'must be an array');

  if (obj.origin === null || typeof obj.origin !== 'object') {
    err('origin', 'must be an object');
  } else if (typeof obj.origin.platform !== 'string') {
    err('origin.platform', 'must be a string');
  }

  if (obj.task === null || typeof obj.task !== 'object') {
    err('task', 'must be an object');
  } else if (typeof obj.task.goal !== 'string') {
    err('task.goal', 'must be a string');
  }

  if (obj.plan === null || typeof obj.plan !== 'object') {
    err('plan', 'must be an object');
  } else if (!Array.isArray(obj.plan.steps)) {
    err('plan.steps', 'must be an array');
  }

  if (obj.files === null || typeof obj.files !== 'object') {
    err('files', 'must be an object');
  } else if (!Array.isArray(obj.files.touched)) {
    err('files.touched', 'must be an array');
  }

  if (obj.roles === null || typeof obj.roles !== 'object') err('roles', 'must be an object');
  if (obj.compaction === null || typeof obj.compaction !== 'object') err('compaction', 'must be an object');

  if (obj.handoff === null || typeof obj.handoff !== 'object') {
    err('handoff', 'must be an object');
  } else if (!HANDOFF_STATUSES.includes(obj.handoff.status)) {
    err('handoff.status', `must be one of ${HANDOFF_STATUSES.join('|')}`);
  }

  // git is nullable by design; when present it must be an object.
  if (obj.git !== null && obj.git !== undefined && typeof obj.git !== 'object') err('git', 'must be an object or null');

  return { ok: errors.length === 0, errors };
}

/**
 * Version migration seam. Schema v1 is identity; anything else is unsupported.
 * @param {any} obj
 */
export function migrate(obj) {
  if (obj?.schema === BUNDLE_SCHEMA) return structuredClone(obj);
  throw new Error(`unsupported bundle schema ${JSON.stringify(obj?.schema)}; this baton understands ${BUNDLE_SCHEMA}`);
}
