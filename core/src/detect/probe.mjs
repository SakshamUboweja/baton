import { Worker } from 'node:worker_threads';

// Load-time pathological-regex probe (plan §Threat model; gate-2 fix 6). The
// structural lint in signatures.mjs rejects every quantified-group shape it
// can see, but a pattern with no groups at all (e.g. a chained-star `a*a*…x`)
// can still backtrack combinatorially. This probe runs the candidate against
// adversarial inputs inside a worker thread and enforces a hard wall-clock
// deadline via Atomics.wait — a synchronous regex match cannot be interrupted
// in-process, so isolation is the only reliable bound. Overlay tables pass
// through this at load; the classify() hot path stays synchronous because
// every table it sees was probed here first.

const DEADLINE_MS = 1000; // generous vs worker spawn (~50-100 ms); tiny vs the 93.8 s repro
const INPUT_LEN = 4096;

// A covering alphabet (gate-2 iter-2 M8): a chained-star pattern backtracks on
// a long run of characters its classes accept, then a non-matching tail. These
// fills exercise digits, spaces, word chars, and common punctuation ranges
// regardless of how the class is spelled; the tail (\x01) is outside all of
// them, forcing a full backtrack.
const COVER = ['0', '9', ' ', '\t', 'a', 'Z', '_', '!', '/', '-', '.', '#', '@'];
const TAIL = String.fromCharCode(1);
const MAX_PATTERN_FILLS = 32; // bound probe cost; overlays have few distinct literals

// Structural regex metacharacters — NOT content, so never used as a fill run.
const META = new Set(['(', ')', '[', ']', '{', '}', '|', '^', '$', '.', '*', '+', '?', '\\', '-', '/', '\n', '\r']);

/**
 * Every LITERAL code point the pattern can match a run of, including non-ASCII
 * (gate-2 iter-3 F7): the ASCII-only cover + `[A-Za-z0-9]` extraction missed a
 * chained star over a non-ASCII literal (`é*é*…`) or class (`[à-ÿ]*…`),
 * so it probed SAFE and then hung classify() on real non-ASCII input. Escapes
 * are decoded to their literal char and class-range endpoints are captured (a
 * run of an endpoint char backtracks the same as any interior member).
 * @param {string} pattern
 * @returns {string[]}
 */
function patternLiterals(pattern) {
  /** @type {Set<string>} */
  const out = new Set();
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      const n = pattern[i + 1];
      if (n === 'x') {
        out.add(String.fromCharCode(parseInt(pattern.slice(i + 2, i + 4), 16)));
        i += 3;
        continue;
      }
      if (n === 'u') {
        if (pattern[i + 2] === '{') {
          const e = pattern.indexOf('}', i);
          out.add(cp(parseInt(pattern.slice(i + 3, e), 16)));
          i = e;
          continue;
        }
        out.add(String.fromCharCode(parseInt(pattern.slice(i + 2, i + 6), 16)));
        i += 5;
        continue;
      }
      // Control escapes decode to their real char; escaped metacharacters (`\(`,
      // `\.`, `\*`…) decode to the literal char (iter-4 I4 defense-in-depth: the
      // old code dropped these, so a chained star over an escaped metachar or a
      // `\n` literal never got a matching probe run). Class shorthands are
      // already represented by COVER.
      const named = { n: '\n', t: '\t', r: '\r', f: '\f', v: '\v', 0: '\0' };
      if (Object.prototype.hasOwnProperty.call(named, n)) out.add(named[/** @type {'n'} */ (n)]);
      else if (n !== undefined && !'dwsDWSbB'.includes(n)) out.add(n);
      i += 1;
      continue;
    }
    if (!META.has(c)) out.add(c);
  }
  return [...out];
}

/** @param {number} n @returns {string} */
function cp(n) {
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

/**
 * Build adversarial probe inputs: one long run per covering-alphabet char plus
 * the pattern's own literal code points, each ending in a non-matching byte.
 * @param {string} pattern
 * @returns {string[]}
 */
function probeInputs(pattern) {
  const fills = [...new Set([...COVER, ...patternLiterals(pattern)])].slice(0, MAX_PATTERN_FILLS);
  return fills.map((c) => c.repeat(INPUT_LEN) + TAIL);
}

/**
 * @param {string} pattern @param {string} [flags] @param {number} [timeoutMs]
 * @returns {{safe: true} | {safe: false, reason: string}}
 */
export function probeRegexSafe(pattern, flags = '', timeoutMs = DEADLINE_MS) {
  // Pre-compile in the main thread (gate-2 iter-2 B3): a bad pattern/flag pair
  // is a COMPILE error reported distinctly, never conflated with a timeout.
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern, flags);
  } catch (err) {
    return { safe: false, reason: `invalid regex pattern/flags (compile error: ${/** @type {any} */ (err)?.message ?? 'syntax error'})` };
  }
  const sab = new SharedArrayBuffer(4);
  const flag = new Int32Array(sab);
  const worker = new Worker(new URL('./probe-worker.mjs', import.meta.url), {
    workerData: { pattern, flags, inputs: probeInputs(pattern), sab },
  });
  const waited = Atomics.wait(flag, 0, 0, timeoutMs);
  worker.terminate();
  worker.unref();
  if (waited === 'timed-out') {
    return { safe: false, reason: `pathological backtracking: probe match exceeded the ${timeoutMs} ms deadline` };
  }
  return { safe: true };
}
