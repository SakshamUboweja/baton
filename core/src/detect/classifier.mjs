const PRECEDENCE = ['usage-limit', 'auth', 'model-unavailable', 'throttle', 'other-error'];

/** @type {Record<string, string>} */
const STOP_FAILURE_MAP = {
  rate_limit: 'usage-limit',
  overloaded: 'throttle',
  authentication_failed: 'auth',
  oauth_org_not_allowed: 'auth',
  billing_error: 'auth',
};

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** @param {any} matcher @param {string} text */
function matches(matcher, text) {
  switch (matcher.kind) {
    case 'substring':
      return text.includes(matcher.value);
    case 'regex':
      return new RegExp(matcher.pattern, matcher.flags || '').test(text);
    case 'json-field': {
      for (const line of text.split('\n')) {
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        const val = String(matcher.path)
          .split('.')
          .reduce((o, k) => (o == null ? undefined : o[k]), obj);
        if (val === matcher.equals) return true;
      }
      return false;
    }
    default:
      return false;
  }
}

/**
 * The classification window for supervised-child transcripts: only the TAIL
 * is evidence. Death banners land at the end of a log, while a child's own
 * work product can legitimately contain signature text in the body — the
 * first live pipeline run misrouted a healthy child whose README diff
 * documented usage-limit failover (dogfood finding D1).
 * @param {string} text @param {number} [maxChars]
 * @returns {string}
 */
export function transcriptTail(text, maxChars = 4096) {
  const s = String(text ?? '');
  return s.length > maxChars ? s.slice(-maxChars) : s;
}

/**
 * Classify harness output. Structured evidence first (text and exit code are
 * ignored when a recognized structured signal is present); text signatures as
 * the fallback tier; exit code only breaks the no-match tie — a generic nonzero
 * exit is never usage-limit on its own.
 * @param {{text?: string, exitCode?: number, platform: string, table: any, structured?: {kind: string, errorType: string} | null}} input
 * @returns {{class: string, signatureId: string | null, confidence: string | null, resetHint: string | null, tried?: string[]}}
 */
export function classify({ text = '', exitCode = 0, platform, table, structured = null }) {
  if (structured) {
    if (structured.kind === 'stop-failure') {
      const cls = STOP_FAILURE_MAP[structured.errorType] ?? 'other-error';
      return { class: cls, signatureId: `structured:${structured.errorType}`, confidence: 'high', resetHint: null };
    }
    if (structured.kind === 'exec-json') {
      const cls = structured.errorType === 'usage_limit' ? 'usage-limit' : 'other-error';
      return { class: cls, signatureId: `structured:${structured.errorType}`, confidence: 'high', resetHint: null };
    }
    // Unrecognized structured kind: fall through to the text tier.
  }

  const stripped = text.replace(ANSI, '');
  const candidates = table.signatures.filter((/** @type {any} */ s) => s.platform === platform);
  /** @type {any} */
  let best = null;
  for (const s of candidates) {
    if (!matches(s.matcher, stripped)) continue;
    if (best === null || PRECEDENCE.indexOf(s.class) < PRECEDENCE.indexOf(best.class)) best = s;
  }

  if (best) {
    let resetHint = null;
    if (typeof best.resetHint === 'string') {
      const m = stripped.match(new RegExp(best.resetHint));
      if (m) resetHint = m[1] ?? m[0];
    }
    return { class: best.class, signatureId: best.id, confidence: best.confidence, resetHint };
  }

  return {
    class: exitCode !== 0 ? 'other-error' : 'ok',
    signatureId: null,
    confidence: null,
    resetHint: null,
  };
}
