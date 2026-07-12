// Path-spelling normalization shared by every containment/ascent check (plan
// §Root discovery, §Threat model, Windows + packaging). Windows realpathSync
// returns backslash paths and Node tolerates forward slashes, so all comparisons
// happen in one canonical forward-slash space: backslashes → slashes, collapsed
// duplicate separators, and no trailing separator (except a bare root). Doing
// this in one place stopped the recurring "fixed jail, forgot resolveRoot /
// transcript containment" class of bugs.

/**
 * Canonical forward-slash spelling: `\`→`/`, `//`→`/`, trailing `/` trimmed
 * (a lone `/` is preserved).
 * @param {any} p
 * @returns {string}
 */
export function normSep(p) {
  let s = String(p).replace(/\\/g, '/').replace(/\/+/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/**
 * Join a base and a single child segment without producing a doubled separator
 * (so `C:/` + `.handoff` → `C:/.handoff`, not `C://.handoff`).
 * @param {string} base @param {string} child
 * @returns {string}
 */
export function joinNorm(base, child) {
  return normSep(`${base}/${child}`);
}

/**
 * True when `child` IS `base` or is contained under it, compared on normalized
 * forward-slash spellings (volume-aware; `C:/repo` contains `C:/repo/.handoff`
 * but not `C:/repository`).
 * @param {string} base @param {string} child
 * @returns {boolean}
 */
export function isContained(base, child) {
  const b = normSep(base);
  const c = normSep(child);
  return c === b || c.startsWith(`${b}/`);
}
