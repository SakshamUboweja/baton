import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { makeIo } from '../helpers/fakeio.mjs';
import { cmdDoctor } from '../../core/src/commands/doctor.mjs';
import { cmdRemap } from '../../core/src/commands/remap.mjs';
import { cmdReceive } from '../../core/src/commands/receive.mjs';

// ---------------------------------------------------------------------------
// Gate-2 major 13 (reviewer-a finding 9 / reviewer-b findings 16+25): doctor
// gaps. Version floors (codex >= 0.144, cursor >= 2026.05) with the support
// claim capped at the TESTED versions; codex/cursor hook trust+canary states
// reported honestly; network-filesystem detection; and the probe cache
// actually CONSUMED — by remap's resolver and by receive, whose token already
// binds probesDigest (a cache change between prepare and commit is drift).
// ---------------------------------------------------------------------------

const T0 = '2026-07-11T00:00:00.000Z';
const here = dirname(fileURLToPath(import.meta.url));
const CONFIG = readFileSync(join(here, '..', '..', 'templates', 'baton.config.json.tpl'), 'utf8');

/** Doctor env: enough exec results that unrelated checks stay quiet. */
const baseExec = () => ({
  'git log -n 50 --format=%h %s%n%n%b': { stdout: 'abc1234 clean commit\n\n\n' },
});

const checksOf = (io) => JSON.parse(io.stdoutText()).data.checks;
const checkById = (io, id) => checksOf(io).find((/** @type {any} */ c) => c.id === id);

describe('doctor — version floors and tested-version cap', () => {
  it('codex below the 0.144 floor fails with a protocol-only degradation note', async () => {
    const io = makeIo({
      now: T0,
      execResults: { ...baseExec(), 'codex --version': { stdout: 'codex-cli 0.100.0\n' } },
    });
    await cmdDoctor(['--json'], io);
    const c = checkById(io, 'version-codex');
    assert.ok(c, 'a version-codex check exists');
    assert.equal(c.ok, false);
    assert.match(c.detail, /0\.144/);
    assert.match(c.detail, /protocol-only|Tier C/i);
  });

  it('cursor newer than tested stays ok with an explicit untested info line', async () => {
    const io = makeIo({
      now: T0,
      execResults: { ...baseExec(), 'cursor-agent --version': { stdout: '2027.01.00-abcdef\n' } },
    });
    await cmdDoctor(['--json'], io);
    const c = checkById(io, 'version-cursor');
    assert.equal(c.ok, true);
    assert.match(c.detail, /newer than tested/i);
  });

  it('an unprobeable version never fails the check', async () => {
    const io = makeIo({ now: T0, execResults: baseExec() });
    await cmdDoctor(['--json'], io);
    for (const id of ['version-claude-code', 'version-codex', 'version-cursor']) {
      const c = checkById(io, id);
      assert.ok(c, `${id} exists`);
      assert.equal(c.ok, true, `${id} must not fail when the binary is absent`);
      assert.match(c.detail, /unverifiable|not installed|unknown/i);
    }
  });
});

describe('doctor — codex/cursor hook trust + canary states', () => {
  const HOOKS = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'baton checkpoint --platform codex' }] }] } });

  it('not installed: named, with the init pointer', async () => {
    const io = makeIo({ now: T0, execResults: baseExec() });
    await cmdDoctor(['--json'], io);
    const c = checkById(io, 'codex-hooks');
    assert.ok(c);
    assert.match(c.detail, /not installed/i);
    assert.match(c.detail, /init --codex/);
  });

  it('installed but never observed executing: fidelity claim gated on the canary', async () => {
    const io = makeIo({ now: T0, execResults: baseExec(), files: { '/repo/.codex/hooks.json': HOOKS } });
    await cmdDoctor(['--json'], io);
    const c = checkById(io, 'codex-hooks');
    assert.match(c.detail, /installed/i);
    assert.match(c.detail, /not.*observed|pending|gated/i);
    assert.match(c.detail, /trust|\/hooks/i);
  });

  it('journal evidence of a codex-sourced event flips the canary to observed', async () => {
    const entry = JSON.stringify({ seq: 1, ts: T0, type: 'note', dedupeKey: 'k1', source: 'codex', payload: { text: 'hook Stop observed on codex' } });
    const io = makeIo({
      now: T0,
      execResults: baseExec(),
      files: { '/repo/.codex/hooks.json': HOOKS, '/repo/.handoff/journal.ndjson': entry + '\n' },
    });
    await cmdDoctor(['--json'], io);
    assert.match(checkById(io, 'codex-hooks').detail, /observed/i);
  });

  it('cursor check exists and names the trusted-workspace requirement', async () => {
    const io = makeIo({
      now: T0,
      execResults: baseExec(),
      files: { '/repo/.cursor/hooks.json': JSON.stringify({ version: 1, hooks: { stop: [{ command: 'baton checkpoint --platform cursor' }] } }) },
    });
    await cmdDoctor(['--json'], io);
    assert.match(checkById(io, 'cursor-hooks').detail, /trusted workspace/i);
  });
});

