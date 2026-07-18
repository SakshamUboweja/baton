import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeIo } from '../helpers/fakeio.mjs';
import { cmdCheckpoint } from '../../core/src/commands/checkpoint.mjs';
import { cmdSessionStart } from '../../core/src/commands/session-start.mjs';
import { bundlePaths } from '../../core/src/bundle/store.mjs';

// ---------------------------------------------------------------------------
// RED — Layer-1 supervised-child no-op guard (subtask l1-supervised-guard).
//
// Source of truth: docs/plans/2026-07-18-goal-loop-worktree-pipeline.md
//   §"Child-hook policy (Gate-1 iteration 2, finding 1; iteration 3,
//   finding 1)" and §"Acceptance constraints" constraint 1.
//
// Gate-1 findings this traces to:
//   - iteration-2 finding 1: Layer-2 main-root children collide with the
//     supervisor-owned bundle; the fix is a BATON_SUPERVISED_CHILD no-op guard
//     on the hook entrypoints AND `baton checkpoint` so children never touch
//     any bundle (no write, no foreign-session rejection).
//   - iteration-3 finding 1: the guard originally MISSED `session-start`, which
//     would still read the supervisor-owned bundle and inject pending-handoff
//     resume context into the child. The fix extends the guard to EVERY
//     hook-invoked command — `session-start` included — asserting zero writes
//     AND zero resume context.
//
// CONTRACT (pinned here):
//   G1. ACTIVATION. `BATON_SUPERVISED_CHILD` set to ANY non-empty string
//       activates the guard. Unset OR empty string ('') is NORMAL behavior.
//   G2. SILENCE. Under the guard, every hook-invoked command exits 0 with
//       stdout === '' and stderr === '' — even with --json (no envelope).
//   G3. NO .handoff/ TOUCH. Under the guard, the command reads NOTHING under
//       `<root>/.handoff/` (bundle, journal, lock, log) and writes NOTHING
//       anywhere. "Reads NOTHING" spans content reads (readFileSync) AND the
//       metadata/discovery probes core code uses — existsSync (root discovery,
//       shared.mjs), readdirSync, statSync, lstatSync, realpathSync
//       (store.mjs / jail). The no-read property is the security contract
//       (mirrors the symlink jail test, tests/commands/gate2-iter3-group6.test
//       .mjs F12): an implementation that reads the bundle then suppresses
//       output still leaks the supervisor bundle to the child and fails here.
//       "Writes NOTHING" is asserted BOTH via a spy over every fake-fs mutator
//       (write/append/mkdir/rename/unlink/rm/copy — lock.mjs uses rm/unlink,
//       store.mjs uses rename/unlink) AND via the authoritative memfs mutation
//       history (io.fs.__history), applied to EVERY guard-active case.
//   G4. GUARD-BEFORE-PARSING (ambiguity resolved — see note below). The guard
//       check runs FIRST, before flag parsing. So a garbled invocation (a
//       stray positional) or a missing required flag STILL produces the silent
//       exit-0 no-op instead of a usage error. Pinned per command.
//   G5. THREE PLATFORMS (acceptance constraint 1). The guard-active no-op holds
//       for the hook-shaped invocations the codex and cursor adapters emit
//       (adapters/codex/hooks.json, adapters/cursor/hooks.json), not just
//       claude-code — tabled below.
//
// CONTRACT AMBIGUITY RESOLVED: the plan says the guard "quietly no-ops (exit 0,
// empty output)" but does not state whether it precedes flag parsing. Two
// readings were possible: (a) parse first, then guard (a bad invocation exits 2
// even for a supervised child); (b) guard first (a supervised child is ALWAYS
// silent). We pinned (b) — the simpler, safer contract: a supervised child must
// NEVER emit anything on stdout/stderr or set a nonzero exit, because the
// supervisor spawns these hooks and any output/exit is noise it must not have
// to filter. The guard is the very first statement of each command.
// ---------------------------------------------------------------------------

const T0 = '2026-07-11T00:00:00.000Z';
const paths = bundlePaths('/repo');
const HANDOFF_PREFIX = '/repo/.handoff';
const PLATFORMS = ['claude-code', 'codex', 'cursor'];

