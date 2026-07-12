import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeIo } from '../helpers/fakeio.mjs';
import { resolveRoot } from '../../core/src/commands/shared.mjs';
import { cmdCheckpoint } from '../../core/src/commands/checkpoint.mjs';

// ---------------------------------------------------------------------------
// Gate-2 fix 5 (reviewer-a finding 5 / reviewer-b finding 10): root discovery.
// Commands must resolve the repo root — nearest ancestor with .handoff/ or
// baton.config.json, else the .git toplevel (a boundary the walk never
// crosses), else cwd — with --root overriding everything. A checkpoint from a
// subdirectory must land in the repo root's bundle, never seed a stray one.
// ---------------------------------------------------------------------------

const event = JSON.stringify({ schema: 'baton/event@1', type: 'decision', payload: { summary: 'from-subdir' } });

describe('resolveRoot — discovery ladder', () => {
  it('--root overrides everything', () => {
    const io = makeIo({ files: { '/elsewhere/baton.config.json': '{}' } });
    assert.equal(resolveRoot(io, { root: '/explicit' }), '/explicit');
  });

  it('nearest ancestor with .handoff/ wins', () => {
    const io = makeIo({ files: { '/repo/.handoff/bundle.json': '{}' } });
    io.cwd = '/repo/deep/sub/dir';
    io.fs.mkdirSync('/repo/deep/sub/dir', { recursive: true });
    assert.equal(resolveRoot(io, {}), '/repo');
  });

  it('nearest ancestor with baton.config.json wins when no .handoff exists', () => {
    const io = makeIo({ files: { '/repo/baton.config.json': '{}', '/repo/sub/x.txt': 'x' } });
    io.cwd = '/repo/sub';
    assert.equal(resolveRoot(io, {}), '/repo');
  });

  it('falls back to the .git toplevel and never walks past it (nested-repo boundary)', () => {
    const io = makeIo({
      files: {
        '/outer/baton.config.json': '{}', // the outer repo has a marker…
        '/outer/inner/.git/HEAD': 'ref: refs/heads/main\n', // …but inner is its own repo
        '/outer/inner/src/x.txt': 'x',
      },
    });
    io.cwd = '/outer/inner/src';
    assert.equal(resolveRoot(io, {}), '/outer/inner', 'the nested .git stops the walk before the outer marker');
  });

  it('nothing anywhere -> cwd', () => {
    const io = makeIo({ files: { '/lonely/x.txt': 'x' } });
    io.cwd = '/lonely';
    assert.equal(resolveRoot(io, {}), '/lonely');
  });
});

describe('root discovery — checkpoint from a subdirectory lands in the repo bundle', () => {
  it('does not seed a stray bundle under the subdirectory', async () => {
    const bundle = {
      schema: 'baton/bundle@1',
      bundleId: 'b_root000000000',
      generation: 1,
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-11T00:00:00.000Z',
      origin: { platform: 'claude-code', model: 'm', sessionHint: null, unstable: false },
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
    const io = makeIo({
      files: { '/repo/.handoff/bundle.json': JSON.stringify(bundle, null, 2) + '\n', '/repo/sub/dir/x.txt': 'x' },
      stdin: event,
    });
    io.cwd = '/repo/sub/dir';

    const code = await cmdCheckpoint(['--platform', 'claude-code'], io);
    assert.equal(code, 0);

    assert.equal(io.files()['/repo/sub/dir/.handoff/bundle.json'], undefined, 'no stray bundle under the subdirectory');
    const rootBundle = JSON.parse(io.files()['/repo/.handoff/bundle.json']);
    assert.ok(rootBundle.decisions.some((/** @type {any} */ d) => d.summary === 'from-subdir'), 'the event landed in the repo root bundle');
  });
});
