# Overnight Agent (Copilot CLI plugin)

Autonomously makes progress on your **Focus Planner** tasks overnight using a
per-task **plan → approve → execute** loop. The agent *proposes* a plan inside a
task's journal, you *approve* it (or ask for revisions), and only an **approved**
plan gets **executed**. Approval is the safety gate.

This plugin packages the `overnight-agent` skill (its `SKILL.md`, helper
PowerShell scripts, and a settings template) so it can be installed with one
command from the Focus Planner plugin marketplace.

## What's inside

```
overnight-agent/
├── plugin.json                 # Plugin manifest
└── skills/
    └── overnight-agent/
        ├── SKILL.md            # The skill instructions
        ├── user-settings.md    # Template — fill in your own values after install
        ├── oa-state.ps1        # Skill-owned per-task state (local, not synced)
        ├── check-google-token.ps1
        ├── ensure-mcp-browsers.ps1
        └── launch-signed-in-browser.ps1
```

## Install

From the marketplace (recommended):

```shell
copilot plugin marketplace add shivbijlani/focus-planner
copilot plugin install overnight-agent@focus-planner
```

Or install the plugin directly from the repo subdirectory:

```shell
copilot plugin install shivbijlani/focus-planner:plugins/overnight-agent
```

Verify it loaded:

```shell
copilot plugin list
```

```copilot
/skills list
```

## First-run setup

`skills/overnight-agent/user-settings.md` ships as a **placeholder template** so
the plugin is safe to publish. After installing, open it and replace every
`<...>` placeholder with your own values (planner paths, timezone, GitHub owner,
agent email account, and the email allow-lists). The skill reads this file at the
start of every run.

Keep your filled-in `user-settings.md` **out of any public repository** — see the
"Making your settings persist" section at the bottom of that file for durable
options.

## Usage

Ask Copilot to "run the overnight agent", "propose plans for my tasks", or
"execute approved plans". The skill's `SKILL.md` documents the full run flow
(inbox check → execute approved plans → propose new plans behind the approval
gate).

### Is this issue already shipped?

A shipped PR does not close its issue in this repo — it stays `OPEN` until the doc is
read — so `gh issue list` shows "nobody has done this" and "done, waiting on you"
identically. Measured 2026-09-08: 98 of 169 open issues were already shipped.

Before committing to an issue, ask:

```
node plugins/overnight-agent/checks/issue-shipped.mjs 588 620
```

`0` safe to pick up · `1` already shipped, pick something else · `2` could not classify
(**not** a pass) · `3` bad arguments.

It resolves each issue against implementation source on `origin/main` rather than the
commit log, because a commit subject names the PR, not the issue. `write-turn.ps1`'s G15
enforces the same answer on journal turns, so a run cannot recommend shipped work by
skipping the check (GH #635).
