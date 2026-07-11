# Per-subtask test review

Read-only. Advise only; do not edit any files.

## Subtask goal
<one-line goal>

## Spec being encoded
<the behavior these tests must pin down>

## Proposed tests (full source)
```
<paste test file(s)>
```

## Questions for the test-verifier
- Do these tests encode the spec — would only a correct implementation pass?
- Any tautologies, missing edge cases, or tests that pass against a broken implementation?
- Is anything over-mocked such that the real behavior escapes verification?

Return a verdict — `APPROVED` / `APPROVED_WITH_NOTES` / `BLOCKED` — listing each missing/weak test concretely.
