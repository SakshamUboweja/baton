import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHookPayload } from '../../core/src/bundle/normalize.mjs';

// ---------------------------------------------------------------------------
// Contract choices for core/src/bundle/normalize.mjs (docs/design/core.md
// §Module APIs "normalizeHookPayload(raw, platform) -> Event[]  // never throws;
// unknowns -> note"; §Per-module test lists "normalize"; plan §Checkpoint engine
// "adapters send pre-normalized baton/event@1 … raw hook payloads get best-effort
// per-platform extraction that never throws — unknowns degrade to note events";
// §"sessionHint derivation" (Gate-1 final note); docs/design/platform-notes.md
// per-harness hook payload shapes). normalizeHookPayload is PURE (a JS value in,
// an Event[] out) and NEVER THROWS.
//
// INPUT: normalizeHookPayload(raw, platform, session?). `raw` is an already-
//   PARSED JS value (checkpoint does the JSON.parse and hands the value in), so
//   the fuzz corpus feeds real values — null / [] / 'string' / number / {} /
//   deeply-nested / huge. `platform` selects the extractor: 'claude-code' |
//   'codex' | 'cursor'. The baton/event@1 passthrough works regardless of
//   platform. `session` (OPTIONAL third arg, verifier fold F1) carries the
//   process-identity facts {host, pid, startTime} — the same fields fakeio's io
//   exposes; the checkpoint cmd passes io's. It feeds ONLY the generated-
//   unstable-hint path (pin B below); when omitted, normalize falls back to the
//   real process's own facts (still process-scoped, still deterministic).
//
// EVENT SHAPES this file pins:
//   A. PASSTHROUGH (raw carries schema 'baton/event@1'): the events are returned
//      VERBATIM (deep-equal), no field injected or stripped, no sessionHint
//      derived — the adapter already formed them. Two envelope forms:
//        - {schema:'baton/event@1', events:[E1, E2]}  -> returns [E1, E2] (the
//          inner event objects, verbatim).
//        - a single event object {schema:'baton/event@1', type, payload, …}
//          -> returns [rawObject] (verbatim, schema field retained — verbatim
//          means unchanged).
//   B. EXTRACTED events (from a raw per-harness hook payload) carry:
//        { type, payload, source, sessionHint, unstable }
//      where:
//        - source === the PLATFORM string ('claude-code' | 'codex' | 'cursor').
//          The task pins Codex -> source 'codex'; this file makes source===platform
//          uniform, and puts the hook trigger in payload (payload.trigger), so the
//          harness is the source and the event name is data.
//        - sessionHint: the payload's stable session id when present (unstable:
//          false). When ABSENT, core GENERATES a process-scoped hint flagged
//          unstable:true (plan §sessionHint derivation — verifier fold F1;
//          replaces this file's earlier null-hint pin, which violated the plan).
//          The generated hint is a NON-EMPTY string derived DETERMINISTICALLY
//          from the session facts (host/pid/startTime): one process/session
//          scope -> ONE hint, stable across calls and across payloads; different
//          process facts -> a different hint. No wall-clock randomness. Unstable
//          hints never trigger foreign-session rejection on their own (that rule
//          is pinned at the checkpoint-cmd altitude).
//   C. Claude Code file event: a PostToolUse whose tool WRITES a file
//      ({hook_event_name:'PostToolUse', tool_name:'Write'|'Edit', tool_input:{file_path}})
//      -> exactly one 'file.touch' event with payload {path, op}. op is the
//      lowercased edit verb: Write -> 'write', Edit -> 'edit' (pinned mapping).
//      path === tool_input.file_path.
//   D. Claude Code Stop -> a single 'note' event recording the trigger:
//      payload.trigger === 'Stop' and payload.text is a non-empty string (merge's
//      note reducer renders payload.text, so it must be set).
//   E. Claude Code StopFailure -> a single 'note' event whose payload carries the
//      error type AND a structured marker the checkpoint cmd can act on:
//      payload.errorType === error.type ('rate_limit') and payload.structured is
//      TRUTHY (a marker — boolean true or a {kind,errorType} object; not pinned to
//      a specific shape, only that it is present and truthy).
//   F. Codex payload ({hook_event_name, session_id, cwd, model, transcript_path})
//      -> a 'note' event with source 'codex' and sessionHint from session_id.
//   G. Cursor payload -> a 'note' event with source 'cursor'. Cursor may name the
//      event field 'hook_event_name' OR 'event' (both accepted).
//   H. Any unrecognized-but-known-platform payload (unknown hook_event_name, a
//      non-file PostToolUse tool, etc.) degrades to a 'note' event — never throws,
//      never a file.touch.
//   I. FUZZ: >= 6 malformed shapes each return an ARRAY, never throw, and any
//      element present is a note event (the design allows [] OR note events).
// ---------------------------------------------------------------------------

