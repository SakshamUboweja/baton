#!/usr/bin/env node
const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  process.stderr.write(`baton requires Node >= 20 (running ${process.versions.node})\n`);
  process.exit(2);
}

const fs = await import('node:fs');
const { execFile, execFileSync } = await import('node:child_process');
const { promisify } = await import('node:util');
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
  newFencingToken: () => `tok-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  stdout: process.stdout,
  stderr: process.stderr,
});
process.exit(code);
