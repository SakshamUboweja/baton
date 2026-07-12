import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeIo } from '../helpers/fakeio.mjs';
import { cmdCheckpoint } from '../../core/src/commands/checkpoint.mjs';
import { emptyBundle } from '../../core/src/bundle/schema.mjs';

// ---------------------------------------------------------------------------
// Gate-2 iteration-2 findings M1 (reviewer-a #1), M5 (reviewer-a #10),
// m1 (reviewer-b #2):
// - M1: git is refreshed on EVERY snapshot rewrite (a routine Stop that clears
//   the throttle must still carry fresh branch/HEAD/dirty), not only on an
//   "important" event.
// - M5: the debounce stamp check-and-set runs UNDER the repo lock, so two
//   simultaneous afterFileEdit hooks can't both observe no stamp (barrier test
//   lives in the concurrency suite; here we pin serialized behavior + lock use).
// - m1: transcript_path from the untrusted payload is confined to an allowlist
//   (repo root, ~/.claude, or a configured dir); an arbitrary path is refused.
// ---------------------------------------------------------------------------

const T0 = '2026-07-12T00:00:00.000Z';
const plus = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();

const GIT_OK = {
  'git rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
  'git rev-parse HEAD': { stdout: 'routinesha\n' },
  'git status --porcelain': { stdout: ' M x.js\n' },
  'git diff --cached': { stdout: '' },
  'git diff': { stdout: '' },
  'git ls-files --others --exclude-standard': { stdout: '' },
};

function seededBundle(updatedAt) {
  const b = emptyBundle({ platform: 'claude-code', model: 'm', goal: 'g' }, T0);
  b.updatedAt = updatedAt;
  return JSON.stringify(b, null, 2) + '\n';
}

describe('M1 — git refreshed on every snapshot rewrite, not just important events', () => {
  it('a ROUTINE Stop that clears the throttle (elapsed > 30s) still captures git', async () => {
    // A Stop payload normalizes to a routine `note` event; an old snapshot
    // updatedAt makes `elapsed` true, forcing a rewrite.
    const io = makeIo({
      files: { '/repo/.handoff/bundle.json': seededBundle(T0) },
      stdin: JSON.stringify({ hook_event_name: 'Stop', session_id: 's1' }),
      execResults: GIT_OK,
      now: plus(T0, 60_000),
    });
    assert.equal(await cmdCheckpoint(['--platform', 'claude-code'], io), 0);
    const snap = JSON.parse(io.files()['/repo/.handoff/bundle.json']);
    assert.equal(snap.git?.headSha, 'routinesha', 'git was refreshed on the routine rewrite');
    assert.equal(snap.git?.branch, 'main');
  });

  it('git unavailable on a rewrite degrades to null, checkpoint still lands', async () => {
    const io = makeIo({
      files: { '/repo/.handoff/bundle.json': seededBundle(T0) },
      stdin: JSON.stringify({ hook_event_name: 'Stop', session_id: 's1' }),
      now: plus(T0, 60_000),
    });
    assert.equal(await cmdCheckpoint(['--platform', 'claude-code'], io), 0);
    assert.equal(JSON.parse(io.files()['/repo/.handoff/bundle.json']).git, null);
  });
});

