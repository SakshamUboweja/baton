import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// RED — loop child supervision, REAL-PROCESS parts (subtask loop-children,
// part B). Mirrors tests/adapters/claude-code-hook-spawn.test.mjs idioms
// (mkdtempSync scratch dirs, real node child scripts). Source of truth:
// docs/plans §"Child supervision contract": detached own-process-group spawn,
// timeout -> SIGTERM group -> grace -> SIGKILL group (no zombie grandchildren),
// output streamed to a capped log, stdin closed.
//
// PINNED: superviseChild(spec, opts) -> Promise<result>
//   spec  = {command, args, env?, cwd?}
//   opts  = {timeoutMs, graceMs, logPath, maxLogBytes?, platform?}
//   result= {timedOut, exitCode, verdict?, findings?, logPath}
//
// RED MECHANISM: dynamic-import-with-catch + M() guard.
// ---------------------------------------------------------------------------

let mod = /** @type {any} */ (null);
let importError = /** @type {any} */ (null);
try {
  mod = await import('../../core/src/loop/children.mjs');
} catch (e) {
  importError = e;
}
function M() {
  assert.ok(mod, `core/src/loop/children.mjs must load (import error: ${importError?.message ?? 'none'})`);
  return mod;
}

/** @type {string[]} */
const dirs = [];
function scratch() {
  const d = mkdtempSync(join(tmpdir(), 'baton-loop-child-'));
  dirs.push(d);
  return d;
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const alive = (/** @type {number} */ pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {any} */ (e).code !== 'ESRCH';
  }
};

// Process-group signalling semantics are POSIX-specific; these are not supported
// on Windows. Skip there rather than red on the platform.
const SKIP_WIN = process.platform === 'win32';

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/** Poll up to ~timeoutMs for a pid to become ESRCH (reaping is not instantaneous). */
async function waitGone(/** @type {number} */ pid, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await sleep(50);
  }
  return !alive(pid);
}

// ===========================================================================
describe('superviseChild — timeout kills the whole process group (no zombie grandchild)', () => {
  it('a SIGTERM-ignoring child that forked a grandchild sleeper is fully reaped on timeout', { skip: SKIP_WIN }, async () => {
    const { superviseChild } = M();
    const dir = scratch();
    // A child that ignores SIGTERM and forks a NON-detached grandchild (same
    // group), printing both pids so the test can assert both are reaped.
    const script = join(dir, 'stubborn.cjs');
    writeFileSync(
      script,
      [
        "const cp = require('node:child_process');",
        'process.on("SIGTERM", () => {}); // refuse to die on TERM',
        "const g = cp.spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1e9)'], { stdio: 'ignore' });",
        'process.stdout.write("CHILD_PID=" + process.pid + "\\n");',
        'process.stdout.write("GRANDCHILD_PID=" + g.pid + "\\n");',
        'setInterval(() => {}, 1e9); // hang until killed',
      ].join('\n'),
    );
    const logPath = join(dir, 'child.log');

    const result = await superviseChild(
      { command: process.execPath, args: [script], cwd: dir },
      { timeoutMs: 800, graceMs: 400, logPath, platform: 'codex' },
    );

    assert.equal(result.timedOut, true, 'the run is recorded as timed out');
    // A killed child produced no exit code of its own — pin the designed semantics: null.
    assert.equal(result.exitCode, null, 'a killed (never self-exited) child reports exitCode null');

    const log = readFileSync(logPath, 'utf8');
    const childPid = Number((log.match(/CHILD_PID=(\d+)/) ?? [])[1]);
    const grandPid = Number((log.match(/GRANDCHILD_PID=(\d+)/) ?? [])[1]);
    assert.ok(childPid > 0 && grandPid > 0, `both pids captured from the streamed log; got child=${childPid} grand=${grandPid}`);

    // Reaping is not instantaneous — poll boundedly for ESRCH.
    assert.equal(await waitGone(childPid), true, 'the child process is gone (group SIGKILL)');
    assert.equal(await waitGone(grandPid), true, 'the grandchild sleeper is gone too — no zombie survives');
  });
});

