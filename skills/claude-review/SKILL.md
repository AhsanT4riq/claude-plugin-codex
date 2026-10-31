---
name: claude-review
description: Ask Claude Code to review specified code or a diff without edits when the user wants a Claude review.
---

# claude:review

Use the review command, optionally with a focused brief. The runtime collects Git changes with --scope auto|working-tree|branch and optional --base REF. Inspect the selected scope, coverage warnings and validated findings; large reviews fail explicitly and should be split. Outside Git, auto is limited to the manual brief. Do not silently expand review into implementation.

Read [shared runtime instructions](../runtime.md) before invoking the companion. They define entrypoint resolution, task briefs, permissions, session continuation, and result handling.
