---
name: claude-status
description: Inspect running and previous Claude delegation jobs for the current repository.
---

# claude:status

Run status with the explicit target directory. Report exact job UUIDs, state, and relevant context. Use --job for one job, --after for incremental progress, and --wait for a bounded wait. Preserve the returned cursor. Use --resume-candidates with a known --owner-id to list this chat’s resumable session heads; without identity require explicit job selection. Candidates never imply authorization to resume. State reconciles a dead worker conservatively; report an orphan warning without clearing its lease.

Read [shared runtime instructions](../runtime.md) before invoking the companion. They define entrypoint resolution, task briefs, permissions, session continuation, and result handling.
