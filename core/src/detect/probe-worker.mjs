// Worker side of the regex pathological probe (see probe.mjs). Runs the
// candidate pattern against adversarial inputs in an isolated thread; the main
// thread waits on the shared flag with a hard deadline and terminates this
// worker if the matches never finish. flag[0]: 0 = running, 1 = done.
import { workerData } from 'node:worker_threads';

const { pattern, flags, inputs, sab } = workerData;
const flag = new Int32Array(sab);

try {
  const re = new RegExp(pattern, flags);
  for (const s of inputs) re.test(s);
} catch {
  // A compile error is not a hang; the lint layer reports syntax separately.
}

Atomics.store(flag, 0, 1);
Atomics.notify(flag, 0);