// Representative hook-shaped `checkpoint` args per platform, mirroring the
// adapter hook manifests (adapters/<p>/hooks.json). Codex/Cursor carry an
// explicit --trigger; Cursor lower-cases its event ids.
/** @type {Record<string, string[]>} */
const CHECKPOINT_ARGS = {
  'claude-code': ['--platform', 'claude-code'],
  codex: ['--platform', 'codex', '--trigger', 'Stop'],
  cursor: ['--platform', 'cursor', '--trigger', 'stop'],
};

const snapText = (/** @type {any} */ b) => JSON.stringify(b, null, 2) + '\n';
const event = (/** @type {any} */ obj) => JSON.stringify({ schema: 'baton/event@1', ...obj });

function baseBundle(overrides = {}) {
  return {
    schema: 'baton/bundle@1',
    bundleId: 'b_guard0000000000',
    generation: 1,
    createdAt: T0,
    updatedAt: T0,
    origin: { platform: 'claude-code', model: 'claude-fable-5', sessionHint: null, unstable: false },
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
    ...overrides,
  };
}

// An OPEN own-platform bundle (sessionHint null → no foreign check): the state
// where a NORMAL checkpoint appends the journal / rewrites the snapshot.
const checkpointBundle = (/** @type {string} */ platform) =>
  baseBundle({ origin: { platform, model: 'm', sessionHint: null, unstable: false } });

// A foreign, sealed bundle: the state that NORMALLY makes session-start emit a
// pending-handoff resume notice on stdout (proven at its home in
// tests/commands/session-start.test.mjs). `origin` must differ from the running
// platform for the notice to fire.
const foreignSealedBundle = (/** @type {string} */ origin) =>
  baseBundle({
    bundleId: 'b_guardss00000000',
    origin: { platform: origin, model: 'm', sessionHint: 's', unstable: false },
    handoff: { status: 'sealed', reason: 'r', reasonClass: 'usage-limit', toPlatformHint: null, finalizedAt: T0, receive_log: [] },
  });

/** A platform other than `p` (so a bundle from it reads as foreign to `p`). */
const otherPlatform = (/** @type {string} */ p) => (p === 'codex' ? 'claude-code' : 'codex');

/**
 * Instrument io.fs: record the first touch of any path under `<root>/.handoff/`
 * across BOTH content reads and metadata/discovery probes, and record every
 * mutating call the memfs fake exposes. Mirrors the read spy idiom in
 * tests/commands/gate2-iter3-group6.test.mjs (F12), extended to the full read
 * and write surfaces per test-verifier iteration-01 findings 1 and 2.
 * @param {any} io
 */
function spyFs(io) {
  const state = {
    read: /** @type {string | null} */ (null), // first .handoff/ path touched by any reader
    writes: /** @type {string[]} */ ([]), // every mutated path
  };
  const noteRead = (/** @type {any} */ p) => {
    if (state.read === null && String(p).startsWith(HANDOFF_PREFIX)) state.read = String(p);
  };

  // Readers: content + metadata/discovery. Wrap on the same object memfs
  // returned, so memfs's internal lstatSync→statSync delegation is covered too.
  for (const m of ['readFileSync', 'existsSync', 'readdirSync', 'statSync', 'lstatSync', 'realpathSync']) {
    const real = io.fs[m].bind(io.fs);
    io.fs[m] = (/** @type {any} */ p, /** @type {any} */ a) => {
      noteRead(p);
      return real(p, a);
    };
  }

  // Mutators: single-path forms + the two-path forms (rename/copy record the
  // destination, the path that gains content).
  for (const m of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'unlinkSync', 'rmSync']) {
    const real = io.fs[m].bind(io.fs);
    io.fs[m] = (/** @type {any} */ p, /** @type {any} */ a) => {
      state.writes.push(String(p));
      return real(p, a);
    };
  }
  for (const m of ['renameSync', 'copyFileSync']) {
    const real = io.fs[m].bind(io.fs);
    io.fs[m] = (/** @type {any} */ from, /** @type {any} */ to) => {
      state.writes.push(String(to));
      return real(from, to);
    };
  }

  return state;
}

/** G2 silence: exit 0, no stdout (not even a --json envelope), no stderr. */
function assertSilent(io, code, label) {
  assert.equal(code, 0, `${label}: guard active exits 0`);
  assert.equal(io.stdoutText(), '', `${label}: guard active writes nothing to stdout (not even a --json envelope)`);
  assert.equal(io.stderrText(), '', `${label}: guard active writes nothing to stderr`);
}

