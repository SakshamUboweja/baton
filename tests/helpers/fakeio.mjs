// Fake `io` object matching the injected-io contract from docs/design/core.md:
// { cwd, env, stdin, stdout, stderr, fs, execFile, now }. Backed by memfs.
// stdout/stderr collect writes; io.stdoutText()/io.stderrText() flatten them.
// now() returns a settable ISO string (io.setNow). execFile resolves from an
// execResults map keyed by the joined command string.

import { makeMemfs } from './memfs.mjs';

export function makeIo({
  files = {},
  env = {},
  stdin = '',
  execResults = {},
  now = '2026-07-11T00:00:00.000Z',
} = {}) {
  const { fs, files: filesSnapshot } = makeMemfs(files);
  const outChunks = [];
  const errChunks = [];
  let currentNow = now;

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
    stdoutText: () => outChunks.join(''),
    stderrText: () => errChunks.join(''),
    files: filesSnapshot,
  };
}
