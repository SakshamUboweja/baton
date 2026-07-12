import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { makeIo } from '../helpers/fakeio.mjs';
import { cmdCheckpoint } from '../../core/src/commands/checkpoint.mjs';
import { cmdFinalize } from '../../core/src/commands/finalize.mjs';
import { cmdPurgeTranscript } from '../../core/src/commands/purge-transcript.mjs';
import { loadBundle, writeSnapshot, rotateJournal } from '../../core/src/bundle/store.mjs';
import { emptyBundle } from '../../core/src/bundle/schema.mjs';
import { run } from '../../core/src/cli.mjs';
import { runHook } from '../../adapters/claude-code/scripts/hook.mjs';

// ---------------------------------------------------------------------------
// Gate-2 majors 14-15 + minors 16: cursor debounce; validate-before-backup +
// journal seed events; finalize reason-class validation; purge-marker
// auto-resume; lock-aware marker reconciliation on read paths; status through
// the recovery ladder; hook error logging with bounded retention; atomic
// history freeze copies.
// ---------------------------------------------------------------------------

const T0 = '2026-07-12T00:00:00.000Z';
const plus = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();
const EVENT = (summary) => JSON.stringify({ schema: 'baton/event@1', type: 'decision', payload: { summary }, sessionHint: 'mm-sess', unstable: false });

const validBundle = () => emptyBundle({ platform: 'claude-code', model: 'm', goal: 'g' }, T0);
const snapText = (b) => JSON.stringify(b, null, 2) + '\n';

// === major 14 ==============================================================
describe('checkpoint --debounce (cursor afterFileEdit)', () => {
  it('second call inside the window is skipped; a later one lands', async () => {
    const io = makeIo({ files: { '/repo/.handoff/bundle.json': snapText(validBundle()) }, stdin: EVENT('edit-1'), now: T0 });
    assert.equal(await cmdCheckpoint(['--platform', 'cursor', '--debounce', '120'], io), 0);

    io.stdin = EVENT('edit-2');
    io.setNow(plus(T0, 30_000)); // 30 s later — inside the 120 s window
    assert.equal(await cmdCheckpoint(['--platform', 'cursor', '--debounce', '120'], io), 0);

    io.stdin = EVENT('edit-3');
    io.setNow(plus(T0, 121_000)); // past the window
    assert.equal(await cmdCheckpoint(['--platform', 'cursor', '--debounce', '120'], io), 0);

    const journal = io.files()['/repo/.handoff/journal.ndjson'];
    assert.match(journal, /edit-1/);
    assert.doesNotMatch(journal, /edit-2/, 'the in-window event is debounced away');
    assert.match(journal, /edit-3/);
  });

  it('without the flag every event lands (debounce is opt-in per hook)', async () => {
    const io = makeIo({ files: { '/repo/.handoff/bundle.json': snapText(validBundle()) }, stdin: EVENT('a'), now: T0 });
    await cmdCheckpoint(['--platform', 'cursor'], io);
    io.stdin = EVENT('b');
    await cmdCheckpoint(['--platform', 'cursor'], io);
    const journal = io.files()['/repo/.handoff/journal.ndjson'];
    assert.match(journal, /"a"/);
    assert.match(journal, /"b"/);
  });

  it('the cursor template wires --debounce onto afterFileEdit and nothing else', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const cfg = JSON.parse(readFileSync(join(here, '..', '..', 'adapters', 'cursor', 'hooks.json'), 'utf8'));
    for (const item of cfg.hooks.afterFileEdit) assert.match(item.command, /--debounce \d+/);
    for (const ev of ['stop', 'preCompact', 'beforeShellExecution']) {
      for (const item of cfg.hooks[ev]) assert.doesNotMatch(item.command, /--debounce/, `${ev} must checkpoint un-debounced`);
    }
  });
});