/** G3 no-touch: zero .handoff/ reads, zero writes (spy + authoritative history). */
function assertNoTouch(io, spy, label) {
  assert.equal(spy.read, null, `${label}: guard active reads NOTHING under .handoff/ (content or metadata probe)`);
  assert.deepEqual(spy.writes, [], `${label}: guard active writes NOTHING (spy over every fake-fs mutator)`);
  assert.equal(io.fs.__history.length, 0, `${label}: the memfs mutation history is empty — the tree is byte-identical`);
}

// ===========================================================================
describe('supervised-child guard — cmdCheckpoint, tabled over all three platforms (G1–G5)', () => {
  for (const platform of PLATFORMS) {
    it(`[${platform}] guard active: a checkpoint that would normally write is a silent no-op with zero .handoff touch`, async () => {
      const io = makeIo({
        env: { BATON_SUPERVISED_CHILD: '1' },
        files: { [paths.snapshot]: snapText(checkpointBundle(platform)) },
        stdin: event({ type: 'decision', payload: { summary: 'would normally append + rewrite' } }),
        now: T0,
      });
      const spy = spyFs(io);
      const code = await cmdCheckpoint(CHECKPOINT_ARGS[platform], io);
      assertSilent(io, code, `checkpoint ${platform}`);
      assertNoTouch(io, spy, `checkpoint ${platform}`);
    });

    it(`[${platform}] guard active with --json: still silent (the guard beats the --json envelope contract)`, async () => {
      const io = makeIo({
        env: { BATON_SUPERVISED_CHILD: '1' },
        files: { [paths.snapshot]: snapText(checkpointBundle(platform)) },
        stdin: event({ type: 'decision', payload: { summary: 's' } }),
        now: T0,
      });
      const spy = spyFs(io);
      const code = await cmdCheckpoint([...CHECKPOINT_ARGS[platform], '--json'], io);
      assertSilent(io, code, `checkpoint ${platform} --json`);
      assertNoTouch(io, spy, `checkpoint ${platform} --json`);
    });
  }

  it('[cursor] guard active on the debounced afterFileEdit invocation: no lock, no stamp write', async () => {
    // The cursor debounce path normally acquires the repo lock (mkdir) and
    // writes a per-platform stamp under .handoff/log — the guard must skip it.
    const io = makeIo({
      env: { BATON_SUPERVISED_CHILD: '1' },
      files: { [paths.snapshot]: snapText(checkpointBundle('cursor')) },
      stdin: event({ type: 'note', payload: { text: 'edit' } }),
      now: T0,
    });
    const spy = spyFs(io);
    const code = await cmdCheckpoint(['--platform', 'cursor', '--debounce', '120', '--trigger', 'afterFileEdit'], io);
    assertSilent(io, code, 'checkpoint cursor debounce');
    assertNoTouch(io, spy, 'checkpoint cursor debounce');
  });

  it('guard runs BEFORE flag parsing: a stray positional still silent no-ops (not a usage error)', async () => {
    const io = makeIo({
      env: { BATON_SUPERVISED_CHILD: '1' },
      files: { [paths.snapshot]: snapText(checkpointBundle('claude-code')) },
      stdin: event({ type: 'decision', payload: { summary: 's' } }),
      now: T0,
    });
    const spy = spyFs(io);
    // Without the guard this stray token is a strict-parse usage error (exit 2).
    const code = await cmdCheckpoint(['STRAY', '--platform', 'claude-code'], io);
    assertSilent(io, code, 'checkpoint stray-token');
    assertNoTouch(io, spy, 'checkpoint stray-token');
  });

  it('guard runs BEFORE required-flag validation: missing --platform still silent no-ops', async () => {
    const io = makeIo({
      env: { BATON_SUPERVISED_CHILD: '1' },
      files: { [paths.snapshot]: snapText(checkpointBundle('claude-code')) },
      stdin: event({ type: 'decision', payload: { summary: 's' } }),
      now: T0,
    });
    const spy = spyFs(io);
    // Without the guard, a missing --platform is a usage error (exit 2).
    const code = await cmdCheckpoint([], io);
    assertSilent(io, code, 'checkpoint no-platform');
    assertNoTouch(io, spy, 'checkpoint no-platform');
  });

  it('any non-empty value activates the guard (not just "1")', async () => {
    const io = makeIo({
      env: { BATON_SUPERVISED_CHILD: 'yes' },
      files: { [paths.snapshot]: snapText(checkpointBundle('claude-code')) },
      stdin: event({ type: 'decision', payload: { summary: 's' } }),
      now: T0,
    });
    const spy = spyFs(io);
    const code = await cmdCheckpoint(['--platform', 'claude-code'], io);
    assertSilent(io, code, 'checkpoint env=yes');
    assertNoTouch(io, spy, 'checkpoint env=yes');
  });

  for (const platform of PLATFORMS) {
    it(`[${platform}] NEGATIVE: empty-string BATON_SUPERVISED_CHILD does NOT trigger the guard — a real checkpoint runs`, async () => {
      const io = makeIo({
        env: { BATON_SUPERVISED_CHILD: '' },
        files: { [paths.snapshot]: snapText(checkpointBundle(platform)) },
        stdin: event({ type: 'decision', payload: { summary: 'this must actually land' } }),
        now: T0,
      });
      const code = await cmdCheckpoint(CHECKPOINT_ARGS[platform], io);
      assert.equal(code, 0, `[${platform}] normal checkpoint exits 0`);
      assert.ok(io.fs.__history.length > 0, `[${platform}] empty-string env is NORMAL behavior: the checkpoint mutates the tree (journal/snapshot), proving the guard did not fire`);
    });
  }
});

