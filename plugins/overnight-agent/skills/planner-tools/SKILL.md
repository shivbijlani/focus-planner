---
name: planner-tools
description: >-
  Changes Shiv's Focus Planner (OneDrive Apps/Focus Planner) without driving the web UI:
  find tasks, add a task, set priority, defer/move, append an agent-attributed journal note,
  check a journal todo, or complete a task. Use whenever an agent needs to read or update
  planner tasks or journals from a chat, Muse, or a script. Runs the pinned planner-tools
  release (Node 22+), which uses the app's own mutation code and conditional OneDrive writes.
  Guardrail and settings files are unreachable through it.
---

# Planner tools

Pinned release: `planner-tools-v1.0.0` on github.com/shivbijlani/focus-planner.
Archive `planner-tools-1.0.0.tgz`; verify it against `planner-tools-1.0.0.tgz.sha256`
before extracting. Entry point after `tar -xzf`:
`node package/packages/planner-tools/bin/planner.js`. Full contract: `package/README.md`.

## How to call it

- **Muse (credential broker):** `planner mcp --broker` or one-shot `planner plan` with
  `{"tool","arguments","snapshots"}`. Execute the returned Graph reads/conditional writes
  through the broker. Only `already_applied` means saved.
- **Chat / scripts with sign-in:** `planner mcp --device-code` or
  `echo '{...}' | planner <tool> --device-code`. Needs "Allow public client flows" on the
  Focus Planner app registration (client `4f22242f-c9a7-4a61-9208-8ca0e5ef8697`).

## Rules

1. Call `find_tasks` first; confirm the task with the user when more than one matches.
2. One `operationId` per intended change; reuse it unchanged on every retry.
3. Pass `timeZone: "America/Los_Angeles"` on changes for Shiv.
4. Write journal notes as yourself (`author`: your agent name). Never as `me`.
5. Confirm with the user before `complete_task`.
6. Do not edit the local OneDrive sync folder directly; the tools write OneDrive with eTags.
7. Overnight Agent turns still go through `write-turn`, not `append_journal`.
