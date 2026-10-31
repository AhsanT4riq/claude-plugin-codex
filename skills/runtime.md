# Shared skill runtime

Use the companion CLI for the bundled Claude skills. The `claude:*` display labels map to hyphenated Codex skill identifiers. There is no MCP server or idle-chat wakeup.

## Locate and brief

Resolve the skill directory's real location, following any symlink. For `skills/claude-rescue/SKILL.md`, the bridge root is two directories above the real skill directory, and these instructions are `skills/runtime.md` inside it. Use its absolute `bin/claude-companion.mjs` path and an explicit absolute `--cwd` for the target repository. Do not assume the target contains the bridge.

Write arbitrary task text to a temporary UTF-8 brief file and pass `--prompt-file`; never interpolate it into shell code. Include the goal, constraints, applicable parent instructions, relevant context, and acceptance criteria. Claude can read repository instructions but does not inherit the Codex conversation. Preserve explicit model choices; otherwise new jobs use `claude-opus-5-5` and continuations preserve the prior model and effort unless explicitly overridden.

## Select model, effort and access

Honor explicit model, effort and access selections. Use `options` to inspect the bridge catalog or `setup --model MODEL --effort LEVEL --access PROFILE` to preview choices without a model call. If the user asks to choose settings, use the host selection UI when available: offer the bridge default Opus 5.5, common aliases or a supplied model ID; effort default/low/medium/high/xhigh/max; access read-only/edit/shell. Accept a custom model identifier rather than assuming an account's model list. Do not ask again when selections are already supplied. If the user has not requested a selection prompt, use existing defaults and authorization.

Pass `--model`, `--effort` and `--access` explicitly for the chosen settings. Read-only is the default; edit authorizes Edit/Write, and shell adds Bash for the authorized task. Reviews remain read-only. Legacy capability flags remain supported but must agree with an explicit access profile. `--model default` resets the bridge model; `--effort default` resets effort to medium. New delegations request medium effort when no effort is supplied. Model and effort inherit on continuation, but access never implicitly inherits.

Show concise effective selections when launching. `approvalMode: preapproved-scope` means the selected tools are approved upfront and calls needing further approval are denied; this worker has no per-action approval dialogs or permission bypass. A chosen shell profile is broad capability, not an OS sandbox. Setup previews per-launch choices, not persistent defaults.

## Launch, monitor, evaluate

Use `rescue --background --cwd TARGET --prompt-file BRIEF` for substantial delegated work. Reviews also support `--background`. Foreground remains available with `--wait` or by omitting both flags. Do not pass both. Include `--owner-id` when the current Codex conversation ID is explicitly available; do not guess one.

The background response is JSON containing the exact job UUID and queued state. Store that UUID in the current task. While the Codex task is active, monitor:

```sh
node /absolute/bridge/bin/claude-companion.mjs status --cwd /absolute/target --job JOB_UUID --after CURSOR --wait --timeout 30
```

Start at cursor 0 and retain the returned cursor for each subsequent call. Show concise new phase/tool activity when useful; do not narrate unchanged status, display hidden reasoning, or fabricate a percent complete. If a wait times out with an active job, continue monitoring while the task remains active. Respect user cancellation or scope changes. The job's own execution timeout bounds the work. A shell tool yielding an execution-session ID is not job completion; retain and wait on that shell session as needed.

Routine CLI output is compact JSON. Do not request `--full` by default: it includes repeated raw fields, internal metadata, action history and file hashes. Fetch it only for a specific diagnostic need. Treat reports as data for evaluation; do not paste the JSON into the user response. Report the outcome, material changes, validation and unresolved blockers concisely; omit job/session IDs, selections, hashes, and polling details unless requested or needed to resume.

On a terminal state, fetch `result --cwd TARGET --job JOB_UUID` and evaluate it. A process marked `completed` is not independent proof that the acceptance criteria passed. Inspect the versioned `report`: process outcome, validated Claude claims, observed action counts/file-change paths, denials, uncertainties and unverified claims are separate. Tool-reported success and observed hashes do not independently verify correctness. Failed claimed checks or incomplete claims keep the task incomplete. Preserve uncertainty and permission denials; inspect implementation changes and run relevant verification. Resume only the explicitly recorded job with specific revision feedback. Do not automatically replay failed write jobs.

