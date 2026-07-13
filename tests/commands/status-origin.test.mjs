import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeIo } from '../helpers/fakeio.mjs';
import { cmdStatus } from '../../core/src/commands/status.mjs';

// Audit finding 11: the /baton:handoff ownership check reads `status --json`,
// but the envelope carried only {bundleId, status, generation, updatedAt} —
// no origin, so "is this bundle owned by another platform?" was unanswerable
// from the documented command. status now surfaces origin + goal.

const BUNDLE = {
  schema: 'baton/bundle@1',
  bundleId: 'b_status00000000',
  generation: 3,
  createdAt: '2026-07-13T00:00:00.000Z',
  updatedAt: '2026-07-13T00:00:00.000Z',
  origin: { platform: 'codex', model: 'gpt-5.6-sol', sessionHint: 'codex-s-9', unstable: false },
  task: { goal: 'Ship the audit fold', constraints: [], acceptance: [] },
  plan: { steps: [] },
  decisions: [],
  files: { touched: [] },
  roles: { assignments: {} },
  git: null,
  handoff: { status: 'open', reason: null, reasonClass: null, toPlatformHint: null, finalizedAt: null, receive_log: [] },
  journalSeq: 0,
  compaction: { droppedDecisions: 0, note: null },
  dedupeRing: [],
};

describe('status — surfaces bundle ownership', () => {
  it('--json data carries origin {platform, sessionHint, unstable} and the goal', async () => {
    const io = makeIo({ files: { '/repo/.handoff/bundle.json': JSON.stringify(BUNDLE, null, 2) + '\n' } });
    assert.equal(await cmdStatus(['--json'], io), 0);
    const { data } = JSON.parse(io.stdoutText());
    assert.deepEqual(data.origin, { platform: 'codex', sessionHint: 'codex-s-9', unstable: false });
    assert.equal(data.goal, 'Ship the audit fold');
  });

  it('bare mode names the owner too', async () => {
    const io = makeIo({ files: { '/repo/.handoff/bundle.json': JSON.stringify(BUNDLE, null, 2) + '\n' } });
    assert.equal(await cmdStatus([], io), 0);
    assert.match(io.stdoutText(), /owner codex\/codex-s-9/);
  });
});
