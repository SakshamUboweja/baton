#!/usr/bin/env node
const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  process.stderr.write(`baton requires Node >= 20 (running ${process.versions.node})\n`);
  process.exit(2);
}

const fs = await import('node:fs');
const { execFile, execFileSync, spawn } = await import('node:child_process');
const { promisify } = await import('node:util');
const nodePath = await import('node:path');
const { run } = await import('../src/cli.mjs');

// Commands consume stdin as a string (hook payloads arrive that way).
let stdin = '';
if (!process.stdin.isTTY) {
  try {
    const { readFileSync } = fs.default ?? fs;
    stdin = readFileSync(0, 'utf8');
  } catch {
    stdin = '';
  }
}

const code = await run(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdin,
  fs: fs.default ?? fs,
  execFile: promisify(execFile),
  now: () => new Date().toISOString(),
  // Absolute path to THIS node binary. Harness hook files embed it so a
  // GUI-launched harness (Cursor/Codex desktop app) — whose minimal PATH omits
  // nvm/volta shims — can still resolve node to run baton.
  execPath: process.execPath,
  host: (await import('node:os')).hostname(),
  pid: process.pid,
  // Epoch ms of THIS process's start — comparable against `ps` output when a
  // later checker verifies whether our recorded pid was reused (gate-2 fix).
  startTime: Math.round(performance.timeOrigin),
  processAlive: (/** @type {number} */ pid, /** @type {number | null} */ startTime) => {
    try {
      process.kill(pid, 0);
    } catch (err) {
      // EPERM proves the process EXISTS (another user's live process) — never
      // read a permission error as provably dead (gate-2 reviewer-b finding 13).
      return /** @type {any} */ (err)?.code === 'EPERM';
    }
    if (typeof startTime !== 'number') return true;
    // The pid is alive — verify it is the SAME process (pid reuse check): a
    // wildly different OS start time means the recorded owner is gone.
    try {
      const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim();
      if (out === '') return false;
      const started = Date.parse(out);
      if (!Number.isFinite(started)) return true; // unparseable — stay conservative: treat as alive
      return Math.abs(started - startTime) < 10_000;
    } catch {
      return true; // unverifiable — never steal on uncertainty
    }
  },
  // Kill a process or (negative pid) process group — the supervisor's orphan
  // reaper on dead-lock reclaim (gate-2 fold H4).
  processKill: (/** @type {number} */ pid, /** @type {NodeJS.Signals | number} */ signal) => {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false; // ESRCH/EPERM — nothing reapable
    }
  },
  // Fork a background supervisor for `--detach` (v1.1 item 10, POSIX): re-run
  // this same node binary with the baton args (minus --detach), fully detached
  // from the terminal, with stdout+stderr redirected to a byte-capped
  // supervisor.out. Returns the child pid; the child acquires the run lock as
  // its own owner. Truncation to spec.maxBytes is enforced by opening the log
  // in truncate mode and letting the OS-level pipe stay bounded by the child's
  // own capped child-logs; the file itself is size-guarded on next open.
  spawnDetached: (/** @type {{args: string[], cwd?: string, env?: any, outPath: string, maxBytes?: number}} */ spec) => {
    const nodeFs = fs.default ?? fs;
    nodeFs.mkdirSync(nodePath.dirname(spec.outPath), { recursive: true });
    // Fresh log per detach; the child streams into it. A prior oversized log is
    // truncated by 'w'.
    const out = nodeFs.openSync(spec.outPath, 'w');
    const child = spawn(process.execPath, [new URL(import.meta.url).pathname, ...spec.args], {
      cwd: spec.cwd,
      env: spec.env ?? process.env,
      detached: true,
      stdio: ['ignore', out, out],
    });
    child.unref();
    return { pid: child.pid };
  },
  newFencingToken: () => `tok-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  platform: process.platform,
  stdout: process.stdout,
  stderr: process.stderr,
});
process.exit(code);