/** Assert `raw` normalizes without throwing and yields an array. Returns it. */
function norm(raw, platform) {
  let out;
  assert.doesNotThrow(() => {
    out = normalizeHookPayload(raw, platform);
  }, `normalizeHookPayload must never throw (platform=${platform}, raw=${safe(raw)})`);
  assert.ok(Array.isArray(out), `result must be an Event[] array; got ${safe(out)}`);
  return out;
}

function safe(v) {
  try {
    return JSON.stringify(v)?.slice(0, 80) ?? String(v);
  } catch {
    return String(v);
  }
}

// ===========================================================================
describe('normalize — baton/event@1 passthrough (the real adapter API)', () => {
  it('an {events:[...]} envelope returns the inner events VERBATIM', () => {
    const e1 = { type: 'decision', payload: { summary: 'Chose tmp+rename' }, source: 'claude-code' };
    const e2 = { type: 'file.touch', payload: { path: 'a.mjs', op: 'edit' }, source: 'claude-code' };
    const raw = { schema: 'baton/event@1', events: [e1, e2] };
    const out = norm(raw, 'claude-code');
    assert.deepEqual(out, [e1, e2], 'the events array is returned unchanged');
  });

  it('a single baton/event@1 object returns [rawObject] verbatim', () => {
    const raw = { schema: 'baton/event@1', type: 'note', payload: { text: 'hello' }, sessionHint: 's1', unstable: false };
    const out = norm(raw, 'codex');
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], raw, 'a single-event payload is returned verbatim (schema retained)');
  });

  it('passthrough does not derive/overwrite a sessionHint the adapter already set', () => {
    const raw = { schema: 'baton/event@1', events: [{ type: 'note', payload: { text: 'x' }, sessionHint: 'adapter-set', unstable: false }] };
    const out = norm(raw, 'cursor');
    assert.equal(out[0].sessionHint, 'adapter-set', 'the adapter-provided sessionHint survives passthrough');
  });

  it('passthrough works regardless of the platform argument', () => {
    const raw = { schema: 'baton/event@1', events: [{ type: 'note', payload: { text: 'p' } }] };
    for (const p of ['claude-code', 'codex', 'cursor', 'anything']) {
      assert.deepEqual(norm(raw, p), raw.events);
    }
  });
});

