import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { makeIo } from '../helpers/fakeio.mjs';
import { cmdFinalize } from '../../core/src/commands/finalize.mjs';
import { bundlePaths } from '../../core/src/bundle/store.mjs';
import { readAllTolerant } from '../../core/src/util/jsonl.mjs';

// ---------------------------------------------------------------------------
// Command-level contract for core/src/commands/finalize.mjs. Direct import over
// fakeio: cmdFinalize(args, io) -> exit code (this file `await`s it; finalize
// refreshes git via the async injected execFile, so it is async).
//
// Source of truth: docs/design/core.md §CLI contract (exit codes: 2 usage error);
// plan §Checkpoint engine ("finalize --reason \"…\" [--reason-class] [--to] records
// the switch reason (class inferred from text via the classifier when omitted),
// refreshes git state, freezes history"); §"Journal rotation & crash recovery"
// (finalize rotates the journal, kind 'finalize'); §Bundle handoff block
// (status/reason/reasonClass/toPlatformHint/finalizedAt).
//
// PINS:
//   1. --reason is REQUIRED: absent -> exit 2 (usage error), a message naming it.
//   2. On success (exit 0), the sealed snapshot carries handoff = { status:
//      'sealed', reason: <--reason>, reasonClass: <inferred|--reason-class>,
//      toPlatformHint: <--to | null>, finalizedAt: io.now() }.
//   3. reasonClass INFERENCE: when --reason-class is absent, finalize classifies
//      the reason text through the built-in signature table against the bundle's
//      ORIGIN platform; a usage-limit reason string infers 'usage-limit'. An
//      explicit --reason-class overrides inference (no classification).
//   4. GIT REFRESH: finalize recomputes git via git/snapshot.mjs over the injected
//      execFile; the sealed bundle's `git` reflects the execResults fixtures.
//   5. JOURNAL ROTATION (verifier fold F9 — the full store.rotateJournal contract
//      exercised THROUGH finalize, not just freeze existence): the sealed
//      snapshot is written BEFORE the rotation, so the history/<stem>.finalize.json
//      freeze IS the sealed state; the pre-seal journal is renamed to
//      history/<stem>.finalize.ndjson alongside it (same stem, no entries lost);
//      no rotation.marker.json remains; a fresh EMPTY live journal exists; and
//      per-kind retention prunes finalize rotations to the newest 10.
//   6. --json envelope carries data.bundlePath and data.handoffMdPath (absolute
//      paths under <root>/.handoff/).
//
// loadSignatures reads via io.fs, so tests that exercise inference seed the real
// signature table at its module-resolved path.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const SIG_PATH = join(repoRoot, 'core', 'data', 'signatures.v1.json');
const SIG_CONTENT = readFileSync(SIG_PATH, 'utf8');

const NOW = '2026-07-11T12:00:00.000Z';
const paths = bundlePaths('/repo');

// A clean-repo git command fixture set (see git-snapshot.test.mjs for the keys).
const GIT_CLEAN = {
  'git rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
  'git rev-parse HEAD': { stdout: 'a1b2c3d4e5f6a7b8c9d0\n' },
  'git status --porcelain': { stdout: '' },
  'git diff --cached': { stdout: '' },
  'git diff': { stdout: '' },
  'git ls-files --others --exclude-standard': { stdout: '' },
};

