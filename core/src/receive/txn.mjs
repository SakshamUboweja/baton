import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { loadBundle, writeSnapshotIn, rotateJournalIn } from '../bundle/store.mjs';
import { withLock } from '../bundle/lock.mjs';
import { loadConfig } from '../roles/matrix.mjs';
import { resolveRoles } from '../roles/resolve.mjs';
import { renderResumePrompt } from './prompt.mjs';
import { loadSignatures } from '../detect/signatures.mjs';
import { classify } from '../detect/classifier.mjs';
import { dedupeKey } from '../util/ids.mjs';

const BUILTIN_SIGNATURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'signatures.v1.json');
const STALE_AFTER_MS = 12 * 60 * 60 * 1000;

/** @typedef {{platform: string, origin: string, reason: string, gitSnapshot: any, probes?: any, sessionHint: string, sessionUnstable?: boolean, reasonClass?: string}} ReceiveOpts */

/**
 * Classify the switch reason, KEEPING confidence (gate-2 iter-2 M4): a
 * low-confidence heuristic (e.g. Cursor's "quota exceeded") must not silently
 * drive an avoid[] decision — the caller warns and defers to explicit intake.
 * @param {string} reason @param {string} originPlatform @param {any} io
 * @returns {{class: string | null, confidence: string | null}}
 */
function classifyReason(reason, originPlatform, io) {
  try {
    const table = loadSignatures({ builtinPath: BUILTIN_SIGNATURES }, io);
    const verdict = classify({ text: reason, exitCode: 0, platform: originPlatform, table, structured: null });
    return verdict.class === 'ok' ? { class: null, confidence: null } : { class: verdict.class, confidence: verdict.confidence };
  } catch {
    return { class: null, confidence: null };
  }
}

/**
 * The revision fingerprint the receipt token is a hash of. Every field is a
 * bound input: any drift between prepare and commit re-derives a different
 * token, so a stale receipt can never commit (plan §Concurrency).
 * @param {string} root @param {any} bundle @param {ReceiveOpts} opts @param {any} io
 */
function deriveToken(root, bundle, opts, io) {
  let configDigest = 'absent';
  try {
    configDigest = dedupeKey(io.fs.readFileSync(`${root}/baton.config.json`, 'utf8'));
  } catch {
    // no config — 'absent' is itself a bound value
  }
  return dedupeKey({
    generation: bundle.generation,
    journalSeq: bundle.journalSeq,
    // The seal state is a bound input too (gate-2 fix): a competing receiver
    // that lands between this token's derivation and its commit changes
    // status/receive_log, so the loser's token cannot re-derive.
    handoffStatus: bundle.handoff?.status ?? null,
    receives: Array.isArray(bundle.handoff?.receive_log) ? bundle.handoff.receive_log.length : 0,
    origin: opts.origin,
    reason: opts.reason,
    // Explicit --reason-class is a bound intake input (gate-2 iter-2 M4): it
    // changes the avoid[] decision, so a change between prepare and commit is
    // drift that must re-prepare.
    reasonClass: opts.reasonClass ?? null,
    configDigest,
    gitDigest: dedupeKey(opts.gitSnapshot ?? null),
    probesDigest: dedupeKey(opts.probes ?? null),
    platform: opts.platform,
    sessionHint: opts.sessionHint,
  });
}

/**
 * @param {any} bundle @param {ReceiveOpts} opts @param {any} io
 * @returns {string[]} staleness/degradation warnings
 */
function stalenessWarnings(bundle, opts, io) {
  /** @type {string[]} */
  const warnings = [];
  if (bundle.handoff.status === 'open') {
    warnings.push('source bundle is unsealed (open) — the handoff was never finalized; treating this as a degraded (limit-death) receive');
  }
  const ref = bundle.handoff.finalizedAt ?? bundle.updatedAt;
  const ageMs = Date.parse(io.now()) - Date.parse(ref);
  if (Number.isFinite(ageMs) && ageMs > STALE_AFTER_MS) {
    warnings.push(`bundle finalized ${Math.round(ageMs / 3_600_000)}h ago (staleness threshold 12h) — re-verify before continuing`);
  }
  const g = opts.gitSnapshot;
  if (g && bundle.git) {
    if (bundle.git.headSha !== g.headSha) {
      warnings.push(`HEAD moved since capture: bundle recorded ${bundle.git.headSha}, working tree now ${g.headSha}`);
    }
    if (bundle.git.dirty !== g.dirty) {
      warnings.push(`dirty-state mismatch: bundle captured dirty=${bundle.git.dirty}, working tree now dirty=${g.dirty}`);
    }
  }
  return warnings;
}

/**
 * Phase 1 of the receive transaction: validate, resolve roles, render the
 * resume prompt, and return a one-time receipt token. Mutates NOTHING — the
 * token is self-contained (a fingerprint hash), never a persisted record.
 * @param {string} root @param {ReceiveOpts} opts @param {any} io
 * @returns {{token: string, prompt: string, assignments: Record<string, any>, warnings: string[]}}
 */
