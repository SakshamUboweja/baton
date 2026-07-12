import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHook } from '../../adapters/claude-code/scripts/hook.mjs';

// ---------------------------------------------------------------------------
// Gate-2 iteration-3 finding-2 (test-verifier): the fail-open hook diagnostics
// logger writes into .handoff/log, so it must pass the SAME managed-tree jail
// as every other write. A symlinked .handoff/log pointing outside the repo must
// be refused — the logger must NOT create a file through the link — while still
// failing open (runHook returns 0). Proven over the REAL fs (the memfs fake
// cannot represent symlinks).
// ---------------------------------------------------------------------------

const SECRET = 'sk-ant-SUPERSECRET';
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

const failOpenIo = (root) => ({
  cwd: root,
  env: { CLAUDE_PLUGIN_ROOT: root },
  stdin: JSON.stringify({ hook_event_name: 'Stop', session_id: 's', secret_payload: SECRET }),
  stdout: { write: () => true },
  stderr: { write: () => true },
  fs: nodeFs,
  // Force the core child to fail so the diagnostics logger runs.
  execFile: () => Promise.reject(Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' })),
  now: () => '2026-07-12T00:00:00.000Z',
});

describe('hook diagnostics logger honors the managed-tree jail', () => {
  it('refuses to write through a symlinked .handoff/log (fail-open, no escape)', async () => {
    const root = scratch('baton-hooklog-root-');
    const outside = scratch('baton-hooklog-outside-');
    mkdirSync(join(root, '.handoff'), { recursive: true });
    // .handoff/log is a symlink pointing OUTSIDE the repository.
    symlinkSync(outside, join(root, '.handoff', 'log'), 'dir');

    const code = await runHook(['Stop'], failOpenIo(root));
    assert.equal(code, 0, 'the hook still fails open (returns 0)');

    // Nothing was written through the link into the outside directory.
    const escaped = readdirSync(outside);
    assert.deepEqual(escaped, [], `no file was written through the symlinked log path; found ${JSON.stringify(escaped)}`);
    assert.ok(nodeFs.lstatSync(join(root, '.handoff', 'log')).isSymbolicLink(), 'the log symlink is left intact (never followed)');
  });

  it('control: a normal .handoff/log DOES receive a metadata-only entry (guard is symlink-specific)', async () => {
    const root = scratch('baton-hooklog-ok-');
    mkdirSync(join(root, '.handoff'), { recursive: true });

    const code = await runHook(['Stop'], failOpenIo(root));
    assert.equal(code, 0, 'fail-open');

    const logPath = join(root, '.handoff', 'log', 'hook-errors.jsonl');
    assert.ok(existsSync(logPath), 'the diagnostics log is written when the tree is safe');
    const log = readFileSync(logPath, 'utf8');
    assert.match(log, /"Stop"/, 'the event is recorded');
    assert.doesNotMatch(log, new RegExp(SECRET), 'metadata only — the raw hook payload never enters the log');
  });
});
