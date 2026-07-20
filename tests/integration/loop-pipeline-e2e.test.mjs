import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFile as realExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as nodeFs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdLoop } from '../../core/src/commands/loop.mjs';
import { loadBundle, bundlePaths } from '../../core/src/bundle/store.mjs';
import { loadLoopState, loopPaths, LOOP_STATUS } from '../../core/src/loop/state.mjs';
import { teardownWorktrees } from '../../core/src/loop/worktrees.mjs';
import { dedupeKey } from '../../core/src/util/ids.mjs';

// ---------------------------------------------------------------------------
// RED/acceptance — real-fs, real-git end-to-end proofs for the Layer-2/3 loop &
// pipeline (subtask e2e-acceptance). Source: plan §"Acceptance constraints" 1–6.
// Units already cover the composition over memfs; these run the REAL git binary
// over mkdtemp repos with a real io (mirrors tests/integration/e2e-failover +
// loop-children-spawn). Children are in-process async fns injected via
// io.superviseChild — no real claude/codex needed; pipeline WRITERS do REAL git.
//
// These are the real-fs/real-git acceptance pins for constraints 1–6.
// ---------------------------------------------------------------------------

const SKIP_WIN = process.platform === 'win32';
const pexec = promisify(realExecFile);
const NAME = 'SakshamUboweja';
const EMAIL = 'ssakshamu@gmail.com';
const NOW = '2026-07-19T00:00:00.000Z';
const CC_LIMIT = "You've hit your session limit · resets 3pm"; // claude-code usage-limit signature
const CODEX_LIMIT = "You've hit your usage limit"; //            codex usage-limit signature

const tmpDirs = [];
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });
function mkTmp(prefix) { const d = mkdtempSync(join(tmpdir(), prefix)); tmpDirs.push(d); return d; }

function git(cwd, args, env) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

const CONFIG = {
  schema: 'baton/config@1',
  roles: {
    planner: ['codex/plan-m@xhigh'],
    // Two-platform chain so a limit failover can move claude-code -> codex (-> back).
    implementer: ['claude-code/cc-impl', 'codex/cx-impl@xhigh'],
    'test-author': ['codex/ta@xhigh'],
    'test-verifier': ['codex/tv@xhigh'],
    'plan-reviewer': ['codex/pr@xhigh'],
    'final-reviewer-a': ['codex/fra@xhigh'],
    'final-reviewer-b': ['codex/frb@xhigh'],
    // Pipeline seats — codex so worker/merger argv carry --model and merges FF.
    'worker-a': ['codex/wa@xhigh'],
    'worker-b': ['codex/wb@xhigh'],
    merger: ['codex/mg@xhigh'],
    'subtask-reviewer': ['codex/sr@xhigh'],
  },
  platforms: { 'claude-code': {}, codex: {}, cursor: {} },
  defaults: { 'claude-code': 'claude-fable-5', codex: 'gpt-5.6-sol', cursor: 'composer' },
};

/** A real git repo, sole-author config, one initial commit, gitignore seeded. */
function initRepo(prefix, spec) {
  // Canonicalize: git resolves worktree paths to their realpath (on macOS the
  // tmpdir is a /var -> /private/var symlink), so the repo root must be the
  // realpath too or `git worktree list` paths won't match worktreePaths().
  const cwd = nodeFs.realpathSync(mkTmp(prefix));
  git(cwd, ['init', '-q', '-b', 'main']);
  git(cwd, ['config', 'user.name', NAME]);
  git(cwd, ['config', 'user.email', EMAIL]);
  git(cwd, ['config', 'commit.gpgsign', 'false']);
  // Pre-seed BOTH ignore lines so setupWorktrees is a no-op (constraint 5: the
  // only tracked change would be the .worktrees/ line — pre-seeding removes it).
  nodeFs.writeFileSync(join(cwd, '.gitignore'), '.handoff/\n.worktrees/\n');
  nodeFs.writeFileSync(join(cwd, 'baton.config.json'), JSON.stringify(CONFIG, null, 2));
  nodeFs.writeFileSync(join(cwd, 'README.md'), '# demo\n');
  if (spec) nodeFs.writeFileSync(join(cwd, 'loop.json'), JSON.stringify(spec, null, 2) + '\n');
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-q', '-m', 'initial']);
  return cwd;
}

