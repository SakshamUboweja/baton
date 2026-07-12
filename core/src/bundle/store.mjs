import { atomicWriteText, safeReadJson, ensureDir, atomicWriteJson } from '../util/fsx.mjs';
import { appendEntry, readAllTolerant } from '../util/jsonl.mjs';
import { checkHandoffTree, assertHandoffTreeSafe } from '../util/jail.mjs';
import { emptyBundle, validateBundle } from './schema.mjs';
import { applyEvent } from './merge.mjs';
import { compact } from './compact.mjs';
import { renderHandoffMd } from './render.mjs';
import { withLock, guardedWrite, LockHeldError } from './lock.mjs';

const RETAIN_PER_KIND = 10;

/** @param {string} root */
export function bundlePaths(root) {
  const dir = `${root}/.handoff`;
  return {
    dir,
    snapshot: `${dir}/bundle.json`,
    bak: `${dir}/bundle.json.bak`,
    journal: `${dir}/journal.ndjson`,
    handoffMd: `${dir}/HANDOFF.md`,
    historyDir: `${dir}/history`,
    lockDir: `${dir}/lock`,
    logDir: `${dir}/log`,
  };
}

/** @param {string} iso */
const tsForFile = (iso) => iso.replace(/[:.]/g, '-');

/** @param {ReturnType<typeof bundlePaths>} p */
const markerPath = (p) => `${p.dir}/rotation.marker.json`;

/**
 * Reconcile a leftover rotation marker (crash recovery, part of load). The
 * mutations run under the repo lock, acquired WITHOUT waiting (gate-2 minor
 * 16): a held lock means someone is mid-operation — reconciliation defers to
 * the next unlocked load instead of writing behind their back.
 * @param {any} io @param {ReturnType<typeof bundlePaths>} p @param {string[]} warnings @param {string} root
 */
function reconcileMarker(io, p, warnings, root) {
  const mp = markerPath(p);
  if (!io.fs.existsSync(mp)) return;
  try {
    withLock(root, { ...io, lockRetry: { attempts: 0, delayMs: 0 } }, () => {
      if (!io.fs.existsSync(mp)) return; // a competitor reconciled while we acquired
      const marker = safeReadJson(io.fs, mp);
      if (!marker.ok) {
        io.fs.unlinkSync(mp);
        warnings.push('rotation marker was unparseable — rolled the rotation back (marker cleared, journal preserved)');
        return;
      }
      const stem = `${tsForFile(marker.value.startedAt)}.${marker.value.kind}`;
      const freeze = `${p.historyDir}/${stem}.json`;
      const rotated = `${p.historyDir}/${stem}.ndjson`;

      if (io.fs.existsSync(freeze)) {
        // Roll forward: finish whichever step the crash interrupted.
        if (io.fs.existsSync(p.journal) && !io.fs.existsSync(rotated)) {
          io.fs.renameSync(p.journal, rotated);
        }
        if (!io.fs.existsSync(p.journal)) {
          atomicWriteText(io.fs, p.journal, '');
        }
        io.fs.unlinkSync(mp);
        warnings.push(`completed an interrupted rotation (roll-forward of ${stem}); marker cleared`);
      } else {
        io.fs.unlinkSync(mp);
        warnings.push(`aborted an incomplete rotation (roll-back; ${stem} freeze never landed); marker cleared, journal preserved`);
      }
    });
  } catch (err) {
    if (err instanceof LockHeldError) {
      warnings.push('a rotation marker is present but the repo lock is held — reconciliation deferred to the next unlocked load');
      return;
    }
    throw err;
  }
}

/**
 * @param {any} io @param {ReturnType<typeof bundlePaths>} p @param {string[]} warnings
 * @returns {any | null} a usable base bundle, or null when nothing exists
 */
