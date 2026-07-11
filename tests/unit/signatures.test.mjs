import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { makeIo } from '../helpers/fakeio.mjs';
import { loadSignatures } from '../../core/src/detect/signatures.mjs';
import { classify } from '../../core/src/detect/classifier.mjs';

// ===========================================================================
// Contract choices for detect/signatures.mjs + core/data/signatures.v1.json.
// Source of truth: docs/design/core.md §Module APIs (loadSignatures signature,
// "validates, lints regexes"), §"signatures/classifier" test list; plan
// §Core engine — Limit detector; docs/design/platform-notes.md (verified
// limit strings). Readings this file PINS where the spec left room:
//
//   A. TABLE SHAPE (loadSignatures return value): a flat object
//        { schema: 'baton/signatures@1', updated: <ISO-ish date string>,
//          signatures: Signature[] }
//      Signatures are a FLAT array (not grouped by platform); each carries its
//      own `platform`. The classifier filters by that field. Override-by-id and
//      the classifier both operate over `table.signatures`.
//
//   B. SIGNATURE SHAPE:
//        { id: string,            // unique; overlay merge key
//          platform: 'claude-code'|'codex'|'cursor',
//          class: 'usage-limit'|'auth'|'throttle'|'other-error',
//          confidence: 'high'|'medium'|'low',
//          matcher: Matcher,
//          resetHint?: string }   // OPTIONAL regex (string) used by the
//                                 // classifier to extract a reset hint.
//      Matcher kinds (the only three accepted):
//        { kind:'substring', value:string }
//        { kind:'regex', pattern:string, flags?:string }
//        { kind:'json-field', path:string /* dotted */, equals:<value> }
//
//   C. VALIDATION FAILURES THROW. loadSignatures returns a Table on success;
//      an invalid built-in or overlay table (bad matcher kind, over-long
//      regex, syntactically-invalid regex, backreference, pathological nested
//      quantifier, unknown platform key) throws an Error. Error messages are
//      asserted only with permissive keyword regexes.
//      - regex pattern length cap: 200 chars (201 rejected).
//      - a syntactically INVALID regex is rejected with a PATHED error — the
//        message names the offending signature id (fold C1-3).
//      - backreferences (\1) rejected (PIN: the open lookbehind question is
//        resolved to "backreferences rejected"; lookbehind is left UNPINNED so
//        the implementer keeps latitude there).
//      - a pathological nested-quantifier construct like (a+)+ is rejected as a
//        non-linear-time / catastrophic-backtracking risk (fold C1-3). classify()
//        stays SYNCHRONOUS (no options.timeBudgetMs); the runtime time-guard is
//        achieved BY CONSTRUCTION — because the lint forbids such patterns from
//        ever shipping or being overlaid, classify() cannot hang on adversarial
//        input. The same lints apply to the OVERLAY path.
//      - unknown platform key (not one of the three) rejected.
//
//   D. OVERLAY (overlayPath): merged over the built-in by signature `id`,
//      LATER WINS — an overlay id equal to a built-in id replaces it; a new
//      overlay id is appended. A missing/undefined overlayPath = no overlay.
//
//   E. BUILT-IN PIN: the real shipped file core/data/signatures.v1.json is
//      loaded through the loader via node:fs (a minimal real-fs io = {fs}) so
//      the shipped data — the verified per-platform strings from
//      platform-notes.md — is pinned, not just the loader's mechanics.
// ===========================================================================

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const REAL_SIGNATURES_PATH = join(repoRoot, 'core', 'data', 'signatures.v1.json');

// Minimal real-fs io: loadSignatures only needs fs.readFileSync / fs.existsSync.
const realIo = { fs: nodeFs };

