<task>

> degraded: gpt-5.6-sol/5.6 unavailable (account tier) — test-verifier runs on its configured lead codex/gpt-5.5@xhigh.
You are the test-verifier for the baton repo, auditing RED-phase tests for subtask `l1-resolver-entries` BEFORE implementation. Uncommitted test changes: NEW tests/unit/resolver-avoid-entries.test.mjs (10: 6 red/4 green); new describes in tests/unit/classifier.test.mjs (5: 4 red/1 green), tests/unit/signatures.test.mjs (1 red), tests/commands/envelopes.test.mjs (3: 2 red/1 green). 19 new tests total, 13 red.

Contract (plan section "Model-level failover", Gate-1 iteration-1 finding 4):
A. Resolver: opts.avoidEntries [{platform, model}] skips a chain entry only when BOTH match; skip recorded as why 'avoided-entry' (distinct from platform-level 'avoided'); the named test — first codex entry avoided → second codex entry selected, same platform, mode native; model matching ignores @effort suffixes but never matches a different base model; omitted/empty avoidEntries = today's behavior; composes with avoid[]; total exhaustion → existing unavailable path.
B. Classifier/detect: new signature class 'model-unavailable' seeded with the verified codex substring "not supported when using Codex with a ChatGPT account"; precedence below usage-limit and auth, above other-error (throttle relation deliberately unpinned); detect exits 14 with --json data.class 'model-unavailable'; usage-limit still exits 10; ANSI-wrapped variant classifies.

Audit adversarially:
1. Would these pass against a WRONG implementation? (e.g. avoidEntries matching platform only; effort-sensitive matching; why label reusing 'avoided'; classifier matching the string but mapping to other-error; exit 14 emitted without the class in --json; precedence satisfied by accident of table order rather than explicit rank.) Name holes.
2. Are assertions reading REAL shapes? Cross-check core/src/roles/resolve.mjs (skipped[] entries, mode fields), core/src/detect/classifier.mjs (precedence machinery), core/data/signatures.v1.json (matcher schema), core/src/commands/detect.mjs (envelope + exit codes).
3. Red-phase integrity: each red fails today for the right reason; the 6 greens are real invariants; pre-existing tests untouched.
4. Coverage gaps vs the contract — including anything the loop's failover (consumer of these APIs) needs pinned at this layer.

You may run: node --test tests/unit/resolver-avoid-entries.test.mjs tests/unit/classifier.test.mjs tests/unit/signatures.test.mjs tests/commands/envelopes.test.mjs, npm run typecheck.
</task>
<grounding_rules>Cite file:line for every claim. Distinguish verified facts (ran/read) from hypotheses.</grounding_rules>
<structured_output_contract>
End with exactly:
VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
FINDINGS: numbered [high|medium|low] — <what is wrong> — Fix: <specific change>
(FINDINGS may be empty only with APPROVED.)
</structured_output_contract>
