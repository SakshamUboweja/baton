<task>
You are the test-verifier for wave D of the baton project (repo root: current directory), iteration 2. In iteration 1 you returned BLOCKED with 8 findings (3 blocking, 5 major) — verdict at reviews/2026-07-12-wave-d-scaffold-doctor-e2e/subtask-d-tests/iteration-01/verdict.md. The test-author folded all 8. Re-verify.

Files (wave-D set, now 81 literal cases): tests/unit/scaffold-{gitignore,managed-block,attribution}.test.mjs, tests/commands/{init,doctor,purge-transcript}.test.mjs, tests/invariants/attribution.test.mjs, tests/integration/e2e-failover.test.mjs.

Claimed folds (verify each against actual test code):
1. e2e six-direction matrix: 6 directions × {sealed, open} = 12 runtime cases, each prepare AND commit, asserting no dead-origin remap, open-variant unsealed warning + degraded-seal receive_log entry, received freeze, generation 2, target ownership; sealed variant asserted NOT degraded.
2. e2e concurrency: torn-owner refusal, cross-host refusal, live-owner --force refusal, pause-after-final-fence-check (staged via on-disk owner.json rewrite mid-withLock + guardedWrite FencingError), prepare-vs-checkpoint race, foreign-session rejection + --take-over, double-commit — each with outcome asserts and full-tree no-mutation where refusal is expected. Staging pins in header E6 (recoverLock exercised via bundle/lock.mjs, not a recover CLI, to keep the one-red-cause rule).
3. invariants: four non-vacuous arms — recursive templates/ walk failing if missing/empty or lacking AGENTS.md.tpl/CLAUDE.md.tpl/baton.config.json.tpl; goldens via readdir failing on zero; live renders; planInit previews (>=1). Positive control retained.
4. init: scaffolded baton.config.json deep-equals the seeded template; managed blocks contain seeded template bodies verbatim.
5. doctor: capability asserted within the ordered ladder {installed, authenticated, reachable} distinct from outcome; six probe fixtures (installed-only, authenticated, reachable, rate-limited, error, timeout).
6. doctor git-guard: git log args must carry -n 50 / --max-count=50 (variants accepted).
7. purge lock refusal: full-memfs deepEqual before/after.
8. purge preservation: every retained copy survives with non-transcript content intact (bak, history freeze, journal events by dedupeKey across live+rotated, log metadata), secret absent from every survivor.

Authoritative contracts as in iteration 1: docs/plans/2026-07-11-baton-v1.md and docs/design/core.md; the plan wins.
</task>

<grounding_rules>
Do not re-raise folded iteration-1 findings that are genuinely closed. New findings admissible only if a fold fails to close its original finding, introduces a defect or plan contradiction, or you missed a blocking-level plan-invariant gap in iteration 1 — not incremental hardening of adequate tests. Confirm red-state attribution still holds (each file exactly one ERR_MODULE_NOT_FOUND for its own target; 383 existing tests unaffected).
</grounding_rules>

<structured_output_contract>
End your reply with exactly this block:

VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
FINDINGS:
1. [blocking|major|minor] — <file> / <test name> — <what is wrong> — <clause> — Fix: <specific change>
(one numbered line per finding; write "none" if there are no findings)
</structured_output_contract>