// Apply a matcher the same way the classifier is contracted to, so the built-in
// content pins are robust to a substring-vs-regex authoring choice for the
// flexible cases (e.g. the 429 other-error entry).
function matcherMatches(matcher, text) {
  if (!matcher) return false;
  if (matcher.kind === 'substring') return text.includes(matcher.value);
  if (matcher.kind === 'regex') return new RegExp(matcher.pattern, matcher.flags || '').test(text);
  if (matcher.kind === 'json-field') {
    for (const line of text.split('\n')) {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const val = String(matcher.path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
      if (val === matcher.equals) return true;
    }
    return false;
  }
  return false;
}

const sigsFor = (table, platform) => table.signatures.filter((s) => s.platform === platform);
const byId = (table, id) => table.signatures.find((s) => s.id === id);

// A valid built-in table literal for the memfs validation/overlay cases. Kept
// deliberately small; the real-file pins below cover the shipped corpus.
function validTable(extra = []) {
  return {
    schema: 'baton/signatures@1',
    updated: '2026-07-11',
    signatures: [
      {
        id: 'cc/session-limit',
        platform: 'claude-code',
        class: 'usage-limit',
        confidence: 'high',
        matcher: { kind: 'substring', value: "You've hit your session limit" },
      },
      {
        id: 'cursor/too-many',
        platform: 'cursor',
        class: 'throttle',
        confidence: 'medium',
        matcher: { kind: 'json-field', path: 'error', equals: 'Too Many Requests' },
      },
      ...extra,
    ],
  };
}

function ioWith(files) {
  return makeIo({ files });
}

// ---------------------------------------------------------------------------
describe('signatures.loadSignatures — shipped built-in table (real file pin)', () => {
  it('loads core/data/signatures.v1.json into a baton/signatures@1 table', () => {
    const table = loadSignatures({ builtinPath: REAL_SIGNATURES_PATH }, realIo);
    assert.equal(table.schema, 'baton/signatures@1');
    assert.equal(typeof table.updated, 'string');
    assert.ok(Array.isArray(table.signatures) && table.signatures.length > 0);
    // Every id is unique.
    const ids = table.signatures.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, 'signature ids must be unique');
  });

  it('claude-code: verified session-limit + weekly-limit substrings (usage-limit, high)', () => {
    const table = loadSignatures({ builtinPath: REAL_SIGNATURES_PATH }, realIo);
    const cc = sigsFor(table, 'claude-code');

    const session = cc.find(
      (s) => s.matcher.kind === 'substring' && s.matcher.value.includes("You've hit your session limit"),
    );
    assert.ok(session, 'claude-code must carry the session-limit substring signature');
    assert.equal(session.class, 'usage-limit');
    assert.equal(session.confidence, 'high');

    const weekly = cc.find(
      (s) => s.matcher.kind === 'substring' && s.matcher.value.includes("You've hit your weekly limit"),
    );
    assert.ok(weekly, 'claude-code must carry the weekly-limit substring signature');
    assert.equal(weekly.class, 'usage-limit');
    assert.equal(weekly.confidence, 'high');
  });

  it('claude-code: a model-limit REGEX signature (usage-limit) matching a per-model limit string', () => {
    const table = loadSignatures({ builtinPath: REAL_SIGNATURES_PATH }, realIo);
    const modelLimit = sigsFor(table, 'claude-code').find(
      (s) => s.class === 'usage-limit' && s.matcher.kind === 'regex',
    );
    assert.ok(modelLimit, 'claude-code must carry a regex model-limit signature');
    // platform-notes: "Opus limit" is the verified per-model form.
    assert.ok(
      matcherMatches(modelLimit.matcher, "You've hit your Opus limit"),
      'model-limit regex must match a per-model limit string',
    );
  });

  it('claude-code: throttle "Server is temporarily limiting requests"', () => {
    const table = loadSignatures({ builtinPath: REAL_SIGNATURES_PATH }, realIo);
    const throttle = sigsFor(table, 'claude-code').find((s) => s.class === 'throttle');
    assert.ok(throttle, 'claude-code must carry a throttle signature');
    assert.ok(
      matcherMatches(throttle.matcher, 'Server is temporarily limiting requests (not your usage limit)'),
      'throttle signature must match the verified throttle string',
    );
  });

  it('claude-code: other-error 429 (NOT throttle, NOT usage-limit)', () => {
    const table = loadSignatures({ builtinPath: REAL_SIGNATURES_PATH }, realIo);
    const other = sigsFor(table, 'claude-code').find(
      (s) => s.class === 'other-error' && matcherMatches(s.matcher, 'API Error: Request rejected (429)'),
    );
    assert.ok(other, 'claude-code must classify the 429 rejection as other-error');
  });

  it('codex: usage-limit substring "You\'ve hit your usage limit" + a resetHint regex', () => {
    const table = loadSignatures({ builtinPath: REAL_SIGNATURES_PATH }, realIo);
    const usage = sigsFor(table, 'codex').find(
      (s) => s.matcher.kind === 'substring' && s.matcher.value.includes("You've hit your usage limit"),
    );
    assert.ok(usage, 'codex must carry the usage-limit substring signature');
    assert.equal(usage.class, 'usage-limit');
    assert.equal(usage.confidence, 'high');
    assert.equal(typeof usage.resetHint, 'string', 'codex usage-limit must carry a resetHint regex');
    // The resetHint regex must be valid and extract a "try again at …" hint.
    const re = new RegExp(usage.resetHint);
    assert.ok(re.test('Please try again at 6:00 PM'), 'resetHint regex must match a "try again at …" hint');
  });

  it('cursor: json-field Too Many Requests (throttle, confidence medium) + low-confidence usage-limit regex', () => {
    const table = loadSignatures({ builtinPath: REAL_SIGNATURES_PATH }, realIo);
    const cur = sigsFor(table, 'cursor');

    const tooMany = cur.find((s) => s.matcher.kind === 'json-field');
    assert.ok(tooMany, 'cursor must carry a json-field signature');
    assert.equal(tooMany.class, 'throttle');
    assert.equal(tooMany.confidence, 'medium');
    assert.equal(tooMany.matcher.path, 'error');
    assert.equal(tooMany.matcher.equals, 'Too Many Requests');
    assert.ok(
      matcherMatches(tooMany.matcher, '{"error":"Too Many Requests","message":"Rate limit exceeded"}'),
      'cursor throttle must match the BYO-key rate-limit JSON',
    );

    const usageLow = cur.find((s) => s.class === 'usage-limit' && s.matcher.kind === 'regex');
    assert.ok(usageLow, 'cursor must carry a regex usage-limit heuristic');
    assert.equal(usageLow.confidence, 'low', 'cursor usage-limit heuristic must be low confidence');
  });
});