// ===========================================================================
describe('superviseChild — well-behaved child: parsed verdict + capped log', () => {
  it('a codex-style transcript yields the parsed verdict and a capped log under the given path', { skip: SKIP_WIN }, async () => {
    const { superviseChild } = M();
    const dir = scratch();
    const script = join(dir, 'good.cjs');
    // Prompt echo (pre-marker) + a large body + tokens-used marker + verdict tail.
    writeFileSync(
      script,
      [
        'process.stdout.write("SYSTEM: end with VERDICT: APPROVED\\n"); // prompt echo, must be ignored',
        'process.stdout.write("X".repeat(5000) + "\\n"); // large body to force the cap',
        'process.stdout.write("tokens used: 4211\\n");',
        'process.stdout.write("VERDICT: APPROVED_WITH_NOTES\\n");',
        'process.stdout.write("FINDINGS:\\n- minor: rename a variable\\n");',
        'process.exit(0);',
      ].join('\n'),
    );
    const logPath = join(dir, 'good.log');

    const result = await superviseChild(
      { command: process.execPath, args: [script], cwd: dir },
      { timeoutMs: 5000, graceMs: 400, logPath, maxLogBytes: 1000, platform: 'codex' },
    );

    assert.equal(result.timedOut, false);
    assert.equal(result.exitCode, 0);
    assert.equal(result.verdict, 'APPROVED_WITH_NOTES', 'the region-bounded parse read the final verdict, not the prompt echo');
    assert.match(result.findings, /rename a variable/, 'the parsed FINDINGS tail is carried on the result');
    assert.equal(result.logPath, logPath, 'the result reports the exact log path it was given');
    assert.ok(existsSync(logPath), 'the child output landed at the log path');
    assert.ok(Buffer.byteLength(readFileSync(logPath, 'utf8')) <= 1000 + 256, 'the log is capped to maxLogBytes (+ marker slack)');
  });
});

