import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeIo } from '../helpers/fakeio.mjs';
import { cmdDoctor } from '../../core/src/commands/doctor.mjs';
import { bundlePaths } from '../../core/src/bundle/store.mjs';

// ---------------------------------------------------------------------------
// Command-level contract for core/src/commands/doctor.mjs. Direct import over a
// fakeio whose execFile is REPLACED with a responder (doctor probes platforms
// and scans git via the async injected execFile, so cmdDoctor is async).
//
// TARGET MODULE: core/src/commands/doctor.mjs (sole target — its absence is the
// only reason this file is RED). doctor internally consumes git/guard.mjs,
// git/snapshot.mjs and the probe layer; this file imports ONLY doctor and drives
// everything through it (git/guard.mjs is NOT a Wave-D target, so it is exercised
// through doctor, never imported here).
//
// Source of truth: plan §Role matrix "Availability probing" (doctor probes each
// platform noninteractively, HARD 3s bound per probe, results cached 15 min;
// probe record = two SEPARATE dimensions: capability {installed→authenticated→
// reachable} recorded as far as verifiable, and outcome {ok|rate-limited|error|
// timeout}); §Attribution guard layer 2 (doctor scans the LAST 50 COMMITS for AI
// co-author/generated-with trailers, WORD-BOUNDARY-safe, and flags with
// remediation); §"Journal rotation" (doctor warns at journal > 5 MB);
// §"Filesystem support boundary" (doctor detects + warns on network/shared
// mounts); §CLI contract (--strict exit).
//
// PINS (where the spec left the command surface open — the implementer conforms):
//   D1. SIGNATURE: cmdDoctor(args, io) -> Promise<number>. --json emits exactly
//       one compact {ok,data,warnings,error} envelope on stdout.
//   D2. --json data carries CHECKS and per-platform PROBE RECORDS. Shape is read
//       tolerantly (array of {id, ok, detail?} OR a map for checks; array of
//       {platform, capability, outcome, ...} OR a map for platforms), so the
//       exact container is not over-pinned; what IS pinned:
//         - a check whose id matches /attribution/ reflects the .claude/
//           settings.json attribution state (ok when commit==="" && pr==="");
//         - a check whose id matches /guard|commit|trailer/ is the AI-trailer
//           commit scan;
//         - a check whose id matches /journal/ warns when the journal > 5 MB;
//         - a check whose id matches /filesystem|network|mount|fs/ exists;
//         - EVERY platform record exposes BOTH dimensions: `capability` ∈
//           {installed, authenticated, reachable} (the ordered cumulative
//           ladder; verifier fold F5) and `outcome` ∈ {ok, rate-limited, error,
//           timeout}. A not-installed platform may fall below the ladder; every
//           INSTALLED platform's capability must be one of the three rungs.
//   D3. PROBES ARE TIME-BOUNDED: every probe (non-git) execFile call is invoked
//       with an options object carrying timeout <= 3000 (the hard 3 s bound),
//       mirroring git/snapshot.mjs's timeout:5000 convention.
//   D4. PROBES ARE CACHED ~15 min: a SECOND doctor run within the window makes
//       ZERO new probe (non-git) execFile calls (cache reuse via io.fs), while a
//       run AFTER the window re-probes. (The cache lives under io.fs so it
//       persists across calls; its exact path is left to the implementer.)
//   D5. GIT-GUARD is WORD-BOUNDARY-safe: a commit carrying a "Co-Authored-By:
//       Claude" trailer is flagged (its sha surfaces in the envelope); a history
//       whose only "Claude"-ish token is the name "Claudette Smith" is NOT
//       flagged. doctor scans FULL commit messages (subject + body), where
//       trailers live, and (verifier fold F6) the scan is BOUNDED to the last 50
//       commits — the git log invocation must carry `-n 50` / `-n50` /
//       `--max-count=50` / `--max-count 50` (any of these forms).
//   D6. --strict EXIT: without --strict doctor is report-only (exit 0 even with
//       findings); with --strict a failing check (e.g. a flagged AI trailer)
//       exits non-zero (1). An all-green machine exits 0 either way.
//   D7. PROBE STAGING (verifier fold F5 — the fixture oracle, pinned here since
//       the plan names the dimensions but not the probe wire protocol):
//       doctor probes each platform by invoking its CLI binary noninteractively
//       via io.execFile — `claude` for claude-code, `codex` for codex,
//       `cursor-agent` for cursor (the local CLIs named in docs/design/
//       platform-notes.md; multiple calls per binary are permitted, all answered
//       identically by the fixture). The probe result is classified from the
//       invocation result:
//         - clean resolution                        -> capability 'reachable', outcome 'ok'
//         - output matching /not logged in|log ?in first|unauthorized|authenticat/i
//                                                   -> capability 'installed' (auth
//                                                      unverifiable), outcome != 'ok'
//         - output matching the platform's limit signatures (signatures.v1.json,
//           e.g. "You've hit your usage limit")     -> outcome 'rate-limited'
//           (a server-issued limit response also PROVES auth: capability is at
//           least 'authenticated')
//         - output with auth evidence (/authenticated as|logged in as/i) plus a
//           network failure (/unreachable|ECONN|offline|network/i)
//                                                   -> capability 'authenticated',
//                                                      outcome 'error'
//         - a rejection shaped like an execFile timeout kill (err.killed === true)
//                                                   -> outcome 'timeout'
//         - any other rejection                     -> outcome 'error'
// ---------------------------------------------------------------------------

