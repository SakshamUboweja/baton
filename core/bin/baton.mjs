#!/usr/bin/env node
const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  process.stderr.write(`baton requires Node >= 20 (running ${process.versions.node})\n`);
  process.exit(2);
}

const { run } = await import('../src/cli.mjs');
const code = run(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
});
process.exit(code);
