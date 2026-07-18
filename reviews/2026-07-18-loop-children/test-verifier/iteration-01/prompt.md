<task>

> degraded: gpt-5.6-sol/5.6 unavailable (account tier) — test-verifier runs on its configured lead codex/gpt-5.5@xhigh.
You are the test-verifier for the baton repo, auditing RED-phase tests for subtask `loop-children` BEFORE implementation — the child-supervision contract, the riskiest Layer-2 module. Uncommitted new files: tests/unit/loop-children.test.mjs (19) and tests/integration/loop-children-spawn.test.mjs (3); all 22 red via the M() guard; 1019 pre-existing green; typecheck green.

Contract (plan §"Child supervision contract" — read it): buildChildArgv(assignment, prompt, opts) → {command, args, env, stdio} with reviewer roles read-only (claude: no write allowlist/acceptEdits; codex: -s read-only) and implementer/test-author write-capable; env carries BATON_SUPERVISED_CHILD='1' + sole-author GIT_AUTHOR/COMMITTER identity; stdio[0]='ignore'. parseVerdict(transcript, {platform}) region-bounded: codex only after the LAST 'tokens used' line, claude-code the JSON result field; prompt-echo defense; multiple tails → last wins; unparseable/absent/truncated → BLOCKED 'unparseable', never APPROVED. capLog: head + marker + verbatim tail ≤ maxBytes + slack. classifyChildExit delegates to core classify. superviseChild(spec, opts) → detached own process group, timeout → SIGTERM group → graceMs → SIGKILL group (child AND grandchild reaped), capped log file, {timedOut, exitCode, verdict, findings, logPath}.

Audit adversarially:
1. Would these pass against a WRONG implementation? Specifically probe: (a) a reviewer argv that includes --permission-mode acceptEdits anyway (are the read-only assertions NEGATIVE — asserting absence — or just presence of something else?); (b) parseVerdict scanning the WHOLE transcript when the last tokens-used region contains no verdict (would it fall back to the prompt echo?); (c) a tokens-used marker appearing INSIDE the prompt echo — does the test pin LAST-marker semantics with a marker in both regions?; (d) capLog dropping the tail instead of the middle; (e) classifyChildExit reimplementing rather than delegating (is the field-for-field comparison against core classify on shared fixtures real?); (f) superviseChild killing only the direct child pid, not the group — does the grandchild test genuinely create a process-group member that survives a naive child-only kill (grandchild must NOT be detached from the child's group but must survive kill(childPid) alone — verify the fake-child mechanics actually distinguish group-kill from pid-kill); (g) timedOut:true but exitCode handling on kill — pinned or vague?
2. Integration-test robustness: short timeouts vs CI flakiness (are the waits generous enough to avoid flaky false-reds but bounded?); mkdtempSync cleanup; platform assumptions (process.kill(-pgid) semantics on darwin/linux only — any Windows skip guard?).
3. API sanity for loop-run (subtask 9) and failover (subtask 8): does the result shape carry what failover needs (the raw transcript path for detect, exit code, timedOut)? Flag under/over-pinning.
4. Red-phase integrity and idiom conformance (M() guard, mkdtempSync idioms from tests/adapters/claude-code-hook-spawn.test.mjs).

You may run: node --test tests/unit/loop-children.test.mjs tests/integration/loop-children-spawn.test.mjs, npm run typecheck.
</task>
<grounding_rules>Cite file:line for every claim. Distinguish verified facts (ran/read) from hypotheses.</grounding_rules>
<structured_output_contract>
End with exactly:
VERDICT: APPROVED | APPROVED_WITH_NOTES | BLOCKED
FINDINGS: numbered [high|medium|low] — <what is wrong> — Fix: <specific change>
(FINDINGS may be empty only with APPROVED.)
</structured_output_contract>