// ===========================================================================
describe('normalize — Claude Code extraction', () => {
  it('PostToolUse/Write -> one file.touch {path, op:"write"} with sessionHint from session_id', () => {
    const raw = { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: '/x.mjs' }, session_id: 's1' };
    const out = norm(raw, 'claude-code');
    assert.equal(out.length, 1, 'a single Write produces exactly one event');
    const ev = out[0];
    assert.equal(ev.type, 'file.touch');
    assert.equal(ev.payload.path, '/x.mjs');
    assert.equal(ev.payload.op, 'write', 'Write maps to op "write"');
    assert.equal(ev.source, 'claude-code', 'source is the harness');
    assert.equal(ev.sessionHint, 's1', 'sessionHint derived from session_id');
    assert.equal(ev.unstable, false, 'a stable session id is not unstable');
  });

  it('PostToolUse/Edit -> file.touch with op:"edit" (the write-verb mapping)', () => {
    const raw = { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: '/y.mjs' }, session_id: 's1' };
    const out = norm(raw, 'claude-code');
    assert.equal(out[0].type, 'file.touch');
    assert.equal(out[0].payload.op, 'edit', 'Edit maps to op "edit"');
    assert.equal(out[0].payload.path, '/y.mjs');
  });

  it('Stop -> a single note event recording the trigger (payload.trigger + rendered payload.text)', () => {
    const raw = { hook_event_name: 'Stop', session_id: 's1' };
    const out = norm(raw, 'claude-code');
    assert.equal(out.length, 1);
    assert.equal(out[0].type, 'note');
    assert.equal(out[0].payload.trigger, 'Stop', 'the note records which hook fired');
    assert.ok(typeof out[0].payload.text === 'string' && out[0].payload.text.length > 0, 'payload.text is set so merge can render the note');
    assert.equal(out[0].source, 'claude-code');
    assert.equal(out[0].sessionHint, 's1');
    assert.equal(out[0].unstable, false);
  });

  it('StopFailure -> a note carrying errorType + a truthy structured marker; NO session_id => unstable null hint', () => {
    const raw = { hook_event_name: 'StopFailure', error: { type: 'rate_limit' } };
    const out = norm(raw, 'claude-code');
    assert.equal(out.length, 1);
    assert.equal(out[0].type, 'note');
    assert.equal(out[0].payload.errorType, 'rate_limit', 'the StopFailure error type is preserved for the checkpoint cmd');
    assert.ok(out[0].payload.structured, 'a structured marker is present so checkpoint can classify structured-first');
    // This payload has no session_id: the absent-id branch must fire — core
    // GENERATES a process-scoped hint (plan §sessionHint derivation), never null.
    assert.ok(
      typeof out[0].sessionHint === 'string' && out[0].sessionHint.length > 0,
      'no session_id => a generated process-scoped hint (non-empty string)',
    );
    assert.equal(out[0].unstable, true, 'no session_id => unstable true');
  });

  it('an unknown Claude Code hook event degrades to a note (never throws)', () => {
    const out = norm({ hook_event_name: 'SomeFutureEvent', session_id: 's1' }, 'claude-code');
    assert.ok(out.every((e) => e.type === 'note'), 'unknown hook events degrade to notes');
  });

  it('a non-file PostToolUse tool (Bash) does not fabricate a file.touch — degrades to a note', () => {
    const out = norm({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 's1' }, 'claude-code');
    assert.ok(!out.some((e) => e.type === 'file.touch'), 'a non-writing tool must not become a file.touch');
    assert.ok(out.every((e) => e.type === 'note'), 'it degrades to a note instead');
  });
});

// ===========================================================================
describe('normalize — Codex extraction', () => {
  it('a Codex Stop payload -> note event carrying source "codex" and sessionHint from session_id', () => {
    const raw = { hook_event_name: 'Stop', session_id: 'c1', cwd: '/repo', model: 'gpt-5.6-sol', transcript_path: '/t.jsonl' };
    const out = norm(raw, 'codex');
    assert.equal(out.length, 1);
    assert.equal(out[0].type, 'note');
    assert.equal(out[0].source, 'codex', 'the source records the codex harness (task pin)');
    assert.equal(out[0].sessionHint, 'c1');
    assert.equal(out[0].unstable, false);
  });

  it('a Codex payload without a session_id yields a generated non-empty unstable hint', () => {
    const out = norm({ hook_event_name: 'Stop', cwd: '/repo', model: 'gpt-5.6-sol' }, 'codex');
    assert.ok(typeof out[0].sessionHint === 'string' && out[0].sessionHint.length > 0, 'a process-scoped hint is generated, never null');
    assert.equal(out[0].unstable, true);
  });
});

// ===========================================================================
describe('normalize — Cursor extraction', () => {
  it('a Cursor payload keyed by hook_event_name -> note event, source "cursor"', () => {
    const out = norm({ hook_event_name: 'stop', session_id: 'cur-1' }, 'cursor');
    assert.equal(out.length, 1);
    assert.equal(out[0].type, 'note');
    assert.equal(out[0].source, 'cursor');
    assert.equal(out[0].sessionHint, 'cur-1');
    assert.equal(out[0].unstable, false);
  });

  it('a Cursor payload keyed by `event` (not hook_event_name) is still recognized -> note, source "cursor"', () => {
    const out = norm({ event: 'stop' }, 'cursor');
    assert.equal(out.length, 1);
    assert.equal(out[0].type, 'note');
    assert.equal(out[0].source, 'cursor');
    // No session field present -> a generated process-scoped unstable hint.
    assert.ok(typeof out[0].sessionHint === 'string' && out[0].sessionHint.length > 0);
    assert.equal(out[0].unstable, true);
  });
});

