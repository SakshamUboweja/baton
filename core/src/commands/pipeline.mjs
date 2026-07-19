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
  LOOP_EVENT,
  LOOP_STATUS,
} from '../loop/state.mjs';
import { buildChildArgv, superviseChild } from '../loop/children.mjs';
import { setupWorktrees, preflightWorktree, postflightWorktree, mergeSubtask, worktreePaths } from '../loop/worktrees.mjs';
import { resolveRoles } from '../roles/resolve.mjs';
import { loadConfig } from '../roles/matrix.mjs';
import { atomicWriteText, ensureDir, safeReadJson } from '../util/fsx.mjs';
import { emitEnvelope, usageError, parseFlagsStrict, resolveRoot } from './shared.mjs';

const STRING_FLAGS = new Set(['root']);
const EXIT_ESCALATED = 3;
const EXIT_PARKED = 4;

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
  const parsed = parseFlagsStrict(flagTokens, {});
  if (parsed.error !== undefined) return usageError(io, parsed.flags, 'pipeline', parsed.error);
  const flags = parsed.flags;

  const sub = positionals[0];
  if (sub === undefined) return usageError(io, flags, 'pipeline', 'a subcommand is required — try: baton pipeline run');
  if (sub !== 'run') return usageError(io, flags, 'pipeline', `unknown subcommand '${sub}' (supported: run)`);
  if (positionals.length > 1) return usageError(io, flags, 'pipeline', `unexpected argument '${positionals[1]}'`);

  return runPipeline(flags, io);
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
  const cap = typeof spec?.budgets?.iterationCap === 'number' ? spec.budgets.iterationCap : 5;
  const timeoutMs = (typeof spec?.budgets?.perRoleTimeoutMin === 'number' ? spec.budgets.perRoleTimeoutMin : 30) * 60_000;

  /** @param {string} role @returns {any | null} */
  const resolveOne = (role) => {
    const a = resolveRoles({ config, to: 'claude-code', avoid: [], avoidEntries: [], probes: null }).assignments[role];
    return a && a.mode !== 'unavailable' ? a : null;
  };

  // The synthesized phase list makes the loop state machine (phase count,
  // done detection, journal replay) work unchanged for the subtask cycle.
  const subtasks = spec.subtasks;
  const stateSpec = {
    goal: spec.goal,
    phases: subtasks.map((/** @type {any} */ st, /** @type {number} */ i) => ({ id: `subtask-${st.id}`, role: `worker-${i % 2 === 0 ? 'a' : 'b'}` })),
  };
  /** @type {any} */
  let state = initLoopState(stateSpec, io);
  await writeLoopState(root, state, io);
  const runner = io.superviseChild ?? superviseChild;
  const seats = worktreePaths(root).seats;
  let childSeq = 0;

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

  await setupWorktrees(root, io);

  const spawn = async (/** @type {any} */ assignment, /** @type {string} */ prompt, /** @type {string} */ seatPath, /** @type {string} */ label) => {
    childSeq += 1;
    const logPath = `${p.dir}/children/${String(childSeq).padStart(3, '0')}-${label}.log`;
    ensureDir(io.fs, `${p.dir}/children`);
    const childSpec = buildChildArgv(assignment, prompt, { root: seatPath });
    return runner(childSpec, { timeoutMs, graceMs: 10_000, logPath, maxLogBytes: 1_000_000, platform: assignment.platform });
  };

  for (let i = 0; i < subtasks.length; i += 1) {
    const st = subtasks[i];
    const seat = i % 2 === 0 ? 'a' : 'b';
    const other = seat === 'a' ? 'b' : 'a';
    const branch = `baton/wt-${seat}/subtask-${st.id}`;
    const gate = `subtask-${st.id}-review`;

    const writerAssignment = resolveOne(`worker-${seat}`);
    const reviewerModel = resolveOne(`worker-${other}`);
    const mergerModel = resolveOne('merger');
    if (!writerAssignment || !reviewerModel || !mergerModel) {
      return park(`no eligible assignment for subtask '${st.id}' (worker-${seat}/worker-${other}/merger must all resolve)`);
    }

    // Start the subtask branch in the writer's seat, then verify the seat.
    await io.execFile('git', ['checkout', '-b', branch], { cwd: seats[seat] });
    const pre = await preflightWorktree(root, { seat, branch }, io);
    if (pre.ok !== true) return park(`preflight refused subtask '${st.id}': ${pre.refusal}`);
    const mainSha = (await io.execFile('git', ['rev-parse', 'main'], { cwd: root })).stdout.trim();

    let findings = '';
    let merged = false;
    while (!merged) {
      if ((state.iterations?.[gate] ?? 0) >= cap) {
        await transition({ type: LOOP_EVENT.GATE_ITERATION, gate, verdict: 'BLOCKED' });
        atomicWriteText(
          io.fs,
          `${p.dir}/ESCALATION.md`,
          `# Pipeline escalation\n\nGate '${gate}' exhausted its ${cap}-iteration cap.\nLast findings:\n\n${findings}\n`,
        );
        io.stderr.write(`baton pipeline run: gate '${gate}' hit the ${cap}-iteration cap — escalated (see ${p.dir}/ESCALATION.md)\n`);
        return EXIT_ESCALATED;
      }

      // Writer (write-capable, its own seat).
      const writerPrompt = [
        `You are the writer (worker-${seat}) for subtask '${st.id}': ${st.title}.`,
        `Goal: ${spec.goal}. Work ONLY on branch ${branch} in your worktree; commit your work there.`,
        findings ? `The previous attempt was BLOCKED — address every finding:\n${findings}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      await spawn({ ...writerAssignment, role: `worker-${seat}` }, writerPrompt, seats[seat], `${st.id}-writer`);

      const post = await postflightWorktree(root, { seat, branch, mainSha }, io);
      if (post.ok !== true) return park(`postflight refused subtask '${st.id}': ${post.refusal}`);

      // Reviewer (read-only, the OTHER seat's model and cwd, subtask-reviewer role).
      const reviewPrompt = [
        `You are the subtask-reviewer for subtask '${st.id}': ${st.title}.`,
        `Review the diff of ${branch} against main from the ${other} seat (fresh context).`,
        "End with exactly:\nVERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED\nFINDINGS: numbered findings, or 'none'",
      ].join('\n\n');
      const review = await spawn({ ...reviewerModel, role: 'subtask-reviewer' }, reviewPrompt, seats[other], `${st.id}-review`);
      if (review.verdict !== 'APPROVED' && review.verdict !== 'APPROVED_WITH_NOTES') {
        findings = String(review.findings ?? '');
        const after = await transition({ type: LOOP_EVENT.GATE_ITERATION, gate, verdict: 'BLOCKED' });
        if (after.status === LOOP_STATUS.ESCALATED) {
          atomicWriteText(io.fs, `${p.dir}/ESCALATION.md`, `# Pipeline escalation\n\nGate '${gate}' exhausted its ${cap}-iteration cap.\nLast findings:\n\n${findings}\n`);
          return EXIT_ESCALATED;
        }
        continue;
      }

      // Merger (read-only child — it re-checks; the SUPERVISOR merges).
      const mergerPrompt = [
        `You are the merger for subtask '${st.id}'. Adversarially re-check ${branch} against main before it merges.`,
        "End with exactly:\nVERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED\nFINDINGS: numbered findings, or 'none'",
      ].join('\n\n');
      const mergerVerdict = await spawn({ ...mergerModel, role: 'merger' }, mergerPrompt, root, `${st.id}-merge-check`);
      if (mergerVerdict.verdict !== 'APPROVED' && mergerVerdict.verdict !== 'APPROVED_WITH_NOTES') {
        findings = String(mergerVerdict.findings ?? '');
        const after = await transition({ type: LOOP_EVENT.GATE_ITERATION, gate, verdict: 'BLOCKED' });
        if (after.status === LOOP_STATUS.ESCALATED) {
          atomicWriteText(io.fs, `${p.dir}/ESCALATION.md`, `# Pipeline escalation\n\nGate '${gate}' exhausted its ${cap}-iteration cap.\nLast findings:\n\n${findings}\n`);
          return EXIT_ESCALATED;
        }
        continue;
      }

      const merge = await mergeSubtask(root, { branch }, io);
      if (merge.ok !== true) return park(`merge of '${branch}' refused: ${merge.reason}`);
      merged = true;
    }

    await transition({ type: LOOP_EVENT.PHASE_ADVANCE });
  }

  if (flags.json) emitEnvelope(io, { ok: true, data: { status: state.status, subtasks: subtasks.length } });
  else io.stdout.write(`baton pipeline run: done — ${subtasks.length} subtask(s) merged\n`);
  return state.status === LOOP_STATUS.DONE ? 0 : state.status === LOOP_STATUS.PARKED ? EXIT_PARKED : 0;
}
