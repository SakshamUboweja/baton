/**
 * `baton pipeline run` — the Layer-3 dual-worktree preset over the loop
 * engine. Subtasks alternate writer seats (index 0 → wt-a/worker-a, 1 →
 * wt-b/worker-b, …); the reviewer runs READ-ONLY from the OTHER seat with
 * that seat's worker model under the subtask-reviewer role; the merger child
 * (read-only) adversarially re-checks, and on its APPROVED the SUPERVISOR
 * merges through worktrees.mergeSubtask (attribution-gated, locked, ff-only
 * seat syncs). Plan: docs/plans/2026-07-18-goal-loop-worktree-pipeline.md
 * §"baton pipeline (Layer 3 — a loop preset)".
 */
import {
  loopPaths,
  initLoopState,
  applyLoopEvent,
  writeLoopState,
  appendLoopEvent,
  smokeApprovalToken,
  verifySmokeToken,
  LOOP_EVENT,
  LOOP_STATUS,
} from '../loop/state.mjs';
import { atomicWriteJson } from '../util/fsx.mjs';
import { snapshot as gitSnapshot } from '../git/snapshot.mjs';
import { buildChildArgv, superviseChild } from '../loop/children.mjs';
import { setupWorktrees, preflightWorktree, postflightWorktree, mergeSubtask, selfHealWorktree, worktreePaths } from '../loop/worktrees.mjs';
import { resolveRoles } from '../roles/resolve.mjs';
import { readProbeCache } from '../roles/availability.mjs';
import { loadConfig } from '../roles/matrix.mjs';
import { runFailover } from '../loop/failover.mjs';
import { loadSignatures } from '../detect/signatures.mjs';
import { classify, transcriptTail } from '../detect/classifier.mjs';
import { atomicWriteText, ensureDir, safeReadJson } from '../util/fsx.mjs';
import { appendEntry } from '../util/jsonl.mjs';
import { dedupeKey } from '../util/ids.mjs';
import { emitEnvelope, usageError, parseFlagsStrict, resolveRoot } from './shared.mjs';
import { acquireSupervisorLock, detachSupervisor } from './loop.mjs';
import { loadLoopState } from '../loop/state.mjs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const BUILTIN_SIGNATURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'signatures.v1.json');

const STRING_FLAGS = new Set(['root', 'approve-smoke']);
const EXIT_ESCALATED = 3;
const EXIT_PARKED = 4;

/** @param {any} g */
const gitHeadOf = (g) => g?.headSha ?? 'none';
/** @param {any} g */
const gitContentOf = (g) => g?.contentDigest ?? dedupeKey(g ?? null);

/**
 * @param {string[]} args @param {any} io
 * @returns {Promise<number>}
 */
export async function cmdPipeline(args, io) {
  /** @type {string[]} */
  const positionals = [];
  /** @type {string[]} */
  const flagTokens = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (typeof a === 'string' && a.startsWith('--')) {
      flagTokens.push(a);
      if (STRING_FLAGS.has(a.slice(2)) && i + 1 < args.length) {
        i += 1;
        flagTokens.push(args[i]);
      }
    } else {
      positionals.push(a);
    }
  }
  const parsed = parseFlagsStrict(flagTokens, { 'approve-smoke': 'string', detach: 'boolean' });
  if (parsed.error !== undefined) return usageError(io, parsed.flags, 'pipeline', parsed.error);
  const flags = parsed.flags;

  const sub = positionals[0];
  if (sub === undefined) return usageError(io, flags, 'pipeline', 'a subcommand is required — try: baton pipeline run');
  if (sub !== 'run' && sub !== 'resume') return usageError(io, flags, 'pipeline', `unknown subcommand '${sub}' (supported: run, resume)`);
  if (positionals.length > 1) return usageError(io, flags, 'pipeline', `unexpected argument '${positionals[1]}'`);
  if (flags['approve-smoke'] === '') return usageError(io, flags, 'pipeline', '--approve-smoke requires a value (the token from smoke-approval.json)');
  if (sub === 'resume') flags.__resume = true;
  // --detach: same POSIX background-supervisor path as `loop run` (v1.1 item
  // 10), sharing the lock precheck/reclaim contract.
  if (flags.detach === true && process.platform !== 'win32') {
    return detachSupervisor(resolveRoot(io, flags), io, { cmdLabel: 'pipeline run', batonArgs: ['pipeline', sub] });
  }
  if (flags.detach === true) io.stderr.write('baton pipeline run: --detach is POSIX-only; running attached on this platform\n');

  return runPipeline(flags, io);
}

/**
 * Derive the repo's trunk branch EXACTLY ONCE per run: origin's HEAD when it
 * exists, else the currently checked-out branch at the root. The result is
 * stamped into state and reused on every resume — never re-derived mid-run.
 * @param {string} root @param {any} io
 * @returns {Promise<string>}
 */