// ===========================================================================
describe('normalize — sessionHint derivation invariants', () => {
  // The process-identity facts a caller injects (mirrors fakeio's io defaults).
  const SESSION = { host: 'host-A', pid: 4242, startTime: 111000 };

  it('present session_id -> event.sessionHint === session_id, unstable === false', () => {
    const out = norm({ hook_event_name: 'Stop', session_id: 'abc-123' }, 'claude-code');
    assert.equal(out[0].sessionHint, 'abc-123');
    assert.equal(out[0].unstable, false);
  });

  it('absent session_id -> a GENERATED non-empty process-scoped hint, unstable === true (plan, F1)', () => {
    const out = norm({ hook_event_name: 'Stop' }, 'claude-code');
    assert.ok(typeof out[0].sessionHint === 'string' && out[0].sessionHint.length > 0, 'the hint is generated, never null');
    assert.equal(out[0].unstable, true);
  });

  it('the generated hint is process-scoped: same session facts -> the SAME hint across calls AND payloads', () => {
    const a = normalizeHookPayload({ hook_event_name: 'Stop' }, 'claude-code', SESSION)[0];
    const b = normalizeHookPayload({ hook_event_name: 'StopFailure', error: { type: 'rate_limit' } }, 'claude-code', SESSION)[0];
    assert.ok(typeof a.sessionHint === 'string' && a.sessionHint.length > 0);
    assert.equal(a.sessionHint, b.sessionHint, 'one process/session scope -> one hint, regardless of payload');
    assert.equal(a.unstable, true);
    assert.equal(b.unstable, true);
  });

  it('different process facts -> a DIFFERENT generated hint (deterministic derivation, not a constant)', () => {
    const a = normalizeHookPayload({ hook_event_name: 'Stop' }, 'codex', SESSION)[0];
    const b = normalizeHookPayload({ hook_event_name: 'Stop' }, 'codex', { ...SESSION, pid: 9999 })[0];
    assert.notEqual(a.sessionHint, b.sessionHint, 'a different pid must derive a different hint');
  });

  it('omitting the session arg still yields a stable non-empty hint within the same process (fallback facts)', () => {
    const a = normalizeHookPayload({ hook_event_name: 'Stop' }, 'claude-code')[0];
    const b = normalizeHookPayload({ hook_event_name: 'Stop' }, 'claude-code')[0];
    assert.ok(typeof a.sessionHint === 'string' && a.sessionHint.length > 0);
    assert.equal(a.sessionHint, b.sessionHint, 'the fallback hint is process-scoped, not per-call randomness');
  });
});

// ===========================================================================
describe('normalize — malformed-input fuzz never throws', () => {
  const deeplyWeird = { a: [{ b: [{ c: [{ d: { e: [null, undefined, { f: [1, [2, [3, [4]]]] }] } }] }] }] };
  const huge = { events: Array.from({ length: 2000 }, (_v, i) => ({ n: i, s: 'x'.repeat(64) })) };

  const CORPUS = [
    ['null', null],
    ['undefined', undefined],
    ['empty array', []],
    ['a bare string', 'this is not a hook payload'],
    ['a number', 42],
    ['a boolean', true],
    ['empty object', {}],
    ['a non-baton object with only noise', { foo: 'bar', nested: { x: 1 } }],
    ['deeply/weirdly nested', deeplyWeird],
    ['a huge object', huge],
    ['an array of junk', [1, 'two', { three: 3 }, null]],
  ];

  for (const [label, raw] of CORPUS) {
    it(`${label} -> an array, never a throw, notes-or-empty only`, () => {
      for (const platform of ['claude-code', 'codex', 'cursor']) {
        const out = norm(raw, platform);
        // The design allows [] OR note events; nothing else, and never a throw.
        for (const ev of out) {
          assert.ok(ev && typeof ev === 'object', 'every emitted event is an object');
          assert.equal(ev.type, 'note', 'a degraded event from garbage must be a note, never a structural type');
        }
      }
    });
  }

  it('is total over the corpus (>= 6 shapes) for every platform without a single throw', () => {
    assert.ok(CORPUS.length >= 6, 'the fuzz corpus must have at least 6 shapes');
    for (const [, raw] of CORPUS) {
      for (const platform of ['claude-code', 'codex', 'cursor']) {
        assert.doesNotThrow(() => normalizeHookPayload(raw, platform));
      }
    }
  });
});