function makeRealIo(cwd, { superviseChild, now = NOW } = {}) {
  const out = [];
  const err = [];
  let tokenN = 0;
  return {
    cwd,
    env: { ...process.env },
    stdin: '',
    stdout: { write: (s) => (out.push(String(s)), true) },
    stderr: { write: (s) => (err.push(String(s)), true) },
    fs: nodeFs,
    execFile: (cmd, args = [], opts = {}) => pexec(cmd, args, { ...opts, encoding: 'utf8' }),
    now: () => now,
    host: 'e2e-host',
    pid: process.pid,
    startTime: Math.round(performance.timeOrigin),
    processAlive: (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return /** @type {any} */ (e).code === 'EPERM'; } },
    platform: process.platform,
    newFencingToken: () => `tok-${(tokenN += 1)}`,
    superviseChild,
    stdoutText: () => out.join(''),
    stderrText: () => err.join(''),
  };
}

const valAfter = (arr, flag) => { const i = arr.indexOf(flag); return i >= 0 ? arr[i + 1] : undefined; };
const mainLog = (cwd) => git(cwd, ['log', 'main', '--format=%an|%ae|%cn|%ce|%s']).trim().split('\n').filter(Boolean);
const historyFreezes = (cwd) => {
  const dir = bundlePaths(cwd).historyDir;
  if (!nodeFs.existsSync(dir)) return [];
  return nodeFs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => ({ name: n, data: JSON.parse(nodeFs.readFileSync(join(dir, n), 'utf8')) }));
};

