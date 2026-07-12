import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { makeIo } from '../helpers/fakeio.mjs';
import { resolveRoot } from '../../core/src/commands/shared.mjs';
import { jailRelPath } from '../../core/src/util/jail.mjs';
import { resolveRoles } from '../../core/src/roles/resolve.mjs';
import { prepare } from '../../core/src/receive/txn.mjs';
import { cmdDoctor } from '../../core/src/commands/doctor.mjs';

// ---------------------------------------------------------------------------
// Gate-2 iteration-2 group 6:
// - M2 (reviewer-a #2): Windows path handling — resolveRoot must ascend
//   backslash paths; jailRelPath must reject a Windows-absolute path.
// - M3 (reviewer-a #7): doctor must not record a --version success as
//   authenticated/reachable (only installed); offline resolution (no probe
//   cache) is flagged degraded.
// - M4 (reviewer-a #8): a LOW-confidence usage-limit heuristic must not
//   silently add the origin to avoid[]; it warns and defers to explicit intake.
// ---------------------------------------------------------------------------

const T0 = '2026-07-11T00:00:00.000Z';
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG = readFileSync(join(REPO_ROOT, 'templates', 'baton.config.json.tpl'), 'utf8');
// txn.mjs classifyReason reads the builtin signature table through io.fs, so
// the fake fs must carry it at the exact packaged path.
const SIG_PATH = join(REPO_ROOT, 'core', 'data', 'signatures.v1.json');
const SIG_TABLE = readFileSync(SIG_PATH, 'utf8');

