import { defaultLoopSpec, validateLoopSpec } from '../loop/spec.mjs';
import {
  loopPaths,
  initLoopState,
  applyLoopEvent,
  writeLoopState,
  appendLoopEvent,
  loadLoopState,
  smokeApprovalToken,
  verifySmokeToken,
  LOOP_EVENT,
  LOOP_STATUS,
} from '../loop/state.mjs';
import { buildChildArgv, superviseChild } from '../loop/children.mjs';
import { runFailover } from '../loop/failover.mjs';
import { loadConfig } from '../roles/matrix.mjs';
import { resolveRoles } from '../roles/resolve.mjs';
import { loadSignatures } from '../detect/signatures.mjs';
import { classify, transcriptTail } from '../detect/classifier.mjs';
import { snapshot as gitSnapshot } from '../git/snapshot.mjs';
import { dedupeKey } from '../util/ids.mjs';
import { atomicWriteJson, atomicWriteText, ensureDir, safeReadJson } from '../util/fsx.mjs';
import { appendEntry } from '../util/jsonl.mjs';
import { emitEnvelope, usageError, parseFlagsStrict, resolveRoot } from './shared.mjs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const BUILTIN_SIGNATURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'signatures.v1.json');

// Flags that consume a value — needed to split positionals from flag tokens
// without mistaking a flag's value for a positional. Keep in sync with the
// strict spec below plus the implied common string flag (--root).
const STRING_FLAGS = new Set(['root', 'approve-smoke']);

/**
 * `baton loop <subcommand>` — the Layer-2 goal-loop surface. v1 subcommands:
 * `init "<goal>"` (scaffold loop.json; two-phase, idempotent, dry-run-able).
 * Supervisor-side by design: the BATON_SUPERVISED_CHILD guard deliberately
 * does NOT apply here.
 * @param {string[]} args @param {any} io
 * @returns {Promise<number>}
 */
export async function cmdLoop(args, io) {
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

  const parsed = parseFlagsStrict(flagTokens, { 'dry-run': 'boolean', 'approve-smoke': 'string' });
  if (parsed.error !== undefined) return usageError(io, parsed.flags, 'loop', parsed.error);
  const flags = parsed.flags;

  const sub = positionals[0];
  if (sub === undefined) return usageError(io, flags, 'loop', 'a subcommand is required — try: baton loop init "<goal>" or baton loop run');
  if (sub === 'run' || sub === 'resume') {
    if (positionals.length > 1) return usageError(io, flags, 'loop', `unexpected argument '${positionals[1]}'`);
    if (flags['approve-smoke'] === '') return usageError(io, flags, 'loop', '--approve-smoke requires a value (the token from smoke-approval.json)');
    if (sub === 'resume') flags.__resume = true;
    return runLoop(flags, io);
  }
  if (sub !== 'init') return usageError(io, flags, 'loop', `unknown subcommand '${sub}' (supported: init, run, resume)`);

  const goal = positionals[1];
  if (goal === undefined) return usageError(io, flags, 'loop', 'loop init requires a goal — baton loop init "<goal>"');
  if (positionals.length > 2) return usageError(io, flags, 'loop', `unexpected argument '${positionals[2]}'`);

  const root = resolveRoot(io, flags);
  const path = `${root}/loop.json`;

  const finish = (/** @type {any} */ data, /** @type {string} */ human) => {
    if (flags.json) emitEnvelope(io, { ok: true, data });
    else io.stdout.write(`${human}\n`);
    return 0;
  };

  // Idempotent: an existing spec is the user's — never overwritten.
  if (io.fs.existsSync(path)) {
    return finish({ created: false, path }, `baton loop init: ${path} already exists — left untouched`);
  }
  if (flags['dry-run'] === true) {
    return finish(
      { created: false, path, dryRun: true },
      `baton loop init (dry-run): would write ${path} — the default baton/loop@1 spec with goal "${goal}"`,
    );
  }
  ensureDir(io.fs, root);
  atomicWriteJson(io.fs, path, defaultLoopSpec(goal));
  return finish({ created: true, path }, `baton loop init: wrote ${path} (goal "${goal}") — edit constraints/smoke, then run baton loop run`);
}