// ===========================================================================
describe('e2e — pipeline over REAL git: two subtasks, real merges, no residue (constraints 3, 5)', () => {
  const pipeSpec = { schema: 'baton/loop@1', goal: 'e2e pipeline', constraints: [], budgets: { iterationCap: 5, perRoleTimeoutMin: 30, maxChildrenPerPhase: 10 }, subtasks: [{ id: 't1', title: 'first' }, { id: 't2', title: 'second' }] };

  // Writers (workspace-write) do REAL git commits in their seat worktree using
  // the identity the supervisor injected via the child env (childSpec.env);
  // reviewers + merger (read-only) just APPROVE.
  function realWriterRunner() {
    let n = 0;
    return async (childSpec, opts) => {
      const args = (childSpec.args ?? []).map(String);
      if (valAfter(args, '-s') === 'workspace-write') {
        const seat = valAfter(args, '-C');
        n += 1;
        nodeFs.writeFileSync(join(seat, `work-${n}.txt`), `change ${n}\n`);
        git(seat, ['add', '.']);
        git(seat, ['commit', '-q', '-m', `subtask change ${n}`], childSpec.env);
      }
      return { timedOut: false, exitCode: 0, verdict: 'APPROVED', findings: '', logPath: opts.logPath };
    };
  }

  // Wrap the REAL execFile so we can prove the supervisor scanned the exact
  // per-subtask ranges at merge time (finding 2 — no vacuous main..main).
  async function runPipeline(prefix) {
    const cwd = initRepo(prefix, pipeSpec);
    const io = makeRealIo(cwd, { superviseChild: realWriterRunner() });
    const gitLogRanges = [];
    const realExec = io.execFile;
    io.execFile = (cmd, args = [], opts = {}) => {
      if (cmd === 'git' && args[0] === 'log') {
        const range = args.find((a) => /\.\./.test(String(a)));
        if (range) gitLogRanges.push(String(range));
      }
      return realExec(cmd, args, opts);
    };
    const { run } = await import('../../core/src/cli.mjs');
    const code = await run(['pipeline', 'run'], io);
    return { cwd, io, code, gitLogRanges };
  }

  it('completes with two sole-author real merges on main; the merge-time attribution scan ran on each subtask range (constraint 3)', { skip: SKIP_WIN }, async () => {
    const { cwd, io, code, gitLogRanges } = await runPipeline('baton-e2e-pipe-');
    assert.equal(code, 0, `pipeline should complete; stderr: ${io.stderrText()}`);
    assert.equal((await loadLoopState(cwd, io)).state.status, LOOP_STATUS.DONE, 'the pipeline reached done');

    const subtaskCommits = mainLog(cwd).filter((l) => /subtask change/.test(l));
    assert.equal(subtaskCommits.length, 2, `both subtasks merged to main; got: ${JSON.stringify(mainLog(cwd))}`);
    for (const line of mainLog(cwd)) {
      const [an, ae, cn, ce] = line.split('|');
      assert.equal(an, NAME); assert.equal(ae, EMAIL);
      assert.equal(cn, NAME); assert.equal(ce, EMAIL);
    }
    assert.doesNotMatch(git(cwd, ['log', 'main', '--format=%B']), /co-authored-by|generated (with|by)|\u{1F916}/iu, 'no forbidden attribution on main');

    // The REAL merge gate scanned exactly the two per-subtask ranges (not main..main).
    assert.ok(gitLogRanges.includes('main..baton/wt-a/subtask-t1'), `merge scanned the subtask-t1 range; saw ${JSON.stringify(gitLogRanges)}`);
    assert.ok(gitLogRanges.includes('main..baton/wt-b/subtask-t2'), `merge scanned the subtask-t2 range; saw ${JSON.stringify(gitLogRanges)}`);
    assert.ok(!gitLogRanges.includes('main..main'), 'no vacuous main..main scan');

    assert.match(git(cwd, ['branch', '--list', 'baton/wt-*']), /baton\/wt-a\/|baton\/wt-b\//, 'wt-* branches existed during the run');
  });

  it('teardown + purge .handoff leaves a PLAIN git repo — no worktrees, no baton/wt-* branches; reviews/ is intended output (constraint 5)', { skip: SKIP_WIN }, async () => {
    const { cwd, io } = await runPipeline('baton-e2e-pipe-td-');

    // Positive (plan item 4b): each subtask gate wrote its review artifacts on
    // real fs — writer/reviewer/merger prompt + verdict under iteration-01.
    const runId = (await loadLoopState(cwd, io)).state.runId;
    for (const gate of ['subtask-t1-review', 'subtask-t2-review']) {
      const dir = join(cwd, 'reviews', runId, gate, 'iteration-01');
      for (const role of ['writer', 'reviewer', 'merger']) {
        assert.ok(nodeFs.existsSync(join(dir, `${role}.prompt.md`)), `${gate}/iteration-01/${role}.prompt.md exists`);
        assert.ok(nodeFs.existsSync(join(dir, `${role}.verdict.md`)), `${gate}/iteration-01/${role}.verdict.md exists`);
      }
    }

    await teardownWorktrees(cwd, io);
    rmSync(join(cwd, '.handoff'), { recursive: true, force: true });

    // Constraint 5's spirit is NO RUNTIME RESIDUE (no worktrees, no baton/wt-*
    // branches, nothing from .handoff). reviews/** is INTENDED permanent output —
    // the committed-tree review artifacts (plan item 4b), like the ones this repo
    // itself commits — so the only untracked paths legitimately sit under reviews/.
    const untracked = git(cwd, ['status', '--porcelain']).trim().split('\n').filter(Boolean);
    assert.ok(
      untracked.every((l) => l.slice(3).startsWith('reviews/')),
      `the only untracked residue is intended reviews/ output (plan item 4b); got ${JSON.stringify(untracked)}`,
    );
    // With the intended output removed too, the tree is genuinely PLAIN.
    rmSync(join(cwd, 'reviews'), { recursive: true, force: true });
    assert.equal(git(cwd, ['status', '--porcelain']).trim(), '', 'the working tree is clean once intended output is set aside');
    assert.equal(git(cwd, ['worktree', 'list', '--porcelain']).split('\n\n').filter(Boolean).length, 1, 'only the main worktree remains');
    // FINDING (constraint 5): teardown deletes only each worktree's CURRENT branch,
    // leaving orphaned baton/wt-*/base branches after seats switch to subtask
    // branches — residue. Constraint 5 requires a plain repo, so this must be [].
    assert.equal(git(cwd, ['branch', '--list', 'baton/wt-*']).trim(), '', 'no baton/wt-* branches remain');
  });
});

// ===========================================================================
describe('e2e — pipeline attribution NEGATIVE on real git (constraint 3 teeth)', () => {
  it('a foreign-author subtask commit is BLOCKED by the real attributionScan; the run parks; main has no subtask commit', { skip: SKIP_WIN }, async () => {
    const spec = { schema: 'baton/loop@1', goal: 'e2e attribution', constraints: [], budgets: { iterationCap: 5, perRoleTimeoutMin: 30, maxChildrenPerPhase: 10 }, subtasks: [{ id: 't1', title: 'first' }] };
    const cwd = initRepo('baton-e2e-attr-', spec);

    const superviseChild = async (childSpec, opts) => {
      const args = (childSpec.args ?? []).map(String);
      if (valAfter(args, '-s') === 'workspace-write') {
        const seat = valAfter(args, '-C');
        nodeFs.writeFileSync(join(seat, 'sneaky.txt'), 'x\n');
        git(seat, ['add', '.']);
        // A FOREIGN author slips in — the merge gate must catch it.
        git(seat, ['commit', '-q', '-m', 'sneaky change'], { GIT_AUTHOR_NAME: 'Someone Else', GIT_AUTHOR_EMAIL: 'else@example.com', GIT_COMMITTER_NAME: NAME, GIT_COMMITTER_EMAIL: EMAIL });
      }
      return { timedOut: false, exitCode: 0, verdict: 'APPROVED', findings: '', logPath: opts.logPath };
    };

    const io = makeRealIo(cwd, { superviseChild });
    const { run } = await import('../../core/src/cli.mjs');
    const code = await run(['pipeline', 'run'], io);
    assert.equal(code, 4, `a foreign-author commit parks the pipeline; stderr: ${io.stderrText()}`);
    assert.equal((await loadLoopState(cwd, io)).state.status, LOOP_STATUS.PARKED);
    assert.equal(mainLog(cwd).filter((l) => /sneaky/.test(l)).length, 0, 'the foreign commit never reached main');
  });
});

// ===========================================================================
describe('e2e — simulated limit death mid-subtask on real fs (constraint 2)', () => {
  const loopSpec = { schema: 'baton/loop@1', goal: 'e2e failover', constraints: [], budgets: { iterationCap: 5, perRoleTimeoutMin: 30, maxChildrenPerPhase: 10 }, phases: [{ id: 'p0', role: 'implementer' }, { id: 'p1', role: 'implementer' }] };

  // A scripted loop runner: returns the next result and writes its log so the
  // supervisor classifies the transcript from the child's LOG file.
  function scriptedRunner(script) {
    const queue = [...script];
    const calls = [];
    const fn = async (childSpec, opts) => {
      calls.push({ command: childSpec.command, args: (childSpec.args ?? []).map(String) });
      const r = queue.shift() ?? { verdict: 'APPROVED' };
      if (typeof r.logContent === 'string' && opts.logPath) {
        nodeFs.mkdirSync(opts.logPath.slice(0, opts.logPath.lastIndexOf('/')), { recursive: true });
        nodeFs.writeFileSync(opts.logPath, r.logContent);
      }
      return { timedOut: false, exitCode: r.exitCode ?? 0, verdict: r.verdict ?? 'APPROVED', findings: '', logPath: opts.logPath };
    };
    fn.calls = calls;
    return fn;
  }

  it('SINGLE limit death (A→B): seals usage-limit, receives onto the other platform, relaunches, completes', { skip: SKIP_WIN }, async () => {
    const cwd = initRepo('baton-e2e-limitA-', loopSpec);
    const runner = scriptedRunner([
      { verdict: 'BLOCKED', exitCode: 1, logContent: `implementing...\n${CC_LIMIT}\n` }, // claude-code child dies
      { verdict: 'APPROVED' }, // relaunched codex child succeeds
      { verdict: 'APPROVED' }, // phase 1
    ]);
    const io = makeRealIo(cwd, { superviseChild: runner });
    const code = await cmdLoop(['run'], io);
    assert.equal(code, 0, `single failover should complete; stderr: ${io.stderrText()}`);

    // A sealed finalize freeze with reasonClass usage-limit exists.
    const fin = historyFreezes(cwd).find((f) => /\.finalize\.json$/.test(f.name));
    assert.ok(fin && fin.data.handoff.status === 'sealed' && fin.data.handoff.reasonClass === 'usage-limit', 'the dead session was sealed usage-limit');

    // The bundle advanced a generation and is owned by the NEW platform.
    const live = loadBundle(cwd, io).bundle;
    assert.ok(live.generation >= 2, 'the receive opened a fresh generation');
    assert.notEqual(live.origin.platform, 'claude-code', 'ownership moved off the dead platform');

    // The second child ran on codex (the relaunch target).
    assert.equal(runner.calls[1].command, 'codex', 'the relaunched child ran on codex');
  });

  it('CHAINED A→B→A: the second death returns to the first platform and completes (constraint 2)', { skip: SKIP_WIN }, async () => {
    const cwd = initRepo('baton-e2e-limitAB A-'.replace(' ', ''), loopSpec);
    const runner = scriptedRunner([
      { verdict: 'BLOCKED', exitCode: 1, logContent: `try 1\n${CC_LIMIT}\n` }, // claude-code dies -> B
      { verdict: 'BLOCKED', exitCode: 1, logContent: `try 2\n${CODEX_LIMIT}\n` }, // codex dies -> back to A
      { verdict: 'APPROVED' }, // relaunched claude-code child succeeds
      { verdict: 'APPROVED' }, // phase 1
    ]);
    const io = makeRealIo(cwd, { superviseChild: runner });
    const code = await cmdLoop(['run'], io);
    // Constraint 2 requires chained A→B→A: after the second death the run must
    // resolve back to the first platform (the avoid list is per-failover).
    assert.equal(code, 0, `chained A→B→A must complete; stderr: ${io.stderrText()}`);
    const live = loadBundle(cwd, io).bundle;
    assert.ok(live.generation >= 3, 'two failovers opened a third generation');
    assert.equal(live.origin.platform, 'claude-code', 'the chain returned to the first platform (A→B→A)');
    assert.equal(runner.calls[2].command, 'claude', 'the third child ran back on claude-code');
  });
});

// ===========================================================================
describe('e2e — supervisor-death recovery via JOURNAL REPLAY on real fs (constraint 4)', () => {
  it('a stale snapshot + a phase-advance journal event past its seq (with a torn tail) + a dead lock -> replay resumes, only the remaining phase spawns', { skip: SKIP_WIN }, async () => {
    const spec = { schema: 'baton/loop@1', goal: 'e2e recovery', constraints: [], budgets: { iterationCap: 5, perRoleTimeoutMin: 30, maxChildrenPerPhase: 10 }, phases: [{ id: 'p0', role: 'implementer' }, { id: 'p1', role: 'implementer' }] };
    const cwd = initRepo('baton-e2e-recover-', spec);
    const p = loopPaths(cwd);
    nodeFs.mkdirSync(p.dir, { recursive: true });

    // STALE snapshot: phase 0 not yet advanced, journalSeq behind the journal.
    const staleSnapshot = {
      schema: 'baton/loop-state@1',
      runId: 'loop-crashed',
      goal: 'e2e recovery',
      phaseCount: 2,
      phaseIndex: 0, // the snapshot predates phase 0 completing
      iterations: {},
      status: 'running',
      parkReason: null,
      escalation: null,
      smokeApproval: null,
      createdAt: NOW,
      journalSeq: 0,
      // I3 reconciliation: a crashed post-fold run carries the stamp from init,
      // so the resume is not refused as unstamped legacy.
      flavor: 'loop',
      specDigest: dedupeKey(spec.phases),
    };
    nodeFs.writeFileSync(p.state, JSON.stringify(staleSnapshot, null, 2) + '\n');
    // JOURNAL ahead of the snapshot: a committed phase-advance (seq 1, > snapshot's
    // journalSeq 0) plus a TORN final line the tolerant reader must skip.
    nodeFs.writeFileSync(
      p.journal,
      JSON.stringify({ seq: 1, ts: NOW, type: 'phase-advance' }) + '\n' + '{"seq":2,"type":"phase-adv', // torn tail, no newline
    );
    // A DEAD supervisor lock (a never-existing pid) — the crash marker.
    nodeFs.writeFileSync(`${p.dir}/supervisor.lock`, JSON.stringify({ host: 'e2e-host', pid: 999999, startTime: 7, runId: 'loop-crashed' }));

    // Prove the fixture reconstructs mid-state via REPLAY, not a hand-written index:
    // the snapshot says phaseIndex 0, the journal advances it to 1.
    const io0 = makeRealIo(cwd);
    assert.equal((await loadLoopState(cwd, io0)).state.phaseIndex, 1, 'journal replay advances the stale snapshot to phase 1');

    // A fresh run reclaims the dead lock, replays to phase 1, and runs ONLY phase 1.
    const runner = (() => { const calls = []; const fn = async (s, o) => { calls.push(s.command); return { timedOut: false, exitCode: 0, verdict: 'APPROVED', findings: '', logPath: o.logPath }; }; fn.calls = calls; return fn; })();
    const io = makeRealIo(cwd, { superviseChild: runner });
    const code = await cmdLoop(['run'], io);
    assert.equal(code, 0, `the resumed run completes; stderr: ${io.stderrText()}`);
    assert.equal(runner.calls.length, 1, 'the journal-recovered phase 0 is NOT re-run — only phase 1 spawns a child');
    assert.equal((await loadLoopState(cwd, io)).state.status, LOOP_STATUS.DONE);
  });
});

// ===========================================================================
describe('e2e — loop leaves no residue (constraint 5, loop half)', () => {
  it('after a completed loop run, removing .handoff leaves git status clean', { skip: SKIP_WIN }, async () => {
    const spec = { schema: 'baton/loop@1', goal: 'e2e residue', constraints: [], budgets: { iterationCap: 5, perRoleTimeoutMin: 30, maxChildrenPerPhase: 10 }, phases: [{ id: 'p0', role: 'implementer' }] };
    const cwd = initRepo('baton-e2e-residue-', spec);
    const io = makeRealIo(cwd, { superviseChild: async (s, o) => ({ timedOut: false, exitCode: 0, verdict: 'APPROVED', findings: '', logPath: o.logPath }) });
    const code = await cmdLoop(['run'], io);
    assert.equal(code, 0, `the loop completes; stderr: ${io.stderrText()}`);

    // The loop wrote only under the gitignored .handoff/ tree.
    rmSync(join(cwd, '.handoff'), { recursive: true, force: true });
    assert.equal(git(cwd, ['status', '--porcelain']).trim(), '', 'no tracked residue after a loop run (.gitignore pre-seeded)');
  });
});
