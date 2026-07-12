import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

// Harness-surface writer for `baton init --codex` / `--cursor`. Read-only
// planner (same Action shape as scaffold/plan.mjs); merges are add-only —
// pre-existing user hook entries always survive as exact objects, with baton's
// entries coexisting in the same arrays. config.toml and the notify shim are
// NEVER touched; legacy ~/.codex/prompts are opt-in via withLegacyPrompts.

const ADAPTERS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'adapters');

const CURSOR_FILES = [
  ['cursor-cmd-receive', 'commands/receive.md'],
  ['cursor-cmd-handoff', 'commands/handoff.md'],
  ['cursor-cmd-setup', 'commands/baton-setup.md'],
  ['cursor-rule', 'rules/baton-handoff.mdc'],
];

const LEGACY_PROMPT_BODY = [
  '# baton handoff (legacy prompt fallback)',
  '',
  'Resume a pending cross-platform handoff: run `baton receive --platform codex --print-prompt`,',
  'audit HANDOFF.md claims against the working tree, then continue the next pending step.',
  'Checkpoint completed subtasks with `baton checkpoint --platform codex`.',
  '',
].join('\n');

/** @param {any} io @param {string} path @returns {string | null} */
function readOrNull(io, path) {
  try {
    return io.fs.readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** @param {any[]} arr @param {any} obj */
const deepIncludes = (arr, obj) => Array.isArray(arr) && arr.some((x) => isDeepStrictEqual(x, obj));

/**
 * Add-only merge of a hooks manifest: every template entry missing from the
 * existing per-event array is appended; user entries and foreign events are
 * untouched; non-hooks top-level keys (e.g. Cursor's version) are preserved.
 * @param {any} existing parsed existing manifest, or null
 * @param {any} tpl parsed template manifest
 * @returns {{merged: any, changed: boolean}}
 */
function mergeHooks(existing, tpl) {
  const merged = structuredClone(existing ?? {});
  for (const key of Object.keys(tpl)) {
    if (key !== 'hooks' && !(key in merged)) merged[key] = structuredClone(tpl[key]);
  }
  if (typeof merged.hooks !== 'object' || merged.hooks === null) merged.hooks = {};
  let changed = existing === null;
  for (const [event, entries] of Object.entries(tpl.hooks ?? {})) {
    if (!Array.isArray(merged.hooks[event])) merged.hooks[event] = [];
    for (const entry of entries) {
      if (!deepIncludes(merged.hooks[event], entry)) {
        merged.hooks[event].push(structuredClone(entry));
        changed = true;
      }
    }
  }
  return { merged, changed };
}

/**
 * Plan one hooks-manifest merge into an Action.
 * @param {string} id @param {string} targetPath @param {string} tplPath @param {any} io
 * @returns {import('./plan.mjs').Action}
 */
function hooksAction(id, targetPath, tplPath, io) {
  const tplText = readOrNull(io, tplPath);
  if (tplText === null) return { id, path: targetPath, op: 'refuse', note: `packaged template missing at ${tplPath} — broken install` };
  const existingText = readOrNull(io, targetPath);
  /** @type {any} */
  let existing = null;
  if (existingText !== null) {
    try {
      existing = JSON.parse(existingText);
    } catch {
      return { id, path: targetPath, op: 'refuse', note: `${targetPath} is not valid JSON — refusing to merge into a file baton cannot parse` };
    }
  }
  const { merged, changed } = mergeHooks(existing, JSON.parse(tplText));
  if (!changed) return { id, path: targetPath, op: 'skip', note: 'baton hooks already present — merge is a no-op' };
  return { id, path: targetPath, op: 'write', preview: JSON.stringify(merged, null, 2) + '\n' };
}

/**
 * Plan a plain file copy from a packaged template (write-if-different).
 * @param {string} id @param {string} targetPath @param {string} tplPath @param {any} io
 * @returns {import('./plan.mjs').Action}
 */
function copyAction(id, targetPath, tplPath, io) {
  const tplText = readOrNull(io, tplPath);
  if (tplText === null) return { id, path: targetPath, op: 'refuse', note: `packaged template missing at ${tplPath} — broken install` };
  if (readOrNull(io, targetPath) === tplText) return { id, path: targetPath, op: 'skip', note: 'already current' };
  return { id, path: targetPath, op: 'write', preview: tplText };
}

/**
 * The plan phase of the harness scaffold. Gated: no flags, no actions.
 * @param {string} cwd
 * @param {{codex?: boolean, cursor?: boolean, withLegacyPrompts?: boolean}} opts
 * @param {any} io
 * @returns {import('./plan.mjs').Action[]}
 */
export function planHarnessInit(cwd, opts, io) {
  /** @type {import('./plan.mjs').Action[]} */
  const actions = [];

  if (opts.codex === true) {
    actions.push(hooksAction('codex-hooks', `${cwd}/.codex/hooks.json`, join(ADAPTERS_DIR, 'codex', 'hooks.json'), io));
    actions.push(
      copyAction(
        'codex-skill',
        `${cwd}/.agents/skills/baton-handoff/SKILL.md`,
        join(ADAPTERS_DIR, 'codex', '.agents', 'skills', 'baton-handoff', 'SKILL.md'),
        io,
      ),
    );
    if (opts.withLegacyPrompts === true) {
      const target = `${io.env?.HOME ?? ''}/.codex/prompts/baton-handoff.md`;
      if (readOrNull(io, target) !== LEGACY_PROMPT_BODY) {
        actions.push({ id: 'codex-legacy-prompt', path: target, op: 'write', preview: LEGACY_PROMPT_BODY });
      } else {
        actions.push({ id: 'codex-legacy-prompt', path: target, op: 'skip', note: 'already current' });
      }
    }
  }

  if (opts.cursor === true) {
    actions.push(hooksAction('cursor-hooks', `${cwd}/.cursor/hooks.json`, join(ADAPTERS_DIR, 'cursor', 'hooks.json'), io));
    for (const [id, rel] of CURSOR_FILES) {
      actions.push(copyAction(id, `${cwd}/.cursor/${rel}`, join(ADAPTERS_DIR, 'cursor', rel), io));
    }
  }

  return actions;
}
