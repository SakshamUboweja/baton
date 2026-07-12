import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeIo } from '../helpers/fakeio.mjs';
import { cmdCheckpoint } from '../../core/src/commands/checkpoint.mjs';
import { writeSnapshot } from '../../core/src/bundle/store.mjs';
import { emptyBundle } from '../../core/src/bundle/schema.mjs';

// ---------------------------------------------------------------------------
// Gate-2 fix 10 (reviewer-a finding 4 / reviewer-b finding 8): the plan's
// checkpoint pipeline features shipped unwired — no git capture at checkpoint,
// capture.transcriptTail a dead config key, compact() never called at runtime.
// This file pins all three into the observable command surface.
// ---------------------------------------------------------------------------

const T0 = '2026-07-12T00:00:00.000Z';

const GIT_OK = {
  'git rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
  'git rev-parse HEAD': { stdout: 'abc1234def\n' },
  'git status --porcelain': { stdout: ' M src/a.js\n' },
  'git diff --cached': { stdout: '' },
  'git diff': { stdout: 'diff --git a/src/a.js b/src/a.js\n' },
  'git ls-files --others --exclude-standard': { stdout: '' },
};

// An IMPORTANT event (decision is not a routine type) forces a snapshot rewrite.
const importantEvent = JSON.stringify({ schema: 'baton/event@1', type: 'decision', payload: { summary: 'chose approach A' } });

const bundleJson = () => JSON.stringify(emptyBundle({ platform: 'claude-code', model: 'm', goal: 'g' }, T0), null, 2) + '\n';

describe('checkpoint — bounded git refresh on important checkpoints', () => {
  it('an important event captures branch/HEAD/dirty into the snapshot', async () => {
    const io = makeIo({
      files: { '/repo/.handoff/bundle.json': bundleJson() },
      stdin: importantEvent,
      execResults: GIT_OK,
      now: T0,
    });
    assert.equal(await cmdCheckpoint(['--platform', 'claude-code'], io), 0);
    const snap = JSON.parse(io.files()['/repo/.handoff/bundle.json']);
    assert.equal(snap.git?.branch, 'main');
    assert.equal(snap.git?.headSha, 'abc1234def');
    assert.equal(snap.git?.dirty, true);
  });

  it('git unavailable degrades silently — checkpoint still lands, git stays null', async () => {
    const io = makeIo({ files: { '/repo/.handoff/bundle.json': bundleJson() }, stdin: importantEvent, now: T0 });
    assert.equal(await cmdCheckpoint(['--platform', 'claude-code'], io), 0);
    const snap = JSON.parse(io.files()['/repo/.handoff/bundle.json']);
    assert.equal(snap.git, null);
    assert.ok(snap.decisions.some((/** @type {any} */ d) => d.summary === 'chose approach A'));
  });
});

describe('checkpoint — config-gated transcript tail capture (plan §Transcript policy)', () => {
  const messages = [];
  for (let i = 1; i <= 14; i++) messages.push(JSON.stringify({ role: i % 2 ? 'user' : 'assistant', content: `message-${i}` }));
  messages.push(JSON.stringify({ role: 'assistant', content: 'the key is sk-ant-api03-PLANTEDSECRET123456 ok' }));
  const transcript = messages.join('\n') + '\n';
  const preCompact = JSON.stringify({ hook_event_name: 'PreCompact', session_id: 's1', transcript_path: '/repo/.claude/t.jsonl' });

  const files = (config) => ({
    '/repo/.handoff/bundle.json': bundleJson(),
    '/repo/.claude/t.jsonl': transcript,
    ...(config === null ? {} : { '/repo/baton.config.json': JSON.stringify(config) }),
  });

  it('OFF by default: no transcript field even at PreCompact with a path', async () => {
    const io = makeIo({ files: files(null), stdin: preCompact, now: T0 });
    assert.equal(await cmdCheckpoint(['--platform', 'claude-code'], io), 0);
    const snap = JSON.parse(io.files()['/repo/.handoff/bundle.json']);
    assert.equal(snap.transcript, undefined);
    assert.doesNotMatch(io.files()['/repo/.handoff/journal.ndjson'] ?? '', /message-1/);
  });

  it('ON: captures the bounded, redacted tail at PreCompact; HANDOFF.md never shows it', async () => {
    const io = makeIo({
      files: files({ schema: 'baton/config@1', capture: { transcriptTail: true } }),
      stdin: preCompact,
      now: T0,
    });
    assert.equal(await cmdCheckpoint(['--platform', 'claude-code'], io), 0);
    const snap = JSON.parse(io.files()['/repo/.handoff/bundle.json']);
    assert.equal(typeof snap.transcript?.tail, 'string');
    assert.match(snap.transcript.tail, /message-14/, 'recent messages are in the tail');
    assert.doesNotMatch(snap.transcript.tail, /message-1\b/, 'only the LAST 10 messages are kept');
    assert.ok(Buffer.byteLength(snap.transcript.tail) <= 8192, '8 KB cap enforced');
    assert.doesNotMatch(snap.transcript.tail, /PLANTEDSECRET/, 'planted secret is redacted');
    assert.match(snap.transcript.tail, /\[redacted\]/);
    assert.doesNotMatch(io.files()['/repo/.handoff/HANDOFF.md'], /message-14|\[redacted\]/, 'the tail is excluded from HANDOFF.md');
  });

  it('ON but a routine Stop event (not PreCompact): no capture', async () => {
    const io = makeIo({
      files: files({ schema: 'baton/config@1', capture: { transcriptTail: true } }),
      stdin: JSON.stringify({ hook_event_name: 'Stop', session_id: 's1', transcript_path: '/repo/.claude/t.jsonl' }),
      now: T0,
    });
    assert.equal(await cmdCheckpoint(['--platform', 'claude-code'], io), 0);
    const snapText = io.files()['/repo/.handoff/bundle.json'];
    assert.doesNotMatch(snapText, /message-14/);
  });
});

describe('writeSnapshot — compaction runs in the snapshot write path', () => {
  it('an oversized decision log is truncated with the compaction marker on disk', () => {
    const b = emptyBundle({ platform: 'claude-code', model: 'm', goal: 'g' }, T0);
    for (let i = 1; i <= 250; i++) b.decisions.push({ seq: i, ts: T0, summary: `decision-${i}` });
    b.journalSeq = 250;
    const io = makeIo({ files: { '/repo/x.txt': 'x' }, now: T0 });
    writeSnapshot('/repo', b, io);
    const snap = JSON.parse(io.files()['/repo/.handoff/bundle.json']);
    assert.ok(snap.decisions.length < 250, `decisions were compacted (got ${snap.decisions.length})`);
    assert.ok(snap.decisions.some((/** @type {any} */ d) => /compacted:/.test(d.summary)), 'the compaction marker is present');
    assert.ok(snap.compaction.droppedDecisions > 0);
    assert.ok(snap.decisions.some((/** @type {any} */ d) => d.summary === 'decision-250'), 'the newest decisions survive');
    assert.ok(snap.decisions.some((/** @type {any} */ d) => d.summary === 'decision-1'), 'the earliest decisions survive');
  });
});
