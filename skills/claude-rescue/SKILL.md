---
name: claude-rescue
description: Delegate a task to Claude Code for investigation, planning, implementation, debugging, or testing when the user asks Claude to help or requests a second agent.
---

# claude:rescue

Delegate the substantial work to Claude with a clear brief rather than solving it twice. Use the rescue command, normally with --background for substantial work. Monitor incremental status while this Codex task remains active, then retrieve and evaluate the result. Honor explicit model and effort choices; use --access read-only|edit|shell to match capabilities to the authorized task. When the user requests settings selection, obtain the missing choices before launching; reuse choices already supplied. Read the returned report and decide whether to accept, verify, or resume with specific feedback. Continue an authorized plan into implementation in the same session using --resume and explicit capability flags; preserve the exact job UUID and caller identity when available.

Read [shared runtime instructions](../runtime.md) before invoking the companion. They define entrypoint resolution, task briefs, permissions, session continuation, and result handling.