function resolveBase(io, p, warnings) {
  const snapshotExists = io.fs.existsSync(p.snapshot);
  if (snapshotExists) {
    const snap = safeReadJson(io.fs, p.snapshot);
    if (snap.ok && validateBundle(snap.value).ok) return snap.value;
    warnings.push(
      snap.ok
        ? 'snapshot bundle.json failed schema validation — attempting recovery'
        : `snapshot bundle.json is unreadable (${snap.error}) — attempting recovery`,
    );
    const bak = safeReadJson(io.fs, p.bak);
    if (bak.ok && validateBundle(bak.value).ok) {
      warnings.push('recovered from backup bundle.json.bak; replaying journal past its journalSeq');
      return bak.value;
    }
    if (io.fs.existsSync(p.bak)) warnings.push('backup bundle.json.bak is also unusable');
    if (io.fs.existsSync(p.journal)) {
      warnings.push('rebuilding the bundle by replaying the whole journal over a fresh seed (recovery of last resort)');
      return emptyBundle({ platform: 'unknown', model: 'unknown', goal: 'unknown (rebuilt from journal)' }, io.now());
    }
    return null;
  }
  if (io.fs.existsSync(p.journal)) {
    warnings.push('no snapshot present — rebuilding the bundle from the journal');
    return emptyBundle({ platform: 'unknown', model: 'unknown', goal: 'unknown (rebuilt from journal)' }, io.now());
  }
  return null;
}

/**
 * Load the active bundle with full crash recovery. Read path — not lock-gated;
 * rotation-marker reconciliation is part of load. A managed tree that fails
 * the symlink/realpath jail (gate-2 fix 6) is refused outright: bundle null,
 * `unsafe: true`, and the problem in warnings — callers must not treat this as
 * "no bundle yet" and seed through the link.
 * @param {string} root @param {any} io
 * @returns {{bundle: any | null, warnings: string[], unsafe?: boolean}}
 */
export function loadBundle(root, io) {
  const p = bundlePaths(root);
  /** @type {string[]} */
  const warnings = [];
  if (!io.fs.existsSync(p.dir)) return { bundle: null, warnings };

  const safe = checkHandoffTree(root, io);
  if (!safe.ok) return { bundle: null, warnings: [safe.problem], unsafe: true };

  reconcileMarker(io, p, warnings, root);

  // An interrupted purge is visible on every read path (gate-2 minor 16): the
  // tree may still hold transcript copies until purge-transcript finishes.
  if (io.fs.existsSync(`${p.dir}/purge.marker.json`)) {
    warnings.push('an interrupted purge left its marker — run baton purge-transcript to finish scrubbing every retained copy');
  }

  let bundle = resolveBase(io, p, warnings);
  if (bundle === null) return { bundle: null, warnings };

  if (io.fs.existsSync(p.journal)) {
    const { entries, warnings: jw } = readAllTolerant(io.fs, p.journal);
    for (const w of jw) {
      warnings.push(`journal line ${w.line}: ${w.kind}${w.kind === 'seq-order' ? ` (prev ${w.prev}, got ${w.seq})` : ''}`);
    }
    for (const e of entries) {
      // Envelope guard (gate-2 iter-2 B4): a parseable but non-object line
      // (null, number, bare string) is not an event — skip it with a warning
      // rather than crash replay on `e.seq` / `e.dedupeKey`.
      if (e === null || typeof e !== 'object' || Array.isArray(e)) {
        warnings.push('skipped a malformed journal line (not an event envelope)');
        continue;
      }
      if (typeof e.seq === 'number' && e.seq <= bundle.journalSeq) continue;
      bundle = applyEvent(bundle, e);
    }
  }
  return { bundle, warnings };
}

/**
 * Lock-context snapshot write: caller already holds the repo lock and passes
 * its fencing token; the write is fence-checked immediately before landing
 * (the fast-abort layer — gate-2 fix, reviewer-b finding 12).
 * @param {string} root @param {any} bundle @param {any} io @param {string} token
 */
export function writeSnapshotIn(root, bundle, io, token) {
  const p = bundlePaths(root);
  return guardedWrite(root, io, token, () => {
    assertHandoffTreeSafe(root, io);
    ensureDir(io.fs, p.dir);
    // Size discipline runs in the write path itself (gate-2 fix 10): every
    // persisted snapshot is within budget; identity for in-budget bundles.
    const bounded = compact(bundle);
    // Validate-before-backup (gate-2 major 15): a corrupt current snapshot
    // must never overwrite a good .bak — the backup only rotates when the
    // outgoing snapshot itself would be recoverable.
    const prev = safeReadJson(io.fs, p.snapshot);
    if (prev.ok && validateBundle(prev.value).ok) {
      atomicWriteText(io.fs, p.bak, io.fs.readFileSync(p.snapshot, 'utf8'));
    }
    atomicWriteText(io.fs, p.snapshot, JSON.stringify(bounded, null, 2) + '\n');
    atomicWriteText(io.fs, p.handoffMd, renderHandoffMd(bounded));
  });
}