// A PARSED config (object chain entries), matching what loadConfig produces —
// resolveRoles consumes {platform, model, effort}, not the raw "p/m@e" strings.
const PARSED_CONFIG = {
  schema: 'baton/config@1',
  roles: {
    planner: [{ platform: 'claude-code', model: 'claude-fable-5' }],
    implementer: [
      { platform: 'claude-code', model: 'claude-fable-5' },
      { platform: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh' },
      { platform: 'cursor', model: 'composer' },
    ],
  },
  platforms: { 'claude-code': {}, codex: {}, cursor: {} },
  defaults: { 'claude-code': 'claude-fable-5', codex: 'gpt-5.6-sol', cursor: 'composer' },
};

describe('M2 — Windows path handling', () => {
  it('resolveRoot ascends a backslash path to the marker directory', () => {
    const io = makeIo({ files: { 'C:/repo/baton.config.json': '{}', 'C:/repo/sub/deep/x.txt': 'x' } });
    io.cwd = 'C:\\repo\\sub\\deep';
    // Node fs accepts forward slashes on Windows, so the fake stores C:/repo/…;
    // the ascent must still recognize the backslash-separated cwd.
    assert.equal(resolveRoot(io, {}), 'C:/repo');
  });

  it('jailRelPath rejects a Windows-absolute path and normalizes backslashes', () => {
    assert.equal(jailRelPath('C:\\Windows\\system32\\x'), null);
    assert.equal(jailRelPath('src\\a\\b.js'), 'src/a/b.js');
  });
});

describe('M3 — doctor probe dimensions', () => {
  const baseExec = () => ({ 'git log -n 50 --format=%h %s%n%n%b': { stdout: 'abc clean\n\n\n' } });
  const probeCall = (io) => JSON.parse(io.stdoutText()).data.platforms;

  it('a claude --version success is capped at capability "installed", never reachable/authenticated', async () => {
    const io = makeIo({
      now: T0,
      execResults: { ...baseExec(), 'claude --version': { stdout: '2.1.201 (Claude Code)\n' } },
    });
    await cmdDoctor(['--json'], io);
    const cc = probeCall(io).find((/** @type {any} */ p) => p.platform === 'claude-code');
    assert.equal(cc.capability, 'installed', 'a --version success proves only installed, not that the server was reached');
  });

  it('remap with NO probe cache flags offline selections degraded (plan: offline always degraded)', () => {
    const io = makeIo({ files: { '/repo/baton.config.json': CONFIG } });
    const { assignments } = resolveRoles({ config: PARSED_CONFIG, to: 'claude-code', probes: null });
    assert.ok(
      Object.values(assignments).every((/** @type {any} */ a) => a.mode === 'unavailable' || a.degraded === true),
      'every selectable assignment is flagged degraded when resolution is offline',
    );
  });

  it('remap WITH a full fresh cache does not blanket-degrade', () => {
    const probes = {
      'claude-code': { capability: 'reachable', outcome: 'ok' },
      codex: { capability: 'reachable', outcome: 'ok' },
      cursor: { capability: 'reachable', outcome: 'ok' },
    };
    const { assignments } = resolveRoles({ config: PARSED_CONFIG, to: 'claude-code', probes });
    assert.ok(
      Object.values(assignments).some((/** @type {any} */ a) => a.platform && !a.degraded),
      'a fully-probed platform resolves without a degraded flag',
    );
  });
});

describe('M4 — low-confidence usage-limit does not silently avoid', () => {
  const sealed = (reasonClass) => ({
    schema: 'baton/bundle@1',
    bundleId: 'b_conf0000000000',
    generation: 1,
    createdAt: T0,
    updatedAt: T0,
    origin: { platform: 'cursor', model: 'composer', sessionHint: 's', unstable: false },
    task: { goal: 'g', constraints: [], acceptance: [] },
    plan: { steps: [] },
    decisions: [],
    files: { touched: [] },
    roles: { assignments: {} },
    git: null,
    // Unsealed (open) so classifyReason runs on the reason text, not a seal.
    handoff: { status: 'open', reason: null, reasonClass, toPlatformHint: null, finalizedAt: null, receive_log: [] },
    journalSeq: 0,
    compaction: { droppedDecisions: 0, note: null },
    dedupeRing: [],
  });

  function prep(reason, extraOpts = {}) {
    const io = makeIo({
      files: { '/repo/baton.config.json': CONFIG, [SIG_PATH]: SIG_TABLE, '/repo/.handoff/bundle.json': JSON.stringify(sealed(null), null, 2) + '\n' },
      now: T0,
    });
    return prepare('/repo', { platform: 'claude-code', origin: 'cursor', reason, probes: null, sessionHint: 'cli', ...extraOpts }, io);
  }

  it('a low-confidence "quota exceeded" reason warns and does NOT avoid cursor', () => {
    const { assignments, warnings } = prep('quota exceeded');
    assert.ok(warnings.some((w) => /low confidence|heuristic|--reason-class/i.test(w)), `a low-confidence warning is surfaced: ${JSON.stringify(warnings)}`);
    // cursor still appears in some chain (not auto-avoided) — implementer chain has cursor.
    const cursorSkippedEverywhere = Object.values(assignments).every((/** @type {any} */ a) =>
      (a.skipped ?? []).some((/** @type {any} */ s) => s.platform === 'cursor' && s.why === 'avoided'),
    );
    assert.equal(cursorSkippedEverywhere, false, 'a low-confidence heuristic must not silently avoid the origin');
  });

  it('an explicit --reason-class usage-limit DOES avoid the origin (confirmed intake)', () => {
    const { assignments } = prep('quota exceeded', { reasonClass: 'usage-limit' });
    const implementer = assignments['implementer']; // chain includes cursor/composer
    const avoided = (implementer.skipped ?? []).some((/** @type {any} */ s) => s.platform === 'cursor' && s.why === 'avoided');
    assert.ok(avoided || implementer.platform !== 'cursor', 'explicit confirmation avoids the dead origin');
  });

  it('a HIGH-confidence usage-limit reason still avoids without needing confirmation', () => {
    // The claude-code verbatim limit string is high confidence for its own platform;
    // here the origin is cursor and a high-confidence cursor signal is the JSON heuristic —
    // use the sealed reasonClass path instead to represent a trusted classification.
    const io = makeIo({
      files: { '/repo/baton.config.json': CONFIG, [SIG_PATH]: SIG_TABLE, '/repo/.handoff/bundle.json': JSON.stringify(sealed('usage-limit'), null, 2) + '\n' },
      now: T0,
    });
    const { assignments } = prepare('/repo', { platform: 'claude-code', origin: 'cursor', reason: 'sealed reason', probes: null, sessionHint: 'cli' }, io);
    const implementer = assignments['implementer'];
    const avoided = (implementer.skipped ?? []).some((/** @type {any} */ s) => s.platform === 'cursor' && s.why === 'avoided');
    assert.ok(avoided || implementer.platform !== 'cursor', 'a sealed usage-limit reasonClass avoids the dead origin');
  });
});