// ===========================================================================
describe('supervised-child guard — cmdSessionStart, tabled over all three platforms (G1–G5)', () => {
  for (const platform of PLATFORMS) {
    it(`[${platform}] guard active: a pending foreign bundle is NOT read and NO resume context is emitted (silent no-op)`, async () => {
      const io = makeIo({
        env: { BATON_SUPERVISED_CHILD: '1' },
        files: { [paths.snapshot]: snapText(foreignSealedBundle(otherPlatform(platform))) },
        now: T0,
      });
      const spy = spyFs(io);
      const code = await cmdSessionStart(['--platform', platform], io);
      assertSilent(io, code, `session-start ${platform}`);
      assertNoTouch(io, spy, `session-start ${platform}`);
    });

    it(`[${platform}] guard active with --json: no envelope on stdout, zero .handoff touch`, async () => {
      const io = makeIo({
        env: { BATON_SUPERVISED_CHILD: '1' },
        files: { [paths.snapshot]: snapText(foreignSealedBundle(otherPlatform(platform))) },
        now: T0,
      });
      const spy = spyFs(io);
      const code = await cmdSessionStart(['--platform', platform, '--json'], io);
      assertSilent(io, code, `session-start ${platform} --json`);
      assertNoTouch(io, spy, `session-start ${platform} --json`);
    });
  }

  it('guard runs BEFORE flag parsing: a stray positional still silent no-ops (not a usage error)', async () => {
    const io = makeIo({
      env: { BATON_SUPERVISED_CHILD: '1' },
      files: { [paths.snapshot]: snapText(foreignSealedBundle('codex')) },
      now: T0,
    });
    const spy = spyFs(io);
    // Without the guard this stray token is a strict-parse usage error (exit 2).
    const code = await cmdSessionStart(['STRAY', '--platform', 'claude-code'], io);
    assertSilent(io, code, 'session-start stray-token');
    assertNoTouch(io, spy, 'session-start stray-token');
  });

  it('any non-empty value activates the guard (not just "1")', async () => {
    const io = makeIo({
      env: { BATON_SUPERVISED_CHILD: 'true' },
      files: { [paths.snapshot]: snapText(foreignSealedBundle('codex')) },
      now: T0,
    });
    const spy = spyFs(io);
    const code = await cmdSessionStart(['--platform', 'claude-code'], io);
    assertSilent(io, code, 'session-start env=true');
    assertNoTouch(io, spy, 'session-start env=true');
  });

  for (const platform of PLATFORMS) {
    it(`[${platform}] NEGATIVE: empty-string BATON_SUPERVISED_CHILD does NOT trigger the guard — the pending notice still fires`, async () => {
      const io = makeIo({
        env: { BATON_SUPERVISED_CHILD: '' },
        files: { [paths.snapshot]: snapText(foreignSealedBundle(otherPlatform(platform))) },
        now: T0,
      });
      const code = await cmdSessionStart(['--platform', platform], io);
      assert.equal(code, 0, `[${platform}] normal session-start exits 0`);
      assert.match(io.stdoutText(), /pending/i, `[${platform}] empty-string env is NORMAL behavior: the foreign pending-handoff notice is still emitted, proving the guard did not fire`);
    });
  }
});
