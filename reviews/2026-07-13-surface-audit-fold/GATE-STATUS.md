# Surface-audit fold — test-verifier gate

**APPROVED** at HEAD 5dae7dd (iteration 2 of 5).

## Scope

The post-Gate-2 surface audit (8 execution-based auditors + adversarial
verification, run wf_016ec0b9-f31) found 40 defects across every command/skill/
hook surface. All 40 were folded across 8 commits (4369f3b..5dae7dd). Because
several folds evolved test contracts, the modified tests re-entered
test-verifier review per AGENTS.md §4.

## Iterations

- **Iteration 1** (gpt-5.5 @ xhigh, codex exec read-only): **BLOCKED** — 3
  findings: [high] the moved F12 test dropped the no-read-through-symlink
  assertion; [medium] strict-parser adoption lacked command-level coverage for
  6 commands; [low] five seeded-bundle SessionStart hook negatives became
  tautological under delegation. All folded in 5dae7dd.
- **Iteration 2** (same reviewer, targeted): **APPROVED** — F1/F2/F3 closed,
  no new findings. Evidence: 42/42 across the three touched files; full suite
  878/878 + typecheck clean at the fold head.

## Live validation (same milestone)

Both legs of the e2e handoff loop passed through the real installed plugin
(v0.2.0), headless: /baton:handoff sealed with goal headline, titled plan
steps, evidence-audited narrative, verified envelope; /baton:receive detected
sealed intake, committed generation 2 first try (identical intake flags), and
resumed the pending plan step to a sole-author commit.
