import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeIo } from '../helpers/fakeio.mjs';
import { run } from '../../core/src/cli.mjs';

// ---------------------------------------------------------------------------
// RED — `baton loop init` command (subtask loop-spec, part B). Source of truth:
// docs/plans/2026-07-18-goal-loop-worktree-pipeline.md §"baton loop"; mirrors
// the two-phase / idempotent / strict-flag discipline of `baton init`
// (core/src/commands/init.mjs) and the guard-test history-spy idiom.
//
// SURFACE: driven through the real cli router run(argv, io) — the plan requires
// `loop` be routed via cli.mjs. Today `loop` is not a known command, so run()
// returns exit 2 ("unknown command 'loop'"); the target-behavior assertions
// below therefore red for the right reason (command absent / not wired).
//
// CONTRACT PINNED HERE:
//   - `baton loop` (no subcommand) -> usage error exit 2 (names the missing
//     subcommand, not "unknown command 'loop'").
//   - unknown subcommand -> exit 2 NAMING it.
//   - `loop init` with no goal -> usage error exit 2 (names 'goal').
//   - `loop init "<goal>"` -> writes loop.json at the resolved root (honors
//     --root) = exactly defaultLoopSpec(goal); prints a summary; exit 0.
//     --json -> one envelope data {created:true, path}.
//   - --dry-run: prints the plan, writes NOTHING (history spy).
//   - idempotent: existing loop.json -> NO overwrite, exit 0, data {created:false},
//     existing bytes untouched.
//   - strict flags: stray positional beyond goal / unknown flag -> exit 2.
//   - the supervised-child guard does NOT apply (loop is supervisor-side):
//     BATON_SUPERVISED_CHILD set + `loop init` still writes, exit 0.
// ---------------------------------------------------------------------------

const LOOP_JSON = '/repo/loop.json';

/** stdout must be exactly one parseable envelope line. */
function theEnvelope(io) {
  const out = io.stdoutText().trim();
  const lines = out === '' ? [] : out.split('\n');
  assert.equal(lines.length, 1, `expected exactly one stdout line, got: ${JSON.stringify(io.stdoutText())}`);
  const env = JSON.parse(lines[0]);
  for (const k of ['ok', 'data', 'warnings', 'error']) assert.ok(k in env, `envelope carries ${k}`);
  return env;
}

// Dynamic import of the spec module so the "exactly defaultLoopSpec" test pins
// byte-equality once the module exists (red today: module + command both absent).
let specMod = /** @type {any} */ (null);
try {
  specMod = await import('../../core/src/loop/spec.mjs');
} catch {
  specMod = null;
}

// ===========================================================================
describe('baton loop — subcommand dispatch', () => {
  it('RED: no subcommand is a usage error (exit 2) that names the missing subcommand', async () => {
    const io = makeIo({});
    const code = await run(['loop'], io);
    assert.equal(code, 2);
    const out = io.stderrText() + io.stdoutText();
    assert.match(out, /subcommand|init/i, 'the error guides the user to a subcommand');
    assert.doesNotMatch(out, /unknown command/i, 'loop IS a known command — the error is about a missing subcommand, not an unknown command');
  });

  it('RED: an unknown subcommand exits 2 naming it', async () => {
    const io = makeIo({});
    const code = await run(['loop', 'frobnicate'], io);
    assert.equal(code, 2);
    assert.match(io.stderrText() + io.stdoutText(), /frobnicate/, 'the error names the bad subcommand');
  });
});

// ===========================================================================
describe('baton loop init — goal required', () => {
  it('RED: no goal is a usage error (exit 2) naming the goal', async () => {
    const io = makeIo({});
    const code = await run(['loop', 'init'], io);
    assert.equal(code, 2);
    assert.match(io.stderrText() + io.stdoutText(), /goal/i, 'the error names the missing goal');
  });
});

