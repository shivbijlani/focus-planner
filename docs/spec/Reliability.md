# Reliability

The overnight agent in [Domain-overnight-agent](Domain-overnight-agent) runs unattended, on one
machine, on a `*/30` cadence. Reliability therefore means more than “the code is correct”: the
system has to keep scheduling work, detect when a run or dependency goes dark, repair what it can
silently, and prove that its own guards still detect the failures they name. The adjacent
[Domain-scripts](Domain-scripts) tooling supports repository workflows, but the shipped self-heal
loop itself lives under `plugins/overnight-agent/`.

## Reliability stack at a glance

| Layer | Primary files | What it guards against |
| --- | --- | --- |
| OS-dispatched supervision | `plugins/overnight-agent/checks/install-oa-supervisor.ps1`, `oa-supervisor.ps1`, `oa-supervisor-daemon.ps1`, `supervisor-liveness-sweep.ps1`, `supervisor-replay.mjs` | The agent or app scheduler stopping entirely |
| Stuck-run and orphan repair | `plugins/overnight-agent/checks/stuck-run-sweep.mjs`, `orphan-liveness-sweep.mjs` | A `running` row, live ask, or live journal becoming invisible and permanently blocking progress |
| Silent remedy | `plugins/overnight-agent/checks/oa-supervisor.ps1` | Alert fatigue from “red but unactioned” findings |
| Deploy propagation | `version-bump-sweep.mjs`, `installed-skill-drift-sweep.mjs`, `installed-capability-sweep.mjs`, `sync-oa-home.ps1`, `SKILL.md` | Merged fixes not reaching the bytes the machine actually executes |
| Byte and journal safety | `ps1-encoding-sweep.mjs`, `journal-encoding-invariant.mjs`, `oa-state.ps1`, `write-turn.ps1`, `src/journalChat.js`, `src/journalLoadQueue.js` | Silent mojibake, re-encoding, duplicate writers, and race-shaped read/write corruption |
| MCP and browser health | `reap-stale-mcp.ps1`, `mcp-probe.mjs`, `check-mcp-fanout.ps1`, `check-browser-slots.ps1`, `browser-watchdog.ps1`, `ensure-mcp-browsers.ps1`, `launch-signed-in-browser.ps1` | Orphaned MCP servers, dead/stuck browser slots, wrong-profile launches |
| Guard integrity | `mutcheck-*.mjs`, `mutcheck-*.ps1` | A detector quietly becoming decorative or measuring the wrong thing |
| Settings reconcile loop | `plugins/overnight-agent/skills/overnight-agent/user-settings.md`, `oa-state.ps1` | User configuration drifting from the values the run actually uses |

## OS-dispatched supervision

The core design choice is that supervision does **not** run inside the overnight run it watches.
`plugins/overnight-agent/checks/install-oa-supervisor.ps1` installs the preferred Windows
Scheduled Task, and falls back to a Startup-folder daemon only when unattended elevation is not
available. `plugins/overnight-agent/checks/supervisor-liveness-sweep.ps1` then watches the
watchers themselves.

```powershell
# plugins/overnight-agent/checks/install-oa-supervisor.ps1
Windows Task Scheduler is a service of the operating system. It is not the app, it
is not the app's scheduler, and it is not an agent run - so it keeps firing exactly
when everything this repo controls has stopped.

# Two triggers on purpose:
#   * at logon, so a reboot cannot silently leave supervision off;
#   * a repeating trigger with an effectively unbounded duration.
$atLogon = New-ScheduledTaskTrigger -AtLogOn
$startNow = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
              -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
```

That separation is the whole point: a frozen app scheduler cannot suppress the task that judges the
scheduler. Where Task Scheduler cannot be registered, `oa-supervisor-daemon.ps1` is still outside
the failure domain because Explorer launches it from Startup at logon, as its own process. The
trade-off is explicit in the file: the daemon does **not** auto-restart if it dies, so the
scheduled-task route remains the stronger installation.