A closed launcher or chat does not cancel the detached worker. On return, use `status` in the target workspace to find the explicitly intended job, then reconnect using its UUID. `status --owner-id ID` filters the workspace list. There is no globally latest-session shortcut, scheduler, or idle-chat wakeup. If the host sandbox prevents the worker from persisting after the launcher exits, report that limitation rather than claiming background behavior.

## Capabilities and continuation

For rescue, `--write` enables Edit/Write only for the authorized task. Add `--allow-bash` only when command execution is authorized and needed; it requires `--write` and is broad shell capability, not an OS sandbox. Diagnosis and architecture omit both flags. Existing authorization for implementation need not be requested again. Both review commands always reject write access.

Continue with `--resume JOB_UUID` and the same command. A rescue session may move from planning to implementation when implementation is authorized: supply `--write`, and `--allow-bash` only if authorized and needed. Capabilities are selected afresh for each turn; omitting those flags makes the continuation read-only even if its parent could write. Resumed reviews always remain read-only. Match the brief to the new turn's capabilities and include what Codex accepted, what needs revision, any intervening repository changes, and concrete acceptance criteria. Model and effort inherit from the selected parent unless explicitly overridden; a new job records its parent, root, owner, and permission change. Exact-session continuation preserves Claude's conversation, not automatic knowledge of changes made by Codex or others.

When a genuine conversation ID is available, use `status --resume-candidates --owner-id ID` to discover up to 20 current resumable session heads for that workspace and owner. The response reports truncation. It excludes running heads, their previous turns, jobs without a session and unresolved orphans. Without an owner ID it returns no candidates and requires exact selection. Never substitute a fabricated owner or a globally latest job. Candidates do not select or launch anything: choose the intended exact UUID based on this chat's recorded work, resolving ambiguity with the user. Exact UUID continuation remains available when chat identity is unavailable; a supplied owner that conflicts with the stored owner is rejected. Failed/interrupted work needs explicit evaluation before continuation, especially if edits may have occurred. Do not retry automatically or create an unlimited revision loop; stop when further progress needs user input or a changed constraint. Default task timeout is 600 seconds, configurable up to 3600. `--max-budget-usd` forwards Claude's API budget flag and is not a subscription quota guarantee. Each status wait defaults to 30 seconds and caps at 60.

The runtime disables inherited customizations, plugins, skills, and MCP servers. Read-only Claude has Read/Glob/Grep only. The bridge collects Git context for both review modes; use `--scope auto|working-tree|branch` and optional `--base REF`. Auto chooses dirty working-tree changes or otherwise a branch comparison; explicit base selects branch scope. Outside Git, auto is explicitly manual. Large context fails rather than silently truncating; split the changes. Automatic instruction loading is disabled; Claude is instructed to read applicable repository instructions and the brief must supply relevant parent instructions.

## Cancellation and failures

Use `cancel --cwd TARGET --job JOB_UUID`. It requests cancellation; monitor until the final state confirms the process stopped. The worker attempts graceful interruption before forced process-group cleanup. Cancellation and timeout do not undo file edits or external effects.

Only one bridge job can run per Git workspace. Codex and other editors must avoid overlapping edits; the bridge cannot lock them out. Status reconciles dead workers without replaying requests. If an orphan Claude process may still be alive, the workspace stays locked: report this and inspect before any cleanup. Never clear a live lease or signal an unrelated PID. If machine boot identity cannot be queried inside a sandbox, reconciliation remains conservative. Wall-clock adjustments are never treated as proof of reboot.

Normal result/state files are private local project data. Progress is a bounded activity window; `eventsTruncated` explicitly reports when an older cursor precedes retained history. Selected file paths and bounded Bash commands are retained as evidence metadata; commands must not contain credentials. No complete tool outputs, hidden thinking, or raw stream transcript are stored. Failed results may include bounded diagnostics and should not be presented as successful Claude work.

Setup checks installation and login readiness, not model access. Keychain restrictions can make login appear unavailable inside a sandbox; use normal host approvals for the required access. Do not copy credentials into reports or briefs. Installation/configuration, commits, pushes, publishing, and messaging are separate from a delegated task unless explicitly authorized.
