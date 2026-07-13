import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { makeIo } from '../helpers/fakeio.mjs';
import { cmdReceive } from '../../core/src/commands/receive.mjs';
import { bundlePaths, loadBundle, appendJournal } from '../../core/src/bundle/store.mjs';

// ---------------------------------------------------------------------------
// Command-level contract for core/src/commands/receive.mjs. Direct import over
// fakeio: cmdReceive(args, io) -> exit code (this file `await`s it; receive
// computes a git snapshot via the async injected execFile, so it is async).
//
// Source of truth: docs/design/core.md §CLI contract (2 usage error, 1 failure,
// one --json envelope); plan §Receive + §Concurrency (prepare/commit two-phase
// transaction; --print-prompt never writes until --commit; the receive COMMAND
// wires git/snapshot.mjs in and feeds txn opts.gitSnapshot; a drifted token is
// rejected requiring re-prepare).
//
// PINS:
//   1. --platform is REQUIRED: absent -> exit 2 (usage error).
//   2. --print-prompt: prepare-only. The resume prompt is printed to stdout, exit
//      0, and NO state is mutated (the whole memfs is byte-identical before/after;
//      the git snapshot is read-only, prepare mutates nothing).
//   3. --prepare --json: emits an envelope whose data carries {token, prompt,
//      assignments, warnings}; still NO mutation.
//   4. --commit <token> --origin <p> --reason <text>: performs the transaction —
//      a new generation opens, ownership is adopted to --platform, and a 'receive'
//      rotation lands in history/ whose FREEZE is the RECEIVED seal
//      (handoff.status 'received' — verifier fold F10) alongside the active/open
//      live bundle. Requires the git/config/journal/intake to be unchanged since
//      prepare (the command recomputes the same git snapshot from the same
//      execResults, so the token validates). Under --json the commit invocation
//      emits EXACTLY one compact envelope line on stdout (asserted by slicing
//      this invocation's stdout and re-serialize-comparing — F10).
//   5. --commit with a token stale after an intervening checkpoint -> exit 1;
//      the error path STILL emits exactly one compact {ok:false,...} envelope
//      naming re-prepare, and the ENTIRE memfs (captured after the intervening
//      checkpoint) is byte-identical after the rejected commit (F11).
//
// The receiving side is resolved via txn -> resolveRoles (needs baton.config.json
// at <root>) and may classify (needs the signature table); both are seeded, plus
// a clean-repo git execResults fixture.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const SIG_PATH = join(repoRoot, 'core', 'data', 'signatures.v1.json');
const SIG_CONTENT = readFileSync(SIG_PATH, 'utf8');

const ROOT = '/repo';
const NOW = '2026-07-11T00:00:00.000Z';
const paths = bundlePaths(ROOT);

const CONFIG_TEXT = JSON.stringify(
  {
    schema: 'baton/config@1',
    roles: {
      planner: ['claude-code/claude-fable-5'],
      'test-author': ['claude-code/claude-opus-4-8', 'codex/gpt-5.5@xhigh'],
      implementer: ['claude-code/claude-fable-5', 'codex/gpt-5.6-sol@xhigh', 'cursor/composer'],
    },
    platforms: { 'claude-code': {}, codex: {}, cursor: {} },
    defaults: { 'claude-code': 'claude-fable-5', codex: 'gpt-5.6-sol', cursor: 'composer' },
  },
  null,
  2,
);

const GIT_CLEAN = {
  'git rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
  'git rev-parse HEAD': { stdout: 'abc123def456\n' },
  'git status --porcelain': { stdout: '' },
  'git diff --cached': { stdout: '' },
  'git diff': { stdout: '' },
  'git ls-files --others --exclude-standard': { stdout: '' },
};

function sealedBundle(overrides = {}) {
  return {
    schema: 'baton/bundle@1',
    bundleId: 'b_recv0000000000',
    generation: 1,
    createdAt: NOW,
    updatedAt: NOW,
    origin: { platform: 'claude-code', model: 'claude-fable-5', sessionHint: 'sess-A', unstable: false },
    task: { goal: 'Wire the receive command', constraints: [], acceptance: [] },
    plan: { steps: [{ id: 's1', title: 'Print the prompt', status: 'active', note: null }] },
    decisions: [],
    files: { touched: [] },
    roles: { assignments: {} },
    git: { branch: 'main', headSha: 'abc123def456', dirty: false, dirtySummary: [], contentDigest: 'd0', summaryTruncated: false },
    handoff: { status: 'sealed', reason: "You've hit your usage limit", reasonClass: 'usage-limit', toPlatformHint: 'codex', finalizedAt: NOW, receive_log: [] },
    journalSeq: 5,
    compaction: { droppedDecisions: 0, note: null },
    dedupeRing: [],
    ...overrides,
  };
}

