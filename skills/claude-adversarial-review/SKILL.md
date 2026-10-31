---
name: claude-adversarial-review
description: Ask Claude Code to challenge architecture, assumptions, tradeoffs, or an implementation when the user wants an adversarial second opinion.
---

# claude:adversarial-review

Use the adversarial-review command with the design, decision, or implementation under challenge and the requested focus. Use --scope auto|working-tree|branch and optional --base REF for Git targets; inspect coverage warnings and validated structured findings. Outside Git, auto reviews only the manual brief. Preserve tradeoffs and uncertainty. This is read-only; do not add write capability.

Read [shared runtime instructions](../runtime.md) before invoking the companion. They define entrypoint resolution, task briefs, permissions, session continuation, and result handling.
