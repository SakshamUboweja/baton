{
  "schema": "baton/config@1",
  "roles": {
    "planner": ["claude-code/claude-fable-5"],
    "plan-reviewer": ["codex/gpt-5.6-sol@xhigh", "claude-code/claude-fable-5@xhigh"],
    "test-author": ["claude-code/claude-opus-4-8", "codex/gpt-5.5@xhigh"],
    "test-verifier": ["codex/gpt-5.5@xhigh", "claude-code/claude-opus-4-8"],
    "implementer": ["claude-code/claude-fable-5", "codex/gpt-5.6-sol@xhigh", "cursor/composer"],
    "final-reviewer-a": ["codex/gpt-5.6-sol@xhigh", "codex/gpt-5.5@xhigh"],
    "final-reviewer-b": ["claude-code/claude-fable-5@xhigh", "claude-code/claude-opus-4-8"]
  },
  "constraints": {
    "test-author-vs-verifier": "different-vendor-preferred, fresh-context-required",
    "final-review": "two-independent-fresh-context-reviews, cross-vendor-preferred",
    "review-gate-max-iterations": 5
  },
  "platforms": {
    "claude-code": {},
    "codex": {},
    "cursor": {}
  },
  "defaults": {
    "claude-code": "claude-fable-5",
    "codex": "gpt-5.6-sol",
    "cursor": "composer"
  },
  "capture": {
    "transcriptTail": false
  }
}