function mkBundle(overrides = {}) {
  return {
    schema: 'baton/bundle@1',
    bundleId: 'b_final000000000',
    generation: 1,
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
    origin: { platform: 'claude-code', model: 'claude-fable-5', sessionHint: 'sess-1', unstable: false },
    task: { goal: 'Ship failover v1', constraints: [], acceptance: [] },
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

const snapText = (b) => JSON.stringify(b, null, 2) + '\n';

function seedIo({ bundle = mkBundle(), execResults = GIT_CLEAN, now = NOW } = {}) {
  return makeIo({
    files: { [SIG_PATH]: SIG_CONTENT, [paths.snapshot]: snapText(bundle) },
    execResults,
    now,
  });
}

const readSnapshot = (io) => JSON.parse(io.files()[paths.snapshot]);

// ===========================================================================
describe('finalize — usage validation', () => {
  it('missing --reason -> exit 2 with a message naming the flag', async () => {
    const io = seedIo();
    const code = await cmdFinalize([], io);
    assert.equal(code, 2, 'a missing required flag is a usage error (exit 2)');
    assert.match(io.stderrText(), /reason/i, 'the usage error names --reason');
  });
});

// ===========================================================================
describe('finalize — seals the bundle', () => {
  it('sets the sealed handoff block, infers reasonClass, records toPlatformHint + finalizedAt; exit 0', async () => {
    const io = seedIo();
    const reason = "You've hit your session limit · resets 3pm";

    const code = await cmdFinalize(['--reason', reason, '--to', 'codex'], io);
    assert.equal(code, 0);

    const snap = readSnapshot(io);
    assert.equal(snap.handoff.status, 'sealed');
    assert.equal(snap.handoff.reason, reason);
    assert.equal(snap.handoff.reasonClass, 'usage-limit', 'a usage-limit reason infers reasonClass usage-limit (via the classifier, origin platform)');
    assert.equal(snap.handoff.toPlatformHint, 'codex', 'toPlatformHint comes from --to');
    assert.equal(snap.handoff.finalizedAt, NOW, 'finalizedAt is stamped with io.now()');
  });

  it('an explicit --reason-class overrides inference', async () => {
    const io = seedIo();
    const code = await cmdFinalize(['--reason', 'switching for a fresh context', '--reason-class', 'throttle', '--to', 'codex'], io);
    assert.equal(code, 0);
    assert.equal(readSnapshot(io).handoff.reasonClass, 'throttle', '--reason-class is used verbatim, no classification');
  });

  it('refreshes git state from execFile fixtures into the sealed bundle', async () => {
    const io = seedIo();
    await cmdFinalize(['--reason', "You've hit your session limit", '--to', 'codex'], io);
    const snap = readSnapshot(io);
    assert.ok(snap.git, 'finalize populates the git section');
    assert.equal(snap.git.branch, 'main');
    assert.equal(snap.git.headSha, 'a1b2c3d4e5f6a7b8c9d0');
    assert.equal(snap.git.dirty, false);
  });

  it('(F9) rotates the journal kind "finalize": sealed freeze + journal pair, marker cleared, live journal emptied', async () => {
    const io = seedIo();
    // A pending journal entry that must ride into the rotated history journal.
    io.fs.writeFileSync(
      paths.journal,
      JSON.stringify({ seq: 1, ts: '2026-07-11T00:30:00.000Z', type: 'note', dedupeKey: 'pre', source: 'stop', payload: { text: 'pre-seal note' } }) + '\n',
    );

    const code = await cmdFinalize(['--reason', "You've hit your session limit", '--to', 'codex'], io);
    assert.equal(code, 0);

    const names = io.fs.readdirSync(paths.historyDir);
    const freezeName = names.find((n) => /\.finalize\.json$/.test(n));
    assert.ok(freezeName, 'a finalize freeze exists in history/');
    const stem = freezeName.slice(0, -'.json'.length);
    assert.ok(names.includes(`${stem}.ndjson`), 'the rotated journal lands alongside the freeze (same stem)');

    const freeze = JSON.parse(io.files()[`${paths.historyDir}/${freezeName}`]);
    assert.equal(freeze.handoff.status, 'sealed', 'the frozen snapshot is the SEALED state — the seal is written before the rotation');

    const rotated = readAllTolerant(io.fs, `${paths.historyDir}/${stem}.ndjson`);
    assert.ok(rotated.entries.some((e) => e.payload?.text === 'pre-seal note'), 'the pre-seal journal entries ride into history — nothing is lost');

    assert.equal(io.fs.existsSync(`${paths.dir}/rotation.marker.json`), false, 'the rotation marker is cleared on success');
    assert.ok(io.fs.existsSync(paths.journal), 'a fresh live journal exists');
    assert.equal(readAllTolerant(io.fs, paths.journal).entries.length, 0, 'the fresh live journal is empty');

    // (iter-2) Crash-safe ORDER, not just the final state: marker → freeze +
    // rotated journal → fresh live journal → marker cleared, proven from the
    // memfs mutation history (each entry is a full post-mutation snapshot).
    const markerPath = `${paths.dir}/rotation.marker.json`;
    const states = io.fs.__history.map((h) => h.files);
    const firstIndex = (pred) => states.findIndex(pred);
    const iMarker = firstIndex((f) => markerPath in f);
    const iFreeze = firstIndex((f) => Object.keys(f).some((k) => k.startsWith(`${paths.historyDir}/`) && k.endsWith('.finalize.json')));
    const iRotated = firstIndex((f) => Object.keys(f).some((k) => k.startsWith(`${paths.historyDir}/`) && k.endsWith('.finalize.ndjson')));
    assert.ok(iMarker !== -1, 'the rotation marker was written at some point (marker-backed rotation, not a lucky final state)');
    assert.ok(iFreeze !== -1 && iMarker < iFreeze, 'the marker becomes visible BEFORE the history freeze lands');
    assert.ok(iRotated !== -1 && iMarker < iRotated, 'the marker becomes visible BEFORE the journal is rotated into history');
    const iFresh = states.findIndex((f, idx) => idx > iRotated && paths.journal in f);
    assert.ok(iFresh !== -1, 'a fresh live journal is created after the rotation');
    const iCleared = states.findIndex((f, idx) => idx > iMarker && !(markerPath in f));
    assert.ok(iCleared !== -1, 'the marker is eventually removed');
    assert.ok(
      iCleared > iFreeze && iCleared > iRotated && iCleared > iFresh,
      'the marker is removed LAST — after freeze, rotated journal, and fresh live journal all exist',
    );
  });

  it('(F9) retains only the newest 10 finalize rotations (per-kind pruning through the command)', async () => {
    const io = seedIo();
    for (let i = 0; i < 11; i += 1) {
      io.setNow(`2026-07-11T13:${String(i).padStart(2, '0')}:00.000Z`); // distinct stems per rotation
      // Re-seed an open bundle so each iteration has something to seal.
      io.fs.writeFileSync(paths.snapshot, snapText(mkBundle()));
      const code = await cmdFinalize(['--reason', "You've hit your session limit", '--to', 'codex'], io);
      assert.equal(code, 0);
    }
    const names = io.fs.readdirSync(paths.historyDir);
    assert.equal(names.filter((n) => /\.finalize\.json$/.test(n)).length, 10, 'exactly 10 finalize freezes retained after 11 finalizes');
    assert.equal(names.filter((n) => /\.finalize\.ndjson$/.test(n)).length, 10, 'exactly 10 finalize journals retained');
  });
});

// ===========================================================================
describe('finalize — --json envelope', () => {
  it('emits one envelope whose data carries bundlePath + handoffMdPath', async () => {
    const io = seedIo();
    const code = await cmdFinalize(['--reason', "You've hit your session limit", '--to', 'codex', '--json'], io);
    assert.equal(code, 0);

    const parsed = JSON.parse(io.stdoutText());
    assert.equal(io.stdoutText(), JSON.stringify(parsed) + '\n', 'stdout is exactly one compact envelope + newline');
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.bundlePath, paths.snapshot, 'data.bundlePath is the .handoff/bundle.json path');
    assert.equal(parsed.data.handoffMdPath, paths.handoffMd, 'data.handoffMdPath is the .handoff/HANDOFF.md path');
  });
});