// ---------------------------------------------------------------------------
describe('signatures.loadSignatures — validation (memfs)', () => {
  it('accepts a well-formed table and returns its signatures', () => {
    const io = ioWith({ '/data/sig.json': JSON.stringify(validTable()) });
    const table = loadSignatures({ builtinPath: '/data/sig.json' }, io);
    assert.equal(table.signatures.length, 2);
    assert.ok(byId(table, 'cc/session-limit'));
  });

  it('rejects an unknown matcher kind', () => {
    const bad = validTable([
      { id: 'x/bad', platform: 'codex', class: 'usage-limit', confidence: 'high', matcher: { kind: 'glob', value: '*' } },
    ]);
    const io = ioWith({ '/data/sig.json': JSON.stringify(bad) });
    assert.throws(() => loadSignatures({ builtinPath: '/data/sig.json' }, io), /kind|matcher/i);
  });

  it('rejects a regex pattern longer than 200 chars', () => {
    const bad = validTable([
      {
        id: 'x/long',
        platform: 'codex',
        class: 'usage-limit',
        confidence: 'high',
        matcher: { kind: 'regex', pattern: 'a'.repeat(201) },
      },
    ]);
    const io = ioWith({ '/data/sig.json': JSON.stringify(bad) });
    assert.throws(() => loadSignatures({ builtinPath: '/data/sig.json' }, io), /200|length|long/i);
  });

  it('accepts a regex pattern exactly at the 200-char cap (boundary is not over-budget)', () => {
    const ok = validTable([
      {
        id: 'x/cap',
        platform: 'codex',
        class: 'usage-limit',
        confidence: 'high',
        matcher: { kind: 'regex', pattern: 'a'.repeat(200) },
      },
    ]);
    const io = ioWith({ '/data/sig.json': JSON.stringify(ok) });
    assert.doesNotThrow(() => loadSignatures({ builtinPath: '/data/sig.json' }, io));
  });

  it('rejects a regex containing a backreference (\\1)', () => {
    const bad = validTable([
      {
        id: 'x/backref',
        platform: 'codex',
        class: 'usage-limit',
        confidence: 'high',
        matcher: { kind: 'regex', pattern: '(a)\\1' },
      },
    ]);
    const io = ioWith({ '/data/sig.json': JSON.stringify(bad) });
    assert.throws(() => loadSignatures({ builtinPath: '/data/sig.json' }, io), /backref/i);
  });

  it('rejects a syntactically INVALID regex pattern with a PATHED error naming the signature id (fold C1-3)', () => {
    const bad = validTable([
      {
        id: 'x/invalid',
        platform: 'codex',
        class: 'usage-limit',
        confidence: 'high',
        matcher: { kind: 'regex', pattern: '([unterminated' }, // unbalanced group -> SyntaxError when compiled
      },
    ]);
    const io = ioWith({ '/data/sig.json': JSON.stringify(bad) });
    assert.throws(
      () => loadSignatures({ builtinPath: '/data/sig.json' }, io),
      (err) => /regex|pattern|invalid|syntax/i.test(err.message) && /x\/invalid/.test(err.message),
      'the error must be about an invalid regex AND name the offending signature id (a pathed error)',
    );
  });

  it('rejects a pathological nested-quantifier construct (a+)+ (linear-time lint; runtime guard by construction) (fold C1-3)', () => {
    // classify() has NO timeBudgetMs and stays synchronous; the time-guard is
    // structural. A table literally cannot hold a catastrophic-backtracking regex,
    // so classify() over adversarial input (see the by-construction test below)
    // cannot blow up.
    const bad = validTable([
      {
        id: 'x/redos',
        platform: 'codex',
        class: 'usage-limit',
        confidence: 'high',
        matcher: { kind: 'regex', pattern: '(a+)+$' },
      },
    ]);
    const io = ioWith({ '/data/sig.json': JSON.stringify(bad) });
    assert.throws(
      () => loadSignatures({ builtinPath: '/data/sig.json' }, io),
      /nested|quantifier|pathological|linear|backtrack|redos/i,
    );
  });

  it('rejects a signature whose platform is not one of the three known platforms', () => {
    const bad = validTable([
      { id: 'x/vscode', platform: 'vscode', class: 'usage-limit', confidence: 'high', matcher: { kind: 'substring', value: 'nope' } },
    ]);
    const io = ioWith({ '/data/sig.json': JSON.stringify(bad) });
    assert.throws(() => loadSignatures({ builtinPath: '/data/sig.json' }, io), /platform|vscode/i);
  });
});

