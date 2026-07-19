/**
 * Loop run state — snapshot + journal + replay for the Layer-2 supervisor,
 * mirroring the bundle store's crash-tolerance idioms (atomic tmp+rename
 * snapshots, torn-tail-tolerant NDJSON, seq-dedup replay). Everything lives
 * under <root>/.handoff/loop/; the supervisor is the sole writer. Plan:
 * docs/plans/2026-07-18-goal-loop-worktree-pipeline.md §"baton loop",
 * §"Smoke gate", §"Supervisor lifetime and recovery", §"Caps".
 */
import { appendEntry, readAllTolerant } from '../util/jsonl.mjs';
import { atomicWriteJson, safeReadJson, ensureDir } from '../util/fsx.mjs';
import { dedupeKey } from '../util/ids.mjs';

export const LOOP_STATE_SCHEMA = 'baton/loop-state@1';

/** The frozen status vocabulary. */
export const LOOP_STATUS = Object.freeze({
  RUNNING: 'running',
  AWAITING_SMOKE_APPROVAL: 'awaiting-smoke-approval',
  PARKED: 'parked',
  ESCALATED: 'escalated',
  DONE: 'done',
});

/** The frozen journal event vocabulary. */
export const LOOP_EVENT = Object.freeze({
  PHASE_ADVANCE: 'phase-advance',
  GATE_ITERATION: 'gate-iteration',
  ESCALATE: 'escalate',
  PARK: 'park',
  RESUME: 'resume',
  SMOKE_AWAIT: 'smoke-await',
  SMOKE_APPROVE: 'smoke-approve',
});

// Every gate loops at most 5 times — a repo-wide hard invariant (AGENTS.md
// §Review gates); the reducer refuses a 6th and escalates instead.
const GATE_ITERATION_CAP = 5;

/** @param {string} root */
export function loopPaths(root) {
  const dir = `${root}/.handoff/loop`;
  return { dir, state: `${dir}/state.json`, journal: `${dir}/journal.ndjson` };
}

/**
 * Fresh run state — pure and deterministic from the injected io (identity
 * facts + clock only; no Date.now/Math.random, which would break replay).
 * @param {any} spec a VALIDATED loop spec @param {any} io
 */
export function initLoopState(spec, io) {
  const runId = `loop-${dedupeKey({ host: io.host, pid: io.pid, startTime: io.startTime, at: io.now() }).slice(0, 12)}`;
  /** @type {Record<string, number>} */
  const iterations = {};
  for (const p of spec.phases ?? []) {
    if (/gate/.test(String(p.id))) iterations[p.id] = 0;
  }
  return {
    schema: LOOP_STATE_SCHEMA,
    runId,
    goal: spec.goal,
    phaseCount: Array.isArray(spec.phases) ? spec.phases.length : 0,
    phaseIndex: 0,
    iterations,
    status: LOOP_STATUS.RUNNING,
    parkReason: null,
    escalation: null,
    smokeApproval: null,
    createdAt: io.now(),
    journalSeq: 0,
  };
}

/**
 * The pure transition reducer. Never mutates its input; unknown events and
 * refused transitions return the input state unchanged (a new reference is
 * only produced for a real transition).
 * @param {any} state @param {any} ev
 */
