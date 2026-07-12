---
description: Set up baton in this repo — doctor, dry-run plan, scaffold with user confirmation.
---

Run `baton doctor --json` and report the checks plainly. Show `baton init --dry-run` first and walk through what would be written. Apply with `baton init --cursor` only after confirmation; hooks.json is merged, never clobbered, and requires a trusted workspace to fire.
