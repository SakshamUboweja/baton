/**
 * Pure, explainable role resolution over the committed matrix. Every decision
 * is auditable: chosen entries carry their chainIndex; passed-over entries land
 * in skipped[] with a why. avoid[] population is the caller's job.
 * @param {{config: any, to: string, avoid?: string[], avoidEntries?: Array<{platform: string, model: string}>, nativeOnly?: boolean, probes?: Record<string, {capability: string, outcome: string}> | null}} input
 * @returns {{assignments: Record<string, any>, notes: string[]}}
 */
export function resolveRoles({ config, to, avoid = [], avoidEntries = [], nativeOnly = false, probes = null }) {
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
      const { capability, outcome } = probes[platform];
      if (outcome === 'rate-limited') return 'rate-limited';
      if (capability === 'not-installed') return 'not-installed';
      // 'installed' means installation was PROVEN but the probe was capped there
      // (capOnSuccess) — authentication is UNVERIFIED, not verified-failed. Only
      // a probe that ran and did NOT succeed (outcome !== 'ok') is a verified
      // auth/reachability failure worth skipping; a capped success stays
      // selectable and is flagged degraded below (iter-3 F1, plan §Role matrix).
      if (capability === 'installed' && outcome !== 'ok') return 'unauthenticated';
    }
    return null;
  }

  // A selection is degraded when its availability is UNVERIFIED (gate-2 iter-2
  // M3, iter-3 F1): with no probe cache at all, resolution is offline and EVERY
  // selection is degraded (plan: "Offline resolution always succeeds, flagged
  // degraded"); with a partial cache, platforms the cache is missing are; and a
  // platform probed only to 'installed' (auth unverified, e.g. a --version
  // success) is degraded even though it stays selectable.
  /** @param {string} platform */
  const probeUnverified = (platform) => {
    if (probes == null || !probes[platform]) return true;
    const { capability, outcome } = probes[platform];
    // Degraded when ANY required dimension is unverified: a capped 'installed'
    // (auth never confirmed) OR a non-ok outcome (iter-4 I6) — a selectable
    // platform whose last probe ERRORED or TIMED OUT is presented as
    // reachability-verified otherwise, which is exactly the silent-degradation
    // the plan's degraded flag exists to surface. (rate-limited is skipped, not
    // selected, so it never reaches here.)
    return capability === 'installed' || outcome !== 'ok';
  };

  // Entry-level avoidance (plan §Model-level failover): a specific
  // {platform, model} tuple is dead (e.g. account-tier rejected) while its
  // platform stays usable. Matching is on model IDENTITY — an @effort suffix
  // on either side is ignored — and requires BOTH dimensions, so the same
  // model name on another platform is never caught.
  /** @param {any} m */
  const baseModel = (m) => (typeof m === 'string' ? m.split('@')[0] : m);
  /** @param {string} platform @param {string} model */
  const entryAvoided = (platform, model) =>
    avoidEntries.some((a) => a?.platform === platform && baseModel(a?.model) === baseModel(model));

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
      // After skipReason so a dual match keeps the platform-level label.
      if (entryAvoided(entry.platform, entry.model)) {
        skipped.push({ chainIndex: i, platform: entry.platform, model: entry.model, why: 'avoided-entry' });
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
