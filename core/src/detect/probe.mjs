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

/**
 * Build adversarial probe inputs from the pattern itself: long runs of the
 * pattern's own literal characters ending in a byte that cannot match, which
 * forces a full backtrack on pathological shapes.
 * @param {string} pattern
 * @returns {string[]}
 */
function probeInputs(pattern) {
  const chars = [...new Set(pattern.match(/[A-Za-z0-9]/g) ?? [])].slice(0, 4);
  if (chars.length === 0) chars.push('a');
  const tail = String.fromCharCode(1);
  const inputs = chars.map((c) => c.repeat(INPUT_LEN) + tail);
  inputs.push('a'.repeat(INPUT_LEN) + tail);
  return inputs;
}

/**
 * @param {string} pattern @param {string} [flags] @param {number} [timeoutMs]
 * @returns {{safe: true} | {safe: false, reason: string}}
 */
export function probeRegexSafe(pattern, flags = '', timeoutMs = DEADLINE_MS) {
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
