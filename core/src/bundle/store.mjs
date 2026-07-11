import { atomicWriteText, safeReadJson, backupThenWrite, ensureDir, atomicWriteJson } from '../util/fsx.mjs';
import { appendEntry, readAllTolerant } from '../util/jsonl.mjs';
import { emptyBundle, validateBundle } from './schema.mjs';
import { applyEvent } from './merge.mjs';
import { renderHandoffMd } from './render.mjs';
import { withLock } from './lock.mjs';

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
 * Reconcile a leftover rotation marker (crash recovery, part of load — not
 * lock-gated). Roll forward when the history freeze landed, else roll back.
 * @param {any} io @param {ReturnType<typeof bundlePaths>} p @param {string[]} warnings
 */
function reconcileMarker(io, p, warnings) {
  const mp = markerPath(p);
  if (!io.fs.existsSync(mp)) return;
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
 * rotation-marker reconciliation is part of load.
 * @param {string} root @param {any} io
 * @returns {{bundle: any | null, warnings: string[]}}
 */
export function loadBundle(root, io) {
  const p = bundlePaths(root);
  /** @type {string[]} */
  const warnings = [];
  if (!io.fs.existsSync(p.dir)) return { bundle: null, warnings };

  reconcileMarker(io, p, warnings);

  let bundle = resolveBase(io, p, warnings);
  if (bundle === null) return { bundle: null, warnings };

  if (io.fs.existsSync(p.journal)) {
    const { entries, warnings: jw } = readAllTolerant(io.fs, p.journal);
    for (const w of jw) {
      warnings.push(`journal line ${w.line}: ${w.kind}${w.kind === 'seq-order' ? ` (prev ${w.prev}, got ${w.seq})` : ''}`);
    }
    for (const e of entries) {
      if (typeof e.seq === 'number' && e.seq <= bundle.journalSeq) continue;
      bundle = applyEvent(bundle, e);
    }
  }
  return { bundle, warnings };
}

/**
 * Persist a snapshot: back up the previous good one, write atomically, render
 * HANDOFF.md alongside. Mutation — runs under the repo lock.
 * @param {string} root @param {any} bundle @param {any} io
 */
export function writeSnapshot(root, bundle, io) {
  const p = bundlePaths(root);
  return withLock(root, io, () => {
    ensureDir(io.fs, p.dir);
    backupThenWrite(io.fs, p.snapshot, JSON.stringify(bundle, null, 2) + '\n');
    atomicWriteText(io.fs, p.handoffMd, renderHandoffMd(bundle));
  });
}

/**
 * Append one journal entry under the repo lock. A pre-numbered entry keeps its
 * seq; a seq-less entry is allocated max(snapshot.journalSeq, journal tail) + 1.
 * @param {string} root @param {any} entry @param {any} io
 * @returns {number} the entry's (possibly allocated) seq
 */
export function appendJournal(root, entry, io) {
  const p = bundlePaths(root);
  return withLock(root, io, () => {
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
  });
}

/**
 * Crash-safe journal rotation (marker → freeze → rename → fresh journal →
 * clear marker), with 10-per-kind history retention. Mutation — lock-gated.
 * @param {string} root @param {'finalize'|'takeover'|'receive'} kind @param {any} io
 * @returns {string} the history stem for this rotation
 */
export function rotateJournal(root, kind, io) {
  const p = bundlePaths(root);
  return withLock(root, io, () => {
    ensureDir(io.fs, p.dir);
    const startedAt = io.now();
    const stem = `${tsForFile(startedAt)}.${kind}`;
    const snap = safeReadJson(io.fs, p.snapshot);
    const seq = snap.ok && typeof snap.value?.journalSeq === 'number' ? snap.value.journalSeq : 0;

    atomicWriteJson(io.fs, markerPath(p), { kind, startedAt, seq });
    ensureDir(io.fs, p.historyDir);

    if (io.fs.existsSync(p.snapshot)) {
      io.fs.copyFileSync(p.snapshot, `${p.historyDir}/${stem}.json`);
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
