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
// a long run of characters its classes accept, then a non-matching tail. The
// old probe drew fill chars only from the pattern's LITERAL [A-Za-z0-9], so a
// group-free star over \d / \s / [!-/] never got a matching input and was
// reported safe, then hung classify(). These fills exercise digits, spaces,
// word chars, and common punctuation ranges regardless of how the class is
// spelled; the tail (\x01) is outside all of them, forcing a full backtrack.
const COVER = ['0', '9', ' ', '\t', 'a', 'Z', '_', '!', '/', '-', '.', '#', '@'];
const TAIL = String.fromCharCode(1);

/**
 * Build adversarial probe inputs: one long run per covering-alphabet char plus
 * the pattern's own literals, each ending in a non-matching byte.
 * @param {string} pattern
 * @returns {string[]}
 */
function probeInputs(pattern) {
  const literals = [...new Set(pattern.match(/[A-Za-z0-9]/g) ?? [])].slice(0, 4);
  const fills = [...new Set([...COVER, ...literals])];
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