// === major 15 ==============================================================
describe('.bak validate-before-backup + journal seed events', () => {
  it('a corrupt active snapshot never overwrites a good .bak', () => {
    const good = snapText(validBundle());
    const io = makeIo({ files: { '/repo/.handoff/bundle.json': 'corrupt{{{', '/repo/.handoff/bundle.json.bak': good }, now: T0 });
    writeSnapshot('/repo', { ...validBundle(), bundleId: 'b_after00000000' }, io);
    assert.equal(io.files()['/repo/.handoff/bundle.json.bak'], good, 'the good backup survives a corrupt-current write');
    assert.match(io.files()['/repo/.handoff/bundle.json'], /b_after00000000/, 'the new snapshot still lands');
  });

  it('a valid current snapshot still rotates into .bak', () => {
    const first = validBundle();
    const io = makeIo({ files: { '/repo/.handoff/bundle.json': snapText(first) }, now: T0 });
    writeSnapshot('/repo', { ...validBundle(), bundleId: 'b_second0000000' }, io);
    assert.match(io.files()['/repo/.handoff/bundle.json.bak'], new RegExp(first.bundleId));
  });

  it('auto-seed writes a self-applying seed event so a journal-only rebuild restores the origin facts', async () => {
    const io = makeIo({ stdin: EVENT('first-work'), now: T0 });
    assert.equal(await cmdCheckpoint(['--platform', 'claude-code', '--model', 'claude-fable-5'], io), 0);
    assert.match(io.files()['/repo/.handoff/journal.ndjson'], /bundle\.seed/, 'the seed is a replayable bundle.seed event, not a bare note');
    const seededId = JSON.parse(io.files()['/repo/.handoff/bundle.json']).bundleId;

    // Kill snapshot AND backup: the journal alone must restore identity+origin.
    io.fs.unlinkSync('/repo/.handoff/bundle.json');
    io.fs.rmSync('/repo/.handoff/bundle.json.bak', { force: true });
    const { bundle } = loadBundle('/repo', io);
    assert.ok(bundle, 'journal-only rebuild works');
    assert.equal(bundle.origin.platform, 'claude-code', 'origin platform restored (not "unknown")');
    assert.equal(bundle.origin.model, 'claude-fable-5', 'origin model restored');
    assert.equal(bundle.bundleId, seededId, 'bundle identity survives the journal-only rebuild');
  });
});

// === minors 16 =============================================================
describe('finalize --reason-class validation', () => {
  it('rejects an unknown class with usage exit 2', async () => {
    const io = makeIo({ files: { '/repo/.handoff/bundle.json': snapText(validBundle()) }, now: T0 });
    assert.equal(await cmdFinalize(['--reason', 'r', '--reason-class', 'bogus', '--json'], io), 2);
    assert.equal(JSON.parse(io.stdoutText()).error.code, 'usage');
  });

  it('accepts each of the four classes', async () => {
    for (const cls of ['usage-limit', 'auth', 'throttle', 'other-error']) {
      const io = makeIo({ files: { '/repo/.handoff/bundle.json': snapText(validBundle()) }, now: T0 });
      assert.equal(await cmdFinalize(['--reason', 'r', '--reason-class', cls], io), 0, `${cls} is a valid class`);
      assert.equal(JSON.parse(io.files()['/repo/.handoff/bundle.json']).handoff.reasonClass, cls);
    }
  });
});

describe('purge marker — auto-resume and read-path visibility', () => {
  it('a leftover purge marker is surfaced by loadBundle and resumed by the next purge run', async () => {
    const b = { ...validBundle(), transcript: { capturedAt: T0, tail: 'SECRET-tail' } };
    const io = makeIo({
      files: { '/repo/.handoff/bundle.json': snapText(b), '/repo/.handoff/purge.marker.json': JSON.stringify({ startedAt: T0 }) },
      now: T0,
    });

    const { warnings } = loadBundle('/repo', io);
    assert.ok(warnings.some((w) => /purge/i.test(w)), `read paths surface the interrupted purge: ${JSON.stringify(warnings)}`);

    assert.equal(await cmdPurgeTranscript([], io), 0);
    assert.match(io.stderrText(), /resum/i, 'the rerun names that it resumed an interrupted purge');
    assert.equal(io.fs.existsSync('/repo/.handoff/purge.marker.json'), false);
    assert.doesNotMatch(io.files()['/repo/.handoff/bundle.json'], /SECRET-tail/);
  });
});

