---
name: focus-planner-onboarding
description: >
  Installs or updates the Focus Planner Overnight Agent from GitHub and creates its chat-first
  automations. Use when the user says "follow onboarding in github__shivb--focusplanner__",
  asks to install this with the https://github.com/shivbijlani/focus-planner URL, or asks to
  install/setup the Focus Planner watchdog or Overnight Agent from that repository.
---

# Focus Planner onboarding

Install the watchdog first; the watchdog reconciles the Overnight Agent automation. Both are
**global chat automations** using model **Auto**. Never bind either automation to a project,
repository, folder, workspace, or branch. In particular, never use a OneDrive folder as an
automation workspace. Per-task work still gets its own isolated, reusable workspace through the
Overnight Agent dispatch flow.

## 1. Install or update the plugin

Run these non-interactive commands and stop on any non-zero exit:

```powershell
copilot plugin marketplace add shivbijlani/focus-planner
copilot plugin install overnight-agent@focus-planner
```

If the marketplace already exists or the plugin is already installed, run:

```powershell
copilot plugin update overnight-agent@focus-planner
```

Verify with:

```powershell
copilot plugin list
```

Do not clone the repository into OneDrive and do not create a folder project for either automation.

## 2. Reconcile the global watchdog automation

Use `list_workflows` first. Find the automation named **Focus Planner watchdog**.

- If it exists, update that exact workflow with `save_workflow`.
- If it does not exist, create it with `save_workflow`.
- Set `global: true`, `model: auto`, `mode: autopilot`, `interval: hourly`, and `enabled: true`.
- Do not pass `project_id`, `remote_branch`, or `workspace_type`.
- Preserve the existing `host_id` on update. For first creation, use an exact host id already shown
  by `list_workflows`; if none is available, use `user_confirmation: dialog` so the user selects the
  host once rather than guessing.

Use this prompt verbatim:

> Install or update `overnight-agent@focus-planner`. Then reconcile a global automation named
> `Overnight Agent`: model Auto, mode autopilot, cron `*/30 * * * *`, enabled, no project, folder,
> workspace, branch, or OneDrive binding. Use `list_workflows` before `save_workflow`; update the
> existing exact-name automation rather than creating a duplicate. Run `/browser-watchdog` once.
> OS scheduled tasks, Startup shims, and resident watchdog processes remain disabled unless their
> separate `user-settings.md` rows are explicitly `on`.

## 3. Verify the end state

Call `list_workflows` again and require exactly one enabled **Focus Planner watchdog** and exactly one
enabled **Overnight Agent**. Both must report model Auto and no project binding. If the first watchdog
run has not yet reconciled the agent, run the watchdog automation once and check again.

Report the two workflow ids, schedules, model, and global/no-project state. Do not install Windows
Scheduled Tasks, Startup-folder shims, or resident daemon processes during onboarding.
