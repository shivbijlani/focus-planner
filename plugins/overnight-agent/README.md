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

Set the **app's default model to Auto** on each computer before running the
Overnight Agent. When creating the scheduled **Overnight Agent** automation,
select **Auto** as its model (`model: auto` in `save_workflow`). The
`Overnight Agent model` row in external `user-settings.md` defaults to `auto`;
`oa-state.ps1 session -RunLimit`, `session -Id` and `scan` report the resolved
preference and whether it came from the setting or the default. At present,
the app's idle `create_session` and `send_session_message` tools do not accept
a model argument, so idle-created and woken task sessions inherit the **app's
default model**. Changing this row does **not** change the automation's
configured model or enforce a model on task sessions. When intentionally
overriding Auto, pass the resolved value as `model` to `save_workflow` and set
the app default to that value separately;
session-model enforcement requires an app API.

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
├── consumer-browser-watchdog.mjs           # browser-check workload (off by default, GH #698)
├── consumer-update-check.mjs               # plugin update-check workload (daily, report-only, GH #701)
├── oa-user-settings.mjs                    # the ONE reader for tray policy in user-settings.md
├── oa-supervisor-tray.ps1                  # the tray app itself
├── oa-supervisor-startup.ps1               # shared HKCU Run + lock-ownership helpers
└── install-oa-reliability-tray.ps1         # opt-in installer (status / -Enable / -Disable)
```

**Nothing is registered or started by installing or updating the plugin.** To opt in:

```powershell
powershell -File plugins\overnight-agent\checks\install-oa-reliability-tray.ps1 -Enable
```

This deploys the files above — plus the existing browser tools the browser-check workload reuses (`browser-watchdog.ps1`, `check-browser-slots.ps1`, `browser-slot-table.ps1`, `ensure-mcp-browsers.ps1`) — to `%LOCALAPPDATA%\overnight-agent`, registers **one**
per-user startup entry (`HKCU\Software\Microsoft\Windows\CurrentVersion\Run\Overnight Agent
supervisor`), and starts the tray immediately. `-Disable` (alias `-Uninstall`) stops it and
removes the entry; running the installer with no switch only reports status.

The tray owns a single check: a preventive restart of the desktop app on an **M=3h quiet
opportunity / N=4h hard deadline** cycle, requiring a continuous **15-minute quiet window**
before a preventive (non-hard-deadline) restart, and never restarting more than once per
**60-minute cooldown**. Those four values and the workload's on/off switch are **yours to
change**, in the external `user-settings.md` (GH #696) — see below. Every restart decision —
process identity (pid + start time + path), the exclusive action lock,
graceful-close-then-bounded-force termination, and the durable
JSONL audit trail — lives in `reliability-supervisor.mjs` / `windows-app-actuator.mjs`, run
as a child process on every evaluation; the tray itself never touches a process directly.
The tray's own **Pause** menu item is intentionally **not persisted**: it lasts only for the
current tray process and always clears back to normal supervision on the next start.

### The policy lives in `user-settings.md` (GH #696)

The workload's user-facing policy is read from the **external** `user-settings.md` — the same
file that carries every other Overnight Agent setting, resolved in the same documented order
(`$OVERNIGHT_AGENT_SETTINGS` → project folder → `%OneDrive%\Apps\Focus Planner\` →
`%LOCALAPPDATA%\overnight-agent\`), and never overwritten by a plugin update. Add the section
below to change it; **leave it out and the product defaults above apply.**

```markdown
## Tray reliability supervision

| Setting | Value |
| --- | --- |
| Enabled | `on` |
| Quiet opportunity (M) | `3h` |
| Hard deadline (N) | `4h` |
| Quiet window | `15m` |
| Restart cooldown | `60m` |
```

Every row is optional. Durations accept `3h` or `180m`; `Enabled` accepts `on`/`off`. Omit
`Hard deadline (N)` and it is derived from the `M` you set. A row the reader cannot
understand — an unknown name, an out-of-range value, an `N` that does not exceed `M` — is
**refused by name**, and supervision declines to act rather than acting on a guessed policy;
the tray's status shows the refusal.

`%LOCALAPPDATA%\overnight-agent\reliability-supervisor.json` is **derived**: it is rewritten
from `user-settings.md` on every evaluation, so hand-editing it has no lasting effect. Each
tray workload owns its own sibling `##` section, so a later workload adds its own section and
its own independently-missing policy rather than extending this one. This is a fresh-install
design with no migration from previously hand-written JSON.

