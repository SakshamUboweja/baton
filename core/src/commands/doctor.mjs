import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import * as realFs from 'node:fs';
import { bundlePaths } from '../bundle/store.mjs';
import { loadSignatures } from '../detect/signatures.mjs';
import { classify } from '../detect/classifier.mjs';
import { ensureDir, atomicWriteJson, safeReadJson } from '../util/fsx.mjs';
import { emitEnvelope, parseFlags } from './shared.mjs';

const BUILTIN_SIGNATURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'signatures.v1.json');

const PROBE_TIMEOUT_MS = 3000;
const PROBE_CACHE_MS = 15 * 60 * 1000;
const JOURNAL_WARN_BYTES = 5 * 1024 * 1024;
const GUARD_COMMIT_BOUND = 50;

// Noninteractive status probes per platform (docs/design/platform-notes.md CLIs).
const PROBES = [
  { platform: 'claude-code', bin: 'claude', args: ['--version'] },
  { platform: 'codex', bin: 'codex', args: ['login', 'status'] },
  { platform: 'cursor', bin: 'cursor-agent', args: ['status'] },
];

// Word-boundary-safe AI-attribution trailer patterns (plan §Attribution guard).
const TRAILER_PATTERNS = [
  /co-authored-by:[^\n]*\b(claude|gpt|copilot|codex)\b/i,
  /generated (with|by)[^\n]*\bclaude\b/i,
  /\u{1F916}/u,
];

