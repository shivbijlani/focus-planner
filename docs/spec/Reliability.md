# Reliability

The overnight agent runs unattended, on one machine, every 30 minutes, with no human watching a
given run. Every mechanism on this page exists because that combination — autonomy, schedule,
single point of failure — turns an ordinary bug into a silent multi-day outage. The design answer is
uniform: detect narrowly, prefer silent auto-repair over silent failure, and prove every guard is
load-bearing by mutating the real file it protects.

## Out-of-band supervision

`plugins/overnight-agent/checks/oa-supervisor.ps1` runs as an OS-scheduled process independent of
the agent it watches, and classifies it `HEALTHY | STUCK | DEAD | SCHEDULE-DEAD | LEAK`. `LEAK` is
deliberately distinct from "busy": a sustained resource leak (measured live: 7.05 CPU-hours over
14.7h uptime, queue length 21) reaches a non-`HEALTHY` state, while a machine that is merely busy
stays `HEALTHY`, and a long-running interactive session is never restarted purely for being
long-lived — issue #178 documents an earlier age-only heuristic killing legitimate work.
`mutcheck-supervisor-liveness.ps1` and `mutcheck-supervisor-resource.ps1` deliberately dot-source and
mutate the *real* shipped `oa-supervisor.ps1` rather than a reimplementation, because "a copy can
silently diverge from the file that actually runs."

## Liveness-gated stuck-run detection and orphan repair

`checks/stuck-run-sweep.mjs` detects workflow runs stuck at `status=running` and, given `--repair`,
fixes them — not merely reports them. The rationale is a measured incident: the hourly "Browser
watchdog" workflow was dead for 11 hours because a single orphaned row permanently disabled it for
both the scheduler and manual triggers, and a companion detector (`workflow-health-sweep.mjs`) had
correctly flagged it in 16 consecutive runs without anything acting on the flag. The liveness signal
is a per-session `inuse.<pid>.lock` file; "lock PID is not alive" is the orphan test.
`workflow-health-sweep.mjs` reads `workflows`/`workflow_runs` directly from
`%USERPROFILE%\.copilot\data.db` (ordinary SQLite tables) rather than trusting an app-level tool,
because "a whole class of automation was ruled out on an assumption nobody tested" — it also fixes a
"wolf-crier" false positive where a workflow that never ran flagged red in every one of 17 runs.

## Silent auto-restart as the remedy

Detection alone is proven insufficient by the stuck-run incident above (16 flagged runs, 0 acted
on); every subsequent reliability check therefore pairs a detector with a `--repair`/auto-restart
path rather than shipping detection alone.

## Deploy propagation — "merged isn't running"

Two independent deploy targets exist and both have gone stale silently. `checks/auto-deploy-plugin.ps1`
guards the `installed-plugins` target: PR #151 merged and was still not installed five days later,
meaning the `SKILL.md` the agent obeyed nightly was missing an entire PHASE 0 section. It also fixes
a refuse-but-exit-0 seam — a refused deploy previously exited `0`, so a blocked deploy looked
identical to a clean one. `checks/sync-oa-home.ps1` guards the second, flat
`%LOCALAPPDATA%\overnight-agent` target: auto-deploy reported "verified-current: True" for the first
target while the copy the agent actually executes (the second) stayed months behind — measured as
`reap-stale-mcp.ps1` sitting 16,360 bytes behind `main`, the missing fix for the exact "we keep
having to reap processes and restart the device" complaint the reaper itself exists to solve.
`checks/basename-collision-sweep.mjs` guards against the resulting worst case: `sync-oa-home` indexes
the flat deploy directory by basename, so two repo paths sharing one basename make it unable to say
which is current, and it refuses to update either — a guard frozen on the wrong version keeps
passing forever rather than failing. Measured: `mutcheck-turn-ask.ps1` and `mutcheck-write-turn.ps1`
each existed at two paths and refused on every run until fixed.

## Byte-level encoding safety

`oa-state.ps1`'s journal hash must depend only on a journal's bytes, never on which PowerShell host
ran the script. Windows PowerShell 5.1 ANSI-decodes a BOM-less UTF-8 file differently from
PowerShell 7; swapping the running script for an unpatched copy turned "0 changed / 0 reopened" into
"239 changed / 24 reopened" across 239 journals, 362 of 366 of which contain non-ASCII characters.
The fix, applied throughout `oa-state.ps1`, is to build lookup tables (urgency icons, etc.) from
Unicode codepoints rather than literal emoji characters in source, which a mismatched host would
otherwise mangle before the script even runs. `mutcheck-journal-decode.ps1` guards this.