/**
 * Persist a snapshot: back up the previous good one, write atomically, render
 * HANDOFF.md alongside. Mutation — runs under the repo lock.
 * @param {string} root @param {any} bundle @param {any} io
 */
export function writeSnapshot(root, bundle, io) {
  return withLock(root, io, (token) => writeSnapshotIn(root, bundle, io, token));
}

/**
 * Append one journal entry under the repo lock. A pre-numbered entry keeps its
 * seq; a seq-less entry is allocated max(snapshot.journalSeq, journal tail) + 1.
 * @param {string} root @param {any} entry @param {any} io
 * @returns {number} the entry's (possibly allocated) seq
 */
export function appendJournal(root, entry, io) {
  const p = bundlePaths(root);
  return withLock(root, io, (token) =>
    guardedWrite(root, io, token, () => {
      assertHandoffTreeSafe(root, io);
      ensureDir(io.fs, p.dir);
      let seq = entry.seq;
      let toAppend = entry;
      if (typeof seq !== 'number') {
        const snap = safeReadJson(io.fs, p.snapshot);
        const snapSeq = snap.ok && typeof snap.value?.journalSeq === 'number' ? snap.value.journalSeq : 0;
        let tailSeq = 0;
        if (io.fs.existsSync(p.journal)) {
          for (const e of readAllTolerant(io.fs, p.journal).entries) {
            if (typeof e.seq === 'number' && e.seq > tailSeq) tailSeq = e.seq;
          }
        }
        seq = Math.max(snapSeq, tailSeq) + 1;
        toAppend = { ...entry, seq };
      }
      appendEntry(io.fs, p.journal, toAppend);
      return seq;
    }),
  );
}

/**
 * Crash-safe journal rotation (marker → freeze → rename → fresh journal →
 * clear marker), with 10-per-kind history retention. Mutation — lock-gated.
 * @param {string} root @param {'finalize'|'takeover'|'receive'} kind @param {any} io
 * @returns {string} the history stem for this rotation
 */
export function rotateJournal(root, kind, io) {
  return withLock(root, io, (token) => rotateJournalIn(root, kind, io, token));
}

/**
 * Lock-context rotation: caller holds the lock and passes its fencing token.
 * @param {string} root @param {'finalize'|'takeover'|'receive'} kind @param {any} io @param {string} token
 * @returns {string} the history stem for this rotation
 */
export function rotateJournalIn(root, kind, io, token) {
  const p = bundlePaths(root);
  return guardedWrite(root, io, token, () => {
    assertHandoffTreeSafe(root, io);
    ensureDir(io.fs, p.dir);
    const startedAt = io.now();
    const stem = `${tsForFile(startedAt)}.${kind}`;
    const snap = safeReadJson(io.fs, p.snapshot);
    const seq = snap.ok && typeof snap.value?.journalSeq === 'number' ? snap.value.journalSeq : 0;

    atomicWriteJson(io.fs, markerPath(p), { kind, startedAt, seq });
    ensureDir(io.fs, p.historyDir);

    if (io.fs.existsSync(p.snapshot)) {
      // Atomic freeze (gate-2 minor 16): tmp+rename, so a crash mid-copy can
      // never leave a partial history snapshot that recovery would trust.
      atomicWriteText(io.fs, `${p.historyDir}/${stem}.json`, io.fs.readFileSync(p.snapshot, 'utf8'));
    } else {
      atomicWriteText(io.fs, `${p.historyDir}/${stem}.json`, '');
    }
    if (io.fs.existsSync(p.journal)) {
      io.fs.renameSync(p.journal, `${p.historyDir}/${stem}.ndjson`);
    } else {
      atomicWriteText(io.fs, `${p.historyDir}/${stem}.ndjson`, '');
    }
    atomicWriteText(io.fs, p.journal, '');

    // Retention: newest RETAIN_PER_KIND per kind (ISO-derived stems sort by time).
    const freezes = io.fs
      .readdirSync(p.historyDir)
      .filter((/** @type {string} */ n) => n.endsWith(`.${kind}.json`))
      .sort();
    while (freezes.length > RETAIN_PER_KIND) {
      const oldest = /** @type {string} */ (freezes.shift());
      const oldStem = oldest.slice(0, -'.json'.length);
      for (const suffix of ['.json', '.ndjson']) {
        try {
          io.fs.unlinkSync(`${p.historyDir}/${oldStem}${suffix}`);
        } catch {
          // already absent — retention is best-effort per file
        }
      }
    }

    io.fs.unlinkSync(markerPath(p));
    return stem;
  });
}
