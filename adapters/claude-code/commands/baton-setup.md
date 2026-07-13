---
description: Set up baton in this repo — doctor, choose surfaces, scaffold config/templates with a diff preview.
---

Set baton up in the current repository.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/core/bin/baton.mjs" doctor --json` and report each check and per-platform probe record plainly.
2. Ask which harness surfaces to install: `--codex` (.codex/hooks.json + .agents/skills), `--cursor` (.cursor/hooks.json + commands + rule), or core-only.
3. Show the plan first with THE SAME flags you will apply with: `node "${CLAUDE_PLUGIN_ROOT}/core/bin/baton.mjs" init [chosen flags] --dry-run` — walk the user through what would be written (baton.config.json, .gitignore ensure-lines, AGENTS.md/CLAUDE.md managed blocks, attribution settings, harness hook manifests). A preview without the flags hides the harness surfaces the apply will write.
4. Apply with `node "${CLAUDE_PLUGIN_ROOT}/core/bin/baton.mjs" init [chosen flags]`, then re-run doctor to confirm green.

Never overwrite user content: managed blocks only touch bytes between the baton markers, merges are add-only, and a malformed settings file is reported, not rewritten.
