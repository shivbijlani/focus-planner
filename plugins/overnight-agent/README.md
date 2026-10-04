# Overnight Agent (Copilot CLI plugin)

Autonomously makes progress on your **Focus Planner** tasks overnight. Each
step is classified: reversible and standing-rule-allowed work goes to the
task's session in the same run; actions that need approval wait behind one
specific question in its journal. A plan is proposed for approval only when
its first step is gated.

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
        ├── oa-state.mjs        # Skill-owned per-task state (local, not synced); node <skill>\oa-state.mjs <cmd>
        ├── oa-state-lib/       # its modules: core / collect / plan / act / report
        ├── oa-state.ps1        # the same CLI in PowerShell, fallback only (whole run, never mixed)
        └── check-google-token.ps1
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

For non-code tasks, create one local folder project outside OneDrive (once per machine):

```powershell
New-Item -ItemType Directory -Force -Path "$env:LOCALAPPDATA\overnight-agent\task-chats"
```

Then call `create_project` with `path` set to `%LOCALAPPDATA%\overnight-agent\task-chats`
(expanded to its absolute path). Put the returned project ID in the external
`user-settings.md` row `Non-code task project`. Do not use the OneDrive planner
folder or a repository project: each non-code task gets a session in this fixed
local folder project. The binding command refuses either unsafe location.

### Optional machine hygiene (Windows)