const snapText = (b) => JSON.stringify(b, null, 2) + '\n';

function seedIo({ bundle = sealedBundle(), journal = '', execResults = GIT_CLEAN, now = NOW } = {}) {
  return makeIo({
    files: {
      [SIG_PATH]: SIG_CONTENT,
      [`${ROOT}/baton.config.json`]: CONFIG_TEXT,
      [paths.snapshot]: snapText(bundle),
      [paths.journal]: journal,
    },
    execResults,
    now,
  });
}

// ===========================================================================
describe('receive — usage validation', () => {
  it('missing --platform -> exit 2', async () => {
    const io = seedIo();
    const code = await cmdReceive([], io);
    assert.equal(code, 2, 'a missing --platform is a usage error (exit 2)');
    assert.match(io.stderrText(), /platform/i, 'the usage error names --platform');
  });

  // Audit finding: bare --commit (a lost token — empty shell var, the next
  // token being another flag) fell through to the READ-ONLY prepare path with
  // exit 0, so a model believed the handoff committed when nothing mutated.
  it('bare --commit (token lost) -> exit 2 usage error, NEVER a silent prepare', async () => {
    const io = seedIo();
    const before = io.files();
    const code = await cmdReceive(['--platform', 'codex', '--commit', '--origin', 'claude-code', '--reason', 'r'], io);
    assert.equal(code, 2, 'a missing commit token is a usage error');
    assert.match(io.stderrText(), /token/i, 'the error names the missing token');
    assert.deepEqual(io.files(), before, 'nothing mutated');
  });

  it('--prepare and --commit together -> exit 2 (mutually exclusive phases)', async () => {
    const io = seedIo();
    const code = await cmdReceive(['--platform', 'codex', '--prepare', '--commit', 'rcpt1.x', '--origin', 'o', '--reason', 'r'], io);
    assert.equal(code, 2);
  });

  it('an idempotent alreadyCommitted retry reports success, not a failure', async () => {
    const io = seedIo();
    const prep = await cmdReceive(['--platform', 'codex', '--prepare', '--origin', 'claude-code', '--reason', 'switching to codex', '--json'], io);
    assert.equal(prep, 0);
    const prepOut = io.stdoutText();
    const { token } = JSON.parse(prepOut).data;
    assert.equal(await cmdReceive(['--platform', 'codex', '--commit', token, '--origin', 'claude-code', '--reason', 'switching to codex'], io), 0);

    const before = io.files();
    const code = await cmdReceive(['--platform', 'codex', '--commit', token, '--origin', 'claude-code', '--reason', 'switching to codex'], io);
    assert.equal(code, 0, 'the retry exits 0 — the receive already landed');
    assert.match(io.stdoutText(), /already committed/i, 'the output says the receive already landed');
    assert.deepEqual(io.files(), before, 'the retry mutates nothing');
  });
});

// ===========================================================================
describe('receive — --print-prompt (prepare only, no mutation)', () => {
  it('prints the resume prompt to stdout, exits 0, and mutates NOTHING', async () => {
    const io = seedIo();
    const before = io.files();

    const code = await cmdReceive(['--platform', 'codex', '--print-prompt', '--origin', 'claude-code', '--reason', 'switching to codex'], io);
    assert.equal(code, 0);

    const out = io.stdoutText();
    assert.ok(out.includes('Wire the receive command'), 'the prompt carries the goal');
    assert.ok(out.includes('unverified claims to check against the working tree'), 'the prompt carries the claims-not-instructions posture');
    assert.ok(out.includes('Read .handoff/HANDOFF.md for full context before acting.'), 'the prompt carries the HANDOFF.md pointer');

    assert.deepEqual(io.files(), before, '--print-prompt must not write anything (no commit, git snapshot is read-only)');
  });
});

