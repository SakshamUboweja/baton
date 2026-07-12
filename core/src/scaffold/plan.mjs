import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { ensureIgnoreLine } from './gitignore.mjs';
import { applyManagedBlock } from './managed-block.mjs';
import { mergeAttribution } from './attribution.mjs';

const TPL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'templates');

/**
 * @typedef {{id: string, path: string, op: 'write' | 'skip' | 'refuse', preview?: string, note?: string}} Action
 */

/** @param {any} io @param {string} path @returns {string | null} */
function readOrNull(io, path) {
  try {
    return io.fs.readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Detect the template variables from the target tree (plan §Templates:
 * "{{TEST_CMD}}-style variables filled by baton init from detection").
 * Deterministic ladder; when nothing is detectable the fallback is an explicit
 * fill-me hint, never a leftover {{VAR}}.
 * @param {string} cwd @param {any} io
 * @returns {Record<string, string>}
 */
function detectVars(cwd, io) {
  let projectName = cwd.split('/').filter(Boolean).pop() ?? 'this project';
  /** @type {string | null} */
  let testCmd = null;
  const pkgText = readOrNull(io, `${cwd}/package.json`);
  if (pkgText !== null) {
    try {
      const pkg = JSON.parse(pkgText);
      if (typeof pkg.name === 'string' && pkg.name.length > 0) projectName = pkg.name;
      if (typeof pkg.scripts?.test === 'string') testCmd = 'npm test';
    } catch {
      // unparseable package.json — fall through to the other detectors
    }
  }
  if (testCmd === null && io.fs.existsSync(`${cwd}/pyproject.toml`)) testCmd = 'pytest';
  if (testCmd === null && io.fs.existsSync(`${cwd}/Cargo.toml`)) testCmd = 'cargo test';
  if (testCmd === null && io.fs.existsSync(`${cwd}/go.mod`)) testCmd = 'go test ./...';
  return { PROJECT_NAME: projectName, TEST_CMD: testCmd ?? '(set your test command)' };
}

/** @param {string} tpl @param {Record<string, string>} vars */
const fillVars = (tpl, vars) => tpl.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));

/**
 * The plan phase of `baton init`: read-only. Composes the pure scaffold
 * transforms over the current tree and the packaged templates into an Action[]
 * whose previews are the exact bytes apply would write. Never writes.
 * @param {string} cwd @param {{force?: boolean}} opts @param {any} io
 * @returns {Action[]}
 */
export function planInit(cwd, opts, io) {
  /** @type {Action[]} */
  const actions = [];

  const configTpl = readOrNull(io, join(TPL_DIR, 'baton.config.json.tpl'));
  const agentsTplRaw = readOrNull(io, join(TPL_DIR, 'AGENTS.md.tpl'));
  const claudeTplRaw = readOrNull(io, join(TPL_DIR, 'CLAUDE.md.tpl'));
  if (configTpl === null || agentsTplRaw === null || claudeTplRaw === null) {
    throw new Error(`packaged templates missing under ${TPL_DIR} — broken install`);
  }
  const vars = detectVars(cwd, io);
  const agentsTpl = fillVars(agentsTplRaw, vars);
  const claudeTpl = fillVars(claudeTplRaw, vars);

  const configPath = `${cwd}/baton.config.json`;
  if (readOrNull(io, configPath) === null) {
    actions.push({ id: 'config', path: configPath, op: 'write', preview: configTpl });
  } else {
    actions.push({ id: 'config', path: configPath, op: 'skip', note: 'baton.config.json already exists — never overwritten' });
  }

  const gitignorePath = `${cwd}/.gitignore`;
  const gi = ensureIgnoreLine(readOrNull(io, gitignorePath), '.handoff/');
  actions.push(
    gi.changed
      ? { id: 'gitignore', path: gitignorePath, op: 'write', preview: gi.text }
      : { id: 'gitignore', path: gitignorePath, op: 'skip', note: '.gitignore already covers .handoff/' },
  );

  for (const [id, file, tpl] of [
    ['agents', 'AGENTS.md', agentsTpl],
    ['claude', 'CLAUDE.md', claudeTpl],
  ]) {
    const path = `${cwd}/${file}`;
    const r = applyManagedBlock(readOrNull(io, path), tpl.trim());
    if ('error' in r) actions.push({ id, path, op: 'refuse', note: `${file}: ${r.error}` });
    else if (r.changed) actions.push({ id, path, op: 'write', preview: r.text });
    else actions.push({ id, path, op: 'skip', note: `${file} managed block already current` });
  }

  const settingsPath = `${cwd}/.claude/settings.json`;
  const merged = mergeAttribution(readOrNull(io, settingsPath), { force: opts.force === true });
  if ('error' in merged) {
    actions.push({ id: 'attribution', path: settingsPath, op: 'refuse', note: `.claude/settings.json: ${merged.error}` });
  } else if (merged.changed) {
    actions.push({ id: 'attribution', path: settingsPath, op: 'write', preview: merged.text });
  } else {
    actions.push({ id: 'attribution', path: settingsPath, op: 'skip', note: 'attribution settings already present' });
  }

  return actions;
}
