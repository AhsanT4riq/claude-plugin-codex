---
name: claude-cancel
description: Stop an active Claude delegation job when the user asks to cancel or stop it.
---

# claude:cancel

Run cancel with the exact job UUID and target directory. If the target is ambiguous, inspect status before choosing. Cancellation is requested first; wait for the owning execution to exit and inspect result to confirm the final state. Partial edits are not reverted.

Read [shared runtime instructions](../runtime.md) before invoking the companion. They define entrypoint resolution, task briefs, permissions, session continuation, and result handling.
