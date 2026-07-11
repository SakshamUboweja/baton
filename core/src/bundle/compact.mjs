const TRUNC_SUFFIX = '…[truncated]';

export const DEFAULT_BUDGET = {
  decisionsMax: 200,
  keepFirst: 20,
  keepLast: 150,
  detailMax: 2000,
  filesMax: 300,
  dirtyMax: 100,
};

/**
 * Deterministic size-budget enforcement. Pure: returns a new bundle. Truncation
 * only — never summarization — so the output is reproducible byte-for-byte and
 * the full history stays in journal.ndjson.
 * @param {any} bundle
 * @param {Partial<typeof DEFAULT_BUDGET>} [budget]
 */
export function compact(bundle, budget = {}) {
  const B = { ...DEFAULT_BUDGET, ...budget };
  const out = structuredClone(bundle);

  if (out.decisions.length > B.decisionsMax) {
    const dropped = out.decisions.length - (B.keepFirst + B.keepLast);
    const marker = {
      summary: `[compacted: ${dropped} earlier decisions omitted — full log in journal.ndjson]`,
    };
    out.decisions = [
      ...out.decisions.slice(0, B.keepFirst),
      marker,
      ...out.decisions.slice(out.decisions.length - B.keepLast),
    ];
    out.compaction.droppedDecisions += dropped;
  }

  for (const d of out.decisions) {
    if (typeof d.detail === 'string' && d.detail.length > B.detailMax) {
      d.detail = d.detail.slice(0, B.detailMax - TRUNC_SUFFIX.length) + TRUNC_SUFFIX;
    }
  }

  if (out.files.touched.length > B.filesMax) {
    out.files.touched = [...out.files.touched]
      .sort((a, b) => (a.lastTs < b.lastTs ? 1 : a.lastTs > b.lastTs ? -1 : 0))
      .slice(0, B.filesMax);
    out.files.truncated = true;
  }

  if (out.git && Array.isArray(out.git.dirtySummary) && out.git.dirtySummary.length > B.dirtyMax) {
    out.git.dirtySummary = out.git.dirtySummary.slice(0, B.dirtyMax);
    out.git.summaryTruncated = true;
  }

  return out;
}