const ROOT = '/repo';
const paths = bundlePaths(ROOT);
const NOW = '2026-07-11T00:00:00.000Z';
const plus = (base, ms) => new Date(Date.parse(base) + ms).toISOString();

const ATTR_OK = JSON.stringify({ attribution: { commit: '', pr: '' } }, null, 2);

// A git log whose parser sees full commit messages. One commit carries a real
// AI co-author trailer (its sha must be flagged); the rest are clean.
const GIT_LOG_DIRTY =
  'a1b2c3d4 Implement the parser\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n\n' +
  'c4d5e6f7 Refactor utils\n\nA routine change with no trailer.\n';

// Word-boundary control: "Claudette Smith" contains "Claude" as a prefix but is
// NOT an AI-attribution trailer — a \bClaude\b-style scan must NOT flag it.
const GIT_LOG_CLAUDETTE =
  'b2c3d4e5 Add greeting helper\n\nThanks to Claudette Smith for the bug report.\n\n' +
  'e5f6a7b8 Tidy tests\n\nNo attribution here.\n';

const GIT_LOG_CLEAN = 'f0f0f0f0 Initial commit\n\nClean history.\n';

// The pinned platform -> probe binary mapping (D7).
const BIN_FOR = { 'claude-code': 'claude', codex: 'codex', cursor: 'cursor-agent' };

/** Answer one probe invocation according to its staged behavior kind (D7). */
function respondProbe(kind, resolve, reject) {
  switch (kind) {
    case 'ok':
      return resolve({ stdout: 'ok\n', stderr: '' });
    case 'auth-fail': {
      const e = new Error('Command failed');
      e.code = 1;
      e.stdout = '';
      e.stderr = 'Error: not logged in — run the login flow first\n';
      return reject(e);
    }
    case 'net-fail': {
      const e = new Error('Command failed');
      e.code = 1;
      e.stdout = '';
      e.stderr = 'Authenticated as user@example.test, but the service is unreachable (ECONNREFUSED)\n';
      return reject(e);
    }
    case 'rate-limited': {
      const e = new Error('Command failed');
      e.code = 1;
      e.stdout = '';
      e.stderr = "You've hit your usage limit. Please try again at 3pm.\n";
      return reject(e);
    }
    case 'timeout': {
      const e = new Error('timed out');
      e.killed = true;
      e.signal = 'SIGTERM';
      return reject(e);
    }
    case 'error': {
      const e = new Error('Command failed');
      e.code = 1;
      e.stdout = '';
      e.stderr = 'fatal: unexpected internal error\n';
      return reject(e);
    }
    default:
      return resolve({ stdout: 'ok\n', stderr: '' });
  }
}

