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
 * Effective intake: the sealed bundle already records who handed off and why,
 * so the 'unknown'/'unspecified' CLI sentinels default from it (audit finding:
 * the documented resume command rendered "Handed off from unknown" straight
 * after sealing a real origin/reason). Explicit intake always wins. Pure and
 * bundle-deterministic, so prepare and commit derive identical tokens.
 * @param {any} bundle @param {ReceiveOpts} opts @returns {ReceiveOpts}
 */
function effectiveIntake(bundle, opts) {
  const originSentinel = opts.origin === 'unknown' || opts.origin === undefined;
  const reasonSentinel = opts.reason === 'unspecified' || opts.reason === undefined;
  const sealedOrigin = typeof bundle?.origin?.platform === 'string' && bundle.origin.platform !== 'unknown' ? bundle.origin.platform : null;
  const sealedReason = typeof bundle?.handoff?.reason === 'string' && bundle.handoff.reason.length > 0 ? bundle.handoff.reason : null;
  return {
    ...opts,
    origin: originSentinel && sealedOrigin ? sealedOrigin : opts.origin,
    reason: reasonSentinel && sealedReason ? sealedReason : opts.reason,
  };
}

// The bound token inputs, in the fixed order the structured token serializes
// them. The human names power drift diagnosis: a stale-token rejection names
// exactly which input(s) moved instead of listing six guesses.
const TOKEN_FIELDS = /** @type {const} */ ([
  ['generation', 'bundle generation'],
  ['journalSeq', 'journal seq'],
  ['handoffStatus', 'handoff status'],
  ['receives', 'receive count'],
  ['origin', 'intake origin'],
  ['reason', 'intake reason'],
  ['reasonClass', 'intake reason-class'],
  ['configDigest', 'config'],
  ['gitDigest', 'git state'],
  ['probesDigest', 'probe cache'],
  ['platform', 'target platform'],
  ['sessionHint', 'target session'],
]);
const TOKEN_PREFIX = 'rcpt1';

/**
 * The revision fingerprint the receipt token derives from. Every field is a
 * bound input: any drift between prepare and commit re-derives a different
 * token, so a stale receipt can never commit (plan §Concurrency).
 * @param {string} root @param {any} bundle @param {ReceiveOpts} opts @param {any} io
 * @returns {Record<string, any>}
 */
function tokenInputs(root, bundle, opts, io) {
  let configDigest = 'absent';
  try {
    configDigest = dedupeKey(io.fs.readFileSync(`${root}/baton.config.json`, 'utf8'));
  } catch {
    // no config — 'absent' is itself a bound value
  }
  return {
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
  };
}

/**
 * Structured receipt token: a fixed-order join of per-input digests. Equality
 * still gates commit exactly as the old opaque hash did; the structure only
 * buys DIAGNOSIS — a mismatch can name the drifted input(s).
 * @param {string} root @param {any} bundle @param {ReceiveOpts} opts @param {any} io
 */
function deriveToken(root, bundle, opts, io) {
  const inputs = tokenInputs(root, bundle, opts, io);
  return `${TOKEN_PREFIX}.` + TOKEN_FIELDS.map(([key]) => dedupeKey(inputs[key] ?? null).slice(0, 10)).join('.');
}

/**
 * Name the inputs whose digests differ between two structured tokens.
 * @param {string} presented @param {string} expected @returns {string[]}
 */
function driftedInputs(presented, expected) {
  const a = presented.split('.');
  const b = expected.split('.');
  if (a[0] !== TOKEN_PREFIX || b[0] !== TOKEN_PREFIX || a.length !== b.length) return [];
  return TOKEN_FIELDS.filter((_, i) => a[i + 1] !== b[i + 1]).map(([, name]) => name);
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
  opts = effectiveIntake(bundle, opts);

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
 * @returns {{adopted: boolean, generation: number, archivedTo: string | null, alreadyCommitted?: boolean}}
 */
export function commit(root, token, opts, io) {
  // ONE operation-scoped lock across revalidation and every mutation (gate-2
  // fix: reviewers a#1/b#11): two competing receivers serialize here, and the
  // loser's re-derivation sees the winner's generation/status/receive_log.
  return withLock(root, io, (fence) => commitLocked(root, token, opts, io, fence));
}

/**
 * @param {string} root @param {string} token @param {ReceiveOpts} opts @param {any} io @param {string} fence
 * @returns {{adopted: boolean, generation: number, archivedTo: string | null, alreadyCommitted?: boolean}}
 */
function commitLocked(root, token, opts, io, fence) {
  const { bundle } = loadBundle(root, io);
  if (bundle === null) throw new Error(`no handoff bundle under ${root}/.handoff — nothing to receive; run receive --prepare first`);
  opts = effectiveIntake(bundle, opts);

  const expected = deriveToken(root, bundle, opts, io);
  if (expected !== token) {
    // Idempotency first (audit finding: duplicate-receive corruption): if THIS
    // exact receipt already landed — its digest is recorded on a receive_log
    // entry — the retry is a lost-output re-send, not drift. Report success
    // with zero mutation instead of sending the model into a re-prepare +
    // re-commit loop that executes a second full receive.
    const receipt = dedupeKey(token).slice(0, 16);
    const landed = Array.isArray(bundle.handoff?.receive_log) && bundle.handoff.receive_log.some((/** @type {any} */ e) => e?.receipt === receipt);
    if (landed) {
      return { adopted: false, alreadyCommitted: true, generation: bundle.generation, archivedTo: null };
    }
    const drifted = driftedInputs(token, expected);
    const detail = drifted.length > 0 ? `drifted input(s): ${drifted.join(', ')}` : 'a bound input drifted since prepare';
    throw new Error(
      `receipt token is stale — ${detail}. Re-prepare and retry, passing the SAME intake flags (--origin/--reason/--reason-class) to both prepare and --commit`,
    );
  }

  const degraded = bundle.handoff.status !== 'sealed';
  const receiveEntry = {
    origin: opts.origin,
    reason: opts.reason,
    at: io.now(),
    // The receipt digest keys the idempotent-retry detection above.
    receipt: dedupeKey(token).slice(0, 16),
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
    // The fresh writable generation has NO switch reason yet (iter-4 I3): the
    // sealed reason/reasonClass/finalizedAt/toPlatformHint describe the PRIOR
    // handoff, not this one. Carrying them forward made the next prepare trust a
    // stale class as a high-confidence seal (silently auto-avoiding the healthy
    // adopted origin) and poisoned both the 12 h staleness reference and the
    // sessionStart limit-hit signal. Keep only receive_log (the audit chain).
    handoff: { ...receivedSeal.handoff, status: 'open', reason: null, reasonClass: null, finalizedAt: null, toPlatformHint: null },
  };
  writeSnapshotIn(root, next, io, fence);

  return { adopted: true, generation: next.generation, archivedTo };
}
