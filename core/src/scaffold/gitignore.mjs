/**
 * Ensure an ignore pattern is active in a .gitignore body. Pure text
 * transform: a covering non-comment line ('.handoff/' or '.handoff') makes
 * this a byte-for-byte no-op; otherwise the pattern is appended on its own
 * line with a single trailing newline.
 * @param {string | null} existingText current .gitignore body, or null when absent
 * @param {string} pattern the ignore entry to guarantee (e.g. '.handoff/')
 * @returns {{text: string, changed: boolean}}
 */
export function ensureIgnoreLine(existingText, pattern) {
  const body = existingText ?? '';
  const bare = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
  const covers = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .some((l) => l === pattern || l === bare);
  if (covers) return { text: body, changed: false };

  if (body === '') return { text: pattern + '\n', changed: true };
  const joined = body.endsWith('\n') ? body : body + '\n';
  return { text: joined + pattern + '\n', changed: true };
}
