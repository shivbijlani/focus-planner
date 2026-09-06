# Reliability

The overnight agent runs unattended, on one machine, on a recurring schedule, with no operator
watching it. Every mechanism on this page exists because that machine was observed to fail in a
specific, measured way, and the fix is a script or a guard, not a process change — a rule kept as
prose regresses, a rule kept as an executable check does not (`plugins/overnight-agent/checks/README.md`).

## Out-of-band supervision (issue #226)

Every supervisory mechanism in the system used to be dispatched by the thing it supervised:
`reap-stale-mcp.ps1` and the sweep suite both ran from inside an agent run's own `SKILL.md` phases; the
browser watchdog and the agent itself were both launched by the same app scheduler. Measured on the
production machine: zero OS-level scheduled tasks supervised any of it, so "the agent stopped running"
was unobservable from inside the agent, and across 1,222 recorded runs, 32 occupied their slot for over
an hour, 18 of them ending only by "interrupted by app shutdown" — 13.1 cumulative days lost. The fix,
`plugins/overnight-agent/checks/oa-supervisor.ps1`, is dispatched by Windows Task Scheduler — the OS,
not the app — specifically so a frozen agent cannot also freeze its own supervisor. Because Task
Scheduler registration can be denied without elevation on an unattended machine, a second, unelevated
fallback dispatcher (`oa-supervisor-daemon.ps1`) is launched from the Windows Startup folder by Explorer
at logon instead: its own process, not a child of `copilot.exe`, not an MCP server, so neither the MCP
reaper nor a crashing run can take it down, and it is not dispatched by the scheduler whose freezing is
the exact failure being guarded against.

## Liveness-gated stuck detection and orphan repair

`stuck-run-sweep.mjs` detects a run occupying its slot well past a healthy run's observed duration with
no liveness signal, and `--repair` performs the remedy: a silent auto-restart, not a page to a human who
is asleep. `orphan-liveness-sweep.mjs` closes the companion gap — a session-state directory or lock left
behind by a run that died mid-flight, indistinguishable from a live one until a liveness check
(process-alive, not merely file-present) resolves it. Both are proven by mutation replay
(`supervisor-replay.mjs`), which re-runs each sweep against a corpus of known-good and known-bad
historical states and requires the sweep to classify every one correctly — a sweep is only as trustworthy
as its worst historical miss.

## Silent auto-restart as the remedy

The remedy for a detected stuck run is deliberately silent, not an alert: the standing instruction this
plugin is built against is "why block on me, if you're wrong it's easily reversed" — the same reasoning
behind `oa-supervisor-daemon.ps1` shipping unattended rather than waiting on a manual elevation step.
A silent restart costs nothing if it was unnecessary; blocking on a human costs the whole unattended
schedule until someone notices.

## Deploy propagation — "merged isn't running" (issue #196)

A merged PR does not mean the running copy of the plugin has it: `installed-skill-drift-sweep.mjs`
detects the gap nightly, and `deploy-installed-plugin.ps1` closes it by hand, but the loop from
"merged" to "running" had a human step in the middle — and the human step is the one that gets
skipped. Measured: PR #151 merged and sat uninstalled for five days; a reliability guard for the MCP
reaper merged to `origin/main` and was absent from the installed tree, found only by a nightly run and
deployed by hand. `plugins/overnight-agent/checks/auto-deploy-plugin.ps1` is the missing wire: it
closes the loop end-to-end so "merged" and "running" cannot silently diverge again. `repo-drift-sweep.mjs`
runs the same class of check for the checks suite itself (see [Domain-overnight-agent](Domain-overnight-agent)),
because the archive that proves the suite works is exactly as perishable as the plugin it audits.

## Byte-level encoding safety

`ps1-encoding-sweep.mjs` and `journal-encoding-invariant.mjs` guard against silent corruption at the
byte level: PowerShell string interpolation and encoding conversions can drop or mangle characters in
ways that are invisible until a journal or script is read back wrong. The repository's own
`core.autocrlf=true` with no `.gitattributes` — git stores LF, checks out CRLF — is itself a source of
exactly this class of false positive, which is why file-comparison sweeps (`repo-drift-sweep.mjs`)
normalize line endings before comparing rather than hashing raw bytes.

## Journal write safety

`write-turn.ps1` is the **only** sanctioned writer of an agent turn into a journal, and it exists
because every alternative — direct file edits from inside a run, ad hoc string interpolation — has
corrupted a journal in a specific, previously-observed way. Its guards (named G1 through G12 in the
script) include: a double-quoted PowerShell string silently dropping a `$`-prefixed value (lost
interpolation); a single-quoted string producing a doubled apostrophe (`don''t`); a `##` heading not
immediately preceding the Telegram bridge's expected emoji anchor, breaking the bridge's block parsing;
a stray provenance marker breaking downstream parsing; and pointer-turn guards (G9–G11) scoped only to
doc-bound tasks, opt-in via a `<!-- doc-meta ... -->` stamp, so an ordinary journal is never subjected to
doc-binding rules it never opted into. See [Data-Formats](Data-Formats) §3 for the format these guards
protect.

## MCP process reaping

`reap-stale-mcp.ps1` reaps stdio MCP server processes left behind by finished sessions. Every scheduled
run starts a fresh set — roughly six node processes per run, each holding 75–150 MB — and when a
session ends they are not always reaped, so they accumulate. Measured on the production machine: 82
orphaned node processes held ~7 GB, free memory fell to 3.2 GB, and the email MCP died with an
out-of-memory error during the inbox-check phase — meaning emailed instructions could be silently
dropped. Not every MCP server is a node process: `uvx`-launched servers (Telegram, Google Workspace) run
as `uv.exe` plus two `python.exe` children and leak on the identical per-run cadence, so the reaper
scans by a configurable set of process names rather than one hardcoded image name, and only kills a
process satisfying every safety-model condition (a known process name, orphaned from a finished
session, above an age threshold) — never a live, in-use process.

## Browser-slot health (issue #197)

The hourly browser watchdog originally decided a slot was alive with a one-second raw TCP connect to its
debug port — a signal answered by the browser *process*, not by the *renderer*, whose task queue is what
actually wedges. "Already up, reusing" then meant the watchdog left a genuinely frozen slot untouched and
exited 0. `plugins/overnight-agent/checks/browser-watchdog.ps1` replaces the TCP probe with a real CDP
(Chrome DevTools Protocol) health check — evaluating actual page responsiveness, not socket acceptance —
so a wedged renderer is now detected and restarted rather than reported healthy.

## The mutation-tested sweep harness

Every sweep in this domain is proven, not merely written: the `mutcheck-*` convention reverts one part
of a fix and requires some test to go red (the mutant is "killed"). The stricter form used by the newer
mutation checks requires the arm-to-test kill matrix to be a bijection — every arm caught by exactly one
test — because an arm caught by a second test proves less than it claims, and a test that kills two
arms is not pinning either guard individually. See [Domain-overnight-agent](Domain-overnight-agent) and
[Prioritisation](Prioritisation) for the specific mutation checks guarding the gate/pacing/dispatch
mechanics.

## The `user-settings.md` reconcile loop (issue #337)

The supervisor's install/uninstall state should reconcile against a `user-settings.md` toggle rather
than being managed by hand — the watchdog install itself becomes a setting the user flips, and a
reconcile loop brings the running state in line with it on the next check, the same self-healing shape
as every other mechanism on this page.