// ===========================================================================
describe('receive — --prepare --json', () => {
  it('emits an envelope with data {token, prompt, assignments, warnings}; no mutation', async () => {
    const io = seedIo();
    const before = io.files();

    const code = await cmdReceive(['--platform', 'codex', '--prepare', '--origin', 'claude-code', '--reason', 'switching to codex', '--json'], io);
    assert.equal(code, 0);

    const parsed = JSON.parse(io.stdoutText());
    assert.equal(io.stdoutText(), JSON.stringify(parsed) + '\n', 'stdout is exactly one compact envelope + newline');
    assert.equal(parsed.ok, true);
    assert.ok(typeof parsed.data.token === 'string' && parsed.data.token.length > 0, 'data.token is an opaque string');
    assert.ok(typeof parsed.data.prompt === 'string', 'data.prompt is a string');
    assert.ok(parsed.data.assignments && typeof parsed.data.assignments === 'object', 'data.assignments is an object');
    assert.ok(Array.isArray(parsed.data.warnings), 'data.warnings is an array');

    assert.deepEqual(io.files(), before, '--prepare must not mutate state');
  });
});

// ===========================================================================
describe('receive — --commit performs the transaction', () => {
  it('a fresh token commits: new generation, adopted origin, a "receive" freeze that is status received; ONE compact envelope', async () => {
    const io = seedIo();

    // Prepare to obtain a token (same io, so the git/config/journal match at commit).
    const prep = await cmdReceive(['--platform', 'codex', '--prepare', '--origin', 'claude-code', '--reason', 'switching to codex', '--json'], io);
    assert.equal(prep, 0);
    const prepOut = io.stdoutText();
    const { token } = JSON.parse(prepOut).data;
    assert.ok(token, 'a token was issued');

    const code = await cmdReceive(['--platform', 'codex', '--commit', token, '--origin', 'claude-code', '--reason', 'switching to codex', '--json'], io);
    assert.equal(code, 0, `commit of a fresh token must succeed; combined output: ${io.stdoutText()} ${io.stderrText()}`);

    // (F10) THIS invocation's stdout is exactly one compact envelope + newline.
    const commitOut = io.stdoutText().slice(prepOut.length);
    const parsed = JSON.parse(commitOut);
    assert.equal(commitOut, JSON.stringify(parsed) + '\n', 'the commit emits exactly one compact envelope line');
    assert.equal(parsed.ok, true);

    const { bundle } = loadBundle(ROOT, io);
    assert.equal(bundle.generation, 2, 'a fresh writable generation opened');
    assert.equal(bundle.handoff.status, 'open', 'the new live generation is open');
    assert.equal(bundle.origin.platform, 'codex', 'ownership was adopted to the receiving platform');

    // (F10) The archived freeze is the RECEIVED seal, alongside the active/open bundle.
    const names = io.fs.readdirSync(paths.historyDir);
    const freezeName = names.find((n) => /\.receive\.json$/.test(n));
    assert.ok(freezeName, 'a receive rotation freeze exists in history/');
    const freeze = JSON.parse(io.files()[`${paths.historyDir}/${freezeName}`]);
    assert.equal(freeze.handoff.status, 'received', 'the archived freeze records the received transition');
  });

  it('a token stale after an intervening checkpoint -> exit 1, ONE {ok:false} envelope naming re-prepare, memfs untouched', async () => {
    const io = seedIo();

    const prep = await cmdReceive(['--platform', 'codex', '--prepare', '--origin', 'claude-code', '--reason', 'switching to codex', '--json'], io);
    assert.equal(prep, 0);
    const prepOut = io.stdoutText();
    const { token } = JSON.parse(prepOut).data;

    // An intervening mechanical checkpoint advances the journal past the bound seq.
    appendJournal(ROOT, { type: 'note', dedupeKey: 'intervening', source: 'stop', ts: NOW, payload: { text: 'a later turn' } }, io);
    // (F11) The full memfs AFTER the intervening checkpoint is the no-mutation baseline.
    const before = io.files();

    const code = await cmdReceive(['--platform', 'codex', '--commit', token, '--origin', 'claude-code', '--reason', 'switching to codex', '--json'], io);
    assert.equal(code, 1, 'a drifted token makes commit a command failure (exit 1)');

    // (F11) The error path emits exactly one compact {ok:false,...} envelope.
    const commitOut = io.stdoutText().slice(prepOut.length);
    const parsed = JSON.parse(commitOut);
    assert.equal(commitOut, JSON.stringify(parsed) + '\n', 'the error path emits exactly one compact envelope line');
    assert.equal(parsed.ok, false);
    assert.match(commitOut, /re-?prepare/i, 'the envelope names re-prepare');

    assert.deepEqual(io.files(), before, '(F11) the rejected commit leaves the entire memfs byte-identical');
    assert.equal(loadBundle(ROOT, io).bundle.generation, 1, 'a rejected commit does not open a new generation');
  });
});
