import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { makeIo } from '../helpers/fakeio.mjs';
import { cmdCheckpoint } from '../../core/src/commands/checkpoint.mjs';
import { cmdReceive } from '../../core/src/commands/receive.mjs';
import { bundlePaths, loadBundle } from '../../core/src/bundle/store.mjs';

// ---------------------------------------------------------------------------
// Gate-2 fix 2 (reviewer-a finding 2 / reviewer-b findings 3+5): session
// ownership seams. An unverified owner — a fresh auto-seed (null hint) or a
// receive that defaulted to a host-derived hint — must ADOPT the first stable
// same-platform session, after which semantic isolation engages. The receiving
// session's next real hook checkpoint (carrying a hint the receive never saw)
// must be accepted as first-party, never rejected as foreign.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const SIG_PATH = join(repoRoot, 'core', 'data', 'signatures.v1.json');
const SIG_CONTENT = readFileSync(SIG_PATH, 'utf8');

const ROOT = '/repo';
const paths = bundlePaths(ROOT);
const NOW = '2026-07-11T00:00:00.000Z';

const CONFIG_TEXT = JSON.stringify({
  schema: 'baton/config@1',
  roles: { implementer: ['claude-code/claude-fable-5', 'codex/gpt-5.6-sol@xhigh'] },
  platforms: { 'claude-code': {}, codex: {}, cursor: {} },
  defaults: { 'claude-code': 'claude-fable-5', codex: 'gpt-5.6-sol', cursor: 'composer' },
});

const GIT_CLEAN = {
  'git rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
  'git rev-parse HEAD': { stdout: 'abc123\n' },
  'git status --porcelain': { stdout: '' },
  'git diff --cached': { stdout: '' },
  'git diff': { stdout: '' },
  'git ls-files --others --exclude-standard': { stdout: '' },
};

const event = (obj) => JSON.stringify({ schema: 'baton/event@1', ...obj });

function sealedBundle() {
  return {
    schema: 'baton/bundle@1',
    bundleId: 'b_adopt00000000',
    generation: 1,
    createdAt: NOW,
    updatedAt: NOW,
    origin: { platform: 'claude-code', model: 'claude-fable-5', sessionHint: 'sess-A', unstable: false },
    task: { goal: 'g', constraints: [], acceptance: [] },
    plan: { steps: [] },
    decisions: [],
    files: { touched: [] },
    roles: { assignments: {} },
    git: { branch: 'main', headSha: 'abc123', dirty: false, dirtySummary: [], contentDigest: 'd0' },
    handoff: { status: 'sealed', reason: "You've hit your usage limit", reasonClass: 'usage-limit', toPlatformHint: 'codex', finalizedAt: NOW, receive_log: [] },
    journalSeq: 0,
    compaction: { droppedDecisions: 0, note: null },
    dedupeRing: [],
  };
}

// ===========================================================================
describe('session adoption — auto-seed adopts the first stable session (B5)', () => {
  it('a seed created by a stable-hint event is OWNED by that session; a foreign stable hint is then rejected', async () => {
    const io = makeIo({ stdin: event({ type: 'decision', payload: { summary: 'first' }, sessionHint: 'real-sess-1', unstable: false }) });

    assert.equal(await cmdCheckpoint(['--platform', 'claude-code'], io), 0);
    const owned = loadBundle(ROOT, io).bundle;
    assert.equal(owned.origin.sessionHint, 'real-sess-1', 'the seed adopted the first stable session as owner');
    assert.equal(owned.origin.unstable, false);

    // A different stable session now hits the same bundle: isolation must engage.
    io.stdin = event({ type: 'decision', payload: { summary: 'intruder' }, sessionHint: 'other-sess', unstable: false });
    assert.equal(await cmdCheckpoint(['--platform', 'claude-code'], io), 0, 'rejection is still hook-safe');
    assert.match(io.stderrText(), /--take-over/, 'the foreign session is told about --take-over');
    assert.ok(!loadBundle(ROOT, io).bundle.decisions.some((d) => d.summary === 'intruder'), 'the foreign event did not merge');
  });
});

