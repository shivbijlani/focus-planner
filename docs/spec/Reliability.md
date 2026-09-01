# Reliability & Autonomous-Agent Supervision

This page specifies **how the system keeps an unattended, autonomous agent running
correctly on a single personal Windows machine, and how it heals itself when it does
not.** It assumes no prior context. A competent engineer should be able to rebuild the
entire reliability layer from this page alone.

The subject is the **Overnight Agent** (see [Domain-overnight-agent](Domain-overnight-agent)):
a plugin that, on a schedule, wakes up, reads a markdown task board, makes real progress on
tasks, and writes results back into per-task journals — all while the owner is asleep.
"Reliability" here is not uptime of a web service. It is the much narrower, harder problem
of a long-lived autonomous process that runs **inside a desktop app, on one laptop, with no
operator watching**, and that can therefore fail in ways nothing is positioned to observe.

Everything described here is treated as shipped: mechanisms that currently live in a
GitHub issue as intended direction are specified as if implemented, because the point of
this page is the complete blueprint, not a snapshot of progress.

## The founding principles

Every strategy below is an application of one of a few rules the system learned the hard way.

1. **Assert the artifact at the far end — never the exit code of the step that produced
   it.** "Copilot exited 0" says nothing about whether the work is correct; "the file on
   disk parses and contains the run's output" does. Detection always inspects the real
   world (a database row, a file's bytes, a running PID), never a return code or a promise.

2. **A rule kept as prose regresses; a rule kept as an executable check does not.** The
   repository's operating manual (`user-settings.md`) accumulated dozens of "always
   remember to…" warnings, and every one of them was eventually forgotten and caused a
   regression. The fix pattern is always the same: convert the prose rule into a script
   that *prevents* or *detects* the mistake, and a **mutation test** that proves the script
   is load-bearing. This is why the reliability layer is a suite of small scripts
   ("sweeps") plus `mutcheck-*` tests, not documentation.

A third rule governs supervision specifically and is important enough to state on its own:

3. **You cannot supervise a system from inside its own failure domain.** A watchdog
   dispatched by the thing it watches dies with it. Real supervision must be dispatched by
   something strictly outside — the operating system.

One more rule cuts across all of the above and is, for a rebuilder, the most important of
the four, because it is the mechanism by which the other failures stay invisible:

4. **A reader must be able to tell "absent" from "present but unreadable."** The failures
   that survive are the ones that do not raise — they decode to a valid value that happens
   to be a lie. Age-only `STUCK` collapsed "working hard" and "hung" into a single
   observable (Strategy B); the "merged isn't running" gap is silent *in the safe-looking
   direction*, so the blind updater reports success (Strategy D); an encoding fault corrupts
   a script *before any code runs* (Strategy E), where no downstream logic can catch it. The
   liveness lock exists precisely to make a distinction the database alone cannot — a
   `running` row over a dead PID is a different fact from the same row over a live one. The
   design test for every state a check reads is therefore: *does a failure produce an
   invalid value, or a valid one that is wrong?* The first is caught by any check; the
   second is caught only by deliberately asking whether the reader can distinguish missing
   from unparsed — because, by construction, nothing downstream will ever raise it for you.
   This is a cross-cutting hazard, not a supervision-only one: the prioritisation layer hits
   the same shape — a snoozed row that decodes to "not snoozed," a skipped board row that
   reads as "Today is finished" — which is why the two concerns are documented as siblings.

## Strategy A — Out-of-band supervision of the agent process

**Problem (#226).** Every recovery mechanism the agent had was dispatched *by an agent
run*: the stale-process reaper ran in the agent's own start-up phase; the sweep suite ran
inside a run; even the app's workflow scheduler is the same scheduler that would need
restarting. So "the agent stopped running" was structurally unobservable from inside. Over
a measured window, 18 separate stalls (≈315 hours) were each ended only by a human noticing
and restarting the app.

**Mechanism.** A supervisor (`oa-supervisor.ps1`) is dispatched by the **Windows Task
Scheduler**, or, when task registration is denied without elevation, by an unelevated
**Startup-folder daemon** (`oa-supervisor-daemon.ps1`) that Explorer launches at logon and
that loops on a fixed interval. Either dispatcher is the operating system, not the app and
not an agent run, so it keeps firing exactly when everything the app controls has stopped.
`install-oa-supervisor.ps1` registers whichever path is available and is idempotent and
reversible (`-Uninstall` removes the task, the Startup shim, and any running daemon).

The supervisor opens the app's SQLite database **read-only** (against a stale-by-seconds
copy, so a WAL checkpoint can never corrupt the original) and classifies the newest
workflow run:

```
HEALTHY        a run is in progress and making progress, or the last run ended cleanly
STUCK          a run has held the every-30-min slot far past the median run time
SCHEDULE-DEAD  no run of any status has started within the dead-window (app closed,
               or the app is up but its scheduler is wedged)
```

**Invariants.** The supervisor never writes to classify. One incident produces at most one
action (see Strategy C's cooldown). It never prints a secret. Its own daemon writes a
heartbeat file, because an unsupervised supervisor is the same recursion (#226) exists to
break — at minimum its absence must be observable.

## Strategy B — Liveness-gated stuck detection and orphan repair

**Problem (#296).** The first supervisor decided `STUCK` on **age alone** — any run still
marked `running` past a threshold. But healthy runs legitimately take much longer than the
median (a 40-minute run making steady progress is fine), so age-only detection paged the
owner about runs that were perfectly healthy. Age cannot distinguish "working hard" from
"hung."

**Mechanism.** Detection defers to a liveness signal computed by `stuck-run-sweep.mjs`,
which classifies each `running` row with two arms and a race guard:

- **Grace guard.** A run younger than ~20 minutes is never touched, so a starting run is
  never mistaken for a stuck one.
- **Arm 1 — process-dead orphan.** Each agent session directory holds an `inuse.<pid>.lock`.
  If that PID is gone, the owning process is provably dead and the `running` row is a stale
  orphan. (A live run — *including the one running the sweep* — can never be a false
  positive, because its own PID is alive.)
- **Arm 2 — hung-alive orphan.** The PID is alive, but the session's own event log shows
  `session.task_complete` already fired and nothing has been written for ≥15 minutes. The
  run finished; its process leaked and never released the row.
- **Healthy.** A live process still emitting events is left strictly alone, at any age.

Why this matters: an orphaned `running` row **silently disables its workflow for both the
scheduler and manual triggers** — the app refuses to start a workflow it believes is
already running. So a single stale row permanently kills that workflow until the row
reaches a terminal status.

**Recovery.** With `--repair`, the sweep backs up the row to JSON and then sets it to its
*true* terminal status, read from the session's own log (`task_complete` → `completed`,
else `failed`), guarded by `... WHERE status='running'` so it is idempotent and cannot
clobber a status the app has since written. Every repair is reversible from the backup it
wrote. The sweep deliberately does **not** kill a leaked live process — that is the
supervisor's more-reversible decision (Strategy C).

## Strategy C — Silent auto-restart as the remedy (PR (#313))

**Problem.** Detecting a stall is useless if the response is only a notification the owner
has to act on. The owner's instruction was explicit: *act, do not message.*

**Mechanism.** The supervisor computes an **action**, purely from `(state, orphan findings,
app-running)`, and the function is side-effect-free so a mutation test can prove each arm:

```
STUCK + no genuine orphan (live, progressing) -> none        # never restart a working run
STUCK + hung-alive orphan (leaked live process) -> restart   # only a restart reclaims it
STUCK + process-dead orphan -> repair-only                   # sweep --repair already fixed it
SCHEDULE-DEAD + app running (scheduler wedged) -> restart
SCHEDULE-DEAD + app down -> launch
```

"Restart" kills the desktop app's process tree (the GUI process and its server-backend
children, each by explicit PID) and relaunches it from its stable per-user install path;
the row is cleared with `stuck-run-sweep.mjs --repair` first, so the schedule can resume
even if the relaunch does not reconcile it. The action is **fully silent** — no
notification channel is used — and every decision is appended to a local JSON-lines log.

**Invariants.** A per-incident **cooldown** (keyed on state + the run it is about) means one
incident drives at most one restart, so a persistently bad state can never become a reboot
loop; the incident is recorded even when the relaunch itself fails, so a failing restart
cannot hot-loop. A **run-level timeout** (#261) upstream marks a run failed and reschedules
if it exceeds a hard cap, so a hang can never silently freeze the every-30-minutes cadence.
A detect-only mode (no kills, no launches) exists for testing and replay.

## Strategy D — Making "merged" mean "running" (deploy propagation)

**Problem.** The single most recurrent failure class in this system is **"merged isn't
running"**: a fix is correct, reviewed, and on `main`, yet the code actually executing on
the machine is the old copy — and the gap is silent in the safe-looking direction. It has
recurred with many distinct shapes:

- A merged sweep enumerated from the machine, so a *new* file that existed only in the repo
  was invisible to the deployer (#254); a merge that *deleted* a file crashed the deploy
  (#255); duplicate basenames made the deployer refuse a file forever (#251); a merged
  sweep whose manifest was required by no deploy rule never reached the machine at all
  (#299).
- Two updaters disagreed on the meaning of "current": one compared **file content** and
  reported success; the other compared **`plugin.json`'s version** and, seeing an unchanged
  version, correctly did nothing — so a change fully deployed by one was completely
  invisible to the other, and the blind one reported success.

**Mechanism.** Four cooperating pieces, each asserting the artifact:

- `auto-deploy-plugin.ps1` copies merged repo content into the installed plugin, and
  escalates rather than silently refusing (#196).
- **Version-keyed update:** `version-bump-sweep.mjs` fails the build when any plugin file
  changed in commits *after* the last commit that moved `plugin.json`'s `version`. This is
  what forces a version bump so the version-keyed updater actually ships the change. A
  change without a bump is not a release.
- `sync-oa-home.ps1` refreshes the "flat home" (`%LOCALAPPDATA%\overnight-agent\`, the copy
  the supervisor, sweeps, and daemon actually execute) from a **derived required set** — the
  sweep roster, plus a transitive import closure, plus every `mutcheck-*`, plus each
  mutcheck's `$PSScriptRoot` subject, plus an explicit `$AlwaysRequired` list of scripts the
  operating system or operative docs invoke by absolute path. It writes only files that are
  provably **behind** the ref or **missing**, backs up what it overwrites, refuses to
  overwrite a file whose live content is on no commit (a possible live fix), and refuses an
  ambiguous basename rather than guessing. The supervisor and its daemon are in
  `$AlwaysRequired` precisely because they are dispatched by the OS from the flat home and
  are named by no roster and reached by no import edge — without that entry a merged
  supervisor fix would land in the installed plugin and never reach the copy that runs.
- `repo-drift-sweep.mjs` detects divergence between the flat home and the repo every run, so
  "the enforcement suite exists on exactly one laptop with no history" is a finding, not a
  surprise after a disk failure.

## Strategy E — Encoding safety at the byte level

**Problem.** Damage that lands **before any code runs** is the worst kind, because no logic
can guard against it. Two instances: a BOM-less `.ps1` containing non-ASCII is decoded by
Windows PowerShell 5.1 as the ANSI codepage, silently mangling the *script source* on the
way in; and a config file written with a UTF-8 BOM makes `JSON.parse` reject it, blinding
every check that reads it (#212).

**Mechanism.** `ps1-encoding-sweep.mjs` fails when any `.ps1` carrying non-ASCII bytes lacks
a UTF-8 BOM (the fix is free — add the 3-byte prefix; the code bytes do not change). File
reads that must be exact use an explicit UTF-8 decoder rather than a host-dependent
`Get-Content -Raw`, and deployers match a file's existing line endings rather than
normalizing them. New scripts are kept pure-ASCII where practical so the hazard cannot
apply at all.

## Strategy F — Journal write safety

**Problem.** The agent's output is appended to human-readable per-task journals that the
owner also edits. Four distinct byte-level corruptions were each discovered only *after*
they destroyed real content — including a read-modify-write that permanently baked in a
mis-decoding and deleted hundreds of lines.

**Mechanism.** `write-turn.ps1` is the only sanctioned way to write an agent turn. It
authors the body with a file tool (never by interpolating markdown into a PowerShell
double-quoted string), **appends only** (so it can never delete an owner's reply), backs up
the journal first, matches existing line endings, and refuses to write on any of the known
hazards; a `mutcheck-*` proves each guard is load-bearing on both LF and CRLF fixtures. To
bound cost, journals are kept off the unbounded per-run read path and capped, because a
task journal on the read path grows without limit and eventually dominates the context
window (#291).

## Strategy G — Bounding and reaping MCP processes

**Problem.** Each agent session spawns Model-Context-Protocol servers that fan out to ~6
processes per browser slot and survive the run; dozens of leaked processes consuming
gigabytes were observed (#177), a direct contributor to the machine becoming unresponsive.

**Mechanism.** `reap-stale-mcp.ps1` terminates leaked MCP processes. Reaping is by
**ownership, not age alone**: an age-only gate cannot protect the current run and can kill a
long legitimate one (#178), and a fixed 20-minute gate sat below two workflows' real
runtime (#200). The reaper therefore keys on which run owns a process (via the same
`inuse.<pid>.lock` liveness signal) so it can reclaim only genuinely orphaned servers.

## Strategy H — Browser-slot health

**Problem.** Automation drives signed-in browsers over CDP through a small pool of named
"slots." A slot can be a **zombie**: its port answers `/json/version` and existing tabs
render, but every *new* tab dies with "Target crashed" because Edge auto-updated underneath
the running process. It looks healthy and silently fails all automation.

**Mechanism.** `check-browser-slots.ps1` health-checks each slot *before* a run uses it, by
comparing the build the slot reports over CDP against the build of the installed browser on
disk; a mismatch means relaunch. The slot roster lives in `user-settings.md` (#180), and the
watchdog can recover a **stuck** slot, not merely a missing one (#197), and carries its own
plugin-update check so its self-heal does not live entirely inside the thing it repairs
(#243).

## Strategy I — The sweep harness and mutation-tested guards

Every detector above is one of the "sweeps." `run-sweeps.ps1` is the only sanctioned runner:
it sets the environment (`PLANNER_PATH`, and `BRIDGE_SRC` for sweeps that import the bridge)
so a sweep can never silently "measure nothing" by dying on its first import while still
exiting non-zero the way a real finding does. Because a passing test on broken code is worse
than no test, each guard ships with a `mutcheck-*` that **mutates the guard one arm at a
time and requires exactly that arm's fixture to start failing** — a mutation that changes
nothing proves the arm was decoration. This is the mechanism that turns the second founding
principle (prose regresses, checks do not) into something that itself cannot silently rot.

## Strategy J — Configuration and the reconcile loop

All operator-tunable values — paths, accounts, allow-lists, the browser-slot roster, and
whether the supervisor is installed — live in `user-settings.md`, **outside** the plugin, so
a plugin update never overwrites them. The supervisor is opt-in/opt-out through a setting,
and the agent **reconciles installed state to the setting on every run** (#337): setting on
and not installed → install; setting off and installed → uninstall (tearing down both the
scheduled task and the Startup daemon); already matching → no-op. Reconciliation is a state
change that runs inside a run, so it cannot resurrect supervision when the app is fully dead
— that is Strategy A's job — but it keeps the two in agreement whenever the app is alive.

```
## Supervisor
- Enabled: true            # false => the watchdog uninstalls it on the next run
- Interval minutes: 15
- Act on hang: restart     # or detect-only
```

## How to rebuild this layer, in order

1. **Liveness primitive first.** The `inuse.<pid>.lock` per-session signal underpins the
   sweep, the reaper, and the supervisor. Build and test it before anything consumes it.
2. **`stuck-run-sweep.mjs`** (detect + `--repair`) with its process-dead and hung-alive arms
   and the grace guard, plus its test on a throwaway database fixture.
3. **`oa-supervisor.ps1`** — read-only classifier + the pure action function + restart —
   dispatched by **`install-oa-supervisor.ps1`** (scheduled task, daemon fallback).
4. **Deploy propagation** — `sync-oa-home.ps1`'s derived required set, `version-bump-sweep.mjs`,
   `auto-deploy-plugin.ps1`, `repo-drift-sweep.mjs` — so fixes to the above actually run.
5. **Byte-level guards** — `ps1-encoding-sweep.mjs`, `write-turn.ps1` — before trusting any
   script or journal write.
6. **Resource guards** — `reap-stale-mcp.ps1`, `check-browser-slots.ps1`.
7. **The harness** — `run-sweeps.ps1` and a `mutcheck-*` for every guard.
8. **The reconcile loop** and `user-settings.md` toggles last, once the pieces exist to
   turn on and off.

See also [Domain-overnight-agent](Domain-overnight-agent), [Domain-scripts](Domain-scripts),
[Architecture](Architecture), [Rebuilding](Rebuilding), and [Roadmap](Roadmap).