`supervisor-liveness-sweep.ps1` closes the next gap: a supervisor that dies silently is another
single point of failure.

```powershell
# plugins/overnight-agent/checks/supervisor-liveness-sweep.ps1
Both are dispatched by Explorer from the Startup folder, NOT by Task Scheduler
... a check that queries only `Get-ScheduledTask` therefore reports "no supervisor
installed" while two supervisors are running.

if ($taskHealthy -or ($daemonAlive -and $daemonFresh)) { return 'HEALTHY' }
if ($daemonAlive) { return 'STALE' }
return 'DEAD'
```

`supervisor-replay.mjs` supplies evidence for the thresholds. It replays the classifier across real
run history and asks the only questions that matter: does it catch true stalls, does it warn on
slow self-terminating runs, and does it stay quiet on ordinary healthy runs. That is why the page's
forward design is “OS-dispatched supervisor plus replayed thresholds”, not “more checks inside the
run”.

## Liveness-gated stuck detection and orphan repair

`plugins/overnight-agent/checks/stuck-run-sweep.mjs` is the main repairer for stuck workflow rows.
Its design is deliberately evidence-based rather than age-only. It uses three different arms:

| Arm | File logic | Failure guarded |
| --- | --- | --- |
| Process-dead orphan | `sessionLiveness()` reads `inuse.<pid>.lock` and probes the PID | A workflow row says `running` forever although its owning process is gone |
| Hung-alive orphan | `readOutcome()` finds `session.task_complete`; `idleMinutes()` proves the log then went silent | The task finished, but bookkeeping never reached a terminal row |
| Run-level timeout | requires both `age >= MAX_RUNTIME_MIN` and `idle >= STALL_MIN` | A mid-task hang with no terminal event and a still-live process, tracked by issue #261 |

```js
// plugins/overnight-agent/checks/stuck-run-sweep.mjs
if (live.dead) {
  findings.push({ ... arm: 'process-dead' ... })
  continue;
}

if (outcome.completed && idle != null && idle >= IDLE_MIN) {
  findings.push({ ... arm: 'hung-alive' ... })
  continue;
}

if (idle != null && ageMin >= MAX_RUNTIME_MIN && idle >= STALL_MIN) {
  findings.push({ ... arm: 'timed-out' ... })
  continue;
}
```

The repair path is equally conservative: `--repair` is opt-in, every touched row is backed up,
`UPDATE ... and status='running'` makes the write idempotent, and the sweep records `completed`
only when the session's own log says it completed. Otherwise it records `failed`, because that is a
fact about the stopped run without inventing a success outcome.

`plugins/overnight-agent/checks/orphan-liveness-sweep.mjs` handles a different invisibility class:
journals that no longer appear on either board, but still carry a live ask. It deliberately reports
only non-terminal, untombstoned orphans so it does not cry wolf about deliberate board cleanup. The
failure it guards is “live work is invisible on every surface at once”, not generic journal
housekeeping.

## Silent auto-restart is the remedy

The supervisor acts because this repository has repeated evidence that detect-only lines are skimmed.
`oa-supervisor.ps1` does not page; it decides among `none`, `repair-only`, `restart`, and `launch`.
The action depends on liveness, not just age.

```powershell
# plugins/overnight-agent/checks/oa-supervisor.ps1
switch ($State) {
  'STUCK' {
    if ($FlaggedOrphans -le 0) { return 'none' }
    if ($HasHungAlive)         { return 'restart' }
    return 'repair-only'
  }
  'SCHEDULE-DEAD' {
    if ($AppRunning) { return 'restart' }
    return 'launch'
  }
  'RESOURCE-LEAK' {
    if ($AppRunning) { return 'restart' }
    return 'none'
  }
}
```