export function applyLoopEvent(state, ev) {
  switch (ev?.type) {
    case LOOP_EVENT.PHASE_ADVANCE: {
      const next = state.phaseIndex + 1;
      if (next >= state.phaseCount) return { ...state, phaseIndex: state.phaseCount, status: LOOP_STATUS.DONE };
      return { ...state, phaseIndex: next };
    }
    case LOOP_EVENT.GATE_ITERATION: {
      const gate = String(ev.gate);
      const current = state.iterations?.[gate] ?? 0;
      // The 6th attempt is REFUSED: the counter stays at the cap and the run
      // escalates with a record naming the gate — never a 6th run.
      if (current >= GATE_ITERATION_CAP) {
        return { ...state, status: LOOP_STATUS.ESCALATED, escalation: { gate, iteration: current } };
      }
      return { ...state, iterations: { ...state.iterations, [gate]: current + 1 } };
    }
    case LOOP_EVENT.ESCALATE: {
      // Supervisors enforce spec caps LOWER than the hard invariant; this
      // event persists that escalation (dogfood finding D7: a cap-3 pipeline
      // exit left state.json 'running' because only the reducer's own 5-cap
      // could flip the status). Idempotent — an already-escalated run keeps
      // its original record.
      if (state.status === LOOP_STATUS.ESCALATED) return state;
      const gate = String(ev.gate);
      return { ...state, status: LOOP_STATUS.ESCALATED, escalation: { gate, iteration: state.iterations?.[gate] ?? 0 } };
    }
    case LOOP_EVENT.PARK:
      return { ...state, status: LOOP_STATUS.PARKED, parkReason: ev.reason ?? null };
    case LOOP_EVENT.RESUME:
      // Only a PARK is resumable; an escalation is an operator decision.
      if (state.status !== LOOP_STATUS.PARKED) return state;
      return { ...state, status: LOOP_STATUS.RUNNING, parkReason: null };
    case LOOP_EVENT.SMOKE_AWAIT:
      return { ...state, status: LOOP_STATUS.AWAITING_SMOKE_APPROVAL };
    case LOOP_EVENT.SMOKE_APPROVE: {
      // Guarded transition: only meaningful while awaiting, and only with the
      // caller's verifySmokeToken result stamped verified === true. A missing
      // or false `verified` is unverified — it never resumes the run.
      if (state.status !== LOOP_STATUS.AWAITING_SMOKE_APPROVAL) return state;
      if (ev.verified !== true) return state;
      return { ...state, status: LOOP_STATUS.RUNNING, smokeApproval: { token: ev.token, at: ev.ts ?? null } };
    }
    default:
      return state;
  }
}

/**
 * Atomic snapshot write (tmp + rename under .handoff/loop).
 * @param {string} root @param {any} state @param {any} io
 */
export async function writeLoopState(root, state, io) {
  const p = loopPaths(root);
  ensureDir(io.fs, p.dir);
  atomicWriteJson(io.fs, p.state, state);
}

/**
 * Append one journal event; allocates the next seq past
 * max(snapshot.journalSeq, journal tail) unless the entry carries one.
 * @param {string} root @param {any} ev @param {any} io
 * @returns {Promise<number>} the persisted seq
 */
export async function appendLoopEvent(root, ev, io) {
  const p = loopPaths(root);
  ensureDir(io.fs, p.dir);
  let seq = ev.seq;
  if (typeof seq !== 'number') {
    const snap = safeReadJson(io.fs, p.state);
    const snapSeq = snap.ok && typeof snap.value?.journalSeq === 'number' ? snap.value.journalSeq : 0;
    let tailSeq = 0;
    if (io.fs.existsSync(p.journal)) {
      for (const e of readAllTolerant(io.fs, p.journal).entries) {
        if (typeof e.seq === 'number' && e.seq > tailSeq) tailSeq = e.seq;
      }
    }
    seq = Math.max(snapSeq, tailSeq) + 1;
  }
  const ts = typeof ev.ts === 'string' ? ev.ts : io.now();
  const entry = {
    ...ev,
    seq,
    ts,
    dedupeKey: typeof ev.dedupeKey === 'string' && ev.dedupeKey.length > 0 ? ev.dedupeKey : dedupeKey({ seq, ts, type: ev.type, gate: ev.gate ?? null }),
  };
  appendEntry(io.fs, p.journal, entry);
  return seq;
}

/**
 * Load = snapshot + torn-tail-tolerant replay of journal events PAST the
 * snapshot's seq. Duplicate seqs/dedupeKeys apply exactly once, so a
 * supervisor-death recovery never re-runs a completed iteration.
 * @param {string} root @param {any} io
 * @returns {Promise<{state: any, warnings: string[]}>}
 */
