import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Gate-2 fix (reviewer-b finding 1): the hook script must WORK when executed
// exactly as hooks.json invokes it — `node …/scripts/hook.mjs <Event>` with the
// hook payload on stdin — not merely export a function. These tests spawn the
// real script over a real scratch cwd and assert the .handoff/ mutation the
// production path exists to produce. Fail-open is asserted at the same
// altitude: garbage stdin still exits 0.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const HOOK = join(repoRoot, 'adapters', 'claude-code', 'scripts', 'hook.mjs');

/** @type {string[]} */
const dirs = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'baton-hook-spawn-'));
  dirs.push(d);
  return d;
};
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Spawn the hook exactly as hooks.json does. */
function runHookProcess(cwd, event, stdin) {
  return spawnSync('node', [HOOK, event], {
    cwd,
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: repoRoot },
    timeout: 60_000,
  });
}

describe('hook.mjs — spawn-level (production invocation shape)', () => {
  it('a Stop event with a baton/event@1 payload creates/extends .handoff/ in the hook cwd', () => {
    const cwd = scratch();
    const payload = JSON.stringify({
      schema: 'baton/event@1',
      type: 'decision',
      payload: { summary: 'spawned-hook-checkpoint' },
      source: 'claude-code',
      sessionHint: 'spawn-sess-1',
      unstable: false,
    });

    const r = runHookProcess(cwd, 'Stop', payload);
    assert.equal(r.status, 0, `the hook exits 0; stderr: ${r.stderr}`);

    const snapshot = join(cwd, '.handoff', 'bundle.json');
    assert.ok(existsSync(snapshot), 'the real hook invocation produced a bundle — the adapter is not a no-op');
    const bundle = JSON.parse(readFileSync(snapshot, 'utf8'));
    assert.ok(
      bundle.decisions.some((/** @type {any} */ d) => d.summary === 'spawned-hook-checkpoint'),
      'the stdin payload reached the core CLI through the child stdin (execFile input forwarding)',
    );
  });

  it('garbage stdin still exits 0 and mutates nothing (fail-open at spawn altitude)', () => {
    const cwd = scratch();
    const r = runHookProcess(cwd, 'Stop', 'not json at all {');
    assert.equal(r.status, 0, `fail-open: garbage payload exits 0; stderr: ${r.stderr}`);
    assert.ok(!existsSync(join(cwd, '.handoff', 'journal.ndjson')), 'an ignored payload appends nothing');
  });

  it('SessionStart with no bundle is a quiet exit-0 no-op', () => {
    const cwd = scratch();
    const r = runHookProcess(cwd, 'SessionStart', JSON.stringify({ hook_event_name: 'SessionStart' }));
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '', 'nothing pending means no context output');
  });
});