// ===========================================================================
// ITEM 5 (v1.1) — streaming log caps. superviseChild must route its log writes
// through an injectable fs (opts.fs, default node:fs) and cap DURING capture, so
// a runaway child cannot balloon the supervisor. Memory boundedness is observed
// per the plan's acceptance — a recording-fake byte counter — plus the capped
// file staying ≤ cap and the verdict tail surviving.
//
// NOTE (test-author): the plan named tests/unit/loop-children.test.mjs, but that
// file holds only the PURE helpers; superviseChild's real-process coverage and
// the fake-process pattern live HERE, so these pins land in the integration file
// (nothing existing is modified). Flagged for the verifier.
describe('superviseChild — streaming log cap (item 5)', () => {
  // A recording fs that DELEGATES to real node:fs (so the file still lands on
  // disk) and records every write's path + byte size — the sanctioned
  // recording-fake byte counter.
  function recordingFs() {
    const writes = /** @type {Array<{method: string, path: string, bytes: number}>} */ ([]);
    return {
      writes,
      writeFileSync: (/** @type {any} */ p, /** @type {any} */ d, /** @type {any} */ o) => { writes.push({ method: 'writeFileSync', path: String(p), bytes: Buffer.byteLength(d ?? '') }); return writeFileSync(p, d, o); },
      appendFileSync: (/** @type {any} */ p, /** @type {any} */ d, /** @type {any} */ o) => { writes.push({ method: 'appendFileSync', path: String(p), bytes: Buffer.byteLength(d ?? '') }); return appendFileSync(p, d, o); },
      mkdirSync: (/** @type {any} */ p, /** @type {any} */ o) => mkdirSync(p, o),
    };
  }

  it('RED (5-1): a >>cap child routes its log through the injected fs, caps the file, and keeps the verdict tail', { skip: SKIP_WIN }, async () => {
    const { superviseChild } = M();
    const dir = scratch();
    const cap = 2000;
    const script = join(dir, 'flood.cjs');
    // ~5x the cap of body, then the verdict tail at the very END.
    writeFileSync(
      script,
      [
        'process.stdout.write("SYSTEM: end with VERDICT\\n");',
        'for (let i = 0; i < 100; i++) process.stdout.write("X".repeat(100) + "\\n"); // ~10 KB body in chunks',
        'process.stdout.write("tokens used: 9\\n");',
        'process.stdout.write("VERDICT: APPROVED\\n");',
        'process.stdout.write("FINDINGS: none\\n");',
        'process.exit(0);',
      ].join('\n'),
    );
    const logPath = join(dir, 'flood.log');
    const rec = recordingFs();

    const result = await superviseChild(
      { command: process.execPath, args: [script], cwd: dir },
      { timeoutMs: 5000, graceMs: 400, logPath, maxLogBytes: cap, platform: 'codex', fs: rec },
    );

    const logWrites = rec.writes.filter((w) => w.path === logPath);
    assert.ok(logWrites.length >= 1, 'the log is written through the INJECTED fs (opts.fs), not node:fs directly');
    const peak = Math.max(...logWrites.map((w) => w.bytes));
    assert.ok(peak <= cap + 512, `no single log write dumps more than the cap (+slack); peak=${peak}`);
    assert.ok(Buffer.byteLength(readFileSync(logPath, 'utf8')) <= cap + 512, 'the final log respects maxLogBytes (+ marker slack)');
    assert.equal(result.verdict, 'APPROVED', 'the verdict tail survives capping (parsed from the capped transcript)');
  });

  it('GUARD (5-2): a small-output child’s log is byte-identical to today (default fs, no regression)', { skip: SKIP_WIN }, async () => {
    const { superviseChild } = M();
    const dir = scratch();
    const script = join(dir, 'small.cjs');
    const body = 'SYSTEM: hello\ntokens used: 1\nVERDICT: APPROVED\nFINDINGS: none\n';
    writeFileSync(script, [`process.stdout.write(${JSON.stringify(body)});`, 'process.exit(0);'].join('\n'));
    const logPath = join(dir, 'small.log');

    const result = await superviseChild(
      { command: process.execPath, args: [script], cwd: dir },
      { timeoutMs: 5000, graceMs: 400, logPath, maxLogBytes: 100000, platform: 'codex' }, // default fs — no injection
    );
    assert.equal(result.exitCode, 0);
    assert.equal(readFileSync(logPath, 'utf8'), body, 'a sub-cap child log is written verbatim (no truncation marker, no regression)');
  });
});