export function prepare(root, opts, io) {
  const { bundle, warnings: loadWarnings } = loadBundle(root, io);
  if (bundle === null) throw new Error(`no handoff bundle under ${root}/.handoff — nothing to receive`);

  const warnings = [...loadWarnings, ...stalenessWarnings(bundle, opts, io)];

  const { config, errors } = loadConfig(root, io);
  /** @type {Record<string, any>} */
  let assignments = {};
  if (config) {
    // The dead origin comes from the BUNDLE first (its sealed reasonClass and
    // recorded origin platform); typed intake only fills the gaps — a user
    // should not need to retype the verbatim limit string to keep roles off
    // the platform that died (gate-2 reviewer-b finding 4). Confidence gates
    // auto-avoidance (gate-2 iter-2 M4): an explicit --reason-class or a sealed
    // reasonClass is trusted; a live text classification only auto-avoids at
    // medium+ confidence, else it warns and defers to explicit intake.
    let reasonClass;
    let confidence;
    if (typeof opts.reasonClass === 'string') {
      reasonClass = opts.reasonClass;
      confidence = 'high'; // explicit user intake
    } else if (typeof bundle.handoff?.reasonClass === 'string') {
      reasonClass = bundle.handoff.reasonClass;
      confidence = 'high'; // trusted seal
    } else {
      const v = classifyReason(opts.reason, opts.origin, io);
      reasonClass = v.class;
      confidence = v.confidence;
    }
    const deadOrigin =
      typeof bundle.origin?.platform === 'string' && bundle.origin.platform !== 'unknown' ? bundle.origin.platform : opts.origin;
    /** @type {string[]} */
    let avoid = [];
    if (reasonClass === 'usage-limit') {
      if (confidence === 'low') {
        warnings.push(
          `the switch reason matched a usage-limit heuristic only at LOW confidence — not auto-avoiding ${deadOrigin}; pass --reason-class usage-limit to confirm the failover away from it`,
        );
      } else {
        avoid = [deadOrigin];
      }
    }
    assignments = resolveRoles({ config, to: opts.platform, avoid, nativeOnly: false, probes: opts.probes ?? null }).assignments;
  } else {
    warnings.push(`role matrix unavailable (${errors.map((e) => e.msg).join('; ')}) — no role table in this prompt`);
  }

  const prompt = renderResumePrompt({ bundle, assignments, warnings, origin: opts.origin, reason: opts.reason });
  return { token: deriveToken(root, bundle, opts, io), prompt, assignments, warnings };
}

/**
 * Phase 2: one atomic transition. Re-derives every bound input from current
 * disk state + opts and rejects ANY drift (throws, zero mutation). On match:
 * writes the received seal, archives it via a 'receive' rotation, then opens a
 * fresh writable generation owned by the receiving platform/session.
 * @param {string} root @param {string} token @param {ReceiveOpts} opts @param {any} io
 * @returns {{adopted: boolean, generation: number, archivedTo: string}}
 */
export function commit(root, token, opts, io) {
  // ONE operation-scoped lock across revalidation and every mutation (gate-2
  // fix: reviewers a#1/b#11): two competing receivers serialize here, and the
  // loser's re-derivation sees the winner's generation/status/receive_log.
  return withLock(root, io, (fence) => commitLocked(root, token, opts, io, fence));
}

/**
 * @param {string} root @param {string} token @param {ReceiveOpts} opts @param {any} io @param {string} fence
 * @returns {{adopted: boolean, generation: number, archivedTo: string}}
 */
function commitLocked(root, token, opts, io, fence) {
  const { bundle } = loadBundle(root, io);
  if (bundle === null) throw new Error(`no handoff bundle under ${root}/.handoff — nothing to receive; run receive --prepare first`);

  if (deriveToken(root, bundle, opts, io) !== token) {
    throw new Error(
      'receipt token is stale: a bound input (bundle revision, intake, config, git state, probes, or target platform/session) drifted since prepare — run re-prepare and retry',
    );
  }

  const degraded = bundle.handoff.status !== 'sealed';
  const receiveEntry = {
    origin: opts.origin,
    reason: opts.reason,
    at: io.now(),
    ...(degraded ? { degradedSeal: true } : {}),
  };

  // The degraded seal must NOT persist a LOW-confidence classification (iter-3
  // F10): a sealed reasonClass is trusted as high-confidence by the next
  // prepare, so laundering a low-confidence heuristic here would silently
  // auto-avoid the origin one hop later. Explicit intake is high-confidence and
  // seals; a live classification seals ONLY at medium+ confidence, else null
  // (the next receive re-classifies the reason text at its true confidence).
  let sealedReasonClass = null;
  if (degraded) {
    if (typeof opts.reasonClass === 'string') {
      sealedReasonClass = opts.reasonClass;
    } else {
      const v = classifyReason(opts.reason, opts.origin, io);
      sealedReasonClass = v.confidence === 'low' ? null : v.class;
    }
  }

  const receivedSeal = {
    ...bundle,
    updatedAt: io.now(),
    handoff: {
      ...bundle.handoff,
      status: 'received',
      ...(degraded
        ? {
            reason: opts.reason,
            reasonClass: sealedReasonClass,
            finalizedAt: io.now(),
          }
        : {}),
      receive_log: [...bundle.handoff.receive_log, receiveEntry],
    },
  };

  // Freeze order: the received seal is written first so the 'receive' rotation
  // archives exactly that state (never the pre-commit bundle). All three
  // mutations run under the SAME lock acquisition, fence-checked per write.
  writeSnapshotIn(root, receivedSeal, io, fence);
  const archivedTo = rotateJournalIn(root, 'receive', io, fence);

  const { config } = loadConfig(root, io);
  const next = {
    ...receivedSeal,
    generation: bundle.generation + 1,
    origin: {
      platform: opts.platform,
      model: config?.defaults?.[opts.platform] ?? 'unknown',
      sessionHint: opts.sessionHint,
      unstable: opts.sessionUnstable === true,
    },
    handoff: { ...receivedSeal.handoff, status: 'open' },
  };
  writeSnapshotIn(root, next, io, fence);

  return { adopted: true, generation: next.generation, archivedTo };
}
