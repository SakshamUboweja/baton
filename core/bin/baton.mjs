#!/usr/bin/env node
const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  process.stderr.write(`baton requires Node >= 20 (running ${process.versions.node})\n`);
  process.exit(2);
}

const fs = await import('node:fs');
const { execFile } = await import('node:child_process');
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
  startTime: null,
  processAlive: (/** @type {number} */ pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  newFencingToken: () => `tok-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  stdout: process.stdout,
  stderr: process.stderr,
});
process.exit(code);