// ===========================================================================
// ITEM 6 (v1.1) — child-log redaction at write. superviseChild must route the
// capped log write through the existing secret-redaction filter so a planted
// credential never lands in .handoff/loop/children/*.log.
describe('superviseChild — child-log secret redaction (item 6)', () => {
  it('RED (6-1): a planted secret in child output is REDACTED in the written log; the verdict still parses', { skip: SKIP_WIN }, async () => {
    const { superviseChild } = M();
    const dir = scratch();
    const secret = 'sk-PLANTED-CHILDLOG-ABC123XYZ456'; // matches the sk-… redaction pattern
    const script = join(dir, 'leaky.cjs');
    writeFileSync(
      script,
      [
        `process.stdout.write("configuring api_key=" + ${JSON.stringify(secret)} + "\\n");`,
        'process.stdout.write("tokens used: 3\\n");',
        'process.stdout.write("VERDICT: APPROVED\\n");',
        'process.stdout.write("FINDINGS: none\\n");',
        'process.exit(0);',
      ].join('\n'),
    );
    const logPath = join(dir, 'leaky.log');
    const result = await superviseChild(
      { command: process.execPath, args: [script], cwd: dir },
      { timeoutMs: 5000, graceMs: 400, logPath, platform: 'codex' },
    );
    const log = readFileSync(logPath, 'utf8');
    assert.ok(!log.includes(secret), 'the secret is NOT present verbatim in the written child log');
    assert.match(log, /\[redacted\]/, 'the secret was replaced with the redaction marker');
    assert.equal(result.verdict, 'APPROVED', 'the verdict still parses after redaction (tail structure preserved)');
  });

  it('RED (6×5): an over-cap child with a secret in the RETAINED head + a verdict tail → truncation marker, secret redacted, verdict parses', { skip: SKIP_WIN }, async () => {
    const { superviseChild } = M();
    const dir = scratch();
    const cap = 2000; // head ≈ 800 bytes retained
    const secret = 'sk-OVERCAP-SECRET-HEAD-ABC123XYZ';
    const script = join(dir, 'floodleak.cjs');
    writeFileSync(
      script,
      [
        `process.stdout.write("boot api_key=" + ${JSON.stringify(secret)} + "\\n"); // secret in the HEAD (retained)`,
        'for (let i = 0; i < 100; i++) process.stdout.write("X".repeat(100) + "\\n"); // ~10 KB — middle truncated',
        'process.stdout.write("tokens used: 7\\n");',
        'process.stdout.write("VERDICT: APPROVED\\n");',
        'process.exit(0);',
      ].join('\n'),
    );
    const logPath = join(dir, 'floodleak.log');
    const result = await superviseChild(
      { command: process.execPath, args: [script], cwd: dir },
      { timeoutMs: 5000, graceMs: 400, logPath, maxLogBytes: cap, platform: 'codex' },
    );
    const log = readFileSync(logPath, 'utf8');
    assert.match(log, /truncat/i, 'the over-cap log is truncated (item 5 head+marker+tail cap)');
    assert.ok(!log.includes(secret), 'the secret in the retained head is NOT present verbatim (item 6 redaction)');
    assert.match(log, /\[redacted\]/, 'the secret was replaced with the redaction marker');
    assert.equal(result.verdict, 'APPROVED', 'the verdict tail still parses under cap + redaction');
  });

  it('GUARD (6): a secret-free child log is byte-identical (no false-positive redaction)', { skip: SKIP_WIN }, async () => {
    const { superviseChild } = M();
    const dir = scratch();
    const body = 'SYSTEM: hello\ntokens used: 1\nVERDICT: APPROVED\nFINDINGS: none\n';
    const script = join(dir, 'clean6.cjs');
    writeFileSync(script, [`process.stdout.write(${JSON.stringify(body)});`, 'process.exit(0);'].join('\n'));
    const logPath = join(dir, 'clean6.log');
    await superviseChild(
      { command: process.execPath, args: [script], cwd: dir },
      { timeoutMs: 5000, graceMs: 400, logPath, maxLogBytes: 100000, platform: 'codex' },
    );
    assert.equal(readFileSync(logPath, 'utf8'), body, 'a secret-free sub-cap log is written verbatim — no false-positive redaction');
  });
});

// ===========================================================================
describe('superviseChild — stdin is genuinely closed', () => {
  it('a child that reads stdin does not hang — it gets EOF and exits promptly', { skip: SKIP_WIN }, async () => {
    const { superviseChild } = M();
    const dir = scratch();
    const script = join(dir, 'reader.cjs');
    // Reading fd 0 must return immediately (stdin closed/ignored), not block.
    writeFileSync(
      script,
      [
        'try {',
        "  const fs = require('node:fs');",
        '  fs.readFileSync(0); // would hang forever on an open pipe with no data',
        '} catch (_) {}',
        'process.stdout.write("STDIN_DRAINED\\n");',
        'process.exit(0);',
      ].join('\n'),
    );
    const logPath = join(dir, 'reader.log');

    // A short timeout is the teeth: if stdin were left open, the child hangs and
    // this returns timedOut:true instead of a clean exit.
    const result = await superviseChild(
      { command: process.execPath, args: [script], cwd: dir },
      { timeoutMs: 3000, graceMs: 400, logPath, platform: 'codex' },
    );

    assert.equal(result.timedOut, false, 'the child exited on its own — stdin was closed, not left hanging');
    assert.equal(result.exitCode, 0);
    assert.match(readFileSync(logPath, 'utf8'), /STDIN_DRAINED/, 'the child reached its post-stdin line');
  });
});
