import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import * as realFs from 'node:fs';
import { bundlePaths } from '../bundle/store.mjs';
import { loadSignatures } from '../detect/signatures.mjs';
import { classify } from '../detect/classifier.mjs';
import { PROBE_CACHE_MS } from '../roles/availability.mjs';
import { ensureDir, atomicWriteJson, safeReadJson } from '../util/fsx.mjs';
import { readAllTolerant } from '../util/jsonl.mjs';
import { checkHandoffTree } from '../util/jail.mjs';
import { emitEnvelope, parseFlags, resolveRoot } from './shared.mjs';

const BUILTIN_SIGNATURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'signatures.v1.json');

const PROBE_TIMEOUT_MS = 3000;
const JOURNAL_WARN_BYTES = 5 * 1024 * 1024;
const GUARD_COMMIT_BOUND = 50;

// Compatibility policy (plan §Compatibility; gate-2 major 13): documented
// floors are ENFORCED for codex/cursor (below-floor = hooks unavailable →
// protocol-only Tier C); the support claim is CAPPED at the versions this
// build was verified against — newer gets an info line, never a failure.
/** @type {Record<string, string>} */
const VERSION_BINS = { 'claude-code': 'claude', codex: 'codex', cursor: 'cursor-agent' };
/** @type {Record<string, {floor: string | null, label: string | null}>} */
const FLOORS = {
  'claude-code': { floor: '2.1', label: '2.1' }, // StopFailure hook documented on the 2.1 line (task-0 snapshot)
  codex: { floor: '0.144', label: '0.144' }, // lifecycle hooks landed in 0.144
  cursor: { floor: '2026.5', label: '2026.05' },
};
/** @type {Record<string, string>} */
const TESTED = { 'claude-code': '2.1.201', codex: '0.144.1', cursor: '2026.05.01' };

/** @param {any} text @returns {string | null} */
const parseVersion = (text) => String(text).match(/\d+(?:\.\d+)+/)?.[0] ?? null;