describe('doctor — network filesystem detection', () => {
  it('an SMB/NFS-looking mount source fails the filesystem check', async () => {
    const io = makeIo({
      now: T0,
      execResults: {
        ...baseExec(),
        'df -P /repo': { stdout: 'Filesystem 512-blocks Used Available Capacity Mounted on\n//user@server/share 100 1 99 1% /repo\n' },
      },
    });
    await cmdDoctor(['--json'], io);
    const c = checkById(io, 'filesystem');
    assert.equal(c.ok, false);
    assert.match(c.detail, /network/i);
  });

  it('a local mount stays ok; df unavailability degrades to the static boundary note', async () => {
    const local = makeIo({
      now: T0,
      execResults: { ...baseExec(), 'df -P /repo': { stdout: 'Filesystem 512-blocks Used Available Capacity Mounted on\n/dev/disk3s5 100 1 99 1% /\n' } },
    });
    await cmdDoctor(['--json'], local);
    assert.equal(checkById(local, 'filesystem').ok, true);

    const unknown = makeIo({ now: T0, execResults: baseExec() });
    await cmdDoctor(['--json'], unknown);
    const c = checkById(unknown, 'filesystem');
    assert.equal(c.ok, true);
    assert.match(c.detail, /local filesystems only/i);
  });
});

describe('probe cache is consumed, not decorative', () => {
  const cache = (outcome) =>
    JSON.stringify({
      at: T0,
      records: [
        { platform: 'claude-code', capability: 'reachable', outcome: 'ok' },
        { platform: 'codex', capability: 'authenticated', outcome },
        { platform: 'cursor', capability: 'reachable', outcome: 'ok' },
      ],
    });

  it('remap skips a rate-limited platform from the fresh cache, audited in skipped[]', () => {
    const io = makeIo({
      now: T0,
      files: { '/repo/baton.config.json': CONFIG, '/repo/.handoff/log/probe-cache.json': cache('rate-limited') },
    });
    assert.equal(cmdRemap(['--to', 'codex', '--json'], io), 0);
    const { assignments } = JSON.parse(io.stdoutText()).data;
    const a = assignments['plan-reviewer']; // chain: codex first, claude-code second
    assert.notEqual(a.platform, 'codex', 'the rate-limited platform is not selected');
    assert.ok(
      a.skipped.some((/** @type {any} */ s) => s.platform === 'codex' && s.why === 'rate-limited'),
      `the skip is audited: ${JSON.stringify(a.skipped)}`,
    );
  });

  it('a probe-cache change between prepare and commit is token drift (rejected, re-prepare required)', async () => {
    const sealed = {
      schema: 'baton/bundle@1',
      bundleId: 'b_probe00000000',
      generation: 1,
      createdAt: T0,
      updatedAt: T0,
      origin: { platform: 'claude-code', model: 'm', sessionHint: 'sess-1', unstable: false },
      task: { goal: 'g', constraints: [], acceptance: [] },
      plan: { steps: [] },
      decisions: [],
      files: { touched: [] },
      roles: { assignments: {} },
      git: null,
      handoff: { status: 'sealed', reason: 'limits', reasonClass: 'usage-limit', toPlatformHint: null, finalizedAt: T0, receive_log: [] },
      journalSeq: 0,
      compaction: { droppedDecisions: 0, note: null },
      dedupeRing: [],
    };
    const files = {
      '/repo/baton.config.json': CONFIG,
      '/repo/.handoff/bundle.json': JSON.stringify(sealed, null, 2) + '\n',
      '/repo/.handoff/log/probe-cache.json': cache('ok'),
    };
    const io = makeIo({ now: T0, files });
    assert.equal(await cmdReceive(['--platform', 'codex', '--json'], io), 0);
    const token = JSON.parse(io.stdoutText()).data.token;

    io.fs.writeFileSync('/repo/.handoff/log/probe-cache.json', cache('rate-limited'));
    const code = await cmdReceive(['--platform', 'codex', '--commit', token, '--json'], io);
    assert.equal(code, 1, 'the probe snapshot is BOUND into the token — drift rejects the commit');
    const out = io.stdoutText().trim().split('\n');
    const env = JSON.parse(out[out.length - 1]);
    assert.match(env.error.msg, /stale|drift|re-?prepare/i);
  });
});
