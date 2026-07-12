import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeIo } from '../helpers/fakeio.mjs';
import { bundlePaths } from '../../core/src/bundle/store.mjs';
// SOLE RED CAUSE for this file: the module below does not exist yet, so this
// static import throws ERR_MODULE_NOT_FOUND at load and every test in the file
// reds with that single, unambiguous cause. (core/* and helper imports above all
// resolve — only hook.mjs is missing.)
import { runHook } from '../../adapters/claude-code/scripts/hook.mjs';

// ---------------------------------------------------------------------------
// ADAPTERS wave — RED. Behavioural contract for the Claude Code single hook
// entrypoint, exercised over injected io (mirrors the core command tests:
// cmdX(args, io) -> exit code). The adapter CALLS the core CLI — these tests pin
// the adapter SURFACE only (event→command mapping, the SessionStart context
// shape, fail-open), never core checkpoint/detect logic.
//
// TARGET MODULE: adapters/claude-code/scripts/hook.mjs (sole target).
//
// Source of truth: plan §Claude Code adapter hook table + platform-notes
// §Claude Code (SessionStart injects hookSpecificOutput.additionalContext).
//
// PINNED CONTRACT (open details resolved here):
//   S0. SIGNATURE. `runHook(args, io) => Promise<number>`, where args[0] is the
//       hook event name (passed by hooks.json) and io is the injected object
//       {cwd, env, stdin, stdout, stderr, fs, execFile, now, …}. The hook payload
//       arrives as the STRING io.stdin (Claude writes hook JSON on stdin).
//   S1. BATON REACH. To run a core command, hook.mjs invokes the core CLI as a
//       child process via io.execFile: it resolves the baton bin as
//       `${io.env.CLAUDE_PLUGIN_ROOT}/core/bin/baton.mjs` and calls
//       io.execFile(node, [batonBin, <subcmd>, …flags], {input}). Tests assert on
//       the recorded invocation. (Verifier fold V1) EVERY core child call —
//       checkpoint AND detect — must use that resolved bin path and must forward
//       the raw hook payload as the child's stdin: opts.input === io.stdin. An
//       adapter that bypasses the core CLI or drops the payload cannot pass.
//   S2. MAPPING. Stop / PreCompact / SessionEnd -> exactly one `checkpoint
//       --platform claude-code` invocation, identifying the source event.
//       StopFailure -> BOTH a `detect --platform claude-code` invocation (the
//       classify step) AND a `checkpoint --platform claude-code` invocation
//       stamped with a stop-failure trigger; a rate_limit StopFailure carries the
//       rate_limit signal through to the checkpoint (marks the bundle limit-hit).
//   S3. SessionStart is NOT a checkpoint: it spawns NO checkpoint child. Instead
//       it reads <cwd>/.handoff/bundle.json (read-only, via io.fs) and, when a
//       PENDING (sealed OR usage-limit) bundle FROM ANOTHER PLATFORM exists, emits
//       exactly the Claude context shape on stdout:
//         {"hookSpecificOutput":{"hookEventName":"SessionStart",
//                                  "additionalContext":"…suggest /baton:receive…"}}
//       (Verifier fold V2) The full pending matrix is pinned:
//         positive:  foreign SEALED bundle            -> context
//         positive:  foreign OPEN + reasonClass usage-limit (limit death before
//                    finalize — the primary failure case) -> context
//         negative:  foreign OPEN non-limit bundle    -> no context
//         negative:  own-platform open non-limit      -> no context
//         negative:  no bundle at all                 -> no context
//       proving BOTH disjuncts of "sealed OR limit-hit" AND "foreign only".
//   S4. FAIL-OPEN. Every error path (unparseable stdin, a rejected core
//       invocation, a missing/corrupt bundle) returns 0 and never throws — a hook
//       must never break the host session. Claude ignores the exit code anyway.
//
// "limit-hit" (S2/S3): pinned to the documented handoff fields — a bundle whose
// handoff.status==='sealed' OR handoff.reasonClass==='usage-limit' is "pending".
// ---------------------------------------------------------------------------

const T0 = '2026-07-11T00:00:00.000Z';
const paths = bundlePaths('/repo');
const PLUGIN_ROOT = '/repo';

/**
 * Build an io whose execFile RECORDS every invocation. `respond` lets a test
 * control the child's result (resolve/reject); default resolves empty.
 */
