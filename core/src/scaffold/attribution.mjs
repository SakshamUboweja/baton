const MANAGED_KEYS = ['commit', 'pr'];

/**
 * Deep-merge the zero-attribution settings into a .claude/settings.json body:
 * attribution.commit / attribution.pr set to "" — only when absent, unless
 * `force` resets present values. Malformed JSON is refused, never rewritten.
 * Pure text transform. On no-change the input text is returned byte-for-byte.
 * @param {string | null} existingJsonText settings body, or null when the file does not exist
 * @param {{force?: boolean}} opts
 * @returns {{text: string, changed: boolean, warnings: string[]} | {error: string}}
 */
export function mergeAttribution(existingJsonText, opts = {}) {
  /** @type {any} */
  let settings = {};
  if (existingJsonText !== null) {
    try {
      settings = JSON.parse(existingJsonText);
    } catch (err) {
      return { error: `settings JSON is unparseable (${/** @type {any} */ (err)?.message ?? 'parse error'}) — refusing to rewrite it` };
    }
  }

  /** @type {string[]} */
  const warnings = [];
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    return { error: 'settings JSON is not an object — refusing to rewrite it' };
  }
  if ('attribution' in settings && (typeof settings.attribution !== 'object' || settings.attribution === null || Array.isArray(settings.attribution))) {
    warnings.push('attribution key exists but is not an object — left untouched');
    return { text: existingJsonText ?? '', changed: false, warnings };
  }

  const merged = { ...settings, attribution: { ...(settings.attribution ?? {}) } };
  let changed = false;
  for (const key of MANAGED_KEYS) {
    const present = key in merged.attribution;
    if (!present || (opts.force === true && merged.attribution[key] !== '')) {
      if (present) warnings.push(`attribution.${key} was non-empty and has been reset by --force`);
      merged.attribution[key] = '';
      changed = true;
    }
  }

  if (!changed) return { text: existingJsonText ?? '', changed: false, warnings };
  return { text: JSON.stringify(merged, null, 2) + '\n', changed: true, warnings };
}