/**
 * Build a doctor io: fakeio for fs/stdout, but execFile REPLACED with a
 * responder that answers git subcommands from `gitLog`/clean fixtures and
 * treats every non-git command as a platform probe answered per `probes`
 * (a map of binary basename -> behavior kind; default all 'ok').
 * io.__calls records {cmd, args, opts}.
 */
function makeDoctorIo({ files = {}, gitLog = GIT_LOG_CLEAN, now = NOW, probes = {} } = {}) {
  const io = makeIo({ files, env: { HOME: '/home/user' }, now });
  const calls = [];
  io.__calls = calls;
  io.execFile = (cmd, args = [], opts = {}) => {
    calls.push({ cmd, args: [...args], opts });
    return new Promise((resolve, reject) => {
      if (cmd === 'git') {
        const sub = args[0];
        if (sub === 'log') return resolve({ stdout: gitLog, stderr: '' });
        if (sub === 'rev-parse') return resolve({ stdout: args.includes('HEAD') && !args.includes('--abbrev-ref') ? 'f0f0f0f0\n' : 'main\n', stderr: '' });
        return resolve({ stdout: '', stderr: '' });
      }
      // Non-git command === a platform probe; behavior keyed on the binary basename.
      const bin = String(cmd).split('/').pop();
      return respondProbe(probes[bin] ?? 'ok', resolve, reject);
    });
  };
  return io;
}

const probeCalls = (io) => io.__calls.filter((c) => c.cmd !== 'git');

/** Parse the single compact --json envelope and check its wire shape. */
function envelope(io) {
  const parsed = JSON.parse(io.stdoutText());
  assert.equal(io.stdoutText(), JSON.stringify(parsed) + '\n', 'stdout is exactly one compact envelope + newline');
  assert.ok('ok' in parsed && 'data' in parsed && 'warnings' in parsed && 'error' in parsed, 'envelope carries ok/data/warnings/error');
  return parsed;
}

/** Normalize data.checks (array of {id,ok} OR a map) to an array of {id, ok, ...}. */
function checkList(env) {
  const c = env.data && env.data.checks;
  if (Array.isArray(c)) return c;
  if (c && typeof c === 'object') return Object.entries(c).map(([id, v]) => ({ id, ...(v && typeof v === 'object' ? v : { ok: v }) }));
  return [];
}
const findCheck = (env, re) => checkList(env).find((c) => re.test(String(c.id)));

/** Normalize data.platforms (array OR map) to an array of records. */
function platformRecords(env) {
  const p = env.data && env.data.platforms;
  if (Array.isArray(p)) return p;
  if (p && typeof p === 'object') return Object.entries(p).map(([platform, v]) => ({ platform, ...(v && typeof v === 'object' ? v : {}) }));
  return [];
}
const recordFor = (env, platform) => platformRecords(env).find((r) => r.platform === platform);

const LADDER = ['installed', 'authenticated', 'reachable'];
const OUTCOMES = ['ok', 'rate-limited', 'error', 'timeout'];

const ATTR_FILES = { [`${ROOT}/.claude/settings.json`]: ATTR_OK, ['/home/user/.claude/settings.json']: ATTR_OK };