function makeHookIo({ stdin = '', files = {}, respond } = {}) {
  const io = makeIo({ env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT }, stdin, files, now: T0 });
  const calls = [];
  io.execFile = (cmd, args = [], opts = {}) => {
    calls.push({ cmd, args: Array.isArray(args) ? args : [], opts: opts || {} });
    if (respond) return respond({ cmd, args, opts });
    return Promise.resolve({ stdout: '', stderr: '' });
  };
  return { io, calls };
}

const line = (c) => [c.cmd, ...c.args].join(' ');
const inputOf = (c) => (typeof c.opts.input === 'string' ? c.opts.input : '');
const serialize = (c) => `${line(c)} ${inputOf(c)}`;
const findSub = (calls, sub) => calls.filter((c) => c.args.includes(sub) || new RegExp(`\\b${sub}\\b`).test(line(c)));

const BATON_BIN = `${PLUGIN_ROOT}/core/bin/baton.mjs`;
/** (V1) Every core child call goes through the core CLI with the payload forwarded. */
function assertBatonCall(c, io, label) {
  assert.ok(line(c).includes(BATON_BIN), `${label}: the invocation uses the baton bin resolved under CLAUDE_PLUGIN_ROOT (${BATON_BIN}); got: ${line(c)}`);
  assert.equal(inputOf(c), io.stdin, `${label}: the raw hook payload is forwarded as the child's stdin (opts.input === io.stdin)`);
}

