import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdDoctor } from '../../core/src/commands/doctor.mjs';

// ---------------------------------------------------------------------------
// Gate-2 iteration-3 F4 (reviewer-a #3): doctor writes .handoff/log/
// probe-cache.json — a managed-tree write that must pass the jail, so a
// symlinked .handoff/log cannot redirect the cache outside the repository.
// Real fs (the memfs fake cannot represent symlinks). execFile is stubbed so no
// real harness binary is invoked.
// ---------------------------------------------------------------------------

/** @type {string[]} */
const dirs = [];
const scratch = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const doctorIo = (root) => {
  let out = '';
  return {
    cwd: root,
    env: {},
    fs: nodeFs,
    now: () => '2026-07-12T00:00:00.000Z',
    // Every child invocation (version/probe/df/git) returns benign empty output.
    execFile: () => Promise.resolve({ stdout: '', stderr: '' }),
    stdout: { write: (/** @type {string} */ s) => ((out += s), true) },
    stderr: { write: () => true },
    get output() {
      return out;
    },
  };
};

describe('doctor probe-cache write honors the managed-tree jail (F4)', () => {
  it('does NOT write the probe cache through a symlinked .handoff/log', async () => {
    const root = scratch('baton-doctorcache-');
    const outside = scratch('baton-doctorcache-outside-');
    mkdirSync(join(root, '.handoff'), { recursive: true });
    // Give doctor a repo marker so resolveRoot stays at root.
    writeFileSync(join(root, 'baton.config.json'), '{"schema":"baton/config@1","roles":{},"platforms":{},"defaults":{}}');
    symlinkSync(outside, join(root, '.handoff', 'log'), 'dir');

    const io = doctorIo(root);
    const code = await cmdDoctor(['--json'], io);
    assert.equal(typeof code, 'number', 'doctor returns an exit code, does not throw');

    // Nothing was written through the link into the outside directory.
    assert.deepEqual(readdirSync(outside), [], 'no probe-cache.json escaped through the symlinked log dir');
    assert.ok(nodeFs.lstatSync(join(root, '.handoff', 'log')).isSymbolicLink(), 'the log symlink is left intact');
  });

  it('DOES write the probe cache when the tree is safe (guard is symlink-specific)', async () => {
    const root = scratch('baton-doctorcache-ok-');
    mkdirSync(join(root, '.handoff'), { recursive: true });
    writeFileSync(join(root, 'baton.config.json'), '{"schema":"baton/config@1","roles":{},"platforms":{},"defaults":{}}');

    const io = doctorIo(root);
    await cmdDoctor(['--json'], io);
    assert.ok(existsSync(join(root, '.handoff', 'log', 'probe-cache.json')), 'the cache is written on a safe tree');
  });
});
