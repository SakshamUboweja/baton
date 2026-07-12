// Fake `io` object matching the injected-io contract from docs/design/core.md:
// { cwd, env, stdin, stdout, stderr, fs, execFile, now }. Backed by memfs.
// stdout/stderr collect writes; io.stdoutText()/io.stderrText() flatten them.
// now() returns a settable ISO string (io.setNow). execFile resolves from an
// execResults map keyed by the joined command string.
//
// Wave-B2 additions (bundle lock layer) — all optional, defaulted, and purely
// additive so no prior consumer is affected:
//   host / pid / startTime  — the process-identity facts the lock model writes
//     into owner.json and compares on contention (see plan §Concurrency, Lock
//     model iterations 3+4).
//   processAlive(pid, startTime) — the "provably dead" oracle. Default: only
//     THIS io's own {pid, startTime} is alive; every other descriptor reads as
//     dead. Override per test to model a live foreign owner or a pid/start-time
//     mismatch (reused pid).
//   newFencingToken() — the injected per-acquisition token source. Deterministic
//     monotonic counter ("tok-1", "tok-2", …), matching the injected-io
//     discipline already used for now()/execFile so lock acquisition is
//     reproducible in tests rather than drawing from Math.random.

import { makeMemfs } from './memfs.mjs';

export function makeIo({
  files = {},
  env = {},
  stdin = '',
  execResults = {},
  now = '2026-07-11T00:00:00.000Z',
  host = 'host-A',
  pid = 4242,
  startTime = 111000,
  processAlive = null,
  fencingSeed = 1,
} = {}) {
  const { fs, files: filesSnapshot } = makeMemfs(files);
  const outChunks = [];
  const errChunks = [];
  let currentNow = now;
  let tokenCounter = fencingSeed - 1;
  const defaultAlive = (p, s) => p === pid && s === startTime;

  const stdout = { write: (s) => { outChunks.push(String(s)); return true; } };
  const stderr = { write: (s) => { errChunks.push(String(s)); return true; } };

  const execFile = (cmd, args = [], /* opts */ _opts = {}) => {
    const key = [cmd, ...(Array.isArray(args) ? args : [])].join(' ');
    return new Promise((resolve, reject) => {
      if (!(key in execResults)) {
        const e = new Error(`spawn ${cmd} ENOENT`);
        e.code = 'ENOENT';
        return reject(e);
      }
      const r = execResults[key];
      const code = r.code ?? 0;
      const out = r.stdout ?? '';
      const err = r.stderr ?? '';
      if (code !== 0) {
        // util.promisify(execFile) rejects on nonzero exit; error carries code + streams.
        const e = new Error(`Command failed: ${key}`);
        e.code = code;
        e.stdout = out;
        e.stderr = err;
        return reject(e);
      }
      resolve({ stdout: out, stderr: err });
    });
  };

  return {
    cwd: '/repo',
    env,
    stdin,
    stdout,
    stderr,
    fs,
    execFile,
    now: () => currentNow,
    setNow: (iso) => { currentNow = iso; },
    host,
    pid,
    startTime,
    processAlive: processAlive || defaultAlive,
    // Tiny retry budget: unit tests exercising live-lock refusal stay fast
    // while the retry code path itself still runs (production default: 120x25ms).
    lockRetry: { attempts: 2, delayMs: 2 },
    newFencingToken: () => `tok-${++tokenCounter}`,
    stdoutText: () => outChunks.join(''),
    stderrText: () => errChunks.join(''),
    files: filesSnapshot,
  };
}