// ===========================================================================
describe('doctor — envelope + check aggregation', () => {
  it('--json emits one compact envelope carrying checks and per-platform probe records', async () => {
    const io = makeDoctorIo({ files: { ...ATTR_FILES } });
    const code = await cmdDoctor(['--json'], io);
    assert.equal(code, 0, `an all-green machine exits 0; stderr: ${io.stderrText()}`);

    const env = envelope(io);
    assert.ok(checkList(env).length > 0, 'doctor reports a set of checks');

    assert.ok(findCheck(env, /attribution/), 'an attribution-settings check is present');
    assert.ok(findCheck(env, /guard|commit|trailer/), 'a git-guard commit-scan check is present');
    assert.ok(findCheck(env, /journal/), 'a journal-size check is present');
    assert.ok(findCheck(env, /filesystem|network|mount|fs/), 'a filesystem check is present');
  });

  it('reports the four per-hook states distinctly: installed/enabled/trusted/observed (iter-4 I5)', async () => {
    // Not installed → every state false.
    const io0 = makeDoctorIo({ files: { ...ATTR_FILES } });
    await cmdDoctor(['--json'], io0);
    const s0 = findCheck(envelope(io0), /codex-hooks/).states;
    assert.deepEqual(s0, { installed: false, enabled: false, trusted: 'unknown', observed: false });

    // Installed (hooks.json references baton), no canary yet → trusted unknown, observed false.
    const io1 = makeDoctorIo({ files: { ...ATTR_FILES, [`${ROOT}/.codex/hooks.json`]: '{"hooks":{"Stop":"node baton.mjs checkpoint"}}' } });
    await cmdDoctor(['--json'], io1);
    const s1 = findCheck(envelope(io1), /codex-hooks/).states;
    assert.equal(s1.installed, true);
    assert.equal(s1.enabled, true);
    assert.equal(s1.trusted, 'unknown', 'trust is not externally verifiable');
    assert.equal(s1.observed, false, 'no canary yet');

    // Installed + a journal entry from codex → observed true (fidelity canary).
    const journal = JSON.stringify({ seq: 1, ts: NOW, type: 'note', source: 'codex', payload: { text: 'ran' } }) + '\n';
    const io2 = makeDoctorIo({ files: { ...ATTR_FILES, [`${ROOT}/.codex/hooks.json`]: '{"hooks":{"Stop":"node baton.mjs checkpoint"}}', [`${ROOT}/.handoff/journal.ndjson`]: journal } });
    await cmdDoctor(['--json'], io2);
    const s2 = findCheck(envelope(io2), /codex-hooks/).states;
    assert.equal(s2.observed, true, 'a codex-sourced journal entry is the observed canary');
  });

  it('reports the four states for the cursor hook surface too (iter-4 I5)', async () => {
    // Same shared reporter, but pin cursor explicitly so a future divergence is caught.
    const io = makeDoctorIo({ files: { ...ATTR_FILES, [`${ROOT}/.cursor/hooks.json`]: '{"version":1,"hooks":{"stop":"node baton.mjs checkpoint"}}' } });
    await cmdDoctor(['--json'], io);
    const s = findCheck(envelope(io), /cursor-hooks/).states;
    assert.equal(s.installed, true);
    assert.equal(s.enabled, true);
    assert.equal(s.trusted, 'unknown');
    assert.equal(s.observed, false);
  });
});