## Journal write safety

`skills/overnight-agent/write-turn.ps1` is the only sanctioned path for appending a journal turn and
is append-only by construction — "it physically cannot eat one of Shiv's replies." Its header
documents distinct corruption classes it guards against, each with a measured cost before the fix:
lost string interpolation (`$150` silently expanding to nothing, `~$150-275` landing as `~\-275`;
cost: 12 journals), doubled apostrophes (cost: 50 occurrences), a bad Telegram heading anchor (cost:
5,405 of 10,557 characters dropped, twice in one day), a stray provenance marker (cost: 26 journals
left with an inert fallback), and an unstamped 🌙 heading silently reading as human consent (issue
#272). `Cmd-Extract`/`Get-BoundedSlice` similarly bound how much of a journal any reader may pull
into context at once — one journal alone reached 272 KB (~70K tokens), and issue #262 records the
same defect on a different file freezing the `*/30` schedule for roughly 9 hours; the read contract
is verbatim (contiguous substrings only), bounded (a byte ceiling), and read-only.

## MCP process reaping

`checks/reap-stale-mcp.ps1` reaps orphaned or stillborn MCP server processes under two guards. The
**ownership veto**: a server is reapable only if no live owning session remains anywhere in its
ancestor chain — without the veto, a run would have killed 9 live servers (621 MB) all aged 24
minutes, every one still in use. The **cohort rule** closes a gap the veto alone missed: 17 servers
(1,164 MB, growing ~436 MB/run) were unreachable by every existing rule while the reaper reported
perfect health. **Stillborn-host detection** targets a `copilot.exe --server --stdio` process that
came up, announced readiness, and was never driven — two real fixtures (392-byte logs, PIDs resident
8 hours) confirm the class. Guarded by `mutcheck-reaper-ownership.ps1`, `mutcheck-reaper-cohort.ps1`,
`mutcheck-reaper-stillborn.ps1`.

## Browser-slot health

`checks/check-browser-slots.ps1` detects two distinct dead states in the Playwright MCP CDP browser
pool: a "zombie" slot whose process still answers CDP but has an old Edge DLL loaded, so every new
tab crashes instantly; and a "wedged" slot (issue #197) whose page lifecycle is frozen — it passes
every HTTP probe but never resolves an `evaluate` call. The check is read-only by default; its only
`-Repair` action is the non-destructive `Page.setWebLifecycleState -> 'active'` call. Guarded by
`mutcheck-browser-slots.ps1`, `mutcheck-browser-slot-probe.ps1`, `mutcheck-playwright-slots.ps1`,
`mutcheck-browser-watchdog.ps1`.

## The mutation-tested sweep harness (the `mutcheck-*` pattern)

Roughly 48 files across `checks/` and `skills/overnight-agent/` follow one shape: build a synthetic
fixture, run the *real* shipped script or function against it (never a reimplementation), mutate one
behavior at a time, and assert exactly the owning arm flips — "a test suite that passes on broken
code is worse than none." A `-Matrix` mode mechanically proves the arm↔mutant bijection.
`mutcheck-today-served.ps1` additionally guards a meta-failure: some scripts assert their own
literal-match targets still exist in the source, because a later reformat can silently kill a mutant
while every arm still reports green. The pattern itself exists because of a near-catastrophic single
point of failure: `checks/repo-drift-sweep.mjs`'s own header records that on 2026-08-26, 70 of 73
files making up this enforcement suite existed in exactly one place — a single laptop's
`%LOCALAPPDATA%\overnight-agent` — with no git history and no backup; a disk failure would have
erased the entire self-healing layer. `repo-drift-sweep.mjs` now continuously re-verifies the
archive against what actually runs, "because a rule kept as prose regresses; a rule kept as an
executable check does not."

## `user-settings.md` reconcile loop

Both the Today-gate settings (`Resolve-GateSettings`: backstop hours, strict flag) and the pacing
setting (`Resolve-PacingSettings`: concurrency, see [Prioritisation](Prioritisation)) are re-read from
`user-settings.md` fresh on every run with an identical contract: an explicit CLI argument outranks
the settings-file row, which outranks a safe built-in default, and a malformed cell is *reported* as
a distinct `*-malformed` source rather than silently substituted — "narrowing a run that the user can
see was narrowed is recoverable; widening one nobody can see is not."

## Related pages

Journal-corruption guards feed directly into the Today-gate design in
[Prioritisation](Prioritisation) §5–6; the on-disk shapes referenced here (`agent-gate.md`,
`user-settings.md`, journal turns, `scan` rows) are specified in full in
[Data-Formats](Data-Formats).