```powershell
function Restart-App {
  foreach ($name in @('github', 'copilot')) {
    foreach ($proc in (Get-Process -Name $name -ErrorAction SilentlyContinue)) {
      try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop } catch { }
    }
  }
  Start-Sleep -Seconds 3
  if ($exe) { try { Start-Process -FilePath $exe | Out-Null; $launched = $true } catch { } }
}
```

This keeps the remedy narrow. A genuinely long but still-emitting run does not restart. A
process-dead orphan gets `repair-only`, because clearing the blocked row is enough. A hung-alive row
or a schedule-dead app gets a silent restart, with a cooldown to prevent loops. Issue #403 adds a
second trigger: the supervisor now also restarts when the app stays *responsive enough to schedule*
while consuming the machine pathologically.

## Deploy propagation: “merged” is not “running”

The repository treats deploy propagation as a first-class reliability problem. Three separate checks
answer three different questions:

| Question | Guard | Why it exists |
| --- | --- | --- |
| Did plugin content change without moving `plugin.json`'s version? | `version-bump-sweep.mjs` + `mutcheck-version-bump.mjs` | A version-keyed updater otherwise skips the fix entirely |
| Are the installed plugin bytes a named, recoverable version? | `installed-skill-drift-sweep.mjs` + `mutcheck-installed-skill-drift.mjs` | A live machine can run `MAIN`, `BRANCH-ONLY`, `UNVERSIONED`, or `MISSING` bytes |
| Does the installed plugin still retain required behaviour even if its bytes match `main`? | `installed-capability-sweep.mjs` + `mutcheck-installed-capability.mjs` | Provenance can be healthy while capability is regressed |

```js
// plugins/overnight-agent/checks/version-bump-sweep.mjs
FLAGGED - plugin content changed WITHOUT a version bump

The installed copy is keyed off plugin.json's version, so a version-based
updater sees no work to do and these changes never reach the running agent.
```

```js
// plugins/overnight-agent/checks/installed-skill-drift-sweep.mjs
VERDICTS
  MAIN         the installed bytes match origin/main. Fine.
  BRANCH-ONLY  they match some other ref but not main
  UNVERSIONED  they match no ref at all
  MISSING      the file is on origin/main but is ABSENT from the installed tree
```

```js
// plugins/overnight-agent/checks/installed-capability-sweep.mjs
installed-skill-drift-sweep : provenance -- can we NAME the bytes we are running?
installed-capability-sweep  : capability -- can the bytes we are running DO the job?
Provenance can be perfect while capability is broken.
```

The runbook in `plugins/overnight-agent/skills/overnight-agent/SKILL.md` extends this to both live
deploy targets: `installed-plugins` and the flat `%LOCALAPPDATA%\overnight-agent` OA home.
Issue #519 records why that matters: the deploy can report `verified-current True` while PHASE 3
still executes from a stale checkout. Issue #533 records the next split-brain risk: a budget expiry
can leave the two deploy targets on different refs. Issue #485 adds a measurement warning: a sweep
that reads an unpulled working checkout can return a confident wrong answer in either direction.
The capability manifest adds one more layer: issue #459 records that a required server has to be
declared before PHASE 0 can probe it, and issue #570 records the remaining gap where a server can
probe as available yet still be missing from the agent session's live toolset. The design therefore
keeps provenance checks, capability checks, and live-session probes separate instead of collapsing
them into one “deploy is healthy” verdict.

## Byte-level encoding safety and journal write safety

The repository treats encoding as a byte-level reliability contract, not as presentation polish.
`ps1-encoding-sweep.mjs` guards the script source itself; `journal-encoding-invariant.mjs` guards
read-modify-write behaviour against journals; `oa-state.ps1` centralises the only acceptable UTF-8
journal read path.

```js
// plugins/overnight-agent/checks/ps1-encoding-sweep.mjs
PowerShell 5.1 decodes a script file with no BOM as the ANSI codepage...
A BOM-less .ps1 with non-ASCII is mangled by PowerShell 5.1 before it runs.

Fix: re-save each file as UTF-8 **with** BOM.
```