describe('rotation-marker reconciliation respects the repo lock', () => {
  it('a held lock defers reconciliation with a warning instead of writing un-locked', () => {
    const marker = JSON.stringify({ kind: 'finalize', startedAt: T0, seq: 0 });
    const io = makeIo({
      files: {
        '/repo/.handoff/bundle.json': snapText(validBundle()),
        '/repo/.handoff/rotation.marker.json': marker,
        '/repo/.handoff/lock/owner.json': JSON.stringify({ host: 'host-A', pid: 777, startTime: 1, fencingToken: 'x' }),
      },
      now: T0,
      processAlive: () => true, // the lock holder is alive
    });
    const { warnings } = loadBundle('/repo', io);
    assert.equal(io.fs.existsSync('/repo/.handoff/rotation.marker.json'), true, 'the marker is untouched while the lock is held');
    assert.ok(warnings.some((w) => /defer/i.test(w)), `deferral is surfaced: ${JSON.stringify(warnings)}`);
  });
});

describe('status runs through the recovery ladder', () => {
  it('a corrupt snapshot with a good .bak still reports the bundle', async () => {
    const good = validBundle();
    const io = makeIo({
      files: { '/repo/.handoff/bundle.json': 'corrupt{{{', '/repo/.handoff/bundle.json.bak': snapText(good) },
      now: T0,
    });
    assert.equal(await run(['status', '--json'], io), 0, 'status recovers instead of failing on a corrupt snapshot');
    const env = JSON.parse(io.stdoutText());
    assert.equal(env.ok, true);
    assert.equal(env.data.bundleId, good.bundleId);
  });

  it('no bundle stays exit 1 with the no-bundle envelope', async () => {
    const io = makeIo({ files: { '/repo/x.txt': 'x' } });
    assert.equal(await run(['status', '--json'], io), 1);
    assert.equal(JSON.parse(io.stdoutText()).error.code, 'no-bundle');
  });
});

describe('hook errors land in .handoff/log with bounded, metadata-only entries', () => {
  const PLUGIN_ROOT = '/repo';
  const hookIo = (files = {}) => {
    const io = makeIo({ env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT }, stdin: JSON.stringify({ hook_event_name: 'Stop', session_id: 's', secret_payload: 'sk-ant-SUPERSECRET' }), files, now: T0 });
    io.execFile = () => Promise.reject(Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' }));
    return io;
  };

  it('a failing core invocation logs {ts, event, code} — never the payload', async () => {
    const io = hookIo();
    assert.equal(await runHook(['Stop'], io), 0, 'still fail-open');
    const log = io.files()['/repo/.handoff/log/hook-errors.jsonl'];
    assert.ok(log, 'the error log exists');
    const entry = JSON.parse(log.trim().split('\n')[0]);
    assert.equal(entry.event, 'Stop');
    assert.ok(entry.ts);
    assert.doesNotMatch(log, /SUPERSECRET/, 'metadata only — raw hook payloads never enter the log');
  });

  it('retention: at most 50 entries survive a write', async () => {
    const old = Array.from({ length: 60 }, (_, i) => JSON.stringify({ ts: T0, event: `old-${i}`, code: null })).join('\n') + '\n';
    const io = hookIo({ '/repo/.handoff/log/hook-errors.jsonl': old });
    await runHook(['Stop'], io);
    const lines = io.files()['/repo/.handoff/log/hook-errors.jsonl'].trim().split('\n');
    assert.ok(lines.length <= 50, `retention holds: ${lines.length} entries`);
    assert.match(lines[lines.length - 1], /"Stop"/, 'the newest entry is present');
  });
});

describe('history freeze copies are atomic', () => {
  it('the frozen snapshot first appears via rename, never as a partial write', () => {
    const io = makeIo({ files: { '/repo/.handoff/bundle.json': snapText(validBundle()), '/repo/.handoff/journal.ndjson': '' }, now: T0 });
    const stem = rotateJournal('/repo', 'finalize', io);
    const freezePath = `/repo/.handoff/history/${stem}.json`;
    assert.ok(io.fs.existsSync(freezePath));
    const firstAppearance = io.fs.__history.find((/** @type {any} */ h) => freezePath in h.files);
    assert.ok(firstAppearance, 'the freeze landed');
    assert.equal(firstAppearance.op, 'renameSync', `the freeze must land atomically (tmp+rename); first seen via ${firstAppearance.op}`);
  });
});