function claudeBundle(overrides = {}) {
  return {
    schema: 'baton/bundle@1',
    bundleId: 'b_hook0000000000',
    generation: 1,
    createdAt: T0,
    updatedAt: T0,
    origin: { platform: 'claude-code', model: 'claude-fable-5', sessionHint: 'sess-cc', unstable: false },
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
const snapText = (b) => JSON.stringify(b, null, 2) + '\n';
const payload = (event, extra = {}) => JSON.stringify({ hook_event_name: event, session_id: 'sess-cc', cwd: '/repo', ...extra });

// ===========================================================================
describe('hook.mjs — routine checkpoint events map to a single core checkpoint (S1, S2)', () => {
  for (const event of ['Stop', 'PreCompact', 'SessionEnd']) {
    it(`${event} -> one \`checkpoint --platform claude-code\` reaching core/bin/baton.mjs`, async () => {
      const { io, calls } = makeHookIo({ stdin: payload(event), files: { [paths.snapshot]: snapText(claudeBundle()) } });

      const code = await runHook([event], io);
      assert.equal(code, 0, 'a checkpoint hook always exits 0 (fail-open by construction)');

      const ckpts = findSub(calls, 'checkpoint');
      assert.equal(ckpts.length, 1, `${event} maps to exactly one checkpoint invocation`);
      const c = ckpts[0];
      assertBatonCall(c, io, `${event} checkpoint`);
      assert.ok(c.args.includes('--platform') && c.args.includes('claude-code'), 'checkpoint is stamped --platform claude-code');
      assert.match(serialize(c), new RegExp(event.replace('Session', 'session.?').toLowerCase(), 'i'), `the invocation identifies the ${event} source`);

      assert.equal(findSub(calls, 'detect').length, 0, `${event} is a routine checkpoint, not a detect`);
      // (V1) No core call anywhere in this event bypassed the baton bin.
      for (const any of calls) assertBatonCall(any, io, `${event} core call`);
    });
  }
});

// ===========================================================================
describe('hook.mjs — StopFailure classifies AND checkpoints (S2)', () => {
  it('a rate_limit StopFailure invokes detect and a stop-failure checkpoint carrying the rate_limit signal', async () => {
    const { io, calls } = makeHookIo({
      stdin: payload('StopFailure', { error: { type: 'rate_limit' } }),
      files: { [paths.snapshot]: snapText(claudeBundle()) },
      // Mirror real `baton detect`: usage-limit exits 10 with a JSON verdict on
      // stdout. hook.mjs must tolerate the nonzero exit (fail-open) and still route.
      respond: ({ args }) => {
        if (args.includes('detect')) {
          const e = new Error('Command failed');
          e.code = 10;
          e.stdout = JSON.stringify({ ok: true, data: { class: 'usage-limit' }, warnings: [], error: null }) + '\n';
          e.stderr = '';
          return Promise.reject(e);
        }
        return Promise.resolve({ stdout: '', stderr: '' });
      },
    });

    const code = await runHook(['StopFailure'], io);
    assert.equal(code, 0, 'StopFailure handling is fail-open even when detect exits nonzero');

    const detects = findSub(calls, 'detect');
    assert.equal(detects.length, 1, 'StopFailure runs the payload through `baton detect` (the classify step)');
    assertBatonCall(detects[0], io, 'StopFailure detect');
    assert.ok(detects[0].args.includes('--platform') && detects[0].args.includes('claude-code'), 'detect is stamped --platform claude-code');

    const ckpts = findSub(calls, 'checkpoint');
    assert.equal(ckpts.length, 1, 'StopFailure also writes a mechanical checkpoint');
    const c = ckpts[0];
    assertBatonCall(c, io, 'StopFailure checkpoint');
    assert.ok(c.args.includes('--platform') && c.args.includes('claude-code'), 'checkpoint is stamped --platform claude-code');
    assert.match(serialize(c), /stop-?failure/i, 'the checkpoint is stamped with a stop-failure trigger');
    assert.match(serialize(c), /rate_limit/i, 'the rate_limit signal flows through to the checkpoint (marks the bundle limit-hit)');

    // (V1) No core call anywhere in this event bypassed the baton bin.
    for (const any of calls) assertBatonCall(any, io, 'StopFailure core call');
  });
});

// ===========================================================================
describe('hook.mjs — SessionStart injects a handoff-pending notice, never checkpoints (S3)', () => {
  it('a SEALED bundle from another platform (codex) emits hookSpecificOutput.additionalContext', async () => {
    const bundle = claudeBundle({
      origin: { platform: 'codex', model: 'gpt-5.6-sol', sessionHint: 'sess-x', unstable: false },
      handoff: { status: 'sealed', reason: 'limit', reasonClass: 'usage-limit', toPlatformHint: 'claude-code', finalizedAt: T0, receive_log: [] },
    });
    const { io, calls } = makeHookIo({ stdin: payload('SessionStart'), files: { [paths.snapshot]: snapText(bundle) } });

    const code = await runHook(['SessionStart'], io);
    assert.equal(code, 0);
    assert.equal(findSub(calls, 'checkpoint').length, 0, 'SessionStart never checkpoints');

    const out = io.stdoutText();
    const parsed = JSON.parse(out);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart', 'emits the SessionStart hookSpecificOutput envelope');
    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert.ok(typeof ctx === 'string' && ctx.length > 0, 'additionalContext is a non-empty string');
    assert.match(ctx, /receive/i, 'the injected context suggests receiving the pending handoff (e.g. /baton:receive)');
  });

  it('(V2 positive) an OPEN foreign bundle marked usage-limit (limit death BEFORE finalize) emits additionalContext', async () => {
    // The primary failure case: the origin platform died to a limit before it
    // could seal — handoff.status is still 'open' but reasonClass says usage-limit.
    const bundle = claudeBundle({
      origin: { platform: 'codex', model: 'gpt-5.6-sol', sessionHint: 'sess-x', unstable: false },
      handoff: { status: 'open', reason: "You've hit your usage limit", reasonClass: 'usage-limit', toPlatformHint: null, finalizedAt: null, receive_log: [] },
    });
    const { io, calls } = makeHookIo({ stdin: payload('SessionStart'), files: { [paths.snapshot]: snapText(bundle) } });

    const code = await runHook(['SessionStart'], io);
    assert.equal(code, 0);
    assert.equal(findSub(calls, 'checkpoint').length, 0, 'SessionStart never checkpoints');

    const parsed = JSON.parse(io.stdoutText());
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert.ok(typeof ctx === 'string' && ctx.length > 0, 'an unsealed limit-hit foreign bundle IS pending — context is injected');
    assert.match(ctx, /receive/i, 'the injected context suggests receiving the pending handoff');
  });

  const assertNoContext = (io, why) => {
    const out = io.stdoutText().trim();
    if (out.length > 0) {
      const parsed = JSON.parse(out);
      const ctx = parsed?.hookSpecificOutput?.additionalContext;
      assert.ok(!ctx, why);
    }
  };

  it('(V2 negative) an OPEN, non-limit FOREIGN bundle emits no additionalContext (limit-hit is required when unsealed)', async () => {
    const bundle = claudeBundle({
      origin: { platform: 'codex', model: 'gpt-5.6-sol', sessionHint: 'sess-x', unstable: false },
      // open + reasonClass null: mid-task on another platform, nothing pending.
    });
    const { io, calls } = makeHookIo({ stdin: payload('SessionStart'), files: { [paths.snapshot]: snapText(bundle) } });

    const code = await runHook(['SessionStart'], io);
    assert.equal(code, 0);
    assert.equal(findSub(calls, 'checkpoint').length, 0, 'SessionStart never checkpoints');
    assertNoContext(io, 'a foreign OPEN non-limit bundle is not pending — no additionalContext');
  });

  it('an OPEN, non-limit bundle from THIS platform (claude-code) emits no additionalContext', async () => {
    const { io, calls } = makeHookIo({ stdin: payload('SessionStart'), files: { [paths.snapshot]: snapText(claudeBundle()) } });

    const code = await runHook(['SessionStart'], io);
    assert.equal(code, 0);
    assert.equal(findSub(calls, 'checkpoint').length, 0, 'SessionStart never checkpoints');
    assertNoContext(io, 'an own-platform, open, non-limit bundle is not a pending handoff — no additionalContext');
  });

  it('(iter-2) a SEALED bundle from THIS platform (claude-code) emits no additionalContext — pending requires FOREIGN', async () => {
    const bundle = claudeBundle({
      handoff: { status: 'sealed', reason: 'wrapping up', reasonClass: null, toPlatformHint: 'codex', finalizedAt: T0, receive_log: [] },
    });
    const { io, calls } = makeHookIo({ stdin: payload('SessionStart'), files: { [paths.snapshot]: snapText(bundle) } });

    const code = await runHook(['SessionStart'], io);
    assert.equal(code, 0);
    assert.equal(findSub(calls, 'checkpoint').length, 0, 'SessionStart never checkpoints');
    assertNoContext(io, 'an own-platform sealed bundle is this session\'s own work, not a pending handoff — no additionalContext');
  });

  it('(iter-2) an OPEN usage-limit bundle from THIS platform emits no additionalContext — pending requires FOREIGN', async () => {
    const bundle = claudeBundle({
      handoff: { status: 'open', reason: "You've hit your usage limit", reasonClass: 'usage-limit', toPlatformHint: null, finalizedAt: null, receive_log: [] },
    });
    const { io, calls } = makeHookIo({ stdin: payload('SessionStart'), files: { [paths.snapshot]: snapText(bundle) } });

    const code = await runHook(['SessionStart'], io);
    assert.equal(code, 0);
    assert.equal(findSub(calls, 'checkpoint').length, 0, 'SessionStart never checkpoints');
    assertNoContext(io, 'an own-platform limit-hit bundle belongs to this platform\'s own resumed session — no additionalContext');
  });

  it('(V2 negative) no bundle at all emits no additionalContext and exits 0', async () => {
    const { io, calls } = makeHookIo({ stdin: payload('SessionStart') }); // empty tree: no .handoff/

    const code = await runHook(['SessionStart'], io);
    assert.equal(code, 0, 'a missing bundle is a quiet no-op (fail-open)');
    assert.equal(findSub(calls, 'checkpoint').length, 0, 'SessionStart never checkpoints');
    assertNoContext(io, 'no bundle means nothing pending — no additionalContext');
  });
});

// ===========================================================================
describe('hook.mjs — fail-open (S4)', () => {
  it('unparseable stdin returns 0 and never throws', async () => {
    const { io } = makeHookIo({ stdin: 'not json at all {', files: { [paths.snapshot]: snapText(claudeBundle()) } });
    const code = await runHook(['Stop'], io);
    assert.equal(code, 0, 'a garbage payload soft-fails to exit 0');
  });

  it('a rejected core invocation (baton failed) still returns 0', async () => {
    const { io } = makeHookIo({
      stdin: payload('Stop'),
      files: { [paths.snapshot]: snapText(claudeBundle()) },
      respond: () => Promise.reject(Object.assign(new Error('spawn failed'), { code: 1 })),
    });
    const code = await runHook(['Stop'], io);
    assert.equal(code, 0, 'a failing child process must not break the host session');
  });

  it('SessionStart with a corrupt bundle returns 0 and emits no crash output', async () => {
    const { io } = makeHookIo({ stdin: payload('SessionStart'), files: { [paths.snapshot]: '{ corrupt json' } });
    const code = await runHook(['SessionStart'], io);
    assert.equal(code, 0, 'a corrupt bundle degrades to a quiet no-op');
  });
});
