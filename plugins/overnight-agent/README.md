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

When creating the scheduled **Overnight Agent** automation, select **Auto** as
its model (`model: auto` in the automation configuration). The
`Overnight Agent model` row in external `user-settings.md` defaults to `auto`;
`oa-state.ps1 session -RunLimit`, `session -Id` and `scan` report the resolved
preference and whether it came from the setting or the default. At present,
the app's idle `create_session` and `send_session_message` tools do not accept
a model argument, so changing this row does **not** change the automation's
configured model or enforce a model on task sessions. Configure the
automation's model separately; session-model enforcement requires an app API.

### Continuously drain the prepared queue

`Overnight Agent concurrency` is the number of normal instructions **from this run** that may
be outstanding. At `1`, start one task, observe it finish, then start the next eligible task.
At `2`, refill either opening independently. This is not a total-attempt quota: a run can finish
many tasks. Earlier runs' tasks do not reserve this run's openings, and a later run may nudge a
saved conversation again.

The implementation assumes a half-hour schedule at **:00 and :30**. The launch cutoff is the next
such boundary after the coordinator's first prompt **minus `Overnight Agent start buffer`**
from `user-settings.md` (default **`5m`**). A 10:30 next run therefore stops new starts at **10:25**,
not five minutes after a late tool call. At cutoff
the old run stops sending; its outstanding task conversations are left alone. This bounds
dispatch time, not task runtime or machine-wide concurrency. The five-minute example is never
used to infer completion. Buffer values are whole minutes `0` through `29`, with optional `m`;
`0m` disables it. Missing configuration defaults to five minutes. A malformed value or unreadable
existing file is explicit and prevents a new drain; it never silently chooses a shorter buffer.

The normal flow is **`oa_drain_status` → prepare/bind idle task sessions → scan and prepare
approved briefs → `oa_drain` → `oa_drain_wait` / status**. The model supplies a batch of approved
briefs and their exact `dispatch_input` fingerprints from that scan. Code owns queue selection,
priority and pause rechecks, sending, completion observation, refill and cutoff. Changed inputs
are rejected, not silently attached to an old brief. Each task is attempted at most once per run;
unprepared tasks require more preparation rather than an invented plan. Deferred prepared tasks
can become eligible as Today work finishes.

The SDK extension runs the loop automatically; waiting/status calls do not drive it. The
coordinator's `files/oa-drain.json` stores the queue, next run boundary, configured buffer/source,
immutable cutoff and outcomes across tool
reloads. An interrupted running/prepared queue resumes with the same cutoff, never a fresh window.
Buffer edits take effect on new runs. An initial call already inside the buffer sends nothing;
it does not roll forward to another half-hour. Old incompatible queue records are refused, not
silently reset or migrated.
The app must keep the coordinator host alive; its native completion tool is blocked while the
drain is active. Closing the host stops the loop, and a restart recovers its saved state.

**Accepted is not complete.** The sender adds a unique marker. Refill requires the target's
matching interaction to have started and ended, followed by an app-idle reading. A started
interaction at a human-input/plan gate is parked and releases its opening without another nudge.
Unconfirmed delivery and unknown completion stay visible and hold only that run's opening until
evidence arrives or cutoff. They do not reserve a later run's capacity. Observation is bounded to
16 MiB per outstanding request and native app calls to 15 seconds or the remaining window.
Remote event histories are unsupported and refused before sending. A known new local session
may create its event log after its first instruction; absent history never means completed.

After enrollment the pre-tool hook blocks raw native messages, create-with-kickoff, native
launch/resume shortcuts and premature coordinator completion. Only the scheduler's exact
one-use send is permitted, before cutoff. This is an operational native-tool guard, **not a
sandbox against arbitrary shell/network code**. Unenrolled sessions are outside its scope.

Today-first rules, saved conversations and pauses remain. Explicit human collect requests are
the separately marked width exception, but never bypass pauses, input freshness or cutoff.
Task-state writes remain locked/atomic because task agents can update them concurrently.
`session -RunLimit` (legacy alias `-InFlight`) reads the width, not a global occupied-worker count.
No live settings or old prototype state is automatically migrated or deleted.

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

## Optional reliability supervision tray (GH #695)

The plugin ships an **optional, off-by-default** Windows tray app that supervises the
GitHub Copilot desktop app itself — separate from, and out of process from, both the
overnight agent and the app it supervises:

```
plugins/overnight-agent/checks/
├── reliability-supervisor.mjs             # M/N preventive-restart policy engine
├── windows-app-actuator.mjs                # process identity + graceful/bounded-force actuation
├── session-terminal-evidence.mjs           # "quiet evidence" for the M/N window
├── consumer-reliability-supervisor.mjs     # wires the policy engine to the real desktop app
├── oa-supervisor-tray.ps1                  # the tray app itself
├── oa-supervisor-startup.ps1               # shared HKCU Run + lock-ownership helpers
└── install-oa-reliability-tray.ps1         # opt-in installer (status / -Enable / -Disable)
```

**Nothing is registered or started by installing or updating the plugin.** To opt in:

```powershell
powershell -File plugins\overnight-agent\checks\install-oa-reliability-tray.ps1 -Enable
```

This deploys the six files above to `%LOCALAPPDATA%\overnight-agent`, registers **one**
per-user startup entry (`HKCU\Software\Microsoft\Windows\CurrentVersion\Run\Overnight Agent
supervisor`), and starts the tray immediately. `-Disable` (alias `-Uninstall`) stops it and
removes the entry; running the installer with no switch only reports status.

The tray owns a single check: a preventive restart of the desktop app on an **M=3h quiet
opportunity / N=4h hard deadline** cycle, requiring a continuous **15-minute quiet window**
before a preventive (non-hard-deadline) restart, and never restarting more than once per
**60-minute cooldown**. Every restart decision — process identity (pid + start time + path),
the exclusive action lock, graceful-close-then-bounded-force termination, and the durable
JSONL audit trail — lives in `reliability-supervisor.mjs` / `windows-app-actuator.mjs`, run
as a child process on every evaluation; the tray itself never touches a process directly.
The tray's own **Pause** menu item is intentionally **not persisted**: it lasts only for the
current tray process and always clears back to normal supervision on the next start.

This is signed-in-user supervision only — it runs solely while the user is signed in to
Windows, exactly like the app it supervises, and it registers no Scheduled Task, Startup
shim, or service. Updating the *deployed* copy of these files (e.g. after a plugin update)
is a separate, maintainer/host-side concern — `auto-deploy-plugin.ps1` / `sync-oa-home.ps1`
are one such maintainer adapter for keeping a local checkout's deployed copy current. The
tray itself never fetches `origin/main` or any other remote source; it only ever executes
whatever copy is already deployed to its own home directory. Browser-watchdog tray
ownership and a shared `user-settings.md`-driven policy are tracked as separate follow-up
work and are intentionally not part of this tray.
