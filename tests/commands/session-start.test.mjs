import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeIo } from '../helpers/fakeio.mjs';
import { cmdSessionStart } from '../../core/src/commands/session-start.mjs';

// ---------------------------------------------------------------------------
// Gate-2 fix 8 (reviewer-a finding 11): Codex and Cursor SessionStart hooks
// used to run FULL receive preparation — exit-1 noise with no bundle, a resume
// prompt for the session's own open bundle, and the wrong output shape for
// Cursor. `baton session-start` is the cheap gate the adapters call instead:
// it inspects only pending-foreign state (sealed OR limit-hit, AND from
// another platform), emits the harness-specific context shape, and ALWAYS
// exits 0 — a session-start notice must never break a session.
//
// Pending matrix mirrors the claude-code hook contract (S3):
//   positive:  foreign SEALED bundle                       -> context
//   positive:  foreign OPEN + reasonClass usage-limit      -> context
//   negative:  foreign OPEN non-limit                      -> nothing
//   negative:  own-platform sealed / open                  -> nothing
//   negative:  no bundle / no .handoff                     -> nothing
// ---------------------------------------------------------------------------

const T0 = '2026-07-12T00:00:00.000Z';

function bundleWith(overrides = {}) {
  const b = {
    schema: 'baton/bundle@1',
    bundleId: 'b_sessionstart00',
    generation: 1,
    createdAt: T0,
    updatedAt: T0,
    origin: { platform: 'claude-code', model: 'claude-fable-5', sessionHint: 'sess-cc', unstable: false },
    task: { goal: 'g', constraints: [], acceptance: [] },
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
  return { ...b, ...overrides, handoff: { ...b.handoff, ...(overrides.handoff ?? {}) }, origin: { ...b.origin, ...(overrides.origin ?? {}) } };
}

const withBundle = (b) => makeIo({ files: { '/repo/.handoff/bundle.json': JSON.stringify(b, null, 2) + '\n' } });

describe('session-start — pending-foreign matrix (always exit 0)', () => {
  it('foreign sealed bundle -> codex gets a plain-text notice', async () => {
    const io = withBundle(bundleWith({ handoff: { status: 'sealed', reason: 'limits', finalizedAt: T0 } }));
    assert.equal(await cmdSessionStart(['--platform', 'codex'], io), 0);
    const out = io.stdoutText();
    assert.match(out, /claude-code/, 'names the origin platform');
    assert.match(out, /sealed/);
    assert.match(out, /receive/, 'points at the receive flow');
    assert.doesNotMatch(out, /[{}]/, 'codex context is plain text, not JSON');
  });

  it('foreign open limit-hit bundle (unsealed limit death) -> notice', async () => {
    const io = withBundle(bundleWith({ handoff: { status: 'open', reasonClass: 'usage-limit' } }));
    assert.equal(await cmdSessionStart(['--platform', 'codex'], io), 0);
    assert.match(io.stdoutText(), /limit-hit/);
  });

  it('limit-hit visible ONLY in the journal (post-snapshot note) still surfaces', async () => {
    const io = withBundle(bundleWith({}));
    const note = {
      seq: 1,
      ts: T0,
      type: 'note',
      dedupeKey: 'k-limit',
      payload: { text: 'rate limited', structured: { kind: 'stop-failure' }, errorType: 'rate_limit' },
    };
    io.fs.writeFileSync('/repo/.handoff/journal.ndjson', JSON.stringify(note) + '\n');
    assert.equal(await cmdSessionStart(['--platform', 'codex'], io), 0);
    assert.match(io.stdoutText(), /limit-hit/, 'the cheap path must replay the journal, not trust the stale snapshot');
  });

  it('foreign open NON-limit bundle -> quiet', async () => {
    const io = withBundle(bundleWith({}));
    assert.equal(await cmdSessionStart(['--platform', 'codex'], io), 0);
    assert.equal(io.stdoutText(), '');
  });

  it('own-platform sealed bundle -> quiet (own work is not a pending handoff)', async () => {
    const io = withBundle(bundleWith({ origin: { platform: 'codex', model: 'gpt-5.6-sol' }, handoff: { status: 'sealed', reason: 'r' } }));
    assert.equal(await cmdSessionStart(['--platform', 'codex'], io), 0);
    assert.equal(io.stdoutText(), '');
  });

  it('no .handoff at all -> quiet exit 0 (the old receive prep exited 1 here)', async () => {
    const io = makeIo({ files: { '/repo/x.txt': 'x' } });
    assert.equal(await cmdSessionStart(['--platform', 'codex'], io), 0);
    assert.equal(io.stdoutText(), '');
  });

  it('corrupt snapshot with no journal -> quiet exit 0, never a throw', async () => {
    const io = makeIo({ files: { '/repo/.handoff/bundle.json': 'not json{{' } });
    assert.equal(await cmdSessionStart(['--platform', 'codex'], io), 0);
    assert.equal(io.stdoutText(), '');
  });

  it('missing --platform -> exit 0 with a stderr note, nothing on stdout', async () => {
    const io = withBundle(bundleWith({ handoff: { status: 'sealed' } }));
    assert.equal(await cmdSessionStart([], io), 0);
    assert.equal(io.stdoutText(), '');
    assert.match(io.stderrText(), /--platform/);
  });
});

describe('session-start — harness-specific context shapes', () => {
  const sealed = () => bundleWith({ handoff: { status: 'sealed', reason: 'limits', finalizedAt: T0 } });

  it('cursor gets {"additional_context": …} JSON', async () => {
    const io = withBundle(sealed());
    assert.equal(await cmdSessionStart(['--platform', 'cursor'], io), 0);
    const parsed = JSON.parse(io.stdoutText());
    assert.equal(typeof parsed.additional_context, 'string');
    assert.match(parsed.additional_context, /claude-code/);
    assert.equal(parsed.hookSpecificOutput, undefined);
  });

  it('claude-code gets the hookSpecificOutput shape', async () => {
    const io = withBundle(bundleWith({ origin: { platform: 'codex', model: 'gpt-5.6-sol' }, handoff: { status: 'sealed', reason: 'r' } }));
    assert.equal(await cmdSessionStart(['--platform', 'claude-code'], io), 0);
    const parsed = JSON.parse(io.stdoutText());
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(parsed.hookSpecificOutput.additionalContext, /codex/);
  });
});
