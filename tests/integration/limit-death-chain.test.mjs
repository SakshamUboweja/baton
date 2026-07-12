import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Gate-2 fix 12 (reviewer-a finding 16): adapter-to-core STATE tests. The
// primary failure case — a Claude Code session dying on rate_limit before it
// can seal — is exercised through the real production chain: the shipped hook
// script marks the bundle limit-hit, and a later Codex/Cursor session start
// (the real `baton session-start` gate) surfaces the pending handoff. Argv
// inspection proves nothing here; every assertion below is persisted state or
// real child-process output.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const HOOK = join(repoRoot, 'adapters', 'claude-code', 'scripts', 'hook.mjs');
const BATON = join(repoRoot, 'core', 'bin', 'baton.mjs');

/** @type {string[]} */
const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('unsealed limit death → cross-platform session start (full production chain)', () => {
  it('StopFailure(rate_limit) via the hook, then codex session-start surfaces the pending handoff', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'baton-chain-'));
    dirs.push(cwd);

    // 1. The dying Claude Code session: hooks.json invokes the hook script.
    const stopFailure = spawnSync('node', [HOOK, 'StopFailure'], {
      cwd,
      input: JSON.stringify({ hook_event_name: 'StopFailure', session_id: 'chain-sess', cwd, error: { type: 'rate_limit' } }),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: repoRoot },
      timeout: 60_000,
    });
    assert.equal(stopFailure.status, 0, `hook exits 0; stderr: ${stopFailure.stderr}`);

    const bundle = JSON.parse(readFileSync(join(cwd, '.handoff', 'bundle.json'), 'utf8'));
    assert.equal(bundle.handoff.status, 'open', 'no seal was written — the degraded shape');
    assert.equal(bundle.handoff.reasonClass, 'usage-limit', 'the limit death is persisted state, not a log line');

    // 2. The NEXT session on another platform: its SessionStart hook runs the
    // cheap gate and must surface the pending handoff.
    const codexStart = spawnSync('node', [BATON, 'session-start', '--platform', 'codex', '--root', cwd], {
      cwd,
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert.equal(codexStart.status, 0, `session-start always exits 0; stderr: ${codexStart.stderr}`);
    assert.match(codexStart.stdout, /claude-code/, 'the notice names the origin platform');
    assert.match(codexStart.stdout, /limit-hit/, 'the notice names the unsealed limit death');
    assert.match(codexStart.stdout, /receive/, 'the notice points at the receive flow');

    // 3. Same platform as the origin: quiet — a session's own bundle is not a
    // pending handoff, and the gate never exits nonzero.
    const ownStart = spawnSync('node', [BATON, 'session-start', '--platform', 'claude-code', '--root', cwd], {
      cwd,
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert.equal(ownStart.status, 0);
    assert.equal(ownStart.stdout.trim(), '', 'own-platform bundle stays quiet');
  });
});
