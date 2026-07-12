<task>
You are final-reviewer-a for the baton project v1 (repo root: current directory) — Gate 2, an independent fresh-context final review. The full v1 core + adapters are implemented: 533 tests green, typecheck clean. Review the ENTIRE implementation against the approved plan (docs/plans/2026-07-11-baton-v1.md — you reviewed and approved this plan at Gate 1) and the design docs (docs/design/core.md, docs/design/platform-notes.md).

Scope: core/src/** (all modules), core/bin/baton.mjs, core/data/signatures.v1.json, adapters/** and .claude-plugin/**, templates/**, package.json, and the test suite's fidelity to the plan's acceptance constraints (§Acceptance constraints 1–7). Known-open items you should NOT raise: live cross-harness smoke tests on real harnesses (scheduled after this gate), Windows CI (no CI infra yet — flag only if the CODE would break on Windows), README/contract docs (docs phase), and `baton wrap` (explicitly reserved post-v1).
</task>

<grounding_rules>
Every finding must cite file:line (or file + function) plus the plan/design clause it violates. Rank by severity: blocking (violates a plan invariant, a security posture, or the attribution rule; or a real bug reachable in normal use), major (contract gap or correctness risk), minor (polish). Read the code — do not speculate from names. Verify claims by inspecting the actual implementation and, where cheap, running targeted checks (read-only sandbox: node --test on specific unit files works; mkdtemp-based integration tests will EPERM — do not report those as failures).
</grounding_rules>

<dig_deeper_nudge>
Areas the per-wave verifiers could not see whole: cross-module seams (bin ↔ cli ↔ commands io threading; receive command sessionHint default vs txn binding; checkpoint dedupe vs journal replay), the threat model (§Threat model: path traversal from bundle fields, symlinked .handoff, pathological overlay regexes, adversarial HANDOFF.md), degraded modes (non-git dirs, read-only sandboxes, missing config), and the adapter fail-open guarantees end to end.
</dig_deeper_nudge>

<structured_output_contract>
End your reply with exactly this block:

VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
FINDINGS:
1. [blocking|major|minor] — <file:line or file#function> — <what is wrong> — <clause> — Fix: <specific change>
(one numbered line per finding; write "none" if there are no findings)
</structured_output_contract>