export async function loadLoopState(root, io) {
  const p = loopPaths(root);
  /** @type {string[]} */
  const warnings = [];
  const snap = safeReadJson(io.fs, p.state);
  if (!snap.ok) return { state: null, warnings: ['no loop state snapshot found'] };
  let state = snap.value;
  const baseSeq = typeof state.journalSeq === 'number' ? state.journalSeq : 0;

  if (io.fs.existsSync(p.journal)) {
    const { entries, warnings: jw } = readAllTolerant(io.fs, p.journal);
    for (const w of jw ?? []) warnings.push(`journal: ${w.kind ?? 'warning'} at line ${w.line ?? '?'}`);
    const applied = new Set();
    let maxSeq = baseSeq;
    for (const e of entries) {
      const seq = typeof e.seq === 'number' ? e.seq : null;
      if (seq !== null && seq <= baseSeq) continue; // already folded into the snapshot
      const key = e.dedupeKey ?? (seq !== null ? `seq:${seq}` : null);
      if (key !== null && applied.has(key)) continue; // replayed duplicate — apply once
      if (seq !== null && applied.has(`seq:${seq}`)) continue;
      state = applyLoopEvent(state, e);
      if (key !== null) applied.add(key);
      if (seq !== null) {
        applied.add(`seq:${seq}`);
        if (seq > maxSeq) maxSeq = seq;
      }
    }
    state = { ...state, journalSeq: maxSeq };
  }
  return { state, warnings };
}

// ---------------------------------------------------------------------------
// Smoke-approval token — a STRUCTURED digest over the six bound inputs, so a
// stale approval is refused NAMING what moved (mirrors the receive receipt
// token's driftedInputs discipline).
// ---------------------------------------------------------------------------

const SMOKE_TOKEN_PREFIX = 'smk1';
const SMOKE_TOKEN_FIELDS = /** @type {const} */ ([
  'stateDigest',
  'smokeCmd',
  'smokeOutputDigest',
  'gitHead',
  'gitContentDigest',
  'childAssignment',
]);

/**
 * Deterministic structured token. Per-field digests keep field boundaries
 * (no concatenation collisions) and let verification name drifted inputs.
 * Missing bound fields throw — a token over partial inputs is meaningless.
 * @param {Record<string, string>} inputs
 * @returns {string}
 */
export function smokeApprovalToken(inputs) {
  for (const f of SMOKE_TOKEN_FIELDS) {
    if (typeof inputs?.[f] !== 'string') throw new Error(`smoke approval token: required input '${f}' is missing`);
  }
  return `${SMOKE_TOKEN_PREFIX}.` + SMOKE_TOKEN_FIELDS.map((f) => dedupeKey(inputs[f]).slice(0, 10)).join('.');
}

/**
 * Recompute against current inputs; positional comparison names every
 * drifted input. Never throws — partial current inputs simply cannot verify.
 * @param {string} presented @param {Record<string, string>} inputs
 * @returns {{ok: true} | {ok: false, driftedInputs: string[]}}
 */
export function verifySmokeToken(presented, inputs) {
  /** @type {string} */
  let current;
  try {
    current = smokeApprovalToken(inputs);
  } catch {
    return { ok: false, driftedInputs: SMOKE_TOKEN_FIELDS.filter((f) => typeof inputs?.[f] !== 'string') };
  }
  if (presented === current) return { ok: true };
  const a = String(presented ?? '').split('.');
  const b = current.split('.');
  /** @type {string[]} */
  const drifted = [];
  SMOKE_TOKEN_FIELDS.forEach((f, i) => {
    if (a[i + 1] !== b[i + 1]) drifted.push(f);
  });
  return { ok: false, driftedInputs: drifted.length > 0 ? drifted : [...SMOKE_TOKEN_FIELDS] };
}