This is signed-in-user supervision only — it runs solely while the user is signed in to
Windows, exactly like the app it supervises, and it registers no Scheduled Task, Startup
shim, or service. Updating the *deployed* copy of these files (e.g. after a plugin update)
is a separate, maintainer/host-side concern — `auto-deploy-plugin.ps1` / `sync-oa-home.ps1`
are one such maintainer adapter for keeping a local checkout's deployed copy current. The
tray itself never fetches `origin/main` or any other remote source; it only ever executes
whatever copy is already deployed to its own home directory. The only update action the tray
can take is the separate update-check workload below, which goes through the Copilot plugin
marketplace CLI, never git.

### Browser checks in the tray (GH #698)

The same tray is the **only** resident dispatcher for browser-watchdog checks — an
**independent workload** with its own `## Tray browser checks` section in `user-settings.md`,
its own schedule, its own in-memory **Pause browser checks**, its own state file
(`browser-checks-state.json`) and its own lock (`browser-checks.lock`). It shares no M/N state,
cooldown or action lock with reliability supervision. There is no separate Scheduled Task,
Startup shim or VBS launcher for browser checks; `/browser-watchdog` stays available on demand.

It is **completely off by default, including observation**. Each action is a separate opt-in:

```markdown
## Tray browser checks

| Setting | Value |
| --- | --- |
| Enabled | `on` |
| Observe | `on` |
| Thaw stuck slots | `off` |
| Auto-launch closed slots | `off` |
| Check interval | `60m` |
```

`Observe` runs a read-only CDP work probe; `Thaw stuck slots` allows the non-destructive
in-place thaw; `Auto-launch closed slots` allows starting a closed slot. **Observe and Thaw
never imply Auto-launch** — the tray passes `-NoLaunch` to `browser-watchdog.ps1` unless
Auto-launch is explicitly `on`. The slots are always the existing `## Browser slots` table. The
workload reuses `browser-watchdog.ps1` / `check-browser-slots.ps1` / `browser-slot-table.ps1` /
`ensure-mcp-browsers.ps1` rather than reimplementing them, and never kills or reparents a browser or MCP
worker process. The tray's **Browser checks** menu shows the current status and recent outcomes.

### Plugin update checks in the tray (GH #701)

A third **independent workload** asks whether a newer `overnight-agent` is available. It has
its own `## Tray update checks` section in `user-settings.md`, its own interval, its own
in-memory **Pause update checks**, its own state file (`update-check-state.json`, holding
`lastCheckedAt`, `installedVersion`, `availableVersion` and `lastResult`) and its own lock
(`update-check.lock`). It shares no state, lock or cooldown with the reliability or browser
workloads and imports neither of them.

It is **on by default, checks daily, and only reports**. Hourly is one row away:

```markdown
## Tray update checks

| Setting | Value |
| --- | --- |
| Enabled | `on` |
| Check interval | `hourly` |
| Auto apply | `off` |
| Source | `marketplace` |
```

`Check interval` accepts `hourly`, `daily`, `weekly` or a duration from `60m` to `168h`.
`Source` accepts only `marketplace`. A row it cannot read is refused by name and no check runs.

The **only source is the Copilot plugin marketplace**, driven through the Copilot CLI:
`copilot plugin marketplace list --json` (is `focus-planner` registered?), `copilot plugin
list --json` (is `overnight-agent` installed from it, and at which version?), a best-effort
`copilot plugin marketplace update focus-planner` plus `copilot plugin marketplace browse
focus-planner --json` (the catalog version). The installed and catalog versions are then
compared. With **Auto apply off** (the default) the tray's **Plugin updates** menu just
shows *update available* and nothing is installed. With it on, the workload runs `copilot
plugin install overnight-agent@focus-planner` and reads the installed version again to
confirm it moved. A tray started with `-NoAct` can only report.

It is idempotent. A run inside the interval touches no CLI and writes nothing, so restarting
the tray never adds a check. A failed check is retried after at most an hour. The tray
**never** runs git or fetches `origin/main`, and it never uses `auto-deploy-plugin.ps1`,
`deploy-installed-plugin.ps1` or `sync-oa-home.ps1`; those stay maintainer-only.

**Stale fallback without the tray:** `node consumer-update-check.mjs` performs a check only if
one is due. `node consumer-update-check.mjs --stale-note` is read-only and non-blocking: it
runs no CLI, writes nothing, and prints a note when the last completed check is older than
the interval (or when an update is already known to be available).
