---
description: Seal the current task into a handoff bundle so another platform can resume it.
---

Audit every "done" claim against tool evidence, checkpoint the verified state (`baton/event@1` events piped to `baton checkpoint --platform cursor`), then seal with `baton finalize --reason "<why you are switching>"`. Print the destination's resume command: `baton receive --platform <dest> --print-prompt`.
