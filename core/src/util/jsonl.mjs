/**
 * Append-only JSONL journal IO, tolerant of the corruption modes a
 * kill-mid-write can produce: a torn (unterminated) tail, a corrupt middle
 * line, and out-of-order sequence numbers.
 */

/**
 * Append one entry as a single JSON line.
 * @param {any} fs @param {string} path @param {unknown} obj
 */
export function appendEntry(fs, path, obj) {
  fs.appendFileSync(path, JSON.stringify(obj) + '\n');
}

/**
 * Read every parseable entry. Never throws.
 * Warnings: {line, kind: 'torn-tail'|'parse-error'|'seq-order', ...}.
 * A non-monotonic numeric seq is flagged but the entry is kept — replay and
 * audit must still see it.
 * @param {any} fs @param {string} path
 * @returns {{entries: any[], warnings: any[]}}
 */
export function readAllTolerant(fs, path) {
  /** @type {any[]} */
  const entries = [];
  /** @type {any[]} */
  const warnings = [];

  let raw;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch {
    return { entries, warnings };
  }
  if (raw === '') return { entries, warnings };

  const terminated = raw.endsWith('\n');
  const lines = raw.split('\n');
  if (terminated) lines.pop();

  let prevSeq = null;
  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const isLast = i === lines.length - 1;
    const torn = isLast && !terminated;
    let parsed;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      warnings.push(torn ? { line: lineNo, kind: 'torn-tail' } : { line: lineNo, kind: 'parse-error' });
      continue;
    }
    if (typeof parsed?.seq === 'number') {
      if (prevSeq !== null && parsed.seq <= prevSeq) {
        warnings.push({ line: lineNo, kind: 'seq-order', prev: prevSeq, seq: parsed.seq });
      }
      prevSeq = prevSeq === null ? parsed.seq : Math.max(prevSeq, parsed.seq);
    }
    entries.push(parsed);
  }
  return { entries, warnings };
}