/** Numeric segment-wise version compare: negative when a < b. */
function cmpVersions(/** @type {string} */ a, /** @type {string} */ b) {
  const as = a.split('.').map(Number);
  const bs = b.split('.').map(Number);
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const d = (as[i] ?? 0) - (bs[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** @param {string} platform @param {any} io @returns {Promise<string | null>} */
async function versionOf(platform, io) {
  try {
    const r = await io.execFile(VERSION_BINS[platform], ['--version'], { timeout: PROBE_TIMEOUT_MS });
    return parseVersion(`${r.stdout ?? ''} ${r.stderr ?? ''}`);
  } catch {
    return null;
  }
}

/** @param {string} platform @param {string | null} v @returns {{id: string, ok: boolean, detail: string}} */
function versionCheck(platform, v) {
  const id = `version-${platform}`;
  if (v === null) {
    return { id, ok: true, detail: `${VERSION_BINS[platform]} version unverifiable (not installed or --version unsupported) — floor not enforced` };
  }
  const f = FLOORS[platform];
  if (f.floor && cmpVersions(v, f.floor) < 0) {
    return { id, ok: false, detail: `${platform} ${v} is below the supported floor ${f.label} — lifecycle hooks unavailable; the adapter degrades to protocol-only (Tier C)` };
  }
  if (cmpVersions(v, TESTED[platform]) > 0) {
    return { id, ok: true, detail: `${platform} ${v} is newer than tested (${TESTED[platform]}) — untested; signature drift is absorbed by the overlay table` };
  }
  return { id, ok: true, detail: `${platform} ${v} (tested ${TESTED[platform]})` };
}

/**
 * Codex/Cursor hook surface: installed / enabled / trusted / observed-executing.
 * `installed` = the hooks file references baton at all; `enabled` = the
 * mechanical-checkpoint hook (the `checkpointEvent` key: codex `Stop`, cursor
 * `stop`) actually DECLARES a `baton checkpoint` invocation (iter-5 A3 — not
 * merely that the file mentions baton somewhere); `trusted` is not externally
 * verifiable (Codex per-hash trust / Cursor workspace trust) → 'unknown';
 * `observed` = a mechanical checkpoint sourced from this platform is in the
 * journal (the canary the checkpoint hook actually ran). The ≤1-turn
 * mechanical-staleness fidelity claim is gated on enabled AND observed.
 * @param {any} io @param {string} root @param {any} p bundlePaths
 * @param {string} platform @param {string} relPath @param {string} checkpointEvent @param {string} trustNote
 */
function hookSurfaceCheck(io, root, p, platform, relPath, checkpointEvent, trustNote) {
  const id = `${platform}-hooks`;
  let text = null;
  try {
    text = io.fs.readFileSync(`${root}/${relPath}`, 'utf8');
  } catch {
    text = null;
  }
  const installed = text !== null && text.includes('baton');
  if (!installed) {
    return {
      id,
      ok: true,
      states: { installed: false, enabled: false, trusted: 'unknown', observed: false },
      detail: `not installed — run 'baton init --${platform}' to write ${relPath}`,
    };
  }
  // enabled: the checkpoint hook itself is declared with a `baton checkpoint`
  // command — a file that mentions baton only in (say) a session-start hook is
  // installed but NOT checkpoint-enabled.
  let enabled = false;
  try {
    const cfg = JSON.parse(/** @type {string} */ (text));
    const hookDef = cfg?.hooks?.[checkpointEvent];
    enabled = hookDef !== undefined && /baton\s+checkpoint/.test(JSON.stringify(hookDef));
  } catch {
    enabled = false;
  }
  // observed: a mechanical checkpoint sourced from THIS platform is recorded
  // (writerId `${platform}-…`; lock notes are `lock-…` and excluded), i.e. the
  // checkpoint hook actually executed.
  let observed = false;
  try {
    for (const e of readAllTolerant(io.fs, p.journal).entries) {
      if (String(e?.writerId ?? '').startsWith(`${platform}-`) || e?.source === platform) {
        observed = true;
        break;
      }
    }
  } catch {
    observed = false;
  }
  const states = { installed: true, enabled, trusted: 'unknown', observed };
  // The ≤1-turn claim needs the checkpoint hook DECLARED (enabled) AND OBSERVED —
  // neither alone suffices.
  const fidelityHolds = enabled && observed;
  const enabledNote = enabled ? `${checkpointEvent} checkpoint hook enabled` : `${checkpointEvent} checkpoint hook NOT declared (enabled=false)`;
  return {
    id,
    ok: true,
    states,
    detail: fidelityHolds
      ? `installed, ${enabledNote}; trusted=unknown (not externally verifiable); execution OBSERVED (canary) — the ≤1-turn mechanical-staleness claim holds`
      : `installed, ${enabledNote}; trusted=unknown — ${trustNote}; ${observed ? 'execution observed but' : 'execution not yet observed —'} the ≤1-turn fidelity claim is gated on the ${checkpointEvent} canary + enablement`,
  };
}

// Noninteractive status probes per platform (docs/design/platform-notes.md CLIs).
// capOnSuccess caps what a clean exit PROVES (gate-2 iter-2 M3): `claude
// --version` proves the binary is INSTALLED, not that the server was reached or
// that auth is valid, so its capability is capped at "installed". The codex/
// cursor probes are auth-checking status commands, so a clean exit legitimately
// proves "reachable".
const PROBES = [
  { platform: 'claude-code', bin: 'claude', args: ['--version'], capOnSuccess: 'installed' },
  { platform: 'codex', bin: 'codex', args: ['login', 'status'], capOnSuccess: 'reachable' },
  { platform: 'cursor', bin: 'cursor-agent', args: ['status'], capOnSuccess: 'reachable' },
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
 * @param {{platform: string, bin: string, args: string[], capOnSuccess?: string}} probe @param {any} io @param {any} table
 */
async function runProbe(probe, io, table) {
  try {
    await io.execFile(probe.bin, probe.args, { timeout: PROBE_TIMEOUT_MS });
    return { platform: probe.platform, capability: probe.capOnSuccess ?? 'reachable', outcome: 'ok' };
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

/** @param {any} io @param {string} root @returns {Promise<{id: string, ok: boolean, detail?: string}>} */
async function gitGuardCheck(io, root) {
  let log;
  try {
    log = await io.execFile('git', ['log', '-n', String(GUARD_COMMIT_BOUND), '--format=%h %s%n%n%b'], { cwd: root, timeout: 5000 });
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
  const root = resolveRoot(io, flags);
  const p = bundlePaths(root);
  /** @type {{id: string, ok: boolean, detail?: string}[]} */
  const checks = [];

  // Attribution settings: repo-level first, then the user's global file.
  const settingsText = readOrNull(io, `${root}/.claude/settings.json`) ?? readOrNull(io, `${io.env?.HOME ?? ''}/.claude/settings.json`);
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

  checks.push(await gitGuardCheck(io, root));

  const journalText = readOrNull(io, p.journal);
  const journalBytes = journalText === null ? 0 : Buffer.byteLength(journalText);
  checks.push({
    id: 'journal-size',
    ok: journalBytes <= JOURNAL_WARN_BYTES,
    detail: journalBytes > JOURNAL_WARN_BYTES ? `journal is ${(journalBytes / 1048576).toFixed(1)} MB (> 5 MB) — finalize to rotate it` : `${journalBytes} bytes`,
  });


  // Platform probes + version probes + mount detection: every non-git child
  // invocation rides the same 15-min cache in the state dir.
  const cachePath = `${p.logDir}/probe-cache.json`;
  const cached = safeReadJson(io.fs, cachePath);
  /** @type {any[]} */
  let platforms;
  /** @type {Record<string, string | null>} */
  let versions;
  /** @type {string | null} */
  let mountSource;
  if (cached.ok && typeof cached.value?.at === 'string' && Date.parse(io.now()) - Date.parse(cached.value.at) < PROBE_CACHE_MS && Array.isArray(cached.value.records)) {
    platforms = cached.value.records;
    versions = cached.value.versions ?? {};
    mountSource = cached.value.mount ?? null;
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
    versions = {};
    for (const platform of Object.keys(VERSION_BINS)) versions[platform] = await versionOf(platform, io);
    mountSource = null;
    try {
      const df = await io.execFile('df', ['-P', root], { timeout: 2000 });
      mountSource = ((df.stdout ?? '').split('\n')[1] ?? '').trim().split(/\s+/)[0] || null;
    } catch {
      mountSource = null;
    }
    // Jail before writing the probe cache (iter-3 F4): the cache rides
    // .handoff/log, so a symlinked .handoff or log dir must never redirect the
    // write outside the repository (threat model). Diagnostics are best-effort —
    // on an unsafe tree we simply skip caching; the atomic write already
    // prevents a torn cache under concurrent doctors.
    if (checkHandoffTree(root, io).ok) {
      ensureDir(io.fs, p.logDir);
      atomicWriteJson(io.fs, cachePath, { at: io.now(), records: platforms, versions, mount: mountSource });
    }
  }

  // Network-filesystem detection (gate-2 major 13): a mount source that looks
  // like SMB/NFS fails the check; unverifiable degrades to the static boundary.
  if (mountSource === null) {
    checks.push({
      id: 'filesystem',
      ok: true,
      detail: 'mount type unverifiable — v1 supports local filesystems only; lock/rename atomicity is not guaranteed on network or cloud-sync mounts',
    });
  } else if (/^\/\/|@|^[A-Za-z0-9_.-]+:\//.test(mountSource)) {
    checks.push({
      id: 'filesystem',
      ok: false,
      detail: `${mountSource} looks like a network mount — lock/rename atomicity is not guaranteed there; v1 supports local filesystems only`,
    });
  } else {
    checks.push({ id: 'filesystem', ok: true, detail: `local mount (${mountSource}) — note: v1 supports local filesystems only` });
  }

  // Version floors + tested cap, and the hook trust/canary surfaces.
  for (const platform of Object.keys(VERSION_BINS)) {
    checks.push(versionCheck(platform, versions[platform] ?? null));
  }
  checks.push(hookSurfaceCheck(io, root, p, 'codex', '.codex/hooks.json', 'Stop', 'trust review may be pending (run /hooks inside Codex to trust the definitions)'));
  checks.push(hookSurfaceCheck(io, root, p, 'cursor', '.cursor/hooks.json', 'stop', 'project hooks require a trusted workspace in Cursor'));

  const failing = checks.filter((c) => !c.ok);
  if (flags.json) {
    emitEnvelope(io, { ok: failing.length === 0, data: { checks, platforms }, warnings: failing.map((c) => `${c.id}: ${c.detail ?? 'failed'}`) });
  } else {
    for (const c of checks) io.stdout.write(`${c.ok ? 'ok  ' : 'FAIL'} ${c.id}${c.detail ? ` — ${c.detail}` : ''}\n`);
    for (const r of platforms) io.stdout.write(`probe ${r.platform}: capability ${r.capability ?? 'not-installed'}, outcome ${r.outcome}\n`);
  }
  return flags.strict === true && failing.length > 0 ? 1 : 0;
}
