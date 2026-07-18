import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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