// ===========================================================================
describe('doctor — per-platform probe records expose BOTH dimensions (F5)', () => {
  it('with every probe healthy: outcome is "ok"; capability reflects what each probe PROVES (gate-2 iter-2 M3)', async () => {
    const io = makeDoctorIo({ files: { ...ATTR_FILES } });
    await cmdDoctor(['--json'], io);
    const records = platformRecords(envelope(io));
    assert.ok(records.length >= 3, 'the three platforms each get a probe record');
    for (const r of records) {
      assert.ok(LADDER.includes(r.capability), `${r.platform}: capability must be a ladder rung (${LADDER.join('→')}); got ${JSON.stringify(r.capability)}`);
      assert.ok(OUTCOMES.includes(r.outcome), `${r.platform}: outcome must be one of ${OUTCOMES.join('|')}; got ${JSON.stringify(r.outcome)}`);
      assert.equal(r.outcome, 'ok', `${r.platform}: a clean probe outcome is ok`);
    }
    const cap = Object.fromEntries(records.map((/** @type {any} */ r) => [r.platform, r.capability]));
    // claude-code's probe is `claude --version` — a clean exit proves only that
    // the binary is INSTALLED, not that the server was reached or auth is valid.
    assert.equal(cap['claude-code'], 'installed', 'a --version probe proves installed, never reachable/authenticated');
    // codex/cursor probes are auth-checking status commands → a clean exit reaches.
    assert.equal(cap.codex, 'reachable', 'a clean auth-status probe verifies the full ladder');
    assert.equal(cap.cursor, 'reachable', 'a clean auth-status probe verifies the full ladder');
  });

  it('probe fixtures A: installed-only (auth failure), rate-limited (proves auth), reachable (clean)', async () => {
    const io = makeDoctorIo({
      files: { ...ATTR_FILES },
      probes: { [BIN_FOR['claude-code']]: 'auth-fail', [BIN_FOR.codex]: 'rate-limited', [BIN_FOR.cursor]: 'ok' },
    });
    await cmdDoctor(['--json'], io);
    const env = envelope(io);

    const cc = recordFor(env, 'claude-code');
    assert.equal(cc.capability, 'installed', 'an auth failure stops the ladder at installed (auth unverifiable)');
    assert.notEqual(cc.outcome, 'ok', 'an auth-failed probe is not outcome ok');
    assert.ok(OUTCOMES.includes(cc.outcome));

    const cx = recordFor(env, 'codex');
    assert.equal(cx.outcome, 'rate-limited', 'a server-issued limit response records outcome rate-limited');
    assert.ok(['authenticated', 'reachable'].includes(cx.capability), 'a rate-limit response proves at least authenticated');

    const cu = recordFor(env, 'cursor');
    assert.equal(cu.capability, 'reachable', 'a clean probe verifies reachable');
    assert.equal(cu.outcome, 'ok');
  });

  it('probe fixtures B: authenticated-but-unreachable, timeout, error', async () => {
    const io = makeDoctorIo({
      files: { ...ATTR_FILES },
      probes: { [BIN_FOR['claude-code']]: 'net-fail', [BIN_FOR.codex]: 'timeout', [BIN_FOR.cursor]: 'error' },
    });
    await cmdDoctor(['--json'], io);
    const env = envelope(io);

    const cc = recordFor(env, 'claude-code');
    assert.equal(cc.capability, 'authenticated', 'auth evidence + a network failure stops the ladder at authenticated');
    assert.equal(cc.outcome, 'error', 'the failed reach attempt is outcome error');

    const cx = recordFor(env, 'codex');
    assert.equal(cx.outcome, 'timeout', 'a killed (3s-bound) probe records outcome timeout');
    assert.ok(LADDER.includes(cx.capability), 'capability is still recorded as far as verifiable');

    const cu = recordFor(env, 'cursor');
    assert.equal(cu.outcome, 'error', 'a generic probe failure records outcome error');
    assert.ok(LADDER.includes(cu.capability));
  });
});

// ===========================================================================
describe('doctor — probes are time-bounded and cached', () => {
  it('every probe execFile call carries a timeout <= 3000 (the hard 3s bound)', async () => {
    const io = makeDoctorIo({ files: { ...ATTR_FILES } });
    await cmdDoctor(['--json'], io);
    const probes = probeCalls(io);
    assert.ok(probes.length > 0, 'doctor actually probes the platforms');
    for (const c of probes) {
      assert.equal(typeof c.opts.timeout, 'number', `probe ${c.cmd} must pass a numeric timeout`);
      assert.ok(c.opts.timeout <= 3000, `probe ${c.cmd} timeout must be <= 3000; got ${c.opts.timeout}`);
    }
  });

  it('a second run within the cache window makes ZERO new probe calls; a run past 15 min re-probes', async () => {
    const io = makeDoctorIo({ files: { ...ATTR_FILES } });

    await cmdDoctor(['--json'], io);
    const afterFirst = probeCalls(io).length;
    assert.ok(afterFirst > 0, 'the first run probes');

    // Second run, same clock (well within 15 min): must reuse the cache.
    await cmdDoctor(['--json'], io);
    assert.equal(probeCalls(io).length, afterFirst, 'a cached second run makes no new probe calls (15-min cache reuse)');

    // Third run, clock advanced past the window: cache expired -> re-probe.
    io.setNow(plus(NOW, 16 * 60 * 1000));
    await cmdDoctor(['--json'], io);
    assert.ok(probeCalls(io).length > afterFirst, 'a run past the 15-min window re-probes');
  });
});

