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
├── checks/
│   ├── oa-supervisor.ps1       # Existing out-of-band health check
│   ├── oa-supervisor-tray.ps1  # Optional tray app: one owner for local background checks
│   ├── oa-supervisor-startup.ps1 # Single startup route (HKCU Run), legacy cleanup
│   ├── oa-supervisor-components.ps1 # Fixed local-check inventory and child-process rules
│   ├── install-oa-supervisor.ps1 # Opt-in: status (default) / -Enable / -Disable
│   ├── oa-supervisor-daemon.ps1 # RETIRED stub; makes pre-#689 task/shim inert
│   ├── consumer-reliability-supervisor.mjs
│   ├── reliability-supervisor.mjs  # Shared M/N policy and transaction core
│   ├── windows-app-actuator.mjs     # Enterprise activity/process adapter
│   └── session-terminal-evidence.mjs # Enterprise session event evidence
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

### Reliability supervisor (Windows, optional tray app)

The out-of-band supervisor is an **optional tray app** and is **off by default**.
Installing or updating the plugin (including `sync-oa-home.ps1`) never registers
or starts it. You turn it on explicitly:

```powershell
# Status only - changes nothing
powershell -NoProfile -ExecutionPolicy Bypass -File plugins/overnight-agent/checks/install-oa-supervisor.ps1
# Opt in: deploy to %LOCALAPPDATA%\overnight-agent, remove legacy entries, register, start
powershell -NoProfile -ExecutionPolicy Bypass -File plugins/overnight-agent/checks/install-oa-supervisor.ps1 -Enable
# Opt out: stop the tray, remove the startup entry and any legacy entries
powershell -NoProfile -ExecutionPolicy Bypass -File plugins/overnight-agent/checks/install-oa-supervisor.ps1 -Disable
```

