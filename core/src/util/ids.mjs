import { createHash } from 'node:crypto';

/**
 * New bundle id from an injectable random source (deterministic in tests).
 * @param {() => number} [rand]
 */
export function newBundleId(rand = Math.random) {
  const a = rand().toString(36).slice(2);
  const b = rand().toString(36).slice(2);
  return `b_${(a + b).slice(0, 16) || '0'}`;
}

/**
 * Canonical JSON: object keys sorted ascending at every depth; array order
 * preserved (order is meaningful there).
 * @param {any} value @returns {string}
 */
function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * sha256 hex over canonical JSON — the journal's idempotency key.
 * @param {unknown} obj @returns {string}
 */
export function dedupeKey(obj) {
  return createHash('sha256').update(canonicalJson(obj)).digest('hex');
}
