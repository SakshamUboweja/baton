/**
 * Loop failover orchestration — what the supervisor does when a child dies.
 * Classifies the death via the signature table, then takes exactly one path:
 * retry-once-then-park (generic failures), entry-level re-resolve
 * (model-unavailable — the platform survives its dead model), or the
 * usage-limit transaction: checkpoint the loop position INTO the bundle,
 * seal, and receive onto the resolver's pick with one bounded stale retry.
 * Writes NOTHING under .handoff/loop/ — the supervisor applies the returned
 * decision to loop state afterward. Plan:
 * docs/plans/2026-07-18-goal-loop-worktree-pipeline.md §"Limit failover" +
 * §"Model-level failover".
 */
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { loadSignatures } from '../detect/signatures.mjs';
import { classify } from '../detect/classifier.mjs';
import { resolveRoles } from '../roles/resolve.mjs';
import { loadBundle } from '../bundle/store.mjs';
import { snapshot as gitSnapshot } from '../git/snapshot.mjs';
import { prepare, commit } from '../receive/txn.mjs';
import { cmdCheckpoint } from '../commands/checkpoint.mjs';
import { cmdFinalize } from '../commands/finalize.mjs';

const BUILTIN_SIGNATURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'signatures.v1.json');

/**
 * @param {{
 *   root: string, io: any, config: any, role: string,
 *   assignment: {platform: string, role?: string, model: string, effort?: string | null, mode?: string},
 *   transcript: string, exitCode: number, sessionHint: string,
 *   probes?: any, avoid?: string[], avoidEntries?: Array<{platform: string, model: string}>,
 *   attempt: number, loopState?: any, degradedOpen?: boolean,
 * }} input
 * @returns {Promise<
 *   | {action: 'retry', class: string, attempt: number}
 *   | {action: 'park', class: string, reason: string, resumeAt?: string}
 *   | {action: 'relaunch', class: string, assignment: any, avoidEntries?: any[], prompt?: string}
 * >}
 */
export async function runFailover(input) {
  const { root, io, config, role, assignment, sessionHint } = input;
  const avoid = input.avoid ?? [];
  const avoidEntries = input.avoidEntries ?? [];

  // Classification is TABLE-driven — the same loader/classifier as `baton
  // detect`, so overlay/fixture signatures are honored, never hardcoded.
  const table = loadSignatures({ builtinPath: BUILTIN_SIGNATURES }, io);
  const verdict = classify({ text: input.transcript, exitCode: input.exitCode, platform: assignment.platform, table });

  // Model-level failure: the platform is fine, one model is dead. Avoid the
  // exact {platform, model} tuple and re-resolve — no seal, no receive.
  if (verdict.class === 'model-unavailable') {
    const nextAvoidEntries = [...avoidEntries, { platform: assignment.platform, model: assignment.model }];
    const resolved = resolveRoles({ config, to: assignment.platform, avoid, avoidEntries: nextAvoidEntries, probes: input.probes ?? null });
    const next = resolved.assignments[role];
    if (!next || next.mode === 'unavailable') {
      return { action: 'park', class: verdict.class, reason: `no eligible chain entry left for role '${role}' after avoiding ${assignment.platform}/${assignment.model}` };
    }
    return { action: 'relaunch', class: verdict.class, assignment: next, avoidEntries: nextAvoidEntries };
  }

  // Anything that is not a usage-limit death is a child failure, not a
  // platform death: retry once, then park. Never a seal or receive.
  if (verdict.class !== 'usage-limit') {
    if (input.attempt <= 1) return { action: 'retry', class: verdict.class, attempt: input.attempt };
    return { action: 'park', class: verdict.class, reason: `child failed twice (${verdict.class}) — parked for operator review` };
  }

  // ---- Usage-limit: the exact transaction (plan steps 3–8). ----------------
  const { bundle } = loadBundle(root, io);
  const originPlatform = bundle?.origin?.platform ?? assignment.platform;

  // (3) Checkpoint the loop position INTO the bundle under the supervisor
  // session BEFORE any seal, so the frozen seal carries it.
  if (input.loopState !== undefined) {
    const checkpointIo = {
      ...io,
      stdin: JSON.stringify({
        schema: 'baton/event@1',
        events: [{ type: 'decision', payload: { summary: `loop position at limit death: ${JSON.stringify(input.loopState)}` } }],
      }),
    };
    await cmdCheckpoint(['--platform', originPlatform, '--session', sessionHint, '--root', root], checkpointIo);
  }

  // (4) Seal — unless the caller knows a clean seal is impossible
  // (degradedOpen: a prior death left the bundle unsealed; receive's
  // degraded-open path compensates), or the bundle is already sealed.
  const alreadySealed = bundle?.handoff?.status === 'sealed';
  if (input.degradedOpen !== true && !alreadySealed) {
    await cmdFinalize(['--reason', 'usage-limit death during a supervised loop run', '--reason-class', 'usage-limit', '--root', root], io);
  }

  // (7, ordered before receive because receive needs the target) — resolver
  // pick with the dead origin platform avoided.
  const relaunchAvoid = avoid.includes(assignment.platform) ? avoid : [...avoid, assignment.platform];
  const resolved = resolveRoles({ config, to: assignment.platform, avoid: relaunchAvoid, avoidEntries, probes: input.probes ?? null });
  const target = resolved.assignments[role];
  if (!target || target.mode === 'unavailable') {
    return {
      action: 'park',
      class: verdict.class,
      reason: `every platform is avoided or unavailable for role '${role}' — parked with a resume hint`,
      ...(verdict.resetHint ? { resumeAt: verdict.resetHint } : {}),
    };
  }

  // (5–6) Receive prepare+commit back-to-back with IDENTICAL intake and the
  // supervisor session hint. Git is re-derived fresh for each phase (exactly
  // as the CLI does), so real drift inside the window stales the token; ONE
  // automatic re-prepare retry, then park. No .handoff/loop writes anywhere.
  const receiveOpts = (/** @type {any} */ git) => ({
    platform: target.platform,
    origin: 'unknown', // defaults from the sealed bundle's recorded origin
    reason: 'unspecified', // defaults from the sealed reason
    reasonClass: 'usage-limit',
    gitSnapshot: git,
    probes: input.probes ?? null,
    sessionHint,
    sessionUnstable: false,
  });

  /** @type {string} */
  let prompt = '';
  let lastError = null;
  for (let window = 1; window <= 2; window += 1) {
    const prepGit = await gitSnapshot({ execFile: io.execFile, cwd: root, fs: io.fs });
    const prepared = prepare(root, receiveOpts(prepGit), io);
    prompt = prepared.prompt;
    const commitGit = await gitSnapshot({ execFile: io.execFile, cwd: root, fs: io.fs });
    try {
      commit(root, prepared.token, receiveOpts(commitGit), io);
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError !== null) {
    const msg = /** @type {any} */ (lastError)?.message ?? String(lastError);
    return { action: 'park', class: verdict.class, reason: `receive commit stayed stale after one re-prepare retry — ${msg}` };
  }

  // (8) Relaunch on the adopted platform with the resume prompt.
  return {
    action: 'relaunch',
    class: verdict.class,
    assignment: target,
    avoidEntries,
    prompt,
  };
}