```powershell
# plugins/overnight-agent/skills/overnight-agent/oa-state.ps1
function Read-JournalText([string]$path) {
  # ALWAYS decode journals as UTF-8, explicitly. Never `Get-Content -Raw`.
  return [IO.File]::ReadAllText($path, (New-Object Text.UTF8Encoding($false)))
}
```

```js
// plugins/overnight-agent/checks/journal-encoding-invariant.mjs
mark() altered bytes ABOVE the turn-end marker. The pre-existing journal content must be
preserved byte-for-byte; only the terminator may be appended.
```

`plugins/overnight-agent/skills/overnight-agent/write-turn.ps1` is the sanctioned writer. Its
header says why: append-only means it “physically cannot eat” a newer human reply, and routing turn
bodies through a file instead of a PowerShell string removes whole corruption classes before they
happen.

The app-side files close the companion UI races. `src/journalLoadQueue.js` serialises and
de-duplicates provider reads so 90+ rows do not stampede the storage backend; one row unmounting
cannot cancel another row's in-flight read.

```js
// src/journalLoadQueue.js
// This queue funnels those reads so they run a few at a time, in board order
// and never fetches the same journal twice while a read is already in flight.
```

`src/journalChat.js` makes authorship deterministic on append by using one shared fence mask and a
single `FROM_ME` stamp. That matters to [Prioritisation](Prioritisation) because the overnight
consent gate treats an unattributed trailing note differently from a human reply.

The known gaps stay visible here. Issue #549 records a third corruption class on catch-up-doc reads.
Issue #473 records the two-writers race; issue #476 adds the zero-writer backstop so “at most one
writer” does not degrade into “nobody wrote the wake”.

## MCP process reaping and browser-slot health

The MCP layer heals itself in two ways: it reaps abandoned processes, and it probes the same server
surface the run actually depends on.

`plugins/overnight-agent/skills/overnight-agent/reap-stale-mcp.ps1` kills only processes that pass
all of its ownership, cohort, age, and self-protection checks. It explicitly distinguishes “old”
from “abandoned”, and it separately reaps stillborn `copilot.exe --server --stdio` hosts that were
never driven. `plugins/overnight-agent/checks/mcp-probe.mjs` then avoids a second #346-shaped trap:
probe and payload must use the **same** MCP session, not two independent connections that can
disagree.

```js
// plugins/overnight-agent/checks/mcp-probe.mjs
`calls` runs several tools inside ONE server session ... it is the only way a
health probe can prove the SAME connection the payload call used.
```

`plugins/overnight-agent/skills/overnight-agent/check-mcp-fanout.ps1` keeps the leak measurable.
It asserts both that one idle session stays within a process/memory ceiling and that no orphaned MCP
generation survives past the grace period.

Browser health has the same design shape. The source of truth is one table in
`plugins/overnight-agent/skills/overnight-agent/user-settings.md`, enforced in CI and consumed by
every launcher and checker.

```yaml
# .github/workflows/ci.yml
# The browser slot table (GH #180) lives in ONE place -- `## Browser slots` in
# user-settings.md ... a guard that only runs where the drift happens cannot stop
# the drift from merging.
browser-slots:
  name: Browser slot table
```

Issue #180 is the reason `ensure-mcp-browsers.ps1`, `launch-signed-in-browser.ps1`, and
`check-browser-slots.ps1` refuse to guess. They all read the same table; none keep a fallback slot
list. `ensure-mcp-browsers.ps1` launches on demand; `launch-signed-in-browser.ps1` refuses to bind a
slot port to the wrong profile; `check-browser-slots.ps1` distinguishes a zombie slot from a wedged
slot by doing bounded CDP work, not by TCP connect.

```powershell
# plugins/overnight-agent/checks/check-browser-slots.ps1
A new target is never frozen -- the frozen lifecycle only affects already-open,
occluded tabs -- so a fresh-tab probe reports every wedged slot as healthy.

