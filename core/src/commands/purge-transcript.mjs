import { bundlePaths } from '../bundle/store.mjs';
import { withLock, LockHeldError } from '../bundle/lock.mjs';
import { atomicWriteText, atomicWriteJson } from '../util/fsx.mjs';
import { checkHandoffTree } from '../util/jail.mjs';
import { emitEnvelope, resolveRoot, parseFlagsStrict, usageError } from './shared.mjs';

/**
 * Remove every property named `transcript` anywhere in a JSON value.
 * @param {any} v
 * @returns {any}
 */
function stripTranscript(v) {
  if (Array.isArray(v)) return v.map(stripTranscript);
  if (v !== null && typeof v === 'object') {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === 'transcript') continue;
      out[k] = stripTranscript(val);
    }
    return out;
  }
  return v;
}

/**
 * lstat walk (gate-2 fix 6): never follows links. The tree was jail-checked
 * before the lock, but a symlink appearing mid-walk still throws rather than
 * letting the scrub rewrite bytes outside the repository.
 * @param {any} io @param {string} dir @returns {string[]}
 */
function walk(io, dir) {
  /** @type {string[]} */
  const out = [];
  if (!io.fs.existsSync(dir)) return out;
  for (const name of io.fs.readdirSync(dir)) {
    const p = `${dir}/${name}`;
    const st = io.fs.lstatSync(p);
    if (st.isSymbolicLink()) throw new Error(`${p} is a symlink — refusing to purge through links (managed-tree jail)`);
    if (st.isDirectory()) out.push(...walk(io, p));
    else out.push(p);
  }
  return out;
}

/** @param {any} io @param {string} path */
function scrubJsonFile(io, path) {
  const raw = io.fs.readFileSync(path, 'utf8');
  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return; // unparseable snapshots are the recovery ladder's problem, not purge's
  }
  const stripped = stripTranscript(parsed);
  const next = JSON.stringify(stripped, null, 2) + '\n';
  if (JSON.stringify(stripped) !== JSON.stringify(parsed)) atomicWriteText(io.fs, path, next);
}

/** @param {any} io @param {string} path */
function scrubLinesFile(io, path) {
  const raw = io.fs.readFileSync(path, 'utf8');
  let changed = false;
  const lines = raw.split('\n').map((/** @type {string} */ line) => {
    if (line.trim() === '') return line;
    /** @type {any} */
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return line; // tolerate foreign lines verbatim
    }
    const stripped = stripTranscript(parsed);
    const next = JSON.stringify(stripped);
    if (next !== JSON.stringify(parsed)) {
      changed = true;
      return next;
    }
    return line;
  });
  if (changed) atomicWriteText(io.fs, path, lines.join('\n'));
}

/**
 * `baton purge-transcript` — scrub the opt-in transcript field from EVERY
 * retained copy under .handoff/ (active snapshot, .bak, journal, history
 * freezes + rotated journals, diagnostics log). Marker-guarded so an
 * interrupted purge resumes until the whole tree is clean; runs under the repo
 * lock so a live foreign session blocks it entirely.
 * @param {string[]} args @param {any} io
 * @returns {Promise<number>}
 */
export async function cmdPurgeTranscript(args, io) {
  const parsed = parseFlagsStrict(args, {});
  if (parsed.error !== undefined) return usageError(io, parsed.flags, 'purge-transcript', parsed.error);
  const flags = parsed.flags;
  const root = resolveRoot(io, flags);
  const p = bundlePaths(root);
  const markerPath = `${p.dir}/purge.marker.json`;

  if (!io.fs.existsSync(p.dir)) {
    if (flags.json) emitEnvelope(io, { ok: true, data: { purged: 0, note: 'no .handoff directory — nothing to purge' } });
    else io.stdout.write('purge-transcript: no .handoff directory — nothing to purge\n');
    return 0;
  }

  // Jail check BEFORE the lock: acquiring the lock mkdirs inside .handoff, so
  // a symlinked tree must be refused before any write lands through the link.
  const safe = checkHandoffTree(root, io);
  if (!safe.ok) {
    if (flags.json) emitEnvelope(io, { ok: false, error: { code: 'unsafe-tree', msg: safe.problem } });
    else io.stderr.write(`baton purge-transcript: ${safe.problem}\n`);
    return 1;
  }

  // Auto-resume (gate-2 minor 16): a leftover marker means an earlier purge
  // was interrupted mid-scrub — this run finishes the job.
  if (io.fs.existsSync(markerPath)) {
    io.stderr.write('baton purge-transcript: resuming an interrupted purge (marker found) — re-scrubbing the whole tree\n');
  }

  try {
    withLock(root, io, () => {
      atomicWriteJson(io.fs, markerPath, { startedAt: io.now() });
      for (const file of walk(io, p.dir)) {
        if (file === markerPath) continue;
        if (/\.(ndjson|jsonl)$/.test(file)) scrubLinesFile(io, file);
        else if (/\.(json|bak)$/.test(file)) scrubJsonFile(io, file);
      }
      io.fs.unlinkSync(markerPath);
    });
  } catch (err) {
    const msg = /** @type {any} */ (err)?.message ?? String(err);
    const code = err instanceof LockHeldError ? 'lock-held' : 'purge-failed';
    if (flags.json) emitEnvelope(io, { ok: false, error: { code, msg } });
    else io.stderr.write(`baton purge-transcript: ${msg}\n`);
    return 1;
  }

  if (flags.json) emitEnvelope(io, { ok: true, data: { note: 'transcript fields removed from every retained copy under .handoff/' } });
  else io.stdout.write('purge-transcript: transcript fields removed from every retained copy under .handoff/\n');
  return 0;
}
