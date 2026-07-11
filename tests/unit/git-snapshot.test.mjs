import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeIo } from '../helpers/fakeio.mjs';
import { snapshot } from '../../core/src/git/snapshot.mjs';

// ---------------------------------------------------------------------------
// Contract choices for core/src/git/snapshot.mjs (docs/design/core.md §Module
// APIs; §Per-module test lists "git" (clean/dirty/detached/not-a-repo/timeout);
// plan §Concurrency "content-sensitive prepare-time git digest — HEAD + branch +
// hashes of the staged and unstaged diffs + a bounded untracked-files digest
// (path + size + CONTENT hash, capped) … so a file that stays M but changes
// content still invalidates the token"). snapshot is ASYNC.
//
// SIGNATURE (verifier fold F2 — extends core.md's {execFile, cwd}):
//   snapshot({execFile, cwd, fs}) — `fs` is used ONLY to read untracked file
//   BYTES for the bounded untracked digest (the plan requires path + size +
//   content hash, which a git listing alone cannot provide; the verifier blessed
//   reading untracked files via io.fs). Untracked paths from the git listing are
//   relative and resolve against `cwd`. Every other fact comes from git
//   subprocesses via the injected execFile (fakeio's rejects-on-nonzero
//   contract; the execResults map is keyed by the joined "cmd arg arg …" string).
//
// PINNED git command vocabulary (execResults keys). The keying is exact, so the
// implementation MUST invoke precisely these, as `execFile('git', args, {cwd,…})`:
//   'git rev-parse --abbrev-ref HEAD'          -> branch ('HEAD' when detached)
//   'git rev-parse HEAD'                        -> headSha
//   'git status --porcelain'                    -> dirtySummary lines / dirty flag
//   'git diff --cached'                         -> staged diff (digest input)
//   'git diff'                                  -> unstaged diff (digest input)
//   'git ls-files --others --exclude-standard'  -> untracked listing (digest input)
//
// RETURN SHAPE (clean): {branch, headSha, dirty:false, dirtySummary:[],
//   contentDigest:<string>}. Trailing newlines are trimmed off branch/headSha.
//   Extra fields are tolerated (compact.mjs may add summaryTruncated later) — this
//   file asserts the documented five, never their absence.
//
// PINS:
//   1. CLEAN repo: dirty:false, dirtySummary:[], branch/headSha trimmed, digest a
//      non-empty string.
//   2. DIRTY repo: dirty:true; dirtySummary === the VERBATIM lines of
//      `git status --porcelain` (split on '\n', trailing empty dropped).
//   3. contentDigest is CONTENT-SENSITIVE and DETERMINISTIC — a hash over the
//      staged diff + unstaged diff + the bounded untracked digest (path + size +
//      content hash per untracked file), NOT over HEAD/branch:
//        - identical git outputs AND untracked bytes => identical contentDigest;
//        - a change in `git diff` output alone => different contentDigest;
//        - a change in `git diff --cached` output alone => different contentDigest;
//        - a change in the untracked PATH LIST alone => different contentDigest;
//        - (F2) a change in an untracked file's CONTENT with an identical path
//          list and identical byte length => different contentDigest;
//        - (F2) a change in an untracked file's SIZE with an identical path list
//          => different contentDigest;
//        - a change in HEAD sha ALONE => SAME contentDigest (HEAD is bound
//          separately by the receipt token, not folded into the content digest).
//      contentDigest is a sha256 hex string (64 lowercase hex chars).
//   4. DETACHED HEAD: `git rev-parse --abbrev-ref HEAD` returns 'HEAD' -> branch
//      === 'HEAD'.
//   5. NOT-A-REPO (git exits nonzero / execFile rejects) -> returns null, no throw.
//   6. TIMEOUT (execFile rejects with code 'ETIMEDOUT') -> returns null, no throw.
// ---------------------------------------------------------------------------

const CWD = '/repo';
const HEX64 = /^[0-9a-f]{64}$/;

