import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

// ---------------------------------------------------------------------------
// RED — production io shape for the loop supervisor (Gate-2 iter-2 H4). The
// dead-lock reclaim path (acquireSupervisorLock) kills recorded child groups via
// io.processKill; if core/bin/baton.mjs never defines it, a real reclaim reaps
// NOTHING and then clears the registry — orphans survive. The bin io is built
// inline (not an exported factory), so this is a source-content pin (last resort,
// as the coordinator specified): the injected io literal must define both
// process-lifecycle fields.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, '..', '..', 'core', 'bin', 'baton.mjs');
const src = nodeFs.readFileSync(BIN, 'utf8');

describe('core/bin/baton.mjs — production io defines the process-lifecycle seams', () => {
  it('defines processAlive (already relied on by the run lock)', () => {
    assert.match(src, /processAlive\s*:/, 'the production io exposes processAlive');
  });

  it('RED (H4): defines processKill, backed by process.kill, so a real reclaim can reap orphan child groups', () => {
    assert.match(src, /processKill\s*:/, 'the production io must expose processKill for orphan reaping on reclaim');
    // The reclaim signals whole process GROUPS (negative pid); the field must be
    // backed by the real process.kill, not a no-op stub.
    const m = src.match(/processKill\s*:[\s\S]{0,200}/);
    assert.ok(m && /process\.kill\s*\(/.test(m[0]), 'processKill is backed by process.kill(...)');
  });
});
