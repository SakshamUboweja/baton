import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ensureIgnoreLine } from './gitignore.mjs';

// Harness-surface writer for `baton init --codex` / `--cursor`. Read-only
// planner (same Action shape as scaffold/plan.mjs); merges are add-only —
// pre-existing user hook entries always survive as exact objects, with baton's
// entries coexisting in the same arrays. config.toml and the notify shim are
// NEVER touched; legacy ~/.codex/prompts are opt-in via withLegacyPrompts.

const ADAPTERS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'adapters');
// Absolute path to baton's entry script, resolved from this module's location so
// it is correct for both a linked checkout and a packed npm install.
const BATON_ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'baton.mjs');

/**
 * The absolute `"<node>" "<baton.mjs>"` invocation embedded into hook commands.
 * Bare `baton` only resolves when nvm/volta shims are on PATH — true in a
 * terminal, FALSE in a GUI-launched harness (Cursor/Codex desktop app), whose
 * hooks then silently no-op. Absolute paths make the command PATH-independent.
 * @param {any} io @returns {string}
 */
function batonInvocation(io) {
  const node = io.execPath || process.execPath;
  return `"${node}" "${BATON_ENTRY}"`;
}

/**
 * Rewrite a single hook command string's bare-`baton` prefix to `inv`. Already
 * absolute (or foreign) commands are returned unchanged, so re-rewriting is a
 * no-op — the property idempotent re-init relies on.
 * @param {string} s @param {string} inv @returns {string}
 */
function rewriteCommand(s, inv) {
  if (typeof s !== 'string') return s;
  // cmd.exe /c strips the FIRST and LAST quote when the command starts with a
  // quote and contains more than one pair, so `cmd /c "node" "script" args`
  // executes `node" "script...`. The documented remedy: wrap the whole command
  // in an OUTER quote pair (audit finding).
  if (s.startsWith('cmd /c baton ')) return `cmd /c "${inv} ${s.slice('cmd /c baton '.length)}"`;
  if (s.startsWith('baton ')) return `${inv} ${s.slice('baton '.length)}`;
  return s;
}

/**
 * Deep-walk a parsed hooks manifest, rewriting every `command`/`commandWindows`
 * string. Shape-agnostic: handles Codex's nested `hooks:[{hooks:[…]}]` and
 * Cursor's flat `[{command}]` alike.
 * @param {any} node @param {string} inv @returns {any}
 */
function rewriteInvocations(node, inv) {
  if (Array.isArray(node)) return node.map((v) => rewriteInvocations(v, inv));
  if (node && typeof node === 'object') {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = (k === 'command' || k === 'commandWindows') && typeof v === 'string' ? rewriteCommand(v, inv) : rewriteInvocations(v, inv);
    }
    return out;
  }
  return node;
}

/**
 * A hook entry baton owns: it names baton AND carries a `--platform codex|cursor`
 * flag (both the old bare-`baton` form and the new absolute form). User entries
 * never match, so they always survive; baton's own prior entry is replaced (not
 * duplicated) on re-init even when the embedded node path drifts across upgrades.
 * @param {any} entry @returns {boolean}
 */
function looksBatonManaged(entry) {
  const s = JSON.stringify(entry);
  return /--platform\s+(?:codex|cursor)/.test(s) && /baton/.test(s);
}

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

/**
 * Merge a hooks manifest: for every baton event, drop the existing
 * baton-managed entries (so re-init REPLACES a stale one rather than appending a
 * duplicate) and append the current template entries; user entries and foreign
 * events survive untouched; non-hooks top-level keys (e.g. Cursor's version) are
 * preserved. `changed` is a deep comparison so a byte-identical re-init is a
 * clean no-op even though the merge rebuilt the arrays.
 * @param {any} existing parsed existing manifest, or null
 * @param {any} tpl parsed template manifest (invocations already rewritten)
 * @returns {{merged: any, changed: boolean}}
 */
function mergeHooks(existing, tpl) {
  const merged = structuredClone(existing ?? {});
  for (const key of Object.keys(tpl)) {
    if (key !== 'hooks' && !(key in merged)) merged[key] = structuredClone(tpl[key]);
  }
  if (typeof merged.hooks !== 'object' || merged.hooks === null) merged.hooks = {};
  for (const [event, entries] of Object.entries(tpl.hooks ?? {})) {
    const existingArr = Array.isArray(merged.hooks[event]) ? merged.hooks[event] : [];
    const kept = existingArr.filter((/** @type {any} */ e) => !looksBatonManaged(e));
    merged.hooks[event] = [...kept, .../** @type {any[]} */ (entries).map((e) => structuredClone(e))];
  }
  return { merged, changed: existing === null || !isDeepStrictEqual(merged, existing) };
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
  const tpl = rewriteInvocations(JSON.parse(tplText), batonInvocation(io));
  const { merged, changed } = mergeHooks(existing, tpl);
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
 * @param {{codex?: boolean, cursor?: boolean, withLegacyPrompts?: boolean, gitignoreBase?: string | null}} opts
 *   gitignoreBase: the .gitignore text AFTER the base scaffold's own gitignore
 *   action (cmdInit passes it) so the two writers chain instead of clobber.
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

  // The written hook manifests embed THIS machine's absolute node path, so they
  // are machine-specific and must never be committed — ensure ignore lines for
  // each adapter initialized. Chained from gitignoreBase (the base scaffold's
  // planned text) so this write is a superset, never a clobber.
  if (opts.codex === true || opts.cursor === true) {
    let text = opts.gitignoreBase !== undefined ? opts.gitignoreBase : readOrNull(io, `${cwd}/.gitignore`);
    let changed = false;
    const patterns = [...(opts.codex === true ? ['.codex/hooks.json'] : []), ...(opts.cursor === true ? ['.cursor/hooks.json'] : [])];
    for (const p of patterns) {
      const r = ensureIgnoreLine(text, p);
      text = r.text;
      changed = changed || r.changed;
    }
    actions.push(
      changed
        ? { id: 'harness-gitignore', path: `${cwd}/.gitignore`, op: 'write', preview: /** @type {string} */ (text) }
        : { id: 'harness-gitignore', path: `${cwd}/.gitignore`, op: 'skip', note: '.gitignore already covers the machine-specific hook manifests' },
    );
  }

  return actions;
}
