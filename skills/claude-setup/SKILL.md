---
name: claude-setup
description: Check Claude Code installation and login readiness for delegation from Codex.
---

# claude:setup

Run the setup command and report installation, login method, and model-access uncertainty. Use options to list model/effort/access choices; setup accepts --model, --effort and --access to preview selections without a model call or saving global defaults. Approval is upfront within read-only/edit/shell scope; per-action permission dialogs are not supported. It does not install software, log in, or test a model call. If a sandboxed check reports no login, first account for the observed macOS keychain restriction: retry once through the host’s normal authorized access mechanism before concluding the user must log in. Do not extract credentials or bypass host permissions. If the normally authorized check also reports no login, explain how to run claude auth login in a user terminal. Account details and credentials must stay out of reports.

Read [shared runtime instructions](../runtime.md) before invoking the companion. They define entrypoint resolution, task briefs, permissions, session continuation, and result handling.
