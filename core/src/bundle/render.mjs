const FOOTER = 'Machine-readable data: .handoff/bundle.json (baton bundle schema v1)';
const DASH = '—';

/**
 * Render a bundle as HANDOFF.md — pure, deterministic, byte-stable. The five
 * committed goldens are the format spec. Warnings are supplied by the caller
 * (receive computes staleness); render never derives them.
 * @param {any} bundle
 * @param {{warnings?: string[]}} [options]
 * @returns {string}
 */
export function renderHandoffMd(bundle, options = {}) {
  /** @type {string[]} */
  const L = [];
  const push = (/** @type {string[]} */ ...lines) => L.push(...lines);
  const section = (/** @type {string} */ title, /** @type {string[]} */ lines, /** @type {string} */ placeholder) => {
    push(`## ${title}`, '');
    if (lines.length === 0) push(placeholder);
    else push(...lines);
    push('');
  };

  const steps = bundle.plan.steps;
  const done = steps.filter((/** @type {any} */ s) => s.status === 'done').length;
  const active = steps.filter((/** @type {any} */ s) => s.status === 'active').length;
  const blocked = steps.filter((/** @type {any} */ s) => s.status === 'blocked').length;
  let status = 'No plan steps yet';
  if (steps.length > 0) {
    status = `${done}/${steps.length} steps done`;
    if (active > 0) status += `, ${active} active`;
    if (blocked > 0) status += `, ${blocked} blocked`;
  }

  push(`# Handoff: ${bundle.task.goal}`, '');
  push(`- Status: ${status}`);
  push(`- Origin: ${bundle.origin.platform} / ${bundle.origin.model}`);
  if (bundle.handoff.status === 'sealed') push(`- Finalized: ${bundle.handoff.reason}`);
  push('');

  const warnings = options?.warnings;
  if (Array.isArray(warnings) && warnings.length > 0) {
    push('## Warnings', '');
    for (const w of warnings) push(`- ${w}`);
    push('');
  }

  section('Constraints', bundle.task.constraints.map((/** @type {string} */ c) => `- ${c}`), '_None._');

  section(
    'Plan',
    steps.map((/** @type {any} */ s) => `- [${s.status === 'done' ? 'x' : ' '}] ${s.title}`),
    '_No plan steps._',
  );

  const roleNames = Object.keys(bundle.roles.assignments).sort();
  /** @type {string[]} */
  let roleLines = [];
  if (roleNames.length > 0) {
    const hasMode = roleNames.some((n) => bundle.roles.assignments[n].mode !== undefined);
    const header = hasMode ? '| Role | Platform | Model | Mode |' : '| Role | Platform | Model |';
    const rule = hasMode ? '| --- | --- | --- | --- |' : '| --- | --- | --- |';
    roleLines = [
      header,
      rule,
      ...roleNames.map((n) => {
        const a = bundle.roles.assignments[n];
        const cells = [n, a.platform ?? DASH, a.model ?? DASH];
        if (hasMode) cells.push(a.mode ?? DASH);
        return `| ${cells.join(' | ')} |`;
      }),
    ];
  }
  section('Roles', roleLines, '_No role assignments._');

  section(
    'Decisions (last 15)',
    bundle.decisions.slice(-15).map((/** @type {any} */ d) => `- ${d.summary}`),
    '_No decisions recorded._',
  );

  section(
    'Files touched',
    bundle.files.touched.map((/** @type {any} */ f) => `- ${f.op} ${f.path}`),
    '_No files touched._',
  );

  /** @type {string[]} */
  let gitLines = [];
  if (bundle.git) {
    gitLines = [
      `- Branch: ${bundle.git.branch}`,
      `- HEAD: ${bundle.git.headSha}`,
      `- Dirty: ${bundle.git.dirty ? 'yes' : 'no'}`,
    ];
    if (bundle.git.dirty && Array.isArray(bundle.git.dirtySummary)) {
      for (const line of bundle.git.dirtySummary) gitLines.push(`  - ${line}`);
    }
  }
  section('Git', gitLines, '_No git state captured._');

  const next = steps
    .filter((/** @type {any} */ s) => s.status === 'active' || s.status === 'pending')
    .slice(0, 5);
  section('Next actions', next.map((/** @type {any} */ s, /** @type {number} */ i) => `${i + 1}. ${s.title}`), '_No pending actions._');

  push('---', FOOTER);
  return L.join('\n') + '\n';
}