-Repair opts in to ... Page.setWebLifecycleState -> 'active'
```

`fixture-cdp-slot.mjs`, `cdp-read.mjs`, and `cdp-eval.mjs` pin that distinction: a fresh target can
work while pre-existing targets stay frozen. `browser-watchdog.ps1` composes the slot checker with
`ensure-mcp-browsers.ps1` so the hourly watchdog now acts on `down` and `stuck`, not just on “port
closed”. `probe-workspace-tiers.mjs` adds a related measurement discipline: tool-catalogue cost is
measured before changing MCP surface area, rather than guessed.

Issue #197 is the shipped rationale for the stuck-slot repair rung. Issue #243 remains the design
warning: a watchdog that lives only inside the plugin it repairs is circular. The repo answers that
with OS-dispatched supervisors plus CI-gated guards, not with a single in-band watchdog.

## The mutation-tested sweep harness

The repo carries many narrow checks because each one exists to catch one named silent-failure shape,
not to contribute to a generic coverage number. The working tree currently contains 161 `.mjs`
checks under `plugins/overnight-agent/checks/`, and the mutchecks explain why that count is high.

| Mutcheck | What it proves |
| --- | --- |
| `mutcheck-doc-comments.mjs` | Consent and authorship readers do not trust style, quoted markers, or the API's own misleading author field |
| `mutcheck-repo-drift.mjs` | A drift detector that only ever sees archived green is distinguishable from one that can really detect missing or modified live files |
| `mutcheck-zero-writer.mjs` | Silent wakes are classified correctly: zero writer, masked writer, live in-flight work, and grace-window cases do not collapse into one label |

```js
// plugins/overnight-agent/checks/mutcheck-doc-comments.mjs
If a mutation does not change the answer, that guard is decoration and this file fails.
```

```js
// plugins/overnight-agent/checks/mutcheck-repo-drift.mjs
A detector that has only ever printed "no drift" is indistinguishable from a detector
that cannot detect.
```

```js
// plugins/overnight-agent/checks/mutcheck-zero-writer.mjs
A guard for silent failure that itself fails silently is worse than nothing.
```

This is why the repository prefers many small, mutation-tested files to a handful of broad tests.
Each sweep names one operational question, each mutcheck kills the exact guards that answer it, and
the failure mode each file exists to catch stays recorded in that file's own header instead of only
in tribal memory.

## The `user-settings.md` reconcile loop

`plugins/overnight-agent/skills/overnight-agent/user-settings.md` is only a template; it explicitly
says plugin updates overwrite it and that the real file lives outside the plugin. `oa-state.ps1`
then rereads settings on every invocation.

```powershell
# plugins/overnight-agent/skills/overnight-agent/oa-state.ps1
function Get-UserSettingsPath {
  if ($UserSettings) { return $UserSettings }
  $candidates = @(
    $env:OVERNIGHT_AGENT_SETTINGS,
    (Join-Path (Get-Location).Path 'user-settings.md'),
    (Join-Path (Split-Path -Parent $PlannerBoard) 'user-settings.md'),
    "$env:USERPROFILE\OneDrive\Apps\Focus Planner\user-settings.md",
    "$env:LOCALAPPDATA\overnight-agent\user-settings.md"
  )
}
```

There is no literal `reconcile` token in `oa-state.ps1`. The reconcile loop is behavioural: each
run resolves the external settings path again, rereads the gate and pacing rows again, and reports
the resolved values on scan output so configuration is auditable rather than assumed.

That loop is intentionally fail-safe. `Resolve-GateSettings` and `Resolve-PacingSettings` let an
explicit CLI argument outrank the file, and let the file outrank only a built-in safe default.
Malformed or unreadable settings narrow behaviour instead of widening it. The page's unresolved
gaps are here too: issue #567 tracks the risk that the CWD-relative candidate can still pick the
bundled template, and issue #337 tracks a broader reconcile loop that should install or uninstall
the supervisor to match a user setting rather than relying on a separate manual installer.