// Exit codes for `loop run` (frozen by the loop-run test contract):
// 0 done / awaiting-smoke-approval · 1 live-lock refusal · 2 usage error ·
// 3 escalated · 4 parked.
const EXIT_ESCALATED = 3;
const EXIT_PARKED = 4;

/** @param {any} g */
const gitHeadOf = (g) => g?.headSha ?? 'none';
/** @param {any} g */
const gitContentOf = (g) => g?.contentDigest ?? dedupeKey(g ?? null);

/**
 * Acquire the supervisor run lock ATOMICALLY (exclusive create — never
 * check-then-write, which loses a race by clobbering the winner). A live
 * owner refuses; a provably-dead one is reclaimed: its recorded in-flight
 * child groups (.handoff/loop/children.ndjson) are KILLED first so no
 * orphan survives the takeover, then the lock is retried once.
 * Shared by `loop run` and `pipeline run`.
 * @param {string} root @param {any} io @param {string} cmdLabel
 * @returns {Promise<{ok: true, release: () => void} | {ok: false, code: number}>}
 */
export async function acquireSupervisorLock(root, io, cmdLabel) {
  const p = loopPaths(root);
  const lockPath = `${p.dir}/supervisor.lock`;
  const childrenPath = `${p.dir}/children.ndjson`;
  ensureDir(io.fs, p.dir);
  const payload = JSON.stringify({ host: io.host, pid: io.pid, startTime: io.startTime, runId: `sup-${io.pid}` });

  const tryExclusive = () => {
    // Fast-path an already-present lock (fakes without O_EXCL semantics rely
    // on this); the wx flag below is the REAL exclusivity on a POSIX fs — a
    // competitor that lands between the check and the write throws EEXIST
    // instead of being clobbered.
    if (io.fs.existsSync(lockPath)) return false;
    try {
      io.fs.writeFileSync(lockPath, payload, { flag: 'wx' });
      return true;
    } catch (err) {
      if (/** @type {any} */ (err)?.code === 'EEXIST') return false;
      throw err;
    }
  };

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (tryExclusive()) {
      // A fresh acquisition owns a fresh child registry: prior invocations'
      // start/retire records are truncated so a stale retire can never mask a
      // later in-flight child that reuses the same childId (I2).
      try {
        if (io.fs.existsSync(childrenPath)) io.fs.unlinkSync(childrenPath);
      } catch {
        // Best effort.
      }
      return {
        ok: true,
        release: () => {
          try {
            if (io.fs.existsSync(lockPath)) io.fs.unlinkSync(lockPath);
          } catch {
            // Best effort — a stale lock is recoverable via the dead path.
          }
        },
      };
    }
    const existing = safeReadJson(io.fs, lockPath);
    const other = existing.ok ? existing.value : null;
    // Liveness verifies the (pid, startTime) PAIR — a recycled pid without the
    // recorded start time is a dead owner, not a live supervisor (I5).
    const alive = other && typeof other.pid === 'number' && typeof io.processAlive === 'function' ? io.processAlive(other.pid, other.startTime) : true;
    const sameProcess = other && other.pid === io.pid && other.startTime === io.startTime;
    if (!sameProcess && (!other || other.host !== io.host || alive)) {
      io.stderr.write(`baton ${cmdLabel}: another supervisor (pid ${other?.pid ?? 'unknown'} on ${other?.host ?? 'unknown'}, run ${other?.runId ?? '?'}) holds the run lock — refusing a second supervisor\n`);
      return { ok: false, code: 1 };
    }
    // Provably dead (or our own stale lock): reap its recorded in-flight
    // child groups BEFORE anything else runs, then reclaim.
    if (io.fs.existsSync(childrenPath)) {
      const lines = String(io.fs.readFileSync(childrenPath, 'utf8')).split('\n').filter((l) => l.trim() !== '');
      // Match retires to starts IN ORDER per childId — a resumed invocation
      // reuses childIds, and a prior run's retire must never mask the newer
      // in-flight start of the same id (I2). Whatever start remains unmatched
      // is genuinely in-flight.
      /** @type {Map<string, any[]>} */
      const inflight = new Map();
      for (const line of lines) {
        try {
          const rec = JSON.parse(line);
          if (typeof rec?.endedAt === 'string') inflight.get(rec.childId)?.shift();
          else if (typeof rec?.pgid === 'number') {
            if (!inflight.has(rec.childId)) inflight.set(rec.childId, []);
            inflight.get(rec.childId)?.push(rec);
          }
        } catch {
          // A torn record is unreapable — skip it.
        }
      }
      // Kill ONLY genuinely in-flight children (start with no matching
      // retire): a retired child's pgid may have been recycled by an
      // unrelated live process — killing it would be a pid-reuse casualty (H3).
      for (const recs of inflight.values()) {
        for (const rec of recs) {
          if (typeof io.processAlive === 'function' && io.processAlive(rec.pgid)) {
            if (typeof io.processKill === 'function') io.processKill(-rec.pgid, 'SIGKILL');
          }
        }
      }
      try {
        io.fs.unlinkSync(childrenPath);
      } catch {
        // Best effort.
      }
    }
    io.stderr.write(`baton ${cmdLabel}: reclaimed the run lock from a provably-dead supervisor (pid ${other?.pid})\n`);
    try {
      io.fs.unlinkSync(lockPath);
    } catch {
      // Already gone.
    }
  }
  io.stderr.write(`baton ${cmdLabel}: could not acquire the run lock after reclaiming — another supervisor keeps winning\n`);
  return { ok: false, code: 1 };
}

