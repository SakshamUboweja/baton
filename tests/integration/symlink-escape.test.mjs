import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile as realExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadBundle, writeSnapshot } from '../../core/src/bundle/store.mjs';
import { cmdCheckpoint } from '../../core/src/commands/checkpoint.mjs';
import { cmdPurgeTranscript } from '../../core/src/commands/purge-transcript.mjs';

// ---------------------------------------------------------------------------
// Gate-2 fix 6 (reviewer-a finding 6): real-filesystem escape tests. A
// symlinked .handoff (or any symlink inside it) must be refused everywhere —
// load, write, and the purge walk — so no baton operation ever reads or
// rewrites bytes outside the repository through a planted link.
// ---------------------------------------------------------------------------

const NOW = '2026-07-12T00:00:00.000Z';
const pexec = promisify(realExecFile);
const tmpDirs = [];

function mkTmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function makeRealIo(cwd, { stdin = '' } = {}) {
  const out = [];
  const err = [];
  let tokenN = 0;
  return {
    cwd,
    env: { ...process.env },
    stdin,
    stdout: { write: (s) => (out.push(String(s)), true) },
    stderr: { write: (s) => (err.push(String(s)), true) },
    fs: nodeFs,
    execFile: (cmd, args = [], opts = {}) => pexec(cmd, args, { ...opts, encoding: 'utf8' }),
    now: () => NOW,
    host: 'jail-host',
    pid: 4242,
    startTime: 111000,
    processAlive: (pid) => pid === 4242,
    newFencingToken: () => `jail-tok-${(tokenN += 1)}`,
    stdoutText: () => out.join(''),
    stderrText: () => err.join(''),
  };
}

const validBundle = () => ({
  schema: 'baton/bundle@1',
  bundleId: 'b_symlink000000',
  generation: 1,
  createdAt: NOW,
  updatedAt: NOW,
  origin: { platform: 'claude-code', model: 'm', sessionHint: null, unstable: false },
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
});

describe('symlinked .handoff directory', () => {
  it('loadBundle refuses it and checkpoint writes nothing through the link', async () => {
    const repo = mkTmp('baton-jail-repo-');
    const outside = mkTmp('baton-jail-outside-');
    mkdirSync(join(outside, 'victim'));
    writeFileSync(join(outside, 'victim', 'bundle.json'), JSON.stringify(validBundle(), null, 2) + '\n');
    symlinkSync(join(outside, 'victim'), join(repo, '.handoff'));

    const io = makeRealIo(repo);
    const r = loadBundle(repo, io);
    assert.equal(r.bundle, null, 'a linked tree must never load');
    assert.ok(r.warnings.some((w) => /symlink/i.test(w)), `warnings must name the symlink refusal: ${JSON.stringify(r.warnings)}`);

    const before = nodeFs.readdirSync(join(outside, 'victim')).sort();
    const event = JSON.stringify({ schema: 'baton/event@1', type: 'decision', payload: { summary: 'evil' } });
    const cio = makeRealIo(repo, { stdin: event });
    const code = await cmdCheckpoint(['--platform', 'claude-code', '--root', repo], cio);
    assert.equal(code, 0, 'hook-safety: soft refusal, exit 0');
    assert.match(cio.stderrText(), /symlink/i);
    assert.deepEqual(nodeFs.readdirSync(join(outside, 'victim')).sort(), before, 'nothing written through the link');
    const outsideBundle = JSON.parse(readFileSync(join(outside, 'victim', 'bundle.json'), 'utf8'));
    assert.equal(outsideBundle.decisions.length, 0, 'the outside bundle must be untouched');

    const strictIo = makeRealIo(repo, { stdin: event });
    assert.equal(await cmdCheckpoint(['--platform', 'claude-code', '--root', repo, '--strict'], strictIo), 1, '--strict turns the refusal hard');
  });

  it('writeSnapshot refuses a tree containing a symlinked entry', () => {
    const repo = mkTmp('baton-jail-write-');
    const outside = mkTmp('baton-jail-write-out-');
    writeFileSync(join(outside, 'target.json'), '{"transcript":"secret"}');
    mkdirSync(join(repo, '.handoff'));
    writeFileSync(join(repo, '.handoff', 'bundle.json'), JSON.stringify(validBundle(), null, 2) + '\n');
    symlinkSync(join(outside, 'target.json'), join(repo, '.handoff', 'planted.json'));

    const io = makeRealIo(repo);
    assert.throws(() => writeSnapshot(repo, validBundle(), io), /symlink/i);
  });
});

describe('symlinked file inside .handoff — purge walk', () => {
  it('purge-transcript refuses and the outside file keeps its bytes', async () => {
    const repo = mkTmp('baton-jail-purge-');
    const outside = mkTmp('baton-jail-purge-out-');
    const victim = join(outside, 'secrets.json');
    const victimBytes = JSON.stringify({ transcript: 'planted-secret-XYZ', keep: true }, null, 2);
    writeFileSync(victim, victimBytes);

    mkdirSync(join(repo, '.handoff'));
    const b = validBundle();
    writeFileSync(join(repo, '.handoff', 'bundle.json'), JSON.stringify(b, null, 2) + '\n');
    symlinkSync(victim, join(repo, '.handoff', 'linked.json'));

    const io = makeRealIo(repo);
    const code = await cmdPurgeTranscript(['--root', repo], io);
    assert.equal(code, 1, 'purge must refuse a tree with symlinks');
    assert.match(io.stderrText(), /symlink/i);
    assert.equal(readFileSync(victim, 'utf8'), victimBytes, 'the linked-to file must be byte-identical');
  });
});