// ===========================================================================
describe('baton loop init — writes the scaffold', () => {
  it('RED: `loop init "Ship X"` writes loop.json (schema + goal) and exits 0 with a summary', async () => {
    const io = makeIo({});
    const code = await run(['loop', 'init', 'Ship X'], io);
    assert.equal(code, 0);
    const raw = io.files()[LOOP_JSON];
    assert.ok(raw, 'loop.json is written at the resolved root');
    const spec = JSON.parse(raw);
    assert.equal(spec.schema, 'baton/loop@1');
    assert.equal(spec.goal, 'Ship X');
    assert.ok(io.stdoutText().length > 0, 'a human summary is printed');
  });

  it('RED: the written loop.json is exactly defaultLoopSpec(goal)', async () => {
    assert.ok(specMod, 'core/src/loop/spec.mjs must exist to pin byte-equality');
    const io = makeIo({});
    await run(['loop', 'init', 'Ship X'], io);
    const raw = io.files()[LOOP_JSON];
    assert.ok(raw, 'loop.json is written');
    assert.deepEqual(JSON.parse(raw), specMod.defaultLoopSpec('Ship X'), 'the file content equals defaultLoopSpec(goal)');
  });

  it('RED: --json emits one envelope with data {created:true, path} AND writes defaultLoopSpec(goal)', async () => {
    assert.ok(specMod, 'core/src/loop/spec.mjs must exist to pin the written content');
    const io = makeIo({});
    const code = await run(['loop', 'init', 'Ship X', '--json'], io);
    assert.equal(code, 0);
    const env = theEnvelope(io);
    assert.equal(env.ok, true);
    assert.equal(env.data.created, true);
    assert.equal(env.data.path, LOOP_JSON);
    // The envelope's success must correspond to a real file equal to the scaffold.
    const raw = io.files()[LOOP_JSON];
    assert.ok(raw, 'loop.json exists on disk, not just claimed in the envelope');
    assert.deepEqual(JSON.parse(raw), specMod.defaultLoopSpec('Ship X'), 'the written content is exactly defaultLoopSpec(goal)');
  });

  it('RED: a LEADING global --json honors the same envelope contract as a trailing one', async () => {
    const io = makeIo({});
    const code = await run(['--json', 'loop', 'init', 'Ship X'], io);
    assert.equal(code, 0);
    const env = theEnvelope(io);
    assert.equal(env.ok, true);
    assert.equal(env.data.created, true);
    assert.equal(env.data.path, LOOP_JSON);
  });

  it('RED: honors --root (writes loop.json under the given root)', async () => {
    const io = makeIo({ files: { '/sub/.keep': 'x' } });
    const code = await run(['loop', 'init', 'Ship X', '--root', '/sub'], io);
    assert.equal(code, 0);
    assert.ok(io.files()['/sub/loop.json'], 'loop.json lands under --root');
    assert.ok(!io.files()[LOOP_JSON], 'and NOT at the cwd root');
  });
});

// ===========================================================================
describe('baton loop init — two-phase discipline (--dry-run writes nothing)', () => {
  it('RED: --dry-run prints the plan and writes NO file', async () => {
    const io = makeIo({});
    const code = await run(['loop', 'init', 'Ship X', '--dry-run'], io);
    assert.equal(code, 0, 'dry-run still succeeds');
    assert.ok(!io.files()[LOOP_JSON], 'no loop.json is written on a dry run');
    assert.equal(io.fs.__history.length, 0, 'the memfs is byte-identical after a dry run');
    assert.match(io.stdoutText(), /loop\.json|plan|dry/i, 'the plan is shown');
  });
});

// ===========================================================================
describe('baton loop init — idempotent (no overwrite)', () => {
  it('RED: an existing loop.json is left untouched; exit 0, data {created:false}, ZERO write/rename/unlink of loop.json', async () => {
    const SENTINEL = '{"existing":"do-not-touch"}\n';
    const io = makeIo({ files: { [LOOP_JSON]: SENTINEL } });
    // Capture the exact pre-state (kills a write-then-restore: files() alone
    // would look identical, so also assert NO mutating op touched loop.json).
    const filesBefore = io.files();
    const historyLenBefore = io.fs.__history.length;

    const code = await run(['loop', 'init', 'Ship X', '--json'], io);
    assert.equal(code, 0, 'a pre-existing scaffold is not an error');
    const env = theEnvelope(io);
    assert.equal(env.data.created, false, 'nothing new was created');

    assert.deepEqual(io.files(), filesBefore, 'the whole tree is byte-identical afterward');
    const MUTATORS = new Set(['writeFileSync', 'appendFileSync', 'renameSync', 'unlinkSync', 'rmSync', 'copyFileSync']);
    const touchedLoopJson = io.fs.__history
      .slice(historyLenBefore)
      .some((h) => MUTATORS.has(h.op) && h.paths.some((p) => String(p) === LOOP_JSON));
    assert.equal(touchedLoopJson, false, 'no write/rename/unlink ever touched loop.json (not even write-then-restore)');
  });
});

// ===========================================================================
describe('baton loop init — strict flags', () => {
  it('RED: a stray positional beyond the goal exits 2', async () => {
    const io = makeIo({});
    const code = await run(['loop', 'init', 'Ship X', 'extra-positional'], io);
    assert.equal(code, 2);
    assert.match(io.stderrText() + io.stdoutText(), /unexpected|argument|extra-positional/i, 'the strict parser names the stray token (not a generic unknown-command)');
  });

  it('RED: an unknown flag exits 2 naming it', async () => {
    const io = makeIo({});
    const code = await run(['loop', 'init', 'Ship X', '--no-such-flag'], io);
    assert.equal(code, 2);
    assert.match(io.stderrText() + io.stdoutText(), /unknown flag|--no-such-flag/i);
  });
});

// ===========================================================================
describe('baton loop init — supervised-child guard does NOT apply', () => {
  it('RED: BATON_SUPERVISED_CHILD set still writes loop.json and exits 0 (supervisor-side command)', async () => {
    const io = makeIo({ env: { BATON_SUPERVISED_CHILD: '1' } });
    const code = await run(['loop', 'init', 'Ship X'], io);
    assert.equal(code, 0, 'loop is a supervisor command — the child guard must not silence it');
    assert.ok(io.files()[LOOP_JSON], 'loop.json is written even under the guard env');
  });
});
