---
name: claude-result
description: Retrieve the stored report from an explicitly identified Claude delegation job.
---

# claude:result

Run result with the exact job UUID and target directory. Retrieve the job from this conversation or list status to identify it; never guess or use a globally latest Claude session. Use the compact default output; request --full only for a concrete diagnostic need. Summarize the useful outcome instead of reproducing JSON or routine metadata. Inspect the versioned report, preserving failure/partial state. Separate process success, Claude’s completion/check claims, observed tool/file metadata and independent Codex verification. Hash changes do not prove who edited a file or whether a task is correct; evaluate acceptance criteria before accepting the result.

Read [shared runtime instructions](../runtime.md) before invoking the companion. They define entrypoint resolution, task briefs, permissions, session continuation, and result handling.