describe('M5 — debounce stamp check-and-set is serialized under the lock', () => {
  it('acquires the repo lock to write its stamp (jail applies)', async () => {
    // A symlinked managed tree must make the debounce path refuse too, proving
    // the stamp write goes through withLock (which jails first).
    const io = makeIo({
      files: { '/repo/.handoff/bundle.json': '{}' },
      stdin: JSON.stringify({ event: 'afterFileEdit' }),
      now: T0,
    });
    const realLstat = io.fs.lstatSync.bind(io.fs);
    io.fs.lstatSync = (p) => {
      if (String(p) === '/repo/.handoff') return { ...realLstat('/repo/.handoff'), isSymbolicLink: () => true, isDirectory: () => true, isFile: () => false };
      return realLstat(p);
    };
    // Soft-fail (exit 0) but nothing written through the link: no stamp file.
    assert.equal(await cmdCheckpoint(['--platform', 'cursor', '--debounce', '120'], io), 0);
    assert.equal(io.fs.existsSync('/repo/.handoff/log/debounce-cursor.json'), false, 'no stamp written through a symlinked tree');
  });

  it('still debounces correctly in the serial case', async () => {
    const io = makeIo({ files: { '/repo/.handoff/bundle.json': seededBundle(T0) }, stdin: JSON.stringify({ event: 'afterFileEdit' }), now: T0 });
    await cmdCheckpoint(['--platform', 'cursor', '--debounce', '120'], io);
    const afterFirst = io.files()['/repo/.handoff/journal.ndjson'] ?? '';
    io.setNow(plus(T0, 30_000));
    await cmdCheckpoint(['--platform', 'cursor', '--debounce', '120'], io);
    assert.equal(io.files()['/repo/.handoff/journal.ndjson'] ?? '', afterFirst, 'the in-window second edit appends nothing');
  });
});

describe('m1 — transcript_path confined to an allowlist', () => {
  const cfgOn = JSON.stringify({ schema: 'baton/config@1', capture: { transcriptTail: true } });
  const preCompact = (path) => JSON.stringify({ hook_event_name: 'PreCompact', session_id: 's1', transcript_path: path });

  it('a transcript under the repo root is captured', async () => {
    const io = makeIo({
      files: { '/repo/.handoff/bundle.json': seededBundle(T0), '/repo/baton.config.json': cfgOn, '/repo/.claude/t.jsonl': 'hello world\nmore\n' },
      stdin: preCompact('/repo/.claude/t.jsonl'),
      now: T0,
    });
    await cmdCheckpoint(['--platform', 'claude-code'], io);
    assert.match(JSON.parse(io.files()['/repo/.handoff/bundle.json']).transcript?.tail ?? '', /hello world/);
  });

  it('a transcript under ${HOME}/.claude (where Claude Code really writes) is captured', async () => {
    const io = makeIo({
      env: { HOME: '/home/u' },
      files: { '/repo/.handoff/bundle.json': seededBundle(T0), '/repo/baton.config.json': cfgOn, '/home/u/.claude/projects/x/sess.jsonl': 'transcript line\n' },
      stdin: preCompact('/home/u/.claude/projects/x/sess.jsonl'),
      now: T0,
    });
    await cmdCheckpoint(['--platform', 'claude-code'], io);
    assert.match(JSON.parse(io.files()['/repo/.handoff/bundle.json']).transcript?.tail ?? '', /transcript line/);
  });

  it('an arbitrary path outside the allowlist is REFUSED (no capture, checkpoint still lands)', async () => {
    const io = makeIo({
      env: { HOME: '/home/u' },
      files: { '/repo/.handoff/bundle.json': seededBundle(T0), '/repo/baton.config.json': cfgOn, '/etc/shadow': 'root:x:secret\n' },
      stdin: preCompact('/etc/shadow'),
      now: T0,
    });
    assert.equal(await cmdCheckpoint(['--platform', 'claude-code'], io), 0);
    const snap = JSON.parse(io.files()['/repo/.handoff/bundle.json']);
    assert.equal(snap.transcript, undefined, 'a path outside the allowlist is never read/stored');
    assert.doesNotMatch(io.files()['/repo/.handoff/bundle.json'], /root:x:secret/);
  });

  it('a configured capture.transcriptDir extends the allowlist', async () => {
    const cfg = JSON.stringify({ schema: 'baton/config@1', capture: { transcriptTail: true, transcriptDir: '/var/logs/agent' } });
    const io = makeIo({
      files: { '/repo/.handoff/bundle.json': seededBundle(T0), '/repo/baton.config.json': cfg, '/var/logs/agent/t.jsonl': 'configured dir line\n' },
      stdin: preCompact('/var/logs/agent/t.jsonl'),
      now: T0,
    });
    await cmdCheckpoint(['--platform', 'claude-code'], io);
    assert.match(JSON.parse(io.files()['/repo/.handoff/bundle.json']).transcript?.tail ?? '', /configured dir line/);
  });
});