// ===========================================================================
describe('session adoption — post-receive first-party checkpoint (B3)', () => {
  it('after a receive with NO --session, a checkpoint carrying a hint receive never saw is ACCEPTED and adopts ownership', async () => {
    const io = makeIo({
      files: {
        [SIG_PATH]: SIG_CONTENT,
        [`${ROOT}/baton.config.json`]: CONFIG_TEXT,
        [paths.snapshot]: JSON.stringify(sealedBundle(), null, 2) + '\n',
        [paths.journal]: '',
      },
      execResults: GIT_CLEAN,
    });

    // Receive on codex with the DEFAULTED session hint (no --session flag).
    const prep = await cmdReceive(['--platform', 'codex', '--prepare', '--origin', 'claude-code', '--reason', 'limit', '--json'], io);
    assert.equal(prep, 0);
    const { token } = JSON.parse(io.stdoutText()).data;
    assert.equal(await cmdReceive(['--platform', 'codex', '--commit', token, '--origin', 'claude-code', '--reason', 'limit', '--json'], io), 0);

    const adopted = loadBundle(ROOT, io).bundle;
    assert.equal(adopted.origin.platform, 'codex');
    assert.equal(adopted.origin.unstable, true, 'a defaulted host-derived hint is marked unstable — not a verified session id');

    // The real harness session now checkpoints with ITS OWN id — one the
    // receive never saw. This must be first-party, not foreign.
    io.stdin = event({ type: 'decision', payload: { summary: 'post-receive-work' }, sessionHint: 'codex-real-session-xyz', unstable: false, source: 'codex' });
    assert.equal(await cmdCheckpoint(['--platform', 'codex'], io), 0);

    const after = loadBundle(ROOT, io).bundle;
    assert.ok(after.decisions.some((d) => d.summary === 'post-receive-work'), "the receiving session's first real checkpoint is ACCEPTED (plan: subsequent checkpoints are first-party)");
    assert.equal(after.origin.sessionHint, 'codex-real-session-xyz', 'ownership adopted to the real harness session');
    assert.equal(after.origin.unstable, false);
    assert.doesNotMatch(io.stderrText(), /--take-over/, 'no foreign-session rejection fired');
  });

  it('an explicit --session keeps a STABLE owner that later foreign hints cannot displace', async () => {
    const io = makeIo({
      files: {
        [SIG_PATH]: SIG_CONTENT,
        [`${ROOT}/baton.config.json`]: CONFIG_TEXT,
        [paths.snapshot]: JSON.stringify(sealedBundle(), null, 2) + '\n',
        [paths.journal]: '',
      },
      execResults: GIT_CLEAN,
    });
    const prep = await cmdReceive(['--platform', 'codex', '--prepare', '--origin', 'claude-code', '--reason', 'limit', '--session', 'codex-known-sess', '--json'], io);
    assert.equal(prep, 0);
    const { token } = JSON.parse(io.stdoutText()).data;
    assert.equal(
      await cmdReceive(['--platform', 'codex', '--commit', token, '--origin', 'claude-code', '--reason', 'limit', '--session', 'codex-known-sess', '--json'], io),
      0,
    );

    const adopted = loadBundle(ROOT, io).bundle;
    assert.equal(adopted.origin.sessionHint, 'codex-known-sess');
    assert.equal(adopted.origin.unstable, false, 'an explicit session id is a verified stable owner');

    io.stdin = event({ type: 'decision', payload: { summary: 'intruder' }, sessionHint: 'someone-else', unstable: false, source: 'codex' });
    assert.equal(await cmdCheckpoint(['--platform', 'codex'], io), 0);
    assert.match(io.stderrText(), /--take-over/, 'a foreign stable hint against a verified owner is rejected');
    assert.ok(!loadBundle(ROOT, io).bundle.decisions.some((d) => d.summary === 'intruder'));
  });
});
