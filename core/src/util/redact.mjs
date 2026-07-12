// Secret redaction for transcript tails (plan §Transcript policy; gate-2
// fix 10). Pattern classes cover the common credential shapes; anything
// matched is replaced wholesale with [redacted]. False positives are cheap
// (a redacted transcript line), false negatives are not — patterns lean broad.

const MARKER = '[redacted]';

const PATTERNS = [
  // PEM private key blocks (multi-line) — first so inner matches don't shred it.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // Vendor token prefixes.
  /\bsk-[A-Za-z0-9_-]{8,}/g, // OpenAI / Anthropic (incl. sk-ant-…)
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  // JWTs (three base64url segments, first decoding to a JSON header).
  /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g,
  // Authorization headers.
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
  // Generic credential assignments: api_key = "…", password: …, token=…
  /\b(?:api[_-]?key|secret|token|passwd|password|authorization)\b\s*[:=]\s*["']?[^\s"']{8,}["']?/gi,
];

/**
 * @param {string} text
 * @returns {string}
 */
export function redactSecrets(text) {
  if (typeof text !== 'string' || text.length === 0) return typeof text === 'string' ? text : '';
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, MARKER);
  return out;
}
