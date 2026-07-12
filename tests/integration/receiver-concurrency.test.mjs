import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Gate-2 iteration-2 findings M7 (reviewer-a #13) + M5 (reviewer-a #10):
// genuinely CONCURRENT acceptance, not sequential. Two commit processes are
// released from one filesystem barrier against a single prepared receipt:
// exactly one transition must land (one generation bump, one receive_log
// entry), the loser rejected with state untouched. And two debounced
// afterFileEdit checkpoints released together must yield exactly one append.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const BATON = join(repoRoot, 'core', 'bin', 'baton.mjs');
const CHILD_TIMEOUT_MS = 30_000;

/** @type {string[]} */
const dirs = [];
const scratch = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const spawned = (script, args) =>
  new Promise((resolve) => {
    const child = spawn('node', [script, ...args]);
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const killer = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(killer);
      resolve({ code, signal, stdout, stderr });
    });
  });

async function until(pred, ms = 15_000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('barrier timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const NOW = '2026-07-12T00:00:00.000Z';
const sealed = () => ({
  schema: 'baton/bundle@1',
  bundleId: 'b_recvconc000000',
  generation: 1,
  createdAt: NOW,
  updatedAt: NOW,
  origin: { platform: 'claude-code', model: 'claude-fable-5', sessionHint: 's', unstable: false },
  task: { goal: 'ship', constraints: [], acceptance: [] },
  plan: { steps: [] },
  decisions: [],
  files: { touched: [] },
  roles: { assignments: {} },
  git: null,
  handoff: { status: 'sealed', reason: 'limits', reasonClass: 'usage-limit', toPlatformHint: null, finalizedAt: NOW, receive_log: [] },
  journalSeq: 0,
  compaction: { droppedDecisions: 0, note: null },
  dedupeRing: [],
});

describe('M7 — two commit processes race one receipt: exactly one wins', () => {
  it('one generation bump, one receive_log entry, loser rejected with state untouched', async () => {
    const root = scratch('baton-recvconc-');
    const barrier = scratch('baton-recvconc-barrier-');
    mkdirSync(join(root, '.handoff'), { recursive: true });
    writeFileSync(join(root, '.handoff', 'bundle.json'), JSON.stringify(sealed(), null, 2) + '\n');

    // Prepare once (read-only) to get the receipt token both contenders use.
    const prep = spawnSync('node', [BATON, 'receive', '--platform', 'codex', '--json', '--origin', 'claude-code', '--reason', 'limits', '--root', root], { encoding: 'utf8' });
    assert.equal(prep.status, 0, `prepare exits 0; stderr: ${prep.stderr}`);
    const token = JSON.parse(prep.stdout.trim().split('\n').pop()).data.token;
    assert.ok(token, 'a receipt token was minted');

    const commit = `
import { writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const [bin, root, token, idx, barrierDir] = process.argv.slice(2);
writeFileSync(barrierDir + '/ready-' + idx, '');
while (!existsSync(barrierDir + '/go')) { /* barrier */ }
const r = spawnSync('node', [bin, 'receive', '--platform', 'codex', '--commit', token, '--origin', 'claude-code', '--reason', 'limits', '--root', root], { encoding: 'utf8' });
writeFileSync(barrierDir + '/done-' + idx, JSON.stringify({ status: r.status }));
process.exit(r.status ?? 1);
`;
    const commitPath = join(barrier, 'commit.mjs');
    writeFileSync(commitPath, commit);

    const kids = [1, 2].map((i) => spawned(commitPath, [BATON, root, token, String(i), barrier]));
    await until(() => existsSync(join(barrier, 'ready-1')) && existsSync(join(barrier, 'ready-2')));
    writeFileSync(join(barrier, 'go'), '');
    const results = await Promise.all(kids);

    const codes = results.map((r) => r.code).sort();
    assert.deepEqual(codes, [0, 1], `exactly one commit succeeds and one is rejected; got ${JSON.stringify(codes)} (stderr: ${results.map((r) => r.stderr).join(' | ')})`);

    const bundle = JSON.parse(readFileSync(join(root, '.handoff', 'bundle.json'), 'utf8'));
    assert.equal(bundle.generation, 2, 'exactly one generation bump (no double transition)');
    assert.equal(bundle.handoff.status, 'open', 'the winner opened a fresh writable generation');
    assert.equal(bundle.origin.platform, 'codex', 'the winning receiver adopted ownership');
    // The archived received seal carries exactly one receive_log entry.
    const historyDir = join(root, '.handoff', 'history');
    const freezes = existsSync(historyDir) ? readdirSync(historyDir).filter((n) => n.endsWith('.receive.json')) : [];
    assert.equal(freezes.length, 1, 'exactly one receive archive was frozen to history');
  });
});

describe('M5 — two debounced afterFileEdit checkpoints race: exactly one appends', () => {
  it('the second, inside the window, is debounced away under the lock', async () => {
    const root = scratch('baton-debounce-conc-');
    const barrier = scratch('baton-debounce-conc-barrier-');

    const writer = `
import { writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const [bin, root, idx, barrierDir] = process.argv.slice(2);
const payload = JSON.stringify({ event: 'afterFileEdit', schema: 'baton/event@1', type: 'decision', payload: { summary: 'edit-' + idx }, sessionHint: 'deb-sess', unstable: false });
writeFileSync(barrierDir + '/ready-' + idx, '');
while (!existsSync(barrierDir + '/go')) { /* barrier */ }
const r = spawnSync('node', [bin, 'checkpoint', '--platform', 'cursor', '--debounce', '120', '--root', root], { input: payload, encoding: 'utf8' });
writeFileSync(barrierDir + '/done-' + idx, JSON.stringify({ status: r.status }));
process.exit(r.status ?? 1);
`;
    const writerPath = join(barrier, 'writer.mjs');
    writeFileSync(writerPath, writer);

    const kids = [1, 2].map((i) => spawned(writerPath, [BATON, root, String(i), barrier]));
    await until(() => existsSync(join(barrier, 'ready-1')) && existsSync(join(barrier, 'ready-2')));
    writeFileSync(join(barrier, 'go'), '');
    const results = await Promise.all(kids);
    for (const r of results) assert.equal(r.code, 0, `both exit 0 (hook-safe); signal ${r.signal}, stderr ${r.stderr}`);

    const journal = readFileSync(join(root, '.handoff', 'journal.ndjson'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l));
    const decisions = journal.filter((e) => e.type === 'decision');
    assert.equal(decisions.length, 1, `exactly one edit is checkpointed in the debounce window; got ${decisions.length}`);
  });
});
