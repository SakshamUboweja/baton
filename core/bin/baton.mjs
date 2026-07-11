#!/usr/bin/env node
const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  process.stderr.write(`baton requires Node >= 20 (running ${process.versions.node})\n`);
  process.exit(2);
}

const fs = await import('node:fs');
const { execFile } = await import('node:child_process');
const { run } = await import('../src/cli.mjs');
const code = run(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  fs: fs.default ?? fs,
  execFile,
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
