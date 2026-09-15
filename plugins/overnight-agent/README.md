# Overnight Agent (Copilot CLI plugin)

Autonomously makes progress on your **Focus Planner** tasks overnight using a
per-task **plan → approve → execute** loop. The agent *proposes* a plan inside a
task's journal, you *approve* it (or ask for revisions), and only an **approved**
plan gets **executed**. Approval is the safety gate.

This plugin packages the `overnight-agent` skill (its `SKILL.md`, helper
PowerShell scripts, native task-dispatch extension, and a settings template) so it can be installed with one
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

### Start/continue requests per run

The setting historically named **`Overnight Agent concurrency`** means **automatic start/nudge
attempts per overnight run**, not tasks running simultaneously. At `1`, the 10:00 run may start
task 468; the 10:30 run may nudge 468 again or start another eligible task while 468 continues.
Repeated nudges and overlapping task sessions are intentional. Coordinator runs are assumed
not to overlap on the same machine.

Use **`oa-state.ps1 scan`**, **`oa_run_budget`**, then **`oa_dispatch`** in the Copilot app.
The extension invokes the native `send_session_message` tool; it does not query app activity or
inspect task event logs. It needs Node 22+, Windows PowerShell 5.1 (or `pwsh` elsewhere), and the
app's native message tool. Missing tools stop dispatch rather than bypassing the budget.

`oa_dispatch` checks task eligibility and pauses, records the attempt in this run's counter,
checks again while stamping the wake, and sends the instruction. Requests within one run are
serialized. Failed/unconfirmed attempts consume this run's allowance only and are reported
explicitly; the next run has a fresh allowance. There are no cross-run reservations, generations,
delivery receipts, activity snapshots or deduplication keys.

Each scheduled run already gets its own coordinator session. Its small `files/oa-run-budget.json`
records the counted task IDs and whether each request was a priority or human collect request.
This survives a tool reload in the same run; the next session starts at zero. Budget reads are
read-only. Use a fresh coordinator session for a manual rerun too, rather than resetting a
running session's counter.

Saved task conversations and Today-first eligibility remain unchanged. Create new/replacement
sessions **idle, without a kickoff**, bind them, then send their first instruction through
`oa_dispatch`. Explicit human collect requests remain a separately reported budget exception;
they never override pauses or eligibility. Task-state writes remain locked and atomic because
task agents can still update state while a coordinator runs.

`oa-state.ps1 session -RunLimit` reads configuration only. The legacy `-InFlight` flag is an
alias for that read: it no longer emits a misleading running-worker count. `oa_run_budget`
reports `attempted_this_run`, `collect_attempted_this_run`, `remaining_this_run` and the counted
requests. No installed task state or old experimental receipt files are migrated or deleted.

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