/**
 * The supervisor state machine: drives the spec's phases through headless
 * role children, records every transition in the journal-replayable loop
 * state, enforces the 5-cap, pauses at the smoke gate, and hands limit
 * deaths to the failover transaction. Children run via the injectable seam
 * `io.superviseChild ?? superviseChild`.
 * @param {Record<string, string | boolean>} flags @param {any} io
 * @returns {Promise<number>}
 */
async function runLoop(flags, io) {
  const root = resolveRoot(io, flags);
  const specPath = `${root}/loop.json`;
  const p = loopPaths(root);
  const lockPath = `${p.dir}/supervisor.lock`;

  // Preconditions — before any lock or spawn.
  const rawSpec = safeReadJson(io.fs, specPath);
  if (!rawSpec.ok) {
    return usageError(io, flags, 'loop', `no loop.json at ${specPath} — scaffold one with: baton loop init "<goal>"`);
  }
  const { config } = loadConfig(root, io);
  if (!config) return usageError(io, flags, 'loop', `no readable baton.config.json at ${root} — the role matrix is required`);
  const validated = validateLoopSpec(rawSpec.value, config);
  if (validated.ok !== true) {
    return usageError(io, flags, 'loop', `loop.json is invalid:\n  - ${validated.errors.join('\n  - ')}`);
  }
  const spec = validated.spec;

  // Supervisor run lock — atomic exclusive acquisition; provably-dead owners
  // are reclaimed with their recorded child groups reaped first (B8 + G4).
  const lock = await acquireSupervisorLock(root, io, 'loop run');
  if (lock.ok !== true) return lock.code;

  // Load or initialize the run state — stamped with {flavor, specDigest} so
  // cross-flavor, changed-spec, or pre-stamp resumes refuse instead of
  // misaligning (H5 + I3). These refusals release the lock explicitly — an
  // early return here must not leave supervisor.lock behind (I4).
  const specDigest = dedupeKey(spec.phases);
  let { state } = await loadLoopState(root, io);
  if (state === null) {
    // A resume with nothing persisted is a wrong-directory mistake, not a
    // fresh run — refusing beats silently initializing and running (N2).
    if (flags.__resume === true) {
      lock.release();
      return usageError(io, flags, 'loop', 'nothing to resume — no run state exists here; start with: baton loop run');
    }
    state = { ...initLoopState(spec, io), flavor: 'loop', specDigest };
    await writeLoopState(root, state, io);
  } else {
    if (typeof state.flavor === 'string' && state.flavor !== 'loop') {
      lock.release();
      return usageError(io, flags, 'loop', `the persisted run state is flavor '${state.flavor}' — a ${state.flavor} run cannot be resumed as a loop (flavor mismatch); archive .handoff/loop or finish the ${state.flavor} run first`);
    }
    if (typeof state.flavor !== 'string' || typeof state.specDigest !== 'string') {
      lock.release();
      return usageError(io, flags, 'loop', 'the persisted run state is missing its {flavor, specDigest} stamp (pre-stamp legacy state) — resuming it could misalign the run; archive .handoff/loop to start fresh');
    }
    if (state.specDigest !== specDigest) {
      lock.release();
      return usageError(io, flags, 'loop', 'loop.json phases changed since this run started (spec digest mismatch) — resuming would misalign the phase position; archive .handoff/loop to start fresh');
    }
  }
  const runId = state.runId;
  // The lock payload's runId now correlates with the run it guards (H8).
  io.fs.writeFileSync(`${p.dir}/supervisor.lock`, JSON.stringify({ host: io.host, pid: io.pid, startTime: io.startTime, runId }));

  /** Apply one event, journal it, persist the snapshot — one transition. */
  const transition = async (/** @type {any} */ ev) => {
    const next = applyLoopEvent(state, ev);
    const seq = await appendLoopEvent(root, ev, io);
    state = { ...next, journalSeq: seq };
    await writeLoopState(root, state, io);
    return state;
  };

  const table = loadSignatures({ builtinPath: BUILTIN_SIGNATURES }, io);
  const runner = io.superviseChild ?? superviseChild;
  // The runId is already 'loop-<hex>' — no extra prefix (D5).
  const sessionHint = runId;
  /** @type {string[]} */
  let avoid = [];
  /** @type {Array<{platform: string, model: string}>} */
  let avoidEntries = [];
  let childSeq = 0;
  // Child spend is budgeted PER PHASE (plan item 3) — a runaway phase parks
  // itself without eating the other phases' budgets.
  /** @type {Map<string, number>} */
  const phaseChildren = new Map();
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

  try {
    // `loop resume` — a PARK is resumable; an escalation is operator-only.
    if (flags.__resume === true) {
      if (state.status === LOOP_STATUS.ESCALATED) {
        io.stderr.write(`baton loop resume: the run is ESCALATED (gate ${state.escalation?.gate}) — escalation is an operator decision; resolve the findings and start a fresh gate instead\n`);
        return EXIT_ESCALATED;
      }
      if (state.status === LOOP_STATUS.PARKED) {
        await transition({ type: LOOP_EVENT.RESUME });
        io.stdout.write('baton loop resume: the parked run is running again\n');
      }
    }

    // --approve-smoke: verify the presented token against RECOMPUTED inputs;
    // drift parks (the human approved a state that no longer exists).
    if (typeof flags['approve-smoke'] === 'string') {
      if (state.status !== LOOP_STATUS.AWAITING_SMOKE_APPROVAL) {
        return usageError(io, flags, 'loop', `--approve-smoke only applies while the run awaits smoke approval (status: ${state.status})`);
      }
      const record = safeReadJson(io.fs, `${p.dir}/smoke-approval.json`);
      if (!record.ok) return usageError(io, flags, 'loop', 'no smoke-approval.json found — run the loop to the smoke gate first');
      const git = await gitSnapshot({ execFile: io.execFile, cwd: root, fs: io.fs });
      const currentInputs = {
        stateDigest: dedupeKey(io.fs.readFileSync(p.state, 'utf8')),
        smokeCmd: String(spec.smoke?.cmd ?? ''),
        smokeOutputDigest: String(record.value?.inputs?.smokeOutputDigest ?? ''),
        gitHead: gitHeadOf(git),
        gitContentDigest: gitContentOf(git),
        childAssignment: String(record.value?.inputs?.childAssignment ?? ''),
      };
      const verify = verifySmokeToken(String(flags['approve-smoke']), currentInputs);
      if (verify.ok !== true) {
        const drifted = 'driftedInputs' in verify ? verify.driftedInputs.join(', ') : 'unknown';
        await transition({ type: LOOP_EVENT.PARK, reason: `smoke approval token is stale — drifted inputs: ${drifted}; re-run the smoke gate` });
        io.stderr.write(`baton loop run: smoke approval REFUSED — inputs drifted since the token was issued (${drifted}); the run is parked for a fresh smoke pass\n`);
        return EXIT_PARKED;
      }
      await transition({ type: LOOP_EVENT.SMOKE_APPROVE, token: flags['approve-smoke'], verified: true });
      io.stdout.write('baton loop run: smoke approval verified — continuing the run\n');
    }

    if (state.status === LOOP_STATUS.ESCALATED) {
      io.stderr.write(`baton loop run: the run is escalated (gate ${state.escalation?.gate}) — see ${p.dir}/ESCALATION.md\n`);
      return EXIT_ESCALATED;
    }
    if (state.status === LOOP_STATUS.PARKED) {
      io.stderr.write(`baton loop run: the run is parked — ${state.parkReason ?? 'no reason recorded'} (resume with: baton loop resume)\n`);
      return EXIT_PARKED;
    }
    if (state.status === LOOP_STATUS.AWAITING_SMOKE_APPROVAL) {
      io.stdout.write(`baton loop run: awaiting smoke approval — resume with: baton loop run --approve-smoke <token from ${p.dir}/smoke-approval.json>\n`);
      return 0;
    }

    // ---- The phase loop. ---------------------------------------------------
    while (state.status === LOOP_STATUS.RUNNING && state.phaseIndex < state.phaseCount) {
      const phase = spec.phases[state.phaseIndex];
      const cap = spec.budgets.iterationCap;
      let findings = latestFindings(phase.id);
      let failoverAttempt = 0;
      /** @type {any | null} */
      let forcedAssignment = null;
      /** @type {string | null} */
      let forcedPrompt = null;
      let phaseDone = false;

      while (!phaseDone) {
        // The cap gates the SPAWN: at the cap the reducer escalates and a
        // 6th child never starts.
        if ((state.iterations?.[phase.id] ?? 0) >= cap) {
          // ESCALATE persists at ANY spec cap — GATE_ITERATION only flips the
          // status at the reducer's hard 5-cap (dogfood finding D7).
          await transition({ type: LOOP_EVENT.ESCALATE, gate: phase.id });
          atomicWriteText(
            io.fs,
            `${p.dir}/ESCALATION.md`,
            `# Loop escalation\n\nGate '${phase.id}' exhausted its ${cap}-iteration cap on run ${runId}.\nLast findings:\n\n${findings}\n\nEscalation is operator-only: review and resolve the findings with the operator before any new gate attempt.\n`,
          );
          io.stderr.write(`baton loop run: gate '${phase.id}' hit the ${cap}-iteration cap — escalated (see ${p.dir}/ESCALATION.md)\n`);
          return EXIT_ESCALATED;
        }
        if ((phaseChildren.get(phase.id) ?? 0) >= spec.budgets.maxChildrenPerPhase) {
          const reason = `phase '${phase.id}' exhausted its ${spec.budgets.maxChildrenPerPhase}-child budget — other phases are unaffected`;
          await transition({ type: LOOP_EVENT.PARK, reason });
          io.stderr.write(`baton loop run: parked — ${reason}\n`);
          return EXIT_PARKED;
        }

        const resolved =
          forcedAssignment ??
          (() => {
            const r = resolveRoles({ config, to: 'claude-code', avoid, avoidEntries, probes: null }).assignments[phase.role];
            return r && r.mode !== 'unavailable' ? r : null;
          })();
        if (!resolved) {
          await transition({ type: LOOP_EVENT.PARK, reason: `no eligible platform/model for role '${phase.role}'` });
          io.stderr.write(`baton loop run: no eligible assignment for role '${phase.role}' — parked\n`);
          return EXIT_PARKED;
        }
        const assignment = { ...resolved, role: phase.role };
        const prompt =
          forcedPrompt ??
          [
            `You are the ${phase.role} for loop run ${runId}, phase '${phase.id}'.`,
            `Goal: ${spec.goal}`,
            spec.constraints.length > 0 ? `Constraints:\n${spec.constraints.map((/** @type {string} */ c) => `- ${c}`).join('\n')}` : '',
            findings ? `The previous attempt was BLOCKED with these findings — address every one:\n${findings}` : '',
            "End with exactly:\nVERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED\nFINDINGS: numbered findings, or 'none'",
          ]
            .filter(Boolean)
            .join('\n\n');
        forcedAssignment = null;
        forcedPrompt = null;

        childSeq += 1;
        phaseChildren.set(phase.id, (phaseChildren.get(phase.id) ?? 0) + 1);
        const childId = `${String(childSeq).padStart(3, '0')}-${phase.id}`;
        const logPath = `${p.dir}/children/${childId}.log`;
        ensureDir(io.fs, `${p.dir}/children`);
        const childSpec = buildChildArgv(assignment, prompt, { root });
        const result = await runner(childSpec, {
          timeoutMs: spec.budgets.perRoleTimeoutMin * 60_000,
          graceMs: 10_000,
          logPath,
          maxLogBytes: 1_000_000,
          platform: assignment.platform,
          // Persist the child's process group the INSTANT it spawns — a
          // supervisor crash must leave every in-flight child reap-able by
          // the reclaiming run (G4).
          onStart: (/** @type {{pid: number, pgid: number}} */ info) => {
            appendEntry(io.fs, `${p.dir}/children.ndjson`, { childId, pid: info.pid, pgid: info.pgid, startedAt: io.now() });
          },
        });
        // Retire the child the moment it resolves — a reclaim must never kill
        // a completed child's (possibly OS-recycled) process group (H3).
        appendEntry(io.fs, `${p.dir}/children.ndjson`, { childId, endedAt: io.now() });

        // Classification reads the child's LOG (the frozen transcript), so a
        // limit banner routes to failover even when a verdict parsed.
        const transcript = io.fs.existsSync(logPath) ? io.fs.readFileSync(logPath, 'utf8') : '';
        const cls = classify({ text: transcriptTail(transcript), exitCode: result.exitCode ?? 0, platform: assignment.platform, table }).class;

        if (cls === 'usage-limit' || cls === 'model-unavailable' || cls === 'other-error' || cls === 'throttle' || cls === 'auth') {
          failoverAttempt += 1;
          const decision = await runFailover({
            root,
            io,
            config,
            role: phase.role,
            assignment,
            transcript,
            exitCode: result.exitCode ?? 1,
            sessionHint,
            probes: null,
            avoid,
            avoidEntries,
            attempt: failoverAttempt,
            loopState: { runId, phaseIndex: state.phaseIndex, iterations: state.iterations, status: state.status },
          });
          if (decision.action === 'park') {
            await transition({ type: LOOP_EVENT.PARK, reason: decision.reason });
            io.stderr.write(`baton loop run: parked — ${decision.reason}${'resumeAt' in decision && decision.resumeAt ? ` (resume around ${decision.resumeAt})` : ''}\n`);
            return EXIT_PARKED;
          }
          if (decision.action === 'relaunch') {
            // Platform avoidance is PER-DEATH, not cumulative: runFailover
            // already avoided the just-died platform when it resolved the
            // relaunch. Accumulating here would exhaust every platform on a
            // chained A→B→A failover and park instead of returning to A
            // (acceptance constraint 2). Entry-level avoidance (dead MODELS)
            // does accumulate — a rejected model stays rejected.
            if (Array.isArray(decision.avoidEntries)) avoidEntries = decision.avoidEntries;
            forcedAssignment = { ...decision.assignment, role: phase.role };
            forcedPrompt = typeof decision.prompt === 'string' && decision.prompt.length > 0 ? decision.prompt : null;
            continue; // relaunch the same phase on the new assignment
          }
          continue; // retry: re-spawn the same phase once more
        }

        const verdict = String(result.verdict ?? 'BLOCKED');
        if (verdict === 'APPROVED' || verdict === 'APPROVED_WITH_NOTES') {
          await transition({ type: LOOP_EVENT.PHASE_ADVANCE });
          phaseDone = true;

          // The smoke gate fires right after the smoke-build phase completes.
          if (phase.id === 'smoke-build' && typeof spec.smoke?.cmd === 'string' && spec.smoke.cmd.length > 0) {
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
              gitHead: gitHeadOf(git),
              gitContentDigest: gitContentOf(git),
              childAssignment: JSON.stringify({ platform: assignment.platform, model: assignment.model }),
            };
            const token = smokeApprovalToken(inputs);
            atomicWriteJson(io.fs, `${p.dir}/smoke-approval.json`, { token, inputs, issuedAt: io.now() });
            atomicWriteText(
              io.fs,
              `${p.dir}/SMOKE-REVIEW.md`,
              `# Smoke gate — human approval required\n\nRun: ${runId}\nCommand: \`${spec.smoke.cmd}\`\nExpected: ${spec.smoke.expect ?? '(unspecified)'}\n\n## Output\n\n\`\`\`\n${smokeOut}\n\`\`\`\n\nApprove with:\n\n    baton loop run --approve-smoke ${token}\n\nThe token is bound to the current state/output/git — any drift refuses it.\n`,
            );
            io.stdout.write(`baton loop run: smoke gate reached — review ${p.dir}/SMOKE-REVIEW.md and approve with --approve-smoke <token>\n`);
            return 0;
          }
        } else {
          // BLOCKED (or unparseable, already coerced to BLOCKED upstream).
          findings = String(result.findings ?? '');
          persistFindings(phase.id, findings);
          const after = await transition({ type: LOOP_EVENT.GATE_ITERATION, gate: phase.id, verdict });
          if (after.status === LOOP_STATUS.ESCALATED) {
            atomicWriteText(
              io.fs,
              `${p.dir}/ESCALATION.md`,
              `# Loop escalation\n\nGate '${phase.id}' exhausted its ${cap}-iteration cap on run ${runId}.\nLast findings:\n\n${findings}\n`,
            );
            io.stderr.write(`baton loop run: gate '${phase.id}' escalated at the cap — see ${p.dir}/ESCALATION.md\n`);
            return EXIT_ESCALATED;
          }
        }
      }
    }

    if (state.status === LOOP_STATUS.DONE || state.phaseIndex >= state.phaseCount) {
      io.stdout.write(`baton loop run: done — every phase completed (run ${runId})\n`);
      return 0;
    }
    io.stdout.write(`baton loop run: stopped in status ${state.status}\n`);
    return state.status === LOOP_STATUS.PARKED ? EXIT_PARKED : state.status === LOOP_STATUS.ESCALATED ? EXIT_ESCALATED : 0;
  } finally {
    // The lock is per-invocation: release on every exit path so a paused run
    // (awaiting approval) can be resumed by the next invocation.
    lock.release();
  }
}