Run `checks/setup-machine-hygiene.ps1 -WhatIf` first. It reports whether Windows
Widgets are installed, whether the `Dev drive (repos)` in your **external**
`user-settings.md` is a trusted Dev Drive, and the Defender state of
`%LOCALAPPDATA%\npm-cache`, `%LOCALAPPDATA%\uv\cache`, and
`%LOCALAPPDATA%\overnight-agent\task-chats`. `-WhatIf` does not prompt, write a
log, or change settings. A non-Dev Drive is reported with Microsoft's
[Dev Drive guide](https://learn.microsoft.com/windows/dev-drive/); the script
does not create one. If settings are not found, pass `-SettingsPath` explicitly.

Run `checks/setup-machine-hygiene.ps1` without `-WhatIf` only if you want to
review the offers. It asks separately before removing Widgets for your user
(undo: reinstall **Windows Web Experience Pack** from Microsoft Store), trusting
an existing Dev Drive, or excluding each regenerable/non-code folder. It combines
selected Defender/Dev Drive changes into **one UAC prompt** and writes a log to
`%TEMP%\overnight-agent-machine-hygiene.log` (override with `-LogPath`). After
trusting a volume, remount or reboot before assuming Defender performance mode
fully applies. It never excludes the plugin, OA-home scripts, or executable
code. The `task-chats` folder is non-code only; do not put scripts there.
This optional offer is separate from the [onboarding installer (#694)](https://github.com/shivbijlani/focus-planner/issues/694);
integrate its entry point there rather than creating a second installer.
The live devbox steps and adjacent setup (Truthifi disabled, browser profiles
and account-labeled shortcuts, non-code task project) are recorded in
[#733](https://github.com/shivbijlani/focus-planner/issues/733#issuecomment-5883956307);
this script does **not** change those other configurations.

For Google Workspace MCP compatibility on a new machine, install the proven
pair from [#747](https://github.com/shivbijlani/focus-planner/issues/747):

```powershell
uv tool install workspace-mcp==1.30.0 --with "fastmcp<4" --force
```

A plain `uv tool upgrade workspace-mcp` **drops the FastMCP pin** and can break
the Copilot MCP handshake; rerun the pinned command instead until the host
supports the newer protocol.

## Usage

Ask Copilot to "run the overnight agent" or "work on my tasks". The skill's
`SKILL.md` documents the full run flow (inbox check → dispatch approved and
reversible work → ask only for gated actions).

Set the **app's default model to Auto** on each computer before running the
Overnight Agent. When creating the scheduled **Overnight Agent** automation,
select **Auto** as its model (`model: auto` in `save_workflow`). The
`Overnight Agent model` row in external `user-settings.md` defaults to `auto`;
`oa-state.mjs session -Id` and `scan` report the resolved
preference and whether it came from the setting or the default. At present,
the app's idle `create_session` and `send_session_message` tools do not accept
a model argument, so idle-created and woken task sessions inherit the **app's
default model**. Changing this row does **not** change the automation's
configured model or enforce a model on task sessions. When intentionally
overriding Auto, pass the resolved value as `model` to `save_workflow` and set
the app default to that value separately;
session-model enforcement requires an app API.

### Direct dispatch

The coordinator sends task briefs directly with `send_session_message`. The plugin declares no
extensions and registers no tool hooks, so loading it requires no extension permission prompt.
The cutoff, hard end and one-send-per-task rules remain coordinator instructions in `SKILL.md`,
not mechanical tool restrictions. The existing run ledger still records run starts and decision
records for after-the-fact review; user-pause and agent-gate checks remain on the dispatch path.
Before selecting work, the coordinator saves a `get_sessions_status` snapshot and passes it to
`oa-state.mjs scan -Compact -SessionsStatusFile <file>`. A bound session already busy is reported
as `busy_from_earlier_run`, skipped without consuming this run's concurrency, and checked again
with a fresh snapshot by `session -ForDispatch` immediately before any send. Only accepted sends
from the current run occupy its openings.
`Overnight Agent concurrency` limits accepted sends still active at once, not
the total tasks started during a run. It fills openings in `scan -Compact` order, checks tracked
sessions with one `get_sessions_status` call about every 60 seconds, and re-scans to refill an
opening when a session goes idle. It never sends twice to the same task in one run.

For each task, the coordinator reads `oa-state.mjs session -Id <ID>` first. A `paused` verdict
skips the task. `create` and `replace` create a new task session idle and bind it before sending;
replacement messages begin with the returned `kickoff_continuation`. Immediately before each
send, `session -Id <ID> -ForDispatch -DispatchInput <hash>` rechecks eligibility, user pause and
the exact brief fingerprint, and stamps the wake. If the check throws, nothing is sent. If a send
fails, the coordinator marks that session dead and continues to the next eligible task without
retrying it.
Failed sends, refusals and pauses release the opening; a refusal is never overridden with a
follow-up message in the same run. A task still running at the end continues independently.

The coordinator checks its start cutoff before every send: the next local **:00 or :30** after its
first prompt, minus `Overnight Agent start buffer` from `user-settings.md` (default `5m`). For a
10:30 next run, no send starts at or after 10:25. Valid buffer values are whole minutes `0`–`29`,
optionally suffixed `m`; if an existing value cannot be read or parsed, the coordinator sends
nothing and reports the problem. The separate hard end is one minute before the next run:
at or after it, the skill instructs the coordinator to stop, write its one-line wrap-up and exit.
The coordinator stops starting tasks at that cutoff, without waiting for active tasks to finish.

**Upgrading from the earlier extension:** current installs no longer create the user-level loader
shim. Remove any stale copy left by an earlier install with:

```powershell
$shim = Join-Path $HOME '.copilot\extensions\overnight-task-dispatch\extension.mjs'
if (Test-Path -LiteralPath $shim) { Remove-Item -LiteralPath $shim -Force }
```

This only removes the obsolete dispatch shim; it does not affect other extensions or task
sessions.

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
commit log, because a commit subject names the PR, not the issue. `write-turn.mjs`'s G15
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

This deploys the files above — plus the existing browser tools the browser-check workload reuses (`browser-watchdog.ps1`, `check-browser-slots.ps1`, `browser-slot-table.ps1`) — to `%LOCALAPPDATA%\overnight-agent`, registers **one**
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

### Browser checks in the tray (GH #698, simplified by GH #738)

The same tray is the **only** resident dispatcher for browser status checks — an
**independent workload** with its own `## Tray browser checks` section in `user-settings.md`,
its own schedule, its own in-memory **Pause browser checks**, its own state file
(`browser-checks-state.json`) and its own lock (`browser-checks.lock`). It shares no M/N state,
cooldown or action lock with reliability supervision. There is no separate Scheduled Task,
Startup shim or VBS launcher for browser checks; `/browser-watchdog` stays available on demand.

GH #738 switched every Playwright MCP slot from attach-only (`--cdp-endpoint`) to launching
its own profile directly (`--browser msedge --user-data-dir <dir>`), so there is no longer a
shared browser to launch or thaw on this workload's behalf — each MCP server owns its browser
for the length of one session. What remains is **completely off by default, including
observation**, and read-only:

```markdown
## Tray browser checks

| Setting | Value |
| --- | --- |
| Enabled | `on` |
| Observe | `on` |
| Check interval | `60m` |
```

`Observe` runs a read-only check of which profiles exist and which are currently in use (a
`SingletonLock` file check, never a CDP port). The slots are always the existing
`## Browser slots` table. The workload reuses `browser-watchdog.ps1` / `check-browser-slots.ps1`
/ `browser-slot-table.ps1` rather than reimplementing them, and never launches, kills or
reparents a browser or MCP worker process. The tray's **Browser checks** menu shows the current
status and recent outcomes.

The installer and `sync-oa-home.ps1` share `checks/reliability-tray-files.json` as the
tray's deployed-file roster. Sync reads the roster from the Git ref, so newly added
tray files are deployed with the existing historical-byte safety checks. When sync
writes a tray file, it reports `TRAY RESTART NEEDED` (`trayRestartNeeded` in JSON).
Sync does **not** restart the running tray: restart it separately when safe to load
the new files. A clean repeated sync does not request another restart.

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
list --json` (is `overnight-agent` installed from it, and at which version?), and a best-effort
`copilot plugin marketplace update focus-planner`. After refresh, the catalog version comes
from the registered GitHub marketplace's `marketplace.json` in the Copilot CLI's local
marketplace cache; `copilot plugin marketplace browse focus-planner --json` confirms catalog
membership but does not expose a version. If this CLI cache is unavailable, the tray reports
an explicit `capability-gap` instead of pretending the missing version is transient. The
installed and catalog versions are then compared. With **Auto apply off** (the default) the tray's **Plugin updates** menu just
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

### Uninstalling the tray

```powershell
powershell -File plugins\overnight-agent\checks\install-oa-reliability-tray.ps1 -Disable
```

`-Disable` (alias `-Uninstall`) stops the running tray process (graceful stop request, then a
bounded verified force) and removes the single `HKCU\...\Run\Overnight Agent supervisor`
value. It does **not** delete the deployed files under `%LOCALAPPDATA%\overnight-agent\` or
your `user-settings.md` policy — re-running `-Enable` later picks the same policy back up.
Running the installer with **no switch** at any time only reports status (enabled? running?
PID?) and changes nothing.

### Troubleshooting the tray

- **Is it installed and running?** `powershell -File plugins\overnight-agent\checks\install-oa-reliability-tray.ps1` (no
  switch) prints `startup at sign-in: ENABLED/off`, `running: yes/no (PID ...)`, and the
  signed-in-user limitation. Add `-Json` for a machine-readable version.
- **Is it the only resident dispatcher?** It must be. Check
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` (or Task Manager → Startup apps) for
  exactly one `Overnight Agent supervisor` value, and confirm there is no Scheduled Task, no
  Startup-folder `.vbs`/`.cmd`/`.lnk`, and no separate browser-watchdog or update-check
  process. (The unrelated GH #226 stuck-run supervisor below is the one intentional
  exception — see that section.)
- **Pause didn't survive a restart.** That's correct, not a bug: every tray **Pause** menu
  item (reliability, browser checks, update checks) is **in-memory only** and always clears
  back to normal supervision on the next tray start. There is no persisted "stay paused"
  option.
- **A workload looks off and you expected it on (or vice versa).** Each workload reads its own
  `##` section in `user-settings.md` independently; a missing section means product defaults
  apply (reliability supervision on, browser checks off, update checks on). A row the reader
  cannot understand is **refused by name**, and the tray's own status menu for that workload
  shows the refusal rather than silently falling back to a guessed policy.
- **Browser checks appear to do nothing.** Confirm `Enabled = on` **and** `Observe` is also
  `on` — enabling the workload with no opt-in intentionally runs nothing.
- **Nothing is supervised after signing out, or overnight on a locked machine.** Expected: the
  tray is a per-user `HKCU` Run entry, so it only runs while that user is signed in, exactly
  like the app it supervises. There is no logged-out or multi-user coverage.
- **Full reset:** `-Disable` then `-Enable` redeploys every tray file fresh from the plugin and
  re-registers the one Run entry; it never migrates old state.

### Related but separate: the GH #226 stuck-run supervisor

`install-oa-supervisor.ps1` / `oa-supervisor.ps1` / `oa-supervisor-daemon.ps1` are an
**older, unrelated** mechanism that predates this tray and is **not superseded by it** — it
answers a different question the tray cannot: is the Overnight Agent's own `*/30` schedule
itself stuck or dead (a `running` workflow row that never clears, or no run starting at all),
and separately, is the app tree leaking CPU on a contended machine? Both are read straight out
of the app's own SQLite run history, which the tray's time-based M/N preventive restart never
inspects.

It therefore keeps its own, deliberately different dispatch route: the preferred **Windows
Scheduled Task** (`Overnight Agent supervisor`, registered by `install-oa-supervisor.ps1`),
falling back to a **Startup-folder** shim (`oa-supervisor-daemon.ps1`) only when registering a
scheduled task is denied without elevation. `supervisor-liveness-sweep.ps1` watches that these
watchers themselves have not gone dormant. This is intentionally **not** merged into the
tray's single `HKCU` Run entry: an out-of-band supervisor that shares a startup mechanism with
the thing (or the other supervisor) it is meant to catch failing is a weaker supervisor. The
same display name (`Overnight Agent supervisor`) appearing in two different Windows
mechanisms — a Scheduled Task / Startup shim here, an `HKCU` Run value for the tray — is a
naming coincidence, not a shared or conflicting registration; see
`docs/spec/Reliability.md` for the full design rationale. Install/uninstall for this mechanism
is unchanged: `install-oa-supervisor.ps1` (status/install) and `install-oa-supervisor.ps1
-Uninstall`.