// Default clean-repo git command outputs; override any single key to model drift.
function gitResults(overrides = {}) {
  return {
    'git rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
    'git rev-parse HEAD': { stdout: 'a1b2c3d4e5f6a7b8c9d0\n' },
    'git status --porcelain': { stdout: '' },
    'git diff --cached': { stdout: '' },
    'git diff': { stdout: '' },
    'git ls-files --others --exclude-standard': { stdout: '' },
    ...overrides,
  };
}

// Build an io and run snapshot with the full pinned input {execFile, cwd, fs}.
// `files` seeds untracked file bytes into the memfs at absolute /repo/... paths.
async function snap(overrides = {}, files = {}) {
  const io = makeIo({ execResults: gitResults(overrides), files });
  return snapshot({ execFile: io.execFile, cwd: CWD, fs: io.fs });
}

// ===========================================================================
describe('git.snapshot — clean repository', () => {
  it('reports branch/headSha (trimmed), dirty:false, empty dirtySummary, and a string contentDigest', async () => {
    const s = await snap();
    assert.equal(s.branch, 'main', 'branch trimmed of trailing newline');
    assert.equal(s.headSha, 'a1b2c3d4e5f6a7b8c9d0', 'headSha trimmed of trailing newline');
    assert.equal(s.dirty, false);
    assert.deepEqual(s.dirtySummary, []);
    assert.ok(typeof s.contentDigest === 'string' && s.contentDigest.length > 0, 'contentDigest is a non-empty string');
    assert.match(s.contentDigest, HEX64, 'contentDigest is a sha256 hex string');
  });
});

// ===========================================================================
describe('git.snapshot — dirty repository', () => {
  it('reports dirty:true and dirtySummary as the verbatim porcelain lines', async () => {
    const s = await snap(
      {
        'git status --porcelain': { stdout: ' M core/src/x.mjs\n?? new.txt\n' },
        'git diff': { stdout: 'diff --git a/core/src/x.mjs b/core/src/x.mjs\n@@\n+added\n' },
        'git ls-files --others --exclude-standard': { stdout: 'new.txt\n' },
      },
      { '/repo/new.txt': 'brand new file\n' },
    );
    assert.equal(s.dirty, true);
    assert.deepEqual(s.dirtySummary, [' M core/src/x.mjs', '?? new.txt'], 'porcelain lines are preserved verbatim, trailing empty dropped');
    assert.match(s.contentDigest, HEX64);
  });
});