/** @param {any} io @param {string} path @returns {string | null} */
function readOrNull(io, path) {
  try {
    return io.fs.readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Classify one probe invocation per the two-dimension record: capability is
 * the ordered ladder verified as far as the evidence goes; outcome is what the
 * probe itself did. A server-issued limit response proves authentication.
 * @param {{platform: string, bin: string, args: string[]}} probe @param {any} io @param {any} table
 */
async function runProbe(probe, io, table) {
  try {
    await io.execFile(probe.bin, probe.args, { timeout: PROBE_TIMEOUT_MS });
    return { platform: probe.platform, capability: 'reachable', outcome: 'ok' };
  } catch (err) {
    const e = /** @type {any} */ (err);
    if (e?.code === 'ENOENT') return { platform: probe.platform, capability: null, outcome: 'error' };
    if (e?.killed === true) return { platform: probe.platform, capability: 'installed', outcome: 'timeout' };
    const text = `${e?.stdout ?? ''}\n${e?.stderr ?? ''}`;
    if (table && classify({ text, exitCode: 1, platform: probe.platform, table, structured: null }).class === 'usage-limit') {
      return { platform: probe.platform, capability: 'authenticated', outcome: 'rate-limited' };
    }
    if (/authenticated as|logged in as/i.test(text) && /unreachable|ECONN|offline|network/i.test(text)) {
      return { platform: probe.platform, capability: 'authenticated', outcome: 'error' };
    }
    if (/not logged in|log ?in first|unauthorized|authenticat/i.test(text)) {
      return { platform: probe.platform, capability: 'installed', outcome: 'error' };
    }
    return { platform: probe.platform, capability: 'installed', outcome: 'error' };
  }
}

/** @param {any} io @returns {Promise<{id: string, ok: boolean, detail?: string}>} */
async function gitGuardCheck(io) {
  let log;
  try {
    log = await io.execFile('git', ['log', '-n', String(GUARD_COMMIT_BOUND), '--format=%h %s%n%n%b'], { cwd: io.cwd, timeout: 5000 });
  } catch {
    return { id: 'git-guard', ok: true, detail: 'git unavailable — commit scan skipped' };
  }
  // Chunks start at a line beginning with an abbreviated sha + space.
  const chunks = log.stdout.split(/^(?=[0-9a-f]{7,40} )/m).filter((/** @type {string} */ c) => c.trim() !== '');
  for (const chunk of chunks) {
    if (TRAILER_PATTERNS.some((re) => re.test(chunk))) {
      const sha = chunk.slice(0, chunk.indexOf(' '));
      return {
        id: 'git-guard',
        ok: false,
        detail: `commit ${sha} carries an AI attribution trailer — rewrite it before publishing (git rebase -i / git commit --amend)`,
      };
    }
  }
  return { id: 'git-guard', ok: true, detail: `no AI trailers in the last ${GUARD_COMMIT_BOUND} commits` };
}

/**
 * `baton doctor` — machine health report: attribution settings, git-guard
 * trailer scan, journal size, filesystem boundary, and per-platform probe
 * records ({capability, outcome}, 3 s bound, 15-min cache). Report-only by
 * default; `--strict` turns any failing check into exit 1.
 * @param {string[]} args @param {any} io
 * @returns {Promise<number>}
 */
export async function cmdDoctor(args, io) {
  const { flags } = parseFlags(args);
  const p = bundlePaths(io.cwd);
  /** @type {{id: string, ok: boolean, detail?: string}[]} */
  const checks = [];

  // Attribution settings: repo-level first, then the user's global file.
  const settingsText = readOrNull(io, `${io.cwd}/.claude/settings.json`) ?? readOrNull(io, `${io.env?.HOME ?? ''}/.claude/settings.json`);
  let attrOk = false;
  try {
    const s = settingsText === null ? null : JSON.parse(settingsText);
    attrOk = s?.attribution?.commit === '' && s?.attribution?.pr === '';
  } catch {
    attrOk = false;
  }
  checks.push({
    id: 'attribution-settings',
    ok: attrOk,
    detail: attrOk ? 'attribution.commit and attribution.pr are ""' : 'set {"attribution":{"commit":"","pr":""}} in .claude/settings.json (baton init does this)',
  });

  checks.push(await gitGuardCheck(io));

  const journalText = readOrNull(io, p.journal);
  const journalBytes = journalText === null ? 0 : Buffer.byteLength(journalText);
  checks.push({
    id: 'journal-size',
    ok: journalBytes <= JOURNAL_WARN_BYTES,
    detail: journalBytes > JOURNAL_WARN_BYTES ? `journal is ${(journalBytes / 1048576).toFixed(1)} MB (> 5 MB) — finalize to rotate it` : `${journalBytes} bytes`,
  });

  checks.push({
    id: 'filesystem',
    ok: true,
    detail: 'v1 supports local filesystems only — lock/rename atomicity is not guaranteed on network or cloud-sync mounts',
  });

  // Platform probes, cached 15 min in the state dir.
  const cachePath = `${p.logDir}/probe-cache.json`;
  const cached = safeReadJson(io.fs, cachePath);
  /** @type {any[]} */
  let platforms;
  if (cached.ok && typeof cached.value?.at === 'string' && Date.parse(io.now()) - Date.parse(cached.value.at) < PROBE_CACHE_MS && Array.isArray(cached.value.records)) {
    platforms = cached.value.records;
  } else {
    /** @type {any} */
    let table = null;
    try {
      // Packaged data, not repo state: read through the real fs so probes can
      // classify limit responses regardless of the injected io.fs contents.
      table = loadSignatures({ builtinPath: BUILTIN_SIGNATURES }, { fs: realFs });
    } catch {
      table = null;
    }
    platforms = [];
    for (const probe of PROBES) platforms.push(await runProbe(probe, io, table));
    ensureDir(io.fs, p.logDir);
    atomicWriteJson(io.fs, cachePath, { at: io.now(), records: platforms });
  }

  const failing = checks.filter((c) => !c.ok);
  if (flags.json) {
    emitEnvelope(io, { ok: failing.length === 0, data: { checks, platforms }, warnings: failing.map((c) => `${c.id}: ${c.detail ?? 'failed'}`) });
  } else {
    for (const c of checks) io.stdout.write(`${c.ok ? 'ok  ' : 'FAIL'} ${c.id}${c.detail ? ` — ${c.detail}` : ''}\n`);
    for (const r of platforms) io.stdout.write(`probe ${r.platform}: capability ${r.capability ?? 'not-installed'}, outcome ${r.outcome}\n`);
  }
  return flags.strict === true && failing.length > 0 ? 1 : 0;
}
