/**
 * Load + validate baton.config.json, parsing role chains from their
 * "platform/model[@effort]" string form into structured entries.
 * Never throws: returns {config, errors} with dotted-path errors.
 * @param {string} cwd @param {any} io
 * @returns {{config: any | null, errors: {path: string, msg: string}[]}}
 */
export function loadConfig(cwd, io) {
  const file = `${cwd}/baton.config.json`;
  /** @type {{path: string, msg: string}[]} */
  const errors = [];

  let raw;
  try {
    raw = io.fs.readFileSync(file, 'utf8');
  } catch {
    return { config: null, errors: [{ path: '', msg: `baton.config.json not found at ${file} — run 'baton init' to scaffold it` }] };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { config: null, errors: [{ path: '', msg: `baton.config.json is not valid JSON (${/** @type {any} */ (err)?.message ?? 'parse error'})` }] };
  }

  if (parsed.roles === null || typeof parsed.roles !== 'object' || Array.isArray(parsed.roles)) {
    errors.push({ path: 'roles', msg: 'roles must be an object mapping role names to chain arrays' });
  }

  /** @type {Record<string, any[]>} */
  const roles = {};
  if (errors.length === 0) {
    for (const [role, chain] of Object.entries(parsed.roles)) {
      if (!Array.isArray(chain)) {
        errors.push({ path: `roles.${role}`, msg: 'a role chain must be an array of "platform/model[@effort]" strings' });
        continue;
      }
      /** @type {any[]} */
      const entries = [];
      for (let i = 0; i < chain.length; i += 1) {
        const s = chain[i];
        const slash = typeof s === 'string' ? s.indexOf('/') : -1;
        if (slash <= 0 || slash === s.length - 1) {
          errors.push({ path: `roles.${role}[${i}]`, msg: `malformed chain entry ${JSON.stringify(s)} — expected "platform/model[@effort]"` });
          continue;
        }
        const platform = s.slice(0, slash);
        const rest = s.slice(slash + 1);
        const at = rest.indexOf('@');
        const model = at === -1 ? rest : rest.slice(0, at);
        const effort = at === -1 ? null : rest.slice(at + 1);
        if (parsed.platforms && !(platform in parsed.platforms)) {
          errors.push({ path: `roles.${role}[${i}]`, msg: `unknown platform "${platform}" — not a key of config.platforms` });
          continue;
        }
        entries.push({ platform, model, effort });
      }
      roles[role] = entries;
    }
  }

  if (errors.length > 0) return { config: null, errors };
  return { config: { ...parsed, roles }, errors };
}
