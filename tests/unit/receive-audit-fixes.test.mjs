import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { makeIo } from '../helpers/fakeio.mjs';
import { prepare, commit } from '../../core/src/receive/txn.mjs';
import { loadBundle } from '../../core/src/bundle/store.mjs';

// ---------------------------------------------------------------------------
// Surface-audit fold (post-Gate-2): the receive token contract as a MODEL
// actually drives it. Findings addressed here:
//  - stale-token errors name WHICH bound input drifted (the generic six-way
//    guess left models in a deterministic re-prepare loop);
//  - a spent token re-committed by the SAME receiver is idempotent success
//    (alreadyCommitted), never a re-prepare instruction that produces a
//    duplicate receive (generation bumped twice, bogus degraded archive);
//  - intake defaults from the sealed bundle: prepare/commit without --origin/
//    --reason render and record the SEALED origin/reason instead of
//    "unknown"/"unspecified".
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const SIG_PATH = join(repoRoot, 'core', 'data', 'signatures.v1.json');
const SIG_CONTENT = readFileSync(SIG_PATH, 'utf8');

const ROOT = '/repo';
const NOW = '2026-07-11T00:00:00.000Z';
const CONFIG_TEXT = JSON.stringify({
  schema: 'baton/config@1',
  roles: { planner: ['claude-code/claude-fable-5'], implementer: ['claude-code/claude-fable-5', 'codex/gpt-5.6-sol@xhigh'] },
  platforms: { 'claude-code': {}, codex: {}, cursor: {} },
  defaults: { 'claude-code': 'claude-fable-5', codex: 'gpt-5.6-sol', cursor: 'composer' },
});
const G1 = { branch: 'main', headSha: 'abc123', dirty: false, dirtySummary: [], contentDigest: 'gd-1' };
const snapText = (b) => JSON.stringify(b, null, 2) + '\n';

function sealedBundle(overrides = {}) {
  return {
    schema: 'baton/bundle@1',
    bundleId: 'b_audit000000000',
    generation: 1,
    createdAt: NOW,
    updatedAt: NOW,
    origin: { platform: 'claude-code', model: 'claude-fable-5', sessionHint: 'sess-A', unstable: false },
    task: { goal: 'Fold the audit', constraints: [], acceptance: [] },
    plan: { steps: [{ id: 's1', title: 'Fix receive', status: 'active', note: null }] },
    decisions: [],
    files: { touched: [] },
    roles: { assignments: {} },
    git: { branch: 'main', headSha: 'abc123', dirty: false, dirtySummary: [], contentDigest: 'd0', summaryTruncated: false },
    handoff: { status: 'sealed', reason: 'weekly Opus limit hit mid-task', reasonClass: 'usage-limit', toPlatformHint: 'codex', finalizedAt: NOW, receive_log: [] },
    journalSeq: 5,
    compaction: { droppedDecisions: 0, note: null },
    dedupeRing: [],
    ...overrides,
  };
}

function txnIo(bundle) {
  return makeIo({
    files: {
      [SIG_PATH]: SIG_CONTENT,
      [`${ROOT}/baton.config.json`]: CONFIG_TEXT,
      [`${ROOT}/.handoff/bundle.json`]: snapText(bundle),
      [`${ROOT}/.handoff/journal.ndjson`]: '',
    },
    now: NOW,
  });
}
const opts = (overrides = {}) => ({ platform: 'codex', origin: 'claude-code', reason: 'weekly Opus limit hit mid-task', gitSnapshot: G1, probes: null, sessionHint: 'codex-sess-1', ...overrides });

