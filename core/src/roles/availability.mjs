import { safeReadJson } from '../util/fsx.mjs';

// Doctor's probe results live in .handoff/log/probe-cache.json for 15 minutes
// (plan §Availability probing). This reader is the consumption side (gate-2
// major 13): remap's resolver and receive's token derivation take the FRESH
// cache; a stale or absent cache reads as null — offline resolution stays
// possible, flagged degraded by the resolver.

export const PROBE_CACHE_MS = 15 * 60 * 1000;

/**
 * @param {string} root @param {any} io
 * @returns {Record<string, {capability: string, outcome: string}> | null}
 */
export function readProbeCache(root, io) {
  const cached = safeReadJson(io.fs, `${root}/.handoff/log/probe-cache.json`);
  if (!cached.ok || typeof cached.value?.at !== 'string' || !Array.isArray(cached.value.records)) return null;
  // Inclusive boundary (gate-2 fix): the contract is "staleness > 15 min is
  // ignored", so a cache aged EXACTLY PROBE_CACHE_MS is still fresh.
  if (!(Date.parse(io.now()) - Date.parse(cached.value.at) <= PROBE_CACHE_MS)) return null;
  /** @type {Record<string, {capability: string, outcome: string}>} */
  const out = {};
  for (const r of cached.value.records) {
    // capability null in a probe record means the binary was not found — a
    // VERIFIED not-installed, which the resolver must skip, not select.
    if (r && typeof r.platform === 'string') out[r.platform] = { capability: r.capability ?? 'not-installed', outcome: r.outcome ?? 'error' };
  }
  return out;
}
