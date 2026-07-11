# Review artifacts

Every review gate leaves an auditable trail here. Layout:

```
reviews/
  _templates/               # prompt templates per gate type
  <task-id>/                # YYYY-MM-DD-slug
    gate-1-plan/
      iteration-NN/{prompt.md, verdict.md}
    subtask-<name>-tests/
      iteration-NN/{prompt.md, verdict.md}
    gate-2-final/
      reviewer-a/iteration-NN/{prompt.md, verdict.md}
      reviewer-b/iteration-NN/{prompt.md, verdict.md}
      findings.md           # collated blocking / non-blocking items
```

Verdicts: `APPROVED` / `APPROVED_WITH_NOTES` / `BLOCKED`. Notes are folded in; BLOCKED means revise and re-review.

Every `verdict.md` starts with a header block:

```
role: <plan-reviewer | test-verifier | final-reviewer-a | final-reviewer-b>
model: <concrete model @ effort actually used>
harness: <how it was invoked>
date: <YYYY-MM-DD>
verdict: <APPROVED | APPROVED_WITH_NOTES | BLOCKED>
degraded: <none | single-vendor | model-fallback | ...>
```

Iteration budget: a gate loops at most **5** times. After the 5th iteration the gate closes; outstanding findings escalate to Saksham for a decision.