// ---------------------------------------------------------------------------
describe('signatures.loadSignatures — overlay merge (memfs)', () => {
  it('with no overlayPath, returns the built-in table unchanged', () => {
    const io = ioWith({ '/data/sig.json': JSON.stringify(validTable()) });
    const table = loadSignatures({ builtinPath: '/data/sig.json' }, io);
    assert.equal(table.signatures.length, 2);
  });

  it('overlay overrides a built-in signature by id (later wins)', () => {
    const overlay = {
      schema: 'baton/signatures@1',
      updated: '2026-07-12',
      signatures: [
        {
          id: 'cc/session-limit', // same id as built-in -> override
          platform: 'claude-code',
          class: 'usage-limit',
          confidence: 'medium', // changed
          matcher: { kind: 'substring', value: 'PATCHED session limit string' },
        },
      ],
    };
    const io = ioWith({
      '/data/sig.json': JSON.stringify(validTable()),
      '/data/overlay.json': JSON.stringify(overlay),
    });
    const table = loadSignatures({ builtinPath: '/data/sig.json', overlayPath: '/data/overlay.json' }, io);

    const merged = byId(table, 'cc/session-limit');
    assert.equal(merged.confidence, 'medium', 'overlay confidence must win');
    assert.equal(merged.matcher.value, 'PATCHED session limit string', 'overlay matcher must win');
    // The override replaces rather than duplicates the id.
    assert.equal(table.signatures.filter((s) => s.id === 'cc/session-limit').length, 1);
  });

  it('overlay adds new ids not present in the built-in', () => {
    const overlay = {
      schema: 'baton/signatures@1',
      updated: '2026-07-12',
      signatures: [
        { id: 'codex/new', platform: 'codex', class: 'usage-limit', confidence: 'high', matcher: { kind: 'substring', value: 'brand new' } },
      ],
    };
    const io = ioWith({
      '/data/sig.json': JSON.stringify(validTable()),
      '/data/overlay.json': JSON.stringify(overlay),
    });
    const table = loadSignatures({ builtinPath: '/data/sig.json', overlayPath: '/data/overlay.json' }, io);
    assert.ok(byId(table, 'codex/new'), 'overlay must add the new id');
    assert.equal(table.signatures.length, 3, 'built-in 2 + 1 new overlay id');
  });

  it('lints overlay regexes too — a backreference overlay regex is rejected', () => {
    const overlay = {
      schema: 'baton/signatures@1',
      updated: '2026-07-12',
      signatures: [
        { id: 'codex/bad', platform: 'codex', class: 'usage-limit', confidence: 'high', matcher: { kind: 'regex', pattern: '(a)\\1' } },
      ],
    };
    const io = ioWith({
      '/data/sig.json': JSON.stringify(validTable()),
      '/data/overlay.json': JSON.stringify(overlay),
    });
    assert.throws(
      () => loadSignatures({ builtinPath: '/data/sig.json', overlayPath: '/data/overlay.json' }, io),
      /backref/i,
    );
  });

  it('lints overlay regexes for syntactic validity too — an invalid overlay regex is rejected (pathed) (fold C1-3)', () => {
    const overlay = {
      schema: 'baton/signatures@1',
      updated: '2026-07-12',
      signatures: [
        { id: 'codex/invalid', platform: 'codex', class: 'usage-limit', confidence: 'high', matcher: { kind: 'regex', pattern: '([unterminated' } },
      ],
    };
    const io = ioWith({
      '/data/sig.json': JSON.stringify(validTable()),
      '/data/overlay.json': JSON.stringify(overlay),
    });
    assert.throws(
      () => loadSignatures({ builtinPath: '/data/sig.json', overlayPath: '/data/overlay.json' }, io),
      (err) => /regex|pattern|invalid|syntax/i.test(err.message) && /codex\/invalid/.test(err.message),
    );
  });

  it('lints overlay regexes for length too — a >200-char overlay pattern is rejected (verifier iteration-2 fold)', () => {
    const overlay = {
      schema: 'baton/signatures@1',
      updated: '2026-07-12',
      signatures: [
        { id: 'codex/overlong', platform: 'codex', class: 'usage-limit', confidence: 'high', matcher: { kind: 'regex', pattern: 'a'.repeat(201) } },
      ],
    };
    const io = ioWith({
      '/data/sig.json': JSON.stringify(validTable()),
      '/data/overlay.json': JSON.stringify(overlay),
    });
    assert.throws(
      () => loadSignatures({ builtinPath: '/data/sig.json', overlayPath: '/data/overlay.json' }, io),
      (err) => /length|200|long/i.test(err.message) && /codex\/overlong/.test(err.message),
    );
  });

  it('lints overlay regexes for nested-quantifier pathology too — (a+)+ overlay is rejected (fold C1-3)', () => {
    const overlay = {
      schema: 'baton/signatures@1',
      updated: '2026-07-12',
      signatures: [
        { id: 'codex/redos', platform: 'codex', class: 'usage-limit', confidence: 'high', matcher: { kind: 'regex', pattern: '(a+)+$' } },
      ],
    };
    const io = ioWith({
      '/data/sig.json': JSON.stringify(validTable()),
      '/data/overlay.json': JSON.stringify(overlay),
    });
    assert.throws(
      () => loadSignatures({ builtinPath: '/data/sig.json', overlayPath: '/data/overlay.json' }, io),
      /nested|quantifier|pathological|linear|backtrack|redos/i,
    );
  });
});

// ---------------------------------------------------------------------------
// fold C1-3: runtime time-guard BY CONSTRUCTION. classify() stays synchronous
// (no options.timeBudgetMs). Because loadSignatures lints out catastrophic-
// backtracking regexes, every shipped/overlaid pattern is linear-time, so
// classify() over adversarial input completes. Teeth: a 100k-'a' string against
// the lint-passing shipped table returns a verdict (proving completion) rather
// than hanging (which would time out this test).
describe('signatures + classifier — runtime time-guard is by construction (lint, not timeBudget)', () => {
  it('classify() over a 100k-char pathological input completes against the lint-passing shipped table', () => {
    const table = loadSignatures({ builtinPath: REAL_SIGNATURES_PATH }, realIo);
    const evil = 'a'.repeat(100000);
    const r = classify({ text: evil, exitCode: 0, platform: 'claude-code', table });
    assert.ok(r && typeof r.class === 'string', 'classify must return a verdict, proving it completed');
    assert.notEqual(r.class, 'usage-limit', 'a 100k-a string is not a usage-limit');
  });
});