**One startup route.** Enabling writes a single per-user value,
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run\Overnight Agent supervisor`,
which starts `oa-supervisor-tray.ps1` at sign-in. It needs no elevation and appears
in Task Manager's Startup apps. This is the only local background startup route for
the project: there is no per-check Scheduled Task, Startup-folder shim or service.
The tray's **Start with Windows** item toggles the same value.

**What the tray runs.** Its reviewed inventory has two local checks:

| Check | Cadence | Role |
| --- | --- | --- |
| Overnight Agent supervisor | Every 15 minutes and at its M/N policy boundaries | Detects and safely recovers an unhealthy Overnight Agent app/run. |
| Browser watchdog | Every 60 minutes after **Enable browser checks** in the tray | Uses a CDP work probe to restore missing browser slots and thaw stuck pages in place; it does not close or restart signed-in browser windows. |

Both checks run as bounded child processes of the same tray, share its pause/exit
controls, and report separate state and last-check times. **Browser checks are independently
off by default**; enable/pause/history controls belong to this same tray, not another supervisor.
The browser helper remains callable on demand, but must not have its own chat automation,
Windows startup installer or resident controller. Adding another local check requires adding it
to the reviewed tray inventory; it does not create another startup entry.

The tray manages only local background checks owned by this project. GitHub-hosted
Copilot schedules and workflows keep their existing host-side controls. The planner's
development server is started only by the explicit `start planner` bootstrap and is
not installed as a persistent background service. Session-scoped MCP servers and
browser windows remain under their existing owners. MCP reaping, plugin auto-deployment and
the sweep suite remain in the Overnight Agent run; independent tray scheduling of those
operations, arbitrary third-party daemons, services, and logged-out supervision are **deferred**.
No background automation is created by the tray installer. The separate onboarding work in
issue #694 reconciles exactly one global Auto `Overnight Agent` automation, with no project or
folder binding; it must not create a `Focus Planner watchdog` or browser-watchdog automation.

**Logged-in only.** A Run entry starts after you sign in, and the tray exits when
you sign out. **Nothing is supervised while you are logged out.** The desktop app
it supervises also runs only in a signed-in session.

**Tray controls.** The shield icon's menu shows the last state and next check for
both local checks. It also shows the policy (M, quiet window, N and cooldown, or *INVALID/DISABLED*),
the current cycle's quiet-opportunity and hard-deadline times, any active cooldown,
and the most recent restart/launch outcomes from the audit. Actions are
**Check now**, **Enable browser checks**, **Check browsers now**, **Pause browser checks**,
**Pause/Resume supervision** (saved in `supervisor-tray.json`), **Start with Windows**,
**Remove legacy scheduled task / Startup shim**
(shown only when one exists), **Open supervisor folder** and **Exit**. Exit stops both
checks until the next sign-in, or until you start the tray again. Browser consent, pause and
the last five outcomes survive restarts; `-Disable` clears browser consent as well.

The tray is a separate process from the Overnight Agent and the desktop app. It
runs `oa-supervisor.ps1` as a child process for each evaluation, so its UI and
scheduler do not depend on overnight-agent process health. It evaluates at most
every 15 minutes and writes a heartbeat every 15 seconds. It wakes early at the M/N
boundaries or when the cooldown expires. The tray never restarts anything itself:
every decision and safeguard below lives in `reliability-supervisor.mjs`.
Each child check has a 15-minute outer timeout, independent of the other check; errors and
timeouts remain visible in its heartbeat and tray status. Exit cancels verified checker
PowerShell/Node workers without terminating browser windows or the Copilot desktop app.
Pause prevents new checks; it does not interrupt one already in progress.

**Migration from older installs.** `-Enable` and `-Disable` remove only the known
legacy entries: the Overnight Agent supervisor task/Startup shim and the browser
watchdog task/Startup shim (`Copilot browser watchdog` and `CopilotBrowserWatchdog.vbs`).
The known `%LOCALAPPDATA%\playwright-mcp\browser-watchdog.ps1` controller is stopped only
after matching its exact script command and process identity. Other active browser checks
cause the tray to defer its browser check rather than kill an unknown process.
If a legacy task cannot be removed (for example, it was
registered from an elevated prompt), `-Enable` stops *before* registering the tray;
remove that exact task from an elevated prompt and retry. The deployed
`oa-supervisor-daemon.ps1` is an inert stub. `supervisor-liveness-sweep.ps1` reports
legacy routes as `LEGACY`, an opted-out tray as `OFF`, and a paused tray as `PAUSED`.
Migration refuses same-named tasks outside the root task folder. The retired
`install-browser-watchdog-skill.ps1` only reports the canonical installer; it no longer writes
a separate skill shim or restores the old watchdog. Remove any existing separate watchdog
chat automation using Copilot's automation settings before opting in. The installer never
edits the application's automation database.

**Policy.** The default **M=3 hours** is a
quiet opportunity: the enterprise snapshot adapter reads the GUI process,
both app/session SQLite stores, workflow and session projections, process
locks, and session events. Evidence must remain unchanged and continuously
quiet for **15 minutes**. Unknown activity postpones M. At
**N=4 hours**, active or unknown *activity* no longer postpones an attempt, but
unknown or changed **process identity**, another action owner, and the **60-minute
attempt cooldown** still prevent termination. The age is anchored to the GUI
process start time; a failed attempt does not reset it. N bounds an attempt,
not successful recovery or uninterrupted operation. An absent app is not launched
by the preventive timer; the existing schedule-dead check can still launch it.

The action lock and policy, cycle state, snapshot, heartbeat, and JSONL audit
live under `%LOCALAPPDATA%\overnight-agent\` (`reliability-supervisor-action.lock`,
`reliability-supervisor.json`, `reliability-supervisor-state.json`,
`reliability-supervisor-snapshot.json`, `supervisor-daemon-heartbeat.json`,
`reliability-supervisor-audit.jsonl`). The
policy is created with defaults on the first check and can be edited to change
M/N, the quiet window, cooldown, or `supervisor.enabled`. Invalid policy fails
closed. The same action lock protects the existing stuck-run/schedule-dead/
resource-leak **restart** and schedule-dead launch paths; no restart kills by process name. A quiet
opportunity requests `CloseMainWindow` first, with a bounded wait before
verified-PID force. N goes directly to verified-PID force. Each destructive
step rechecks PID, executable path and process start time; only the verified GUI
root and descendants of its process tree are eligible. A failed attempt is
audited and holds the cooldown.

**Node.js 24+ is required** for the enterprise `node:sqlite` evidence adapter;
`-Enable` refuses an older runtime before changing anything. Updating the repo
alone updates the deployed flat-home copies (through `sync-oa-home.ps1` or a re-run
of `-Enable`) but never enables the tray. To inspect a check
without restarting anything, run
`node plugins/overnight-agent/checks/consumer-reliability-supervisor.mjs --no-act`.
For the tray's read-only status view, run the same script with `--status`.
The Windows desktop GUI and its local session/workflow evidence must be readable
for a quiet restart; if resident activity cannot be proven quiet, it waits for N.
After launch the enterprise adapter requires a distinct GUI identity and fresh
scheduled/catch-up dispatch for work that was due (no due work requires readiness
only). Unknown scheduler evidence does not count as a successful recovery.
Enterprise Dev Box bootstrap, managed-app setup, MCP/profile seeding, ADO logic,
and multi-machine announcements are intentionally not included.

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