// ===========================================================================
describe('doctor — attribution-settings check', () => {
  it('passes when settings carry attribution.commit==="" and .pr===""', async () => {
    const io = makeDoctorIo({ files: { ...ATTR_FILES } });
    await cmdDoctor(['--json'], io);
    assert.equal(findCheck(envelope(io), /attribution/).ok, true, 'attribution present -> check ok');
  });

  it('fails when the attribution keys are absent', async () => {
    const noAttr = JSON.stringify({ theme: 'dark' });
    const io = makeDoctorIo({ files: { [`${ROOT}/.claude/settings.json`]: noAttr, ['/home/user/.claude/settings.json']: noAttr } });
    await cmdDoctor(['--json'], io);
    assert.equal(findCheck(envelope(io), /attribution/).ok, false, 'missing attribution -> check fails with remediation');
  });
});

// ===========================================================================
describe('doctor — journal size warning', () => {
  it('a journal > 5 MB flags the journal check; a small journal does not', async () => {
    const big = 'x'.repeat(5 * 1024 * 1024 + 1) + '\n';
    const ioBig = makeDoctorIo({ files: { ...ATTR_FILES, [paths.journal]: big } });
    await cmdDoctor(['--json'], ioBig);
    assert.equal(findCheck(envelope(ioBig), /journal/).ok, false, 'a journal over 5 MB warns');

    const ioSmall = makeDoctorIo({ files: { ...ATTR_FILES, [paths.journal]: 'small\n' } });
    await cmdDoctor(['--json'], ioSmall);
    assert.equal(findCheck(envelope(ioSmall), /journal/).ok, true, 'a small journal is fine');
  });
});

// ===========================================================================
describe('doctor — git-guard commit scan (word-boundary safe, bounded to 50)', () => {
  it('flags a Co-Authored-By: Claude trailer, names the offending sha, and bounds the log to the last 50 commits (F6)', async () => {
    const io = makeDoctorIo({ files: { ...ATTR_FILES }, gitLog: GIT_LOG_DIRTY });
    await cmdDoctor(['--json'], io);
    const env = envelope(io);
    assert.equal(findCheck(env, /guard|commit|trailer/).ok, false, 'an AI co-author trailer must fail the git-guard check');
    assert.match(io.stdoutText(), /a1b2c3d4/, 'the flagged commit sha surfaces in the envelope for remediation');

    // (F6) The scan is LIMITED to the last 50 commits: the git log invocation
    // must carry an explicit 50-commit bound in one of the accepted spellings.
    const logCall = io.__calls.find((c) => c.cmd === 'git' && c.args.includes('log'));
    assert.ok(logCall, 'doctor invokes git log for the guard scan');
    const joined = logCall.args.join(' ');
    assert.match(
      joined,
      /(?:^|\s)(?:-n ?50|--max-count[= ]50)(?:\s|$)/,
      `git log must be bounded to 50 commits via -n 50 / -n50 / --max-count=50 / --max-count 50; got: ${joined}`,
    );
  });

  it('does NOT flag a history whose only "Claude"-ish token is the name "Claudette Smith"', async () => {
    const io = makeDoctorIo({ files: { ...ATTR_FILES }, gitLog: GIT_LOG_CLAUDETTE });
    await cmdDoctor(['--json'], io);
    assert.equal(findCheck(envelope(io), /guard|commit|trailer/).ok, true, '"Claudette Smith" is a word-boundary false positive and must not be flagged');
  });
});

// ===========================================================================
describe('doctor — --strict exit semantics', () => {
  it('all-green: exit 0 with and without --strict', async () => {
    assert.equal(await cmdDoctor([], makeDoctorIo({ files: { ...ATTR_FILES } })), 0, 'report-only exit 0');
    assert.equal(await cmdDoctor(['--strict'], makeDoctorIo({ files: { ...ATTR_FILES } })), 0, 'strict exit 0 when nothing is wrong');
  });

  it('a failing check: default exit 0 (report-only), --strict exit 1', async () => {
    const lenient = await cmdDoctor([], makeDoctorIo({ files: { ...ATTR_FILES }, gitLog: GIT_LOG_DIRTY }));
    assert.equal(lenient, 0, 'without --strict doctor reports problems but exits 0');
    const strict = await cmdDoctor(['--strict'], makeDoctorIo({ files: { ...ATTR_FILES }, gitLog: GIT_LOG_DIRTY }));
    assert.equal(strict, 1, '--strict turns a failing check into a non-zero exit');
  });
});
