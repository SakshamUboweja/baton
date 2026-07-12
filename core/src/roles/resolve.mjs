/**
 * Pure, explainable role resolution over the committed matrix. Every decision
 * is auditable: chosen entries carry their chainIndex; passed-over entries land
 * in skipped[] with a why. avoid[] population is the caller's job.
 * @param {{config: any, to: string, avoid?: string[], nativeOnly?: boolean, probes?: Record<string, {capability: string, outcome: string}> | null}} input
 * @returns {{assignments: Record<string, any>, notes: string[]}}
 */
export function resolveRoles({ config, to, avoid = [], nativeOnly = false, probes = null }) {
  /** @type {string[]} */
  const notes = [];

  /**
   * The eligibility verdict for a platform, or null when eligible.
   * @param {string} platform @returns {string | null}
   */
  function skipReason(platform) {
    if (avoid.includes(platform)) return 'avoided';
    if (!(platform in (config.platforms ?? {}))) return 'unknown-platform';
    if (config.platforms[platform]?.enabled === false) return 'disabled';
    if (probes && probes[platform]) {
      if (probes[platform].outcome === 'rate-limited') return 'rate-limited';
      if (probes[platform].capability === 'installed') return 'unauthenticated';
      if (probes[platform].capability === 'not-installed') return 'not-installed';
    }
    return null;
  }

  /** @param {string} platform */
  const probeUnverified = (platform) => probes !== null && probes !== undefined && !probes[platform];

  /** @type {Record<string, any>} */
  const assignments = {};
  for (const [role, chain] of Object.entries(config.roles)) {
    /** @type {any[]} */
    const skipped = [];
    /** @type {any} */
    let assignment = null;

    for (let i = 0; i < chain.length; i += 1) {
      const entry = chain[i];
      if (nativeOnly && entry.platform !== to) {
        skipped.push({ chainIndex: i, platform: entry.platform, model: entry.model, why: 'non-native' });
        continue;
      }
      const why = skipReason(entry.platform);
      if (why) {
        skipped.push({ chainIndex: i, platform: entry.platform, model: entry.model, why });
        continue;
      }
      assignment = {
        platform: entry.platform,
        model: entry.model,
        effort: entry.effort ?? null,
        mode: entry.platform === to ? 'native' : 'delegated',
        chainIndex: i,
        skipped,
      };
      if (probeUnverified(entry.platform)) assignment.degraded = true;
      break;
    }

    if (!assignment && nativeOnly) {
      // Forced-default is only valid when the destination itself is eligible.
      const whyTo = skipReason(to);
      const model = config.defaults?.[to];
      if (!whyTo && typeof model === 'string') {
        assignment = { platform: to, model, effort: null, mode: 'forced-default', chainIndex: null, skipped };
        if (probeUnverified(to)) assignment.degraded = true;
      }
    }

    if (!assignment) {
      assignment = { platform: null, model: null, effort: null, mode: 'unavailable', chainIndex: null, skipped };
    }
    assignments[role] = assignment;
  }

  return { assignments, notes };
}