async function deriveTrunk(root, io) {
  try {
    const out = String((await io.execFile('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], { cwd: root })).stdout).trim();
    const m = out.match(/refs\/remotes\/origin\/(.+)$/);
    if (m?.[1]) return m[1];
  } catch {
    // No origin HEAD (local-only repo) — fall back to the checked-out branch.
  }
  const branch = String((await io.execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root })).stdout).trim();
  return branch.length > 0 && branch !== 'HEAD' ? branch : 'main';
}

/** Validate the spec's subtasks — every rejection names its offender.
 * @param {any} subtasks @returns {string | null} */
function validateSubtasks(subtasks) {
  if (!Array.isArray(subtasks) || subtasks.length === 0) {
    return 'loop.json needs a non-empty `subtasks` array ([{id, title}]) for a pipeline run';
  }
  const seen = new Set();
  for (let i = 0; i < subtasks.length; i += 1) {
    const st = subtasks[i];
    if (typeof st?.id !== 'string' || st.id.length === 0) return `subtasks[${i}] is missing a string id`;
    if (typeof st?.title !== 'string' || st.title.length === 0) return `subtasks[${i}] ('${st.id}') is missing a string title`;
    if (seen.has(st.id)) return `subtasks carry a duplicate id '${st.id}' — ids name branches and must be unique`;
    seen.add(st.id);
  }
  return null;
}

/**
 * @param {Record<string, string | boolean>} flags @param {any} io
 * @returns {Promise<number>}
 */
async function runPipeline(flags, io) {
  const root = resolveRoot(io, flags);
  const p = loopPaths(root);

  const rawSpec = safeReadJson(io.fs, `${root}/loop.json`);
  if (!rawSpec.ok) return usageError(io, flags, 'pipeline', `no loop.json at ${root} — scaffold one with: baton loop init "<goal>"`);
  const spec = rawSpec.value;
  const subtaskError = validateSubtasks(spec?.subtasks);
  if (subtaskError !== null) return usageError(io, flags, 'pipeline', subtaskError);
  const { config } = loadConfig(root, io);
  if (!config) return usageError(io, flags, 'pipeline', `no readable baton.config.json at ${root} — the role matrix is required`);
  // The 5-iteration cap is a hard invariant (Gate-2 fold G2): a spec asking
  // for more is rejected BEFORE anything spawns.
  const rawCap = spec?.budgets?.iterationCap;
  if (rawCap !== undefined && (typeof rawCap !== 'number' || rawCap < 1 || rawCap > 5)) {
    return usageError(io, flags, 'pipeline', `budgets.iterationCap must be a number between 1 and 5 (the 5-iteration cap is a hard invariant; got ${JSON.stringify(rawCap)})`);
  }
  const cap = typeof rawCap === 'number' ? rawCap : 5;
  const timeoutMs = (typeof spec?.budgets?.perRoleTimeoutMin === 'number' ? spec.budgets.perRoleTimeoutMin : 30) * 60_000;

  // One supervisor at a time — the same atomic run lock as `loop run`, with
  // dead-owner reclaim + orphan reaping (Gate-2 fold G2/B8).
  const lock = await acquireSupervisorLock(root, io, 'pipeline run');
  if (lock.ok !== true) return lock.code;
  try {
    return await drivePipeline(flags, io, { root, p, spec, config, cap, timeoutMs, probes: readProbeCache(root, io) });
  } finally {
    lock.release();
  }
}

/**
 * @param {Record<string, string | boolean>} flags @param {any} io
 * @param {{root: string, p: any, spec: any, config: any, cap: number, timeoutMs: number, probes: any}} ctx
 * @returns {Promise<number>}
 */
async function drivePipeline(flags, io, { root, p, spec, config, cap, timeoutMs, probes }) {
  const table = loadSignatures({ builtinPath: BUILTIN_SIGNATURES }, io);
  /** @param {string} role @param {Array<{platform: string, model: string}>} [avoidEntries] @returns {any | null} */
  const resolveOne = (role, avoidEntries = []) => {
    const a = resolveRoles({ config, to: 'claude-code', avoid: [], avoidEntries, probes }).assignments[role];
    return a && a.mode !== 'unavailable' ? a : null;
  };

  // The synthesized phase list makes the loop state machine (phase count,
  // done detection, journal replay) work unchanged for the subtask cycle.
  const subtasks = spec.subtasks;
  const stateSpec = {
    goal: spec.goal,
    phases: subtasks.map((/** @type {any} */ st, /** @type {number} */ i) => ({ id: `subtask-${st.id}`, role: `worker-${i % 2 === 0 ? 'a' : 'b'}` })),
  };
  // RESUME, never re-init: a prior run's cap counters and position survive a
  // re-invocation (Gate-2 fold G2 — no cap refunds). The state is stamped
  // {flavor, specDigest} so a cross-flavor or changed-spec resume refuses
  // instead of misaligning (H5).
  const specDigest = dedupeKey(subtasks);
  /** @type {any} */
  let state = (await loadLoopState(root, io)).state;
  if (state === null) {
    // A resume with nothing persisted is a wrong-directory mistake, not a
    // fresh run — refusing beats silently initializing and running (N2).
    if (flags.__resume === true) {
      return usageError(io, flags, 'pipeline', 'nothing to resume — no run state exists here; start with: baton pipeline run');
    }
    state = { ...initLoopState(stateSpec, io), flavor: 'pipeline', specDigest, trunk: await deriveTrunk(root, io) };
    await writeLoopState(root, state, io);
  } else {
    if (typeof state.flavor === 'string' && state.flavor !== 'pipeline') {
      return usageError(io, flags, 'pipeline', `the persisted run state is flavor '${state.flavor}' — a ${state.flavor} run cannot be resumed as a pipeline (flavor mismatch); archive .handoff/loop or finish the ${state.flavor} run first`);
    }
    // A missing stamp is a mismatch, not a grandfathered pass — pre-stamp
    // legacy state resumes with exactly the misalignment H5 prevents (I3).
    if (typeof state.flavor !== 'string' || typeof state.specDigest !== 'string') {
      return usageError(io, flags, 'pipeline', 'the persisted run state is missing its {flavor, specDigest} stamp (pre-stamp legacy state) — resuming it could misalign the run; archive .handoff/loop to start fresh');
    }
    if (state.specDigest !== specDigest) {
      return usageError(io, flags, 'pipeline', 'the subtasks list changed since this run started (spec digest mismatch) — resuming would misalign the subtask position; archive .handoff/loop to start fresh');
    }
    // Additive migration: a stamped state from before trunk derivation lacks
    // the field — derive once and stamp it, never refuse (plan item 2).
    if (typeof state.trunk !== 'string' || state.trunk.length === 0) {
      state = { ...state, trunk: await deriveTrunk(root, io) };
      await writeLoopState(root, state, io);
    }
  }
  const trunk = state.trunk;
  /** Current trunk sha — the smoke token's drift anchor (item 9). @returns {Promise<string>} */
  const trunkSha = async () => {
    try {
      return String((await io.execFile('git', ['rev-parse', trunk], { cwd: root })).stdout).trim();
    } catch {
      return 'none';
    }
  };
  const transition = async (/** @type {any} */ ev) => {
    const next = applyLoopEvent(state, ev);
    const seq = await appendLoopEvent(root, ev, io);
    state = { ...next, journalSeq: seq };
    await writeLoopState(root, state, io);
    return state;
  };
  const park = async (/** @type {string} */ reason) => {
    await transition({ type: LOOP_EVENT.PARK, reason });
    io.stderr.write(`baton pipeline run: parked — ${reason}\n`);
    return EXIT_PARKED;
  };
  // Persisted per-gate findings (plan item 4): the latest non-empty line
  // survives parks, crashes, and re-invocations.
  /** @param {string} gate @returns {string} */
  const latestFindings = (gate) => {
    const path = `${p.dir}/findings/${gate}.ndjson`;
    if (!io.fs.existsSync(path)) return '';
    let last = '';
    for (const line of String(io.fs.readFileSync(path, 'utf8')).split('\n')) {
      if (line.trim() === '') continue;
      try {
        const rec = JSON.parse(line);
        if (typeof rec?.findings === 'string' && rec.findings.length > 0) last = rec.findings;
      } catch {
        // A torn line proves nothing — skip it.
      }
    }
    return last;
  };
  /** @param {string} gate @param {string} text */
  const persistFindings = (gate, text) => {
    ensureDir(io.fs, `${p.dir}/findings`);
    appendEntry(io.fs, `${p.dir}/findings/${gate}.ndjson`, { iteration: state.iterations?.[gate] ?? 0, findings: text, at: io.now() });
  };
  // Review artifacts from gate children (v1.1 item 4b): every PARSED verdict
  // leaves reviews/<runId>/<gate>/iteration-NN/<role>.{prompt,verdict}.md —
  // all children of one review cycle share NN (fixed at the writer spawn).
  // FAIL-OPEN: an artifact error warns and never fails the run.
  /** @param {string} gate @param {string} nn @param {string} roleFile @param {any} assignment @param {string} promptText @param {string} verdict @param {string} findingsText */
  const writeGateArtifact = (gate, nn, roleFile, assignment, promptText, verdict, findingsText) => {
    const rel = `reviews/${state.runId}/${gate}/iteration-${nn}`;
    const header = [
      `role: ${assignment.role}`,
      `model: ${assignment.platform}/${assignment.model}${assignment.effort ? `@${assignment.effort}` : ''}`,
      `harness: ${assignment.platform}`,
      `date: ${String(io.now()).slice(0, 10)}`,
      `verdict: ${verdict}`,
      `degraded: ${assignment.mode && assignment.mode !== 'native' ? String(assignment.mode) : 'none'}`,
    ].join('\n');
    for (const [name, content] of [
      [`${roleFile}.prompt.md`, promptText],
      [`${roleFile}.verdict.md`, `${header}\n\n${findingsText}\n`],
    ]) {
      try {
        ensureDir(io.fs, `${root}/${rel}`);
        atomicWriteText(io.fs, `${root}/${rel}/${name}`, content);
      } catch (err) {
        io.stderr.write(`baton pipeline run: could not write review artifact ${rel}/${name} — ${/** @type {any} */ (err)?.message ?? err} (fail-open; the run continues)\n`);
      }
    }
  };

  /**
   * Persist the escalation (D7 — the exit-3 path must leave state.json
   * escalated, not 'running') and write ESCALATION.md. Empty in-memory
   * findings fall back to the latest PERSISTED findings for the gate (item
   * 4); only when neither exists does the operator get the last child's log
   * tail (D8). The findings-present format is byte-stable.
   * @param {string} gateId @param {string} findingsText @param {number} capN
   */
  const escalate = async (gateId, findingsText, capN) => {
    await transition({ type: LOOP_EVENT.ESCALATE, gate: gateId });
    if (findingsText === '') findingsText = latestFindings(gateId);
    let body = `# Pipeline escalation\n\nGate '${gateId}' exhausted its ${capN}-iteration cap.\nLast findings:\n\n${findingsText}\n`;
    if (findingsText === '') {
      const tail =
        lastChildLogPath && io.fs.existsSync(lastChildLogPath)
          ? transcriptTail(String(io.fs.readFileSync(lastChildLogPath, 'utf8')), 2048)
          : '(no child log recorded)';
      body += `\n(The last child produced no parseable findings — its log tail follows.)\n\nLast child log tail:\n\n${tail}\n`;
    }
    atomicWriteText(io.fs, `${p.dir}/ESCALATION.md`, body);
    return EXIT_ESCALATED;
  };

  // `pipeline resume` — a PARK is resumable; an escalation is operator-only.
  // Mirrors `loop resume` (G6/J1): the RESUME transition preserves the loaded
  // state's cap counters — resuming never refunds a gate.
  if (flags.__resume === true) {
    if (state.status === LOOP_STATUS.ESCALATED) {
      io.stderr.write(`baton pipeline resume: the run is ESCALATED (gate ${state.escalation?.gate}) — escalation is an operator decision; resolve the findings and start a fresh gate instead\n`);
      return EXIT_ESCALATED;
    }
    if (state.status === LOOP_STATUS.PARKED) {
      await transition({ type: LOOP_EVENT.RESUME });
      io.stdout.write('baton pipeline resume: the parked run is running again\n');
    }
  }

  // --approve-smoke: verify the presented token against RECOMPUTED inputs and
  // complete the run (v1.1 item 9); drift parks (the human approved a state
  // that no longer exists). Reuses the loop's smoke token machinery.
  if (typeof flags['approve-smoke'] === 'string') {
    if (state.status !== LOOP_STATUS.AWAITING_SMOKE_APPROVAL) {
      return usageError(io, flags, 'pipeline', `--approve-smoke only applies while the run awaits smoke approval (status: ${state.status})`);
    }
    const record = safeReadJson(io.fs, `${p.dir}/smoke-approval.json`);
    if (!record.ok) return usageError(io, flags, 'pipeline', 'no smoke-approval.json found — run the pipeline to the smoke gate first');
    const git = await gitSnapshot({ execFile: io.execFile, cwd: root, fs: io.fs });
    const currentInputs = {
      stateDigest: dedupeKey(io.fs.readFileSync(p.state, 'utf8')),
      smokeCmd: String(spec.smoke?.cmd ?? ''),
      smokeOutputDigest: String(record.value?.inputs?.smokeOutputDigest ?? ''),
      // A pipeline's merge target is the TRUNK — the base a reviewer signed off
      // on. Binding gitHead to the trunk sha (not HEAD) makes a trunk that
      // moved after review a detected drift that parks the approval (item 9).
      gitHead: await trunkSha(),
      gitContentDigest: gitContentOf(git),
      childAssignment: String(record.value?.inputs?.childAssignment ?? ''),
    };
    const verify = verifySmokeToken(String(flags['approve-smoke']), currentInputs);
    if (verify.ok !== true) {
      const drifted = 'driftedInputs' in verify ? verify.driftedInputs.join(', ') : 'unknown';
      await transition({ type: LOOP_EVENT.PARK, reason: `smoke approval token is stale — drifted inputs: ${drifted}; re-run the smoke gate` });
      io.stderr.write(`baton pipeline run: smoke approval REFUSED — inputs drifted since the token was issued (${drifted}); the run is parked for a fresh smoke pass\n`);
      return EXIT_PARKED;
    }
    await transition({ type: LOOP_EVENT.SMOKE_APPROVE, token: flags['approve-smoke'], verified: true });
    // Approval completes the run — return here so the end-of-run "done" line
    // below never double-prints on top of this (N2).
    io.stdout.write('baton pipeline run: smoke approval verified — pipeline complete\n');
    if (flags.json) emitEnvelope(io, { ok: true, data: { status: state.status, subtasks: subtasks.length } });
    return 0;
  }

  if (state.status === LOOP_STATUS.ESCALATED) {
    io.stderr.write(`baton pipeline run: the run is escalated (gate ${state.escalation?.gate}) — see ${p.dir}/ESCALATION.md\n`);
    return EXIT_ESCALATED;
  }
  if (state.status === LOOP_STATUS.PARKED) {
    io.stderr.write(`baton pipeline run: the run is parked — ${state.parkReason ?? 'no reason recorded'} (resume with: baton pipeline resume)\n`);
    return EXIT_PARKED;
  }
  if (state.status === LOOP_STATUS.AWAITING_SMOKE_APPROVAL) {
    io.stdout.write(`baton pipeline run: awaiting smoke approval — resume with: baton pipeline run --approve-smoke <token from ${p.dir}/smoke-approval.json>\n`);
    return 0;
  }
  if (state.status === LOOP_STATUS.DONE) {
    io.stdout.write(`baton pipeline run: done — ${subtasks.length} subtask(s) merged\n`);
    return 0;
  }
  const runner = io.superviseChild ?? superviseChild;
  const seats = worktreePaths(root).seats;
  let childSeq = 0;
  /** @type {string | null} */
  let lastChildLogPath = null;

  await setupWorktrees(root, io, trunk);

  // Supervisor-owned merge receipts (I1): one appended line per merged
  // subtask, written BEFORE the phase advance is journaled, so a crash
  // between merge and advance resumes into a receipt-backed advance.
  const mergesPath = `${p.dir}/merges.ndjson`;
  /** @returns {any[]} */
  const mergeReceipts = () => {
    if (!io.fs.existsSync(mergesPath)) return [];
    return String(io.fs.readFileSync(mergesPath, 'utf8'))
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null; // a torn record proves nothing — ignore it
        }
      })
      .filter(Boolean);
  };

  const spawn = async (/** @type {any} */ assignment, /** @type {string} */ prompt, /** @type {string} */ seatPath, /** @type {string} */ label) => {
    childSeq += 1;
    const childId = `${String(childSeq).padStart(3, '0')}-${label}`;
    const logPath = `${p.dir}/children/${childId}.log`;
    ensureDir(io.fs, `${p.dir}/children`);
    // gitDir: a linked worktree's index lives under the MAIN repo's .git —
    // write-capable children need it inside their sandbox to commit (D2);
    // buildChildArgv drops it for read-only roles.
    const childSpec = buildChildArgv(assignment, prompt, { root: seatPath, gitDir: `${root}/.git` });
    lastChildLogPath = logPath;
    const result = await runner(childSpec, {
      timeoutMs,
      graceMs: 10_000,
      logPath,
      maxLogBytes: 1_000_000,
      platform: assignment.platform,
      onStart: (/** @type {{pid: number, pgid: number}} */ info) => {
        appendEntry(io.fs, `${p.dir}/children.ndjson`, { childId, pid: info.pid, pgid: info.pgid, startedAt: io.now() });
      },
    });
    // Retire on resolution — reclaim must never kill a completed child's
    // (possibly recycled) group (H3).
    appendEntry(io.fs, `${p.dir}/children.ndjson`, { childId, endedAt: io.now() });
    return result;
  };

  // Prepare a seat for use, healing a listed-but-raw-deleted worktree (prune
  // + re-add) once before giving up (Gate-2 fold G5).
  const withSeatHealing = async (/** @type {string} */ seat, /** @type {() => Promise<any>} */ fn) => {
    try {
      return await fn();
    } catch (err) {
      const msg = String(/** @type {any} */ (err)?.message ?? err);
      if (/already exists/i.test(msg)) throw err; // a stale branch is a park, not a heal
      await selfHealWorktree(root, { seat, branch: `baton/wt-${seat}/base` }, io);
      return fn();
    }
  };

  for (let i = state.phaseIndex; i < subtasks.length; i += 1) {
    const st = subtasks[i];
    const seat = i % 2 === 0 ? 'a' : 'b';
    const other = seat === 'a' ? 'b' : 'a';
    const branch = `baton/wt-${seat}/subtask-${st.id}`;
    const gate = `subtask-${st.id}-review`;

    // A crash between merge and PHASE_ADVANCE leaves the branch fully merged:
    // recognize it and advance instead of a misleading empty-branch park (H7).
    // Recognition requires BOTH a supervisor-owned merge receipt AND the
    // branch tip being an ancestor of main (I1): is-ancestor alone
    // false-positives on a stale empty branch parked at main's old tip (a
    // writer that crashed before its first commit), and a receipt alone can
    // outlive a rewound main. Ancestor-without-receipt parks as stale;
    // receipt-without-ancestor re-runs the subtask.
    let isAncestor = false;
    try {
      await io.execFile('git', ['merge-base', '--is-ancestor', branch, trunk], { cwd: root });
      isAncestor = true;
    } catch {
      // Not an ancestor (or the branch does not exist yet) — the normal path.
    }
    if (isAncestor) {
      if (mergeReceipts().some((r) => r?.subtaskId === st.id)) {
        io.stdout.write(`baton pipeline run: subtask '${st.id}' is already merged into ${trunk} (receipt + ancestor) — advancing\n`);
        await transition({ type: LOOP_EVENT.PHASE_ADVANCE });
        continue;
      }
      return park(
        `subtask '${st.id}' has a stale branch '${branch}' whose tip is already contained in ${trunk}, with no merge receipt — either its writer crashed before committing, or the branch was merged without a receipt being recorded. Inspect \`git log ${trunk}..${branch}\` to tell which. Remediation: the branch may still be checked out in its writer seat worktree — checkout the seat's base branch there first, then delete '${branch}' and continue with: baton pipeline resume`,
      );
    }

    const writerAssignment = resolveOne(`worker-${seat}`);
    const reviewerModel = resolveOne(`worker-${other}`);
    const mergerModel = resolveOne('merger');
    if (!writerAssignment || !reviewerModel || !mergerModel) {
      return park(`no eligible assignment for subtask '${st.id}' (worker-${seat}/worker-${other}/merger must all resolve)`);
    }

    // Start the subtask branch in the writer's seat (self-healing a raw-deleted
    // seat), then verify the seat. A pre-existing (stale) branch parks.
    let mainSha;
    try {
      const alreadyOnBranch =
        String((await withSeatHealing(seat, () => io.execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: seats[seat] }))).stdout).trim() === branch;
      if (!alreadyOnBranch) await withSeatHealing(seat, () => io.execFile('git', ['checkout', '-b', branch], { cwd: seats[seat] }));
      const pre = await preflightWorktree(root, { seat, branch }, io);
      if (pre.ok !== true) return park(`preflight refused subtask '${st.id}': ${pre.refusal}`);
      mainSha = (await io.execFile('git', ['rev-parse', trunk], { cwd: root })).stdout.trim();
    } catch (err) {
      return park(`seat preparation failed for subtask '${st.id}': ${String(/** @type {any} */ (err)?.message ?? err).split('\n')[0]}`);
    }

    let findings = latestFindings(gate);
    let merged = false;
    let failoverAttempt = 0;
    /** @type {Array<{platform: string, model: string}>} */
    let subtaskAvoidEntries = [];
    /** @type {any | null} */
    let forcedWriter = null;

    /**
     * Spawn a verdict child (reviewer/merger) with the writer's death
     * discipline (D6): a failure-class result re-resolves the role from its
     * chain (entry avoidance carried on subtaskAvoidEntries) and relaunches
     * through the bounded failover — a death NEVER reaches the gate; only a
     * real verdict returns.
     * @param {{roleChain: string, childRole: string, prompt: string, seatPath: string, label: string, subtaskId: string, roleLabel: string}} c
     * @returns {Promise<{result?: any, assignment?: any, parked?: number}>}
     */
    const superviseVerdictChild = async (c) => {
      let attempt = 0;
      /** @type {any | null} */
      let forced = null;
      const chainLen = Array.isArray(config?.roles?.[c.roleChain]) ? config.roles[c.roleChain].length : 1;
      for (;;) {
        const resolved = forced ?? resolveOne(c.roleChain, subtaskAvoidEntries);
        if (!resolved) return { parked: await park(`no eligible ${c.roleLabel} remains for subtask '${c.subtaskId}' (every chain entry is avoided)`) };
        forced = null;
        const asg = { ...resolved, role: c.childRole };
        const result = await spawn(asg, c.prompt, c.seatPath, c.label);
        // Classify on the PRE-redaction parsed transcript (N3), not the
        // redacted on-disk log.
        const log = typeof result.transcript === 'string' ? result.transcript : result.logPath && io.fs.existsSync(result.logPath) ? io.fs.readFileSync(result.logPath, 'utf8') : '';
        const cls = classify({ text: transcriptTail(log), exitCode: result.exitCode ?? 0, platform: asg.platform, table }).class;
        if (cls === 'ok') return { result, assignment: asg };
        attempt += 1;
        if (attempt > chainLen) {
          return { parked: await park(`subtask '${c.subtaskId}' exhausted its ${c.roleLabel} failover budget (${chainLen} chain entr${chainLen === 1 ? 'y' : 'ies'}, ${attempt} deaths) — parked instead of looping`) };
        }
        const decision = await runFailover({
          root,
          io,
          config,
          role: c.roleChain,
          assignment: asg,
          transcript: log,
          exitCode: result.exitCode ?? 1,
          sessionHint: state.runId,
          probes,
          avoid: [],
          avoidEntries: subtaskAvoidEntries,
          attempt,
          loopState: { runId: state.runId, phaseIndex: state.phaseIndex, iterations: state.iterations, status: state.status },
        });
        if (decision.action === 'park') return { parked: await park(`${c.roleLabel} failover parked subtask '${c.subtaskId}': ${decision.reason}`) };
        if (decision.action === 'relaunch') {
          if (Array.isArray(decision.avoidEntries)) subtaskAvoidEntries = decision.avoidEntries;
          forced = { ...decision.assignment, role: c.childRole };
        }
      }
    };

    while (!merged) {
      if ((state.iterations?.[gate] ?? 0) >= cap) {
        io.stderr.write(`baton pipeline run: gate '${gate}' hit the ${cap}-iteration cap — escalated (see ${p.dir}/ESCALATION.md)\n`);
        return escalate(gate, findings, cap);
      }

      // One review cycle = writer, reviewer, merger — all three share the
      // artifact iteration number, fixed here at the writer spawn (item 4b).
      const cycleNN = String((state.iterations?.[gate] ?? 0) + 1).padStart(2, '0');

      // Writer (write-capable, its own seat). Every resolution — including a
      // plain BLOCKED retry — honors the subtask's avoided entries, so a
      // model rejected earlier in this subtask is never re-picked (D4).
      const resolvedWriter = forcedWriter ?? resolveOne(`worker-${seat}`, subtaskAvoidEntries);
      if (!resolvedWriter) return park(`no eligible writer remains for subtask '${st.id}' (every chain entry is avoided)`);
      const writerAsg = { ...resolvedWriter, role: `worker-${seat}` };
      forcedWriter = null;
      const writerPrompt = [
        `You are the writer (worker-${seat}) for subtask '${st.id}': ${st.title}.`,
        `Goal: ${spec.goal}. Work ONLY on branch ${branch} in your worktree; commit your work there.`,
        findings ? `The previous attempt was BLOCKED — address every finding:\n${findings}` : '',
        "When your work is committed and self-checked, End with exactly:\nVERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED\nFINDINGS: numbered findings, or 'none'",
      ]
        .filter(Boolean)
        .join('\n\n');
      const writerResult = await spawn(writerAsg, writerPrompt, seats[seat], `${st.id}-writer`);

      // The writer's result is CONSUMED, never discarded (Gate-2 fold G3):
      // classify its log first — a limit/model death routes through failover,
      // a BLOCKED self-check retries the writer, and only a passing writer
      // hands off to review.
      // Classify on the PRE-redaction parsed transcript (N3), not the redacted
      // on-disk log; the log write itself stays redacted (item 6).
      const writerLog = typeof writerResult.transcript === 'string' ? writerResult.transcript : writerResult.logPath && io.fs.existsSync(writerResult.logPath) ? io.fs.readFileSync(writerResult.logPath, 'utf8') : '';
      const writerCls = classify({ text: transcriptTail(writerLog), exitCode: writerResult.exitCode ?? 0, platform: writerAsg.platform, table }).class;
      if (writerCls !== 'ok') {
        failoverAttempt += 1;
        // Failover is BOUNDED: at most one relaunch per configured chain entry
        // for this seat — beyond that the subtask parks instead of ping-ponging
        // across platforms forever (H2).
        const chainLen = Array.isArray(config?.roles?.[`worker-${seat}`]) ? config.roles[`worker-${seat}`].length : 1;
        if (failoverAttempt > chainLen) {
          return park(`subtask '${st.id}' exhausted its failover budget (${chainLen} chain entr${chainLen === 1 ? 'y' : 'ies'}, ${failoverAttempt} deaths) — parked instead of looping`);
        }
        const decision = await runFailover({
          root,
          io,
          config,
          role: `worker-${seat}`,
          assignment: writerAsg,
          transcript: writerLog,
          exitCode: writerResult.exitCode ?? 1,
          sessionHint: state.runId,
          probes,
          avoid: [],
          avoidEntries: subtaskAvoidEntries,
          attempt: failoverAttempt,
          loopState: { runId: state.runId, phaseIndex: state.phaseIndex, iterations: state.iterations, status: state.status },
        });
        if (decision.action === 'park') return park(`writer failover parked subtask '${st.id}': ${decision.reason}`);
        if (decision.action === 'relaunch') {
          // Carry entry-level avoidance across relaunches — a rejected model
          // stays rejected for this subtask (H2).
          if (Array.isArray(decision.avoidEntries)) subtaskAvoidEntries = decision.avoidEntries;
          forcedWriter = { ...decision.assignment, role: `worker-${seat}` };
        }
        continue; // relaunch or retry the writer — never review a failed attempt
      }
      writeGateArtifact(gate, cycleNN, 'writer', writerAsg, writerPrompt, String(writerResult.verdict ?? 'BLOCKED'), String(writerResult.findings ?? ''));
      if (writerResult.verdict !== 'APPROVED' && writerResult.verdict !== 'APPROVED_WITH_NOTES') {
        findings = String(writerResult.findings ?? '');
        persistFindings(gate, findings);
        const after = await transition({ type: LOOP_EVENT.GATE_ITERATION, gate, verdict: 'BLOCKED' });
        if (after.status === LOOP_STATUS.ESCALATED || (after.iterations?.[gate] ?? 0) >= cap) {
          return escalate(gate, findings, cap);
        }
        continue; // the writer retries; no reviewer sees a failed attempt
      }

      const post = await postflightWorktree(root, { seat, branch, mainSha, trunk }, io);
      if (post.ok !== true) return park(`postflight refused subtask '${st.id}': ${post.refusal}`);

      // An empty branch never merges (Gate-2 fold G3): the writer must have
      // actually committed work ahead of main.
      const ahead = String((await io.execFile('git', ['log', `${trunk}..${branch}`, '--format=%H'], { cwd: root })).stdout).trim();
      if (ahead.length === 0) return park(`subtask '${st.id}' produced an EMPTY branch (no commits ahead of main) — nothing to review or merge`);

      // Reviewer-seat preflight (Gate-2 fold G5): the reviewing seat must be
      // listed and clean before a reviewer spawns into it.
      try {
        const otherBranch = String((await withSeatHealing(other, () => io.execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: seats[other] }))).stdout).trim();
        const reviewerPre = await preflightWorktree(root, { seat: other, branch: otherBranch }, io);
        if (reviewerPre.ok !== true) return park(`reviewer-seat preflight refused subtask '${st.id}': ${reviewerPre.refusal}`);
      } catch (err) {
        return park(`reviewer-seat preparation failed for subtask '${st.id}': ${String(/** @type {any} */ (err)?.message ?? err).split('\n')[0]}`);
      }

      // Reviewer (read-only, the OTHER seat's model and cwd, subtask-reviewer role).
      const reviewPrompt = [
        `You are the subtask-reviewer for subtask '${st.id}': ${st.title}.`,
        `Review the change on ${branch} against ${trunk} from the ${other} seat (fresh context). Run: git diff ${trunk}..${branch} (and git log ${trunk}..${branch}) to see exactly what changed — branch refs are shared across worktrees.`,
        "End with exactly:\nVERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED\nFINDINGS: numbered findings, or 'none'",
      ].join('\n\n');
      // A reviewer DEATH is never a review verdict (dogfood finding D6): a
      // failure-class result re-resolves the role (entry avoidance carried on
      // subtaskAvoidEntries) and relaunches, bounded by the chain length —
      // only a real verdict reaches the gate.
      const review = await superviseVerdictChild({
        roleChain: `worker-${other}`,
        childRole: 'subtask-reviewer',
        prompt: reviewPrompt,
        seatPath: seats[other],
        label: `${st.id}-review`,
        subtaskId: st.id,
        roleLabel: 'reviewer',
      });
      if (review.parked !== undefined) return review.parked;
      writeGateArtifact(gate, cycleNN, 'reviewer', review.assignment, reviewPrompt, String(review.result.verdict ?? 'BLOCKED'), String(review.result.findings ?? ''));
      if (review.result.verdict !== 'APPROVED' && review.result.verdict !== 'APPROVED_WITH_NOTES') {
        findings = String(review.result.findings ?? '');
        persistFindings(gate, findings);
        const after = await transition({ type: LOOP_EVENT.GATE_ITERATION, gate, verdict: 'BLOCKED' });
        if (after.status === LOOP_STATUS.ESCALATED || (after.iterations?.[gate] ?? 0) >= cap) {
          return escalate(gate, findings, cap);
        }
        continue;
      }

      // Merger (read-only child — it re-checks; the SUPERVISOR merges).
      const mergerPrompt = [
        `You are the merger for subtask '${st.id}'. Adversarially re-check ${branch} against ${trunk} before it merges.`,
        "End with exactly:\nVERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED\nFINDINGS: numbered findings, or 'none'",
      ].join('\n\n');
      const mergerCheck = await superviseVerdictChild({
        roleChain: 'merger',
        childRole: 'merger',
        prompt: mergerPrompt,
        seatPath: root,
        label: `${st.id}-merge-check`,
        subtaskId: st.id,
        roleLabel: 'merger',
      });
      if (mergerCheck.parked !== undefined) return mergerCheck.parked;
      writeGateArtifact(gate, cycleNN, 'merger', mergerCheck.assignment, mergerPrompt, String(mergerCheck.result.verdict ?? 'BLOCKED'), String(mergerCheck.result.findings ?? ''));
      if (mergerCheck.result.verdict !== 'APPROVED' && mergerCheck.result.verdict !== 'APPROVED_WITH_NOTES') {
        findings = String(mergerCheck.result.findings ?? '');
        persistFindings(gate, findings);
        const after = await transition({ type: LOOP_EVENT.GATE_ITERATION, gate, verdict: 'BLOCKED' });
        if (after.status === LOOP_STATUS.ESCALATED || (after.iterations?.[gate] ?? 0) >= cap) {
          return escalate(gate, findings, cap);
        }
        continue;
      }

      const merge = await mergeSubtask(root, { branch, trunk }, io);
      if (merge.ok !== true) return park(`merge of '${branch}' refused: ${merge.reason}`);
      // The receipt lands BEFORE the phase-advance journal write (I1): a
      // crash between the two resumes into a receipt-backed advance.
      appendEntry(io.fs, mergesPath, { subtaskId: st.id, branch, mergedAt: io.now() });
      merged = true;
    }

    await transition({ type: LOOP_EVENT.PHASE_ADVANCE });
  }

  // Smoke gate (v1.1 item 9): with smoke.cmd set, the run does NOT finish when
  // the final subtask merges — it runs the smoke command once, awaits a human
  // token bound to the current state/output/git, and completes only on a
  // verified token (approval handled above on the next invocation). Reuses the
  // loop's token machinery; drift parks.
  if (state.status === LOOP_STATUS.DONE && typeof spec.smoke?.cmd === 'string' && spec.smoke.cmd.length > 0 && !state.smokeApproval) {
    const [cmd, ...cmdArgs] = spec.smoke.cmd.split(/\s+/);
    let smokeOut = '';
    try {
      const r = await io.execFile(cmd, cmdArgs, { cwd: root });
      smokeOut = `${r?.stdout ?? ''}${r?.stderr ?? ''}`;
    } catch (err) {
      smokeOut = `smoke command failed: ${/** @type {any} */ (err)?.message ?? String(err)}`;
    }
    await transition({ type: LOOP_EVENT.SMOKE_AWAIT });
    const git = await gitSnapshot({ execFile: io.execFile, cwd: root, fs: io.fs });
    const inputs = {
      stateDigest: dedupeKey(io.fs.readFileSync(p.state, 'utf8')),
      smokeCmd: spec.smoke.cmd,
      smokeOutputDigest: dedupeKey(smokeOut),
      gitHead: await trunkSha(),
      gitContentDigest: gitContentOf(git),
      childAssignment: JSON.stringify({ flavor: 'pipeline', subtasks: subtasks.length }),
    };
    const token = smokeApprovalToken(inputs);
    atomicWriteJson(io.fs, `${p.dir}/smoke-approval.json`, { token, inputs, issuedAt: io.now() });
    atomicWriteText(
      io.fs,
      `${p.dir}/SMOKE-REVIEW.md`,
      `# Smoke gate — human approval required\n\nRun: ${state.runId}\nCommand: \`${spec.smoke.cmd}\`\nExpected: ${spec.smoke.expect ?? '(unspecified)'}\n\n## Output\n\n\`\`\`\n${smokeOut}\n\`\`\`\n\nApprove with:\n\n    baton pipeline run --approve-smoke ${token}\n\nThe token is bound to the current state/output/git — any drift refuses it.\n`,
    );
    io.stdout.write(`baton pipeline run: smoke gate reached — review ${p.dir}/SMOKE-REVIEW.md and approve with --approve-smoke <token>\n`);
    return 0;
  }

  if (flags.json) emitEnvelope(io, { ok: true, data: { status: state.status, subtasks: subtasks.length } });
  else io.stdout.write(`baton pipeline run: done — ${subtasks.length} subtask(s) merged\n`);
  return state.status === LOOP_STATUS.DONE ? 0 : state.status === LOOP_STATUS.PARKED ? EXIT_PARKED : 0;
}