// ===========================================================================
describe('stale-token rejection names the drifted input', () => {
  it('an intake-reason drift is named in the error, and re-prepare is still the remedy', () => {
    const io = txnIo(sealedBundle());
    const { token } = prepare(ROOT, opts({ reason: 'reason at prepare' }), io);
    assert.throws(
      () => commit(ROOT, token, opts({ reason: 'DIFFERENT reason at commit' }), io),
      (/** @type {any} */ e) => /re-?prepare/i.test(e.message) && /intake reason\b/.test(e.message),
      'the error names the drifted input (intake reason) so the model stops guessing',
    );
  });

  it('a target-platform drift is named too', () => {
    const io = txnIo(sealedBundle());
    const { token } = prepare(ROOT, opts({ platform: 'codex' }), io);
    assert.throws(
      () => commit(ROOT, token, opts({ platform: 'cursor', sessionHint: 'cursor-s' }), io),
      (/** @type {any} */ e) => /target platform/.test(e.message) && /target session/.test(e.message),
      'platform and session drifts are both named',
    );
  });
});

// ===========================================================================
describe('spent-token re-commit is idempotent (audit finding: duplicate-receive corruption)', () => {
  it('re-committing the SAME token returns alreadyCommitted with zero mutation', () => {
    const io = txnIo(sealedBundle());
    const { token } = prepare(ROOT, opts(), io);
    const first = commit(ROOT, token, opts(), io);
    assert.equal(first.generation, 2);

    const before = io.files();
    const second = commit(ROOT, token, opts(), io);
    assert.equal(second.alreadyCommitted, true, 'the retry reports the receive already landed');
    assert.equal(second.generation, 2, 'and names the generation it landed as');
    assert.deepEqual(io.files(), before, 'the idempotent retry mutates nothing');
    assert.equal(loadBundle(ROOT, io).bundle.generation, 2, 'no duplicate receive: generation advanced exactly once');
  });

  it("a COMPETITOR's stale token still throws (different receipt, not idempotent)", () => {
    const io = txnIo(sealedBundle());
    const winner = prepare(ROOT, opts({ platform: 'codex', sessionHint: 'codex-s' }), io);
    const loser = prepare(ROOT, opts({ platform: 'cursor', sessionHint: 'cursor-s' }), io);
    commit(ROOT, winner.token, opts({ platform: 'codex', sessionHint: 'codex-s' }), io);
    assert.throws(
      () => commit(ROOT, loser.token, opts({ platform: 'cursor', sessionHint: 'cursor-s' }), io),
      /re-?prepare/i,
      'the losing receiver must re-prepare against the new generation',
    );
  });
});

// ===========================================================================
describe('intake defaults from the sealed bundle (no more unknown/unspecified)', () => {
  it('prepare without intake flags renders the SEALED origin and reason in the prompt', () => {
    const io = txnIo(sealedBundle());
    const out = prepare(ROOT, opts({ origin: 'unknown', reason: 'unspecified' }), io);
    assert.ok(out.prompt.includes('Handed off from claude-code'), `prompt uses the sealed origin — got: ${out.prompt.split('\n')[2]}`);
    assert.ok(out.prompt.includes('weekly Opus limit hit mid-task'), 'prompt uses the sealed reason');
  });

  it('prepare→commit both defaulting stays token-consistent, and the receive_log records the defaulted intake', () => {
    const io = txnIo(sealedBundle());
    const { token } = prepare(ROOT, opts({ origin: 'unknown', reason: 'unspecified' }), io);
    const res = commit(ROOT, token, opts({ origin: 'unknown', reason: 'unspecified' }), io);
    assert.equal(res.generation, 2, 'defaulted intake commits cleanly');
    const entry = loadBundle(ROOT, io).bundle.handoff.receive_log.at(-1);
    assert.equal(entry.origin, 'claude-code', 'the audit trail records the real origin, not the sentinel');
    assert.equal(entry.reason, 'weekly Opus limit hit mid-task');
  });

  it('explicit intake flags still win over the sealed values', () => {
    const io = txnIo(sealedBundle());
    const out = prepare(ROOT, opts({ origin: 'cursor', reason: 'user preference' }), io);
    assert.ok(out.prompt.includes('Handed off from cursor'), 'explicit --origin wins');
    assert.ok(out.prompt.includes('user preference'), 'explicit --reason wins');
  });
});