// ===========================================================================
describe('git.snapshot — content-sensitive digest', () => {
  it('is identical for two runs with identical git outputs and untracked bytes (deterministic)', async () => {
    const overrides = { 'git ls-files --others --exclude-standard': { stdout: 'u.txt\n' } };
    const files = { '/repo/u.txt': 'same bytes' };
    const a = await snap(overrides, files);
    const b = await snap(overrides, files);
    assert.equal(a.contentDigest, b.contentDigest, 'identical inputs => identical digest');
  });

  it('changes when the UNSTAGED diff output changes (M-but-recontented file invalidates)', async () => {
    const base = await snap({ 'git diff': { stdout: 'VERSION-A\n' } });
    const changed = await snap({ 'git diff': { stdout: 'VERSION-B\n' } });
    assert.notEqual(base.contentDigest, changed.contentDigest, 'a different unstaged diff must change the digest');
  });

  it('changes when the STAGED diff output changes', async () => {
    const base = await snap({ 'git diff --cached': { stdout: 'STAGED-A\n' } });
    const changed = await snap({ 'git diff --cached': { stdout: 'STAGED-B\n' } });
    assert.notEqual(base.contentDigest, changed.contentDigest, 'a different staged diff must change the digest');
  });

  it('changes when the untracked PATH LIST changes', async () => {
    const base = await snap(
      { 'git ls-files --others --exclude-standard': { stdout: 'a.txt\n' } },
      { '/repo/a.txt': 'alpha' },
    );
    const changed = await snap(
      { 'git ls-files --others --exclude-standard': { stdout: 'a.txt\nb.txt\n' } },
      { '/repo/a.txt': 'alpha', '/repo/b.txt': 'beta' },
    );
    assert.notEqual(base.contentDigest, changed.contentDigest, 'a different untracked listing must change the digest');
  });

  it('(F2) changes when an untracked file\'s CONTENT changes — same path list, same byte length', async () => {
    // The path list AND the size are identical; only the bytes differ. Only a true
    // content hash (not path/size bookkeeping) can tell these apart.
    const overrides = { 'git ls-files --others --exclude-standard': { stdout: 'u.txt\n' } };
    const base = await snap(overrides, { '/repo/u.txt': 'AAAA' });
    const changed = await snap(overrides, { '/repo/u.txt': 'BBBB' });
    assert.notEqual(base.contentDigest, changed.contentDigest, 'recontented untracked bytes must change the digest even at identical size');
  });

  it('(F2) changes when an untracked file\'s SIZE changes — same path list', async () => {
    const overrides = { 'git ls-files --others --exclude-standard': { stdout: 'u.txt\n' } };
    const base = await snap(overrides, { '/repo/u.txt': 'AA' });
    const changed = await snap(overrides, { '/repo/u.txt': 'AAAA' });
    assert.notEqual(base.contentDigest, changed.contentDigest, 'a grown untracked file must change the digest');
  });

  it('does NOT change when only the HEAD sha changes (HEAD is bound separately, not folded into contentDigest)', async () => {
    const base = await snap({ 'git rev-parse HEAD': { stdout: 'aaaa1111\n' } });
    const moved = await snap({ 'git rev-parse HEAD': { stdout: 'bbbb2222\n' } });
    assert.notEqual(base.headSha, moved.headSha, 'the headSha field itself must differ');
    assert.equal(base.contentDigest, moved.contentDigest, 'contentDigest is content-only: a HEAD move alone leaves it unchanged');
  });
});

// ===========================================================================
describe('git.snapshot — detached HEAD', () => {
  it('branch === "HEAD" when rev-parse --abbrev-ref reports a detached HEAD', async () => {
    const s = await snap({ 'git rev-parse --abbrev-ref HEAD': { stdout: 'HEAD\n' } });
    assert.equal(s.branch, 'HEAD', 'a detached HEAD surfaces as branch "HEAD"');
  });
});

// ===========================================================================
describe('git.snapshot — degraded paths return null (never throw)', () => {
  it('not-a-repo (git exits nonzero on every command) -> null', async () => {
    const notRepo = Object.fromEntries(
      Object.keys(gitResults()).map((k) => [k, { code: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git' }]),
    );
    const io = makeIo({ execResults: notRepo });
    let result;
    await assert.doesNotReject(async () => {
      result = await snapshot({ execFile: io.execFile, cwd: CWD, fs: io.fs });
    }, 'a not-a-repo git failure must never reject/throw');
    assert.equal(result, null, 'not-a-repo -> null');
  });

  it('timeout (execFile rejects with code ETIMEDOUT) -> null', async () => {
    const timedOut = Object.fromEntries(Object.keys(gitResults()).map((k) => [k, { code: 'ETIMEDOUT' }]));
    const io = makeIo({ execResults: timedOut });
    let result;
    await assert.doesNotReject(async () => {
      result = await snapshot({ execFile: io.execFile, cwd: CWD, fs: io.fs });
    }, 'a git timeout must never reject/throw');
    assert.equal(result, null, 'ETIMEDOUT -> null');
  });

  it('a missing git binary (execFile rejects ENOENT) -> null', async () => {
    // No execResults at all: fakeio rejects every spawn with ENOENT.
    const io = makeIo({ execResults: {} });
    const result = await snapshot({ execFile: io.execFile, cwd: CWD, fs: io.fs });
    assert.equal(result, null, 'an un-spawnable git -> null, no throw');
  });
});
