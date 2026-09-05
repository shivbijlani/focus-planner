# Reliability

The Overnight Agent is meant to run unattended, for hours, on one Windows machine, with no human
watching. Every mechanism below exists because that machine has already failed in a specific, measured
way, and each fix targets exactly the failure that produced it — not a generic hardening pass.

## The core problem: every supervisor was dispatched by the thing it supervised

Before this layer existed, `reap-stale-mcp.ps1` ran inside an agent run; `run-sweeps.ps1` ran inside an
agent run; `stuck-run-sweep.mjs` ran inside an agent run; the browser watchdog ran from the app's own
scheduler; the Overnight Agent itself ran from the app's own scheduler. Measured on the target machine:
zero OS-level scheduled tasks supervised any of it. The cost was measured directly: median healthy run
7.7 minutes, but 32 runs occupied their 30-minute slot for over an hour, 18 of those ended only by "app
shutdown" — 314.8 hours (13.1 days) of stalled runs, worst single stall 5,463 minutes across 182 ticks —
and not one of the 18 was ended by anything noticing; a human restarting the app ended all 18.

## Out-of-band supervision, dispatched by the OS

The fix is a dispatcher hierarchy where each layer's trigger genuinely lies outside the layer it
watches:

1. **`install-oa-supervisor.ps1`** registers a real Windows Scheduled Task, because "Windows Task
   Scheduler is a service of the operating system... it keeps firing exactly when everything this repo
   controls has stopped." It arms two triggers (`AtLogOn` for reboot survival, plus a repeating `-Once`
   trigger effectively unbounded), runs as `S4U` (fires whether logged on or not) when the installer can
   elevate, and falls back to `Interactive` when it can't — an honest, narrower fallback, not a silent
   failure. If registration itself fails ("Access is denied," measured — the agent cannot elevate
   itself unattended), the installer writes a shim into the Windows Startup folder and starts the
   daemon immediately rather than waiting for the next reboot.
2. **`oa-supervisor-daemon.ps1`** is that unelevated fallback: a plain process launched by Explorer from
   Startup at logon, not a child of the app or an MCP server, so neither an agent-run crash nor the MCP
   reaper can touch it. It runs the actual checker (`oa-supervisor.ps1`) as a child process specifically
   so a crash inside the checker cannot kill the loop meant to outlive everything, and writes its own
   heartbeat so its own absence is observable — "without it the supervisor is unsupervised, which is
   the same recursion [this layer] is about."
3. **`supervisor-liveness-sweep.ps1`** watches the daemons themselves, dispatched by a normal agent run —
   a deliberately different dispatch domain from the OS-triggered daemons, closing the last gap ("those
   are two different dispatch domains watching each other, not one domain watching itself"). Its
   verdicts are `ABSENT` / `DEAD` / `STALE` (alive but heartbeat too old) / `HEALTHY`, with a
   deliberately loose staleness tolerance — a companion sweep once flagged a genuinely overdue watchdog
   for 16 consecutive runs and every run ignored it, because a permanently red line teaches the reader
   to stop reading it.

## Liveness-gated stuck-run detection and orphan repair

`stuck-run-sweep.mjs` uses three escalating, evidence-specific arms rather than one blunt timeout:

- **Process-dead orphan** — each session directory holds a lock file named after its owning PID; if
  that PID is not alive, the run is provably orphaned, and a still-live run (including the one running
  this very sweep) can never be misclassified.
- **Hung-alive** — the owning process is alive but frozen (measured: CPU pinned, no event written for
  six minutes). Discriminated by the session's own event log going silent after its completion event
  fired — "a finished run whose bookkeeping never landed." It deliberately does not kill the idle
  process, only reports the leak, because killing a live process is a separate, less reversible
  decision.
- **Run-level timeout** — catches a run hung mid-task with neither a dead process nor completion
  evidence. It explicitly rejects a plain max-runtime rule, because run duration routinely and
  legitimately exceeds the nominal schedule: "age is not evidence of hanging. Silence is." An hour with
  nothing written is a stopped run, not a slow one. It resolves the row to `failed`, never `completed`,
  because claiming completion would be inventing an outcome.

Safety model across all three: detect-only by default (`--repair` required to write), a grace period
(default 20 minutes) that leaves young runs untouched, every row backed up to disk before modification
so any repair is revertible, and an `UPDATE ... WHERE status='running'` guard so the repair can never
clobber a status the app has since written itself.

## Silent auto-restart as the remedy

`oa-supervisor.ps1` classifies machine state as `STUCK`, `SCHEDULE-DEAD`, `RESOURCE-LEAK`,
`RESOURCE-CONTENDED`, or `HEALTHY` and maps each to an action:

| State | Condition | Action |
| --- | --- | --- |
| STUCK | no flagged orphan (a live, progressing run) | none |
| STUCK | orphan + hung-alive process | restart |
| STUCK | orphan + dead process | repair-only |
| SCHEDULE-DEAD | app running | restart |
| SCHEDULE-DEAD | app down | launch |
| RESOURCE-LEAK | app running | restart |
| RESOURCE-LEAK | app down | none |
| RESOURCE-CONTENDED | — | none (not attributable) |

The remedy acts rather than alerts, by explicit direction: "it should act, restart [the app] — don't
message me." An `-TestAlert` flag is retained but inert, and every decision is still logged to
`supervisor-log.jsonl` for later inspection — fully silent, no chat notification ever. An anti-loop
cooldown (default 20 minutes), keyed on state plus the run's own start time, prevents a repeated restart
for the same incident; the cooldown record is written even when the relaunch itself fails, so a failing
restart cannot become a hot loop. Restart mechanics resolve the app's executable from the live process's
own path first (survives version bumps), falling back to a fixed install path.

**The resource-leak arm** (added after a measured incident: CPU pinned at 100%, a 4-core box's processor
queue length at 21, the app's rendering subtree burning 7 CPU-hours over 14.7 hours of uptime, while the
plain schedule classifier reported `HEALTHY` throughout) requires three independent gates
simultaneously: a *sustained rate* (CPU-hours per wall-hour of process age, not an instantaneous spike),
an actually-contended machine (queue length past a threshold — a healthy 4-core box reads near zero),
and attribution restricted to the app's own process tree only ("restarting the app cannot fix somebody
else's compiler"). Age alone is deliberately excluded as a signal, because legitimate sessions are kept
open for hours. A sampling failure reports an explicit `RESOURCE-UNKNOWN`, never a silent `HEALTHY` — a
probe that could not look must not produce the same bytes as one that looked and found nothing.

**Read-path safety**: the supervisor snapshots the app's SQLite database by copying the `.db` file
together with its `-wal`/`-shm` sidecars, because a committed transaction can live in the WAL file until
the next checkpoint — copying the `.db` alone reads state as of the last checkpoint, not as of now.
Getting this wrong was measured to produce stale reads in 23% of replayed ticks (lag up to 97.6
minutes) and false alarms, which matters acutely here because `SCHEDULE-DEAD` has no liveness veto: it
restarts the app outright, so a stale read alone could kill live sessions on an otherwise healthy
machine.

## Deploy propagation: "merged isn't running"

Three separate deploy targets exist on one machine, and each has its own classify-then-refuse safety
model rather than a blind copy of `main`:

- **`deploy-installed-plugin.ps1`** moves bytes into the installed-plugin tree, delegating its
  classification to the same drift sweep the domain page describes
  (`installed-skill-drift-sweep.mjs`) "so the two halves cannot disagree." It classifies a path as
  `MISSING` (deploy), `UNVERSIONED` (deploy after backup), `BRANCH-ONLY` (refused unless forced — a live
  hand-deployed fix not yet merged), or `MAIN` (skip). A real merged pull request sat unreflected in the
  installed tree for five days because of exactly the seam described next.
- **`auto-deploy-plugin.ps1`** is the missing wire between detection and deployment: the deploy tool
  above exits 0 even on a refusal, so a blocked deploy looks identical to a clean one. This script fetches
  `origin/main` first (a local cache goes stale otherwise), escalates a persistent refusal after a
  configurable number of cycles rather than refusing silently forever, and verifies every changed path
  against the live tree afterward rather than trusting what was merely attempted. It keeps two separate
  time budgets — local classification versus network fetch latency — because sharing one budget once
  caused a slow network to be misreported as a deploy failure.
- **`sync-oa-home.ps1`** targets the second, and more load-bearing, deploy destination: the flat
  `%LOCALAPPDATA%\overnight-agent\` home that `user-settings.md`'s own documented commands actually
  invoke. Measured: immediately after the plugin-deploy tool reported a clean tree, a script in this
  second location was 300 lines behind `main` — a merged, deployed, and still-not-running fix. Its
  classifier adds two states beyond the plugin-deploy set: `DATA-BEHIND` (a non-code file whose live
  bytes match a historical commit — stale, safe to deploy) versus `DATA-STALE` (live bytes matching no
  commit at all — refuse, it may be locally-mutated state). A forward-direction gap remained even after
  this fix: a brand-new file merged and registered but never enumerated as `MISSING` is invisible to
  classification by construction — every reported number can be individually correct while the overall
  conclusion is wrong.

## Byte-level encoding safety

The root cause behind every encoding guard: Windows PowerShell 5.1 decodes a BOM-less file as the
system ANSI codepage, while `pwsh` 7 decodes the identical bytes as UTF-8. `ps1-encoding-sweep.mjs`
scans the repository's own tracked scripts for non-ASCII characters with no BOM, and distinguishes three
severities: **load-bearing** (non-ASCII inside a comparison — `-eq`, `-match`, `-replace`, `-split`,
`[regex]`, `Select-String` — where the comparison silently runs against corrupted text), **literal**
(cosmetic corruption only), and **comment-only** (harmless today, but a trap for the next edit that
moves the character into a literal). `journal-encoding-invariant.mjs` guards a stronger, behavioral
property — that marking a task must never re-encode its journal — after a measured incident destroyed
593 lines of one journal via an asymmetric read-ANSI/write-UTF-8 pair; it runs the installed script
against a synthetic journal and asserts the bytes survive a round trip rather than asserting anything
about source code shape. Its mutation companion proves the hash `oa-state.ps1` computes for a journal
must depend only on the journal's bytes, never on which PowerShell host ran the script — swapping which
host ran the same script turned "0 changed, 0 reopened" into "239 changed, 24 reopened" across a real
corpus of 239 journals.

A related fix for `mcp-config.json`: a BOM silently prepended by `Set-Content -Encoding UTF8` under
Windows PowerShell 5.1 passed every PowerShell-side validation (which tolerates a BOM) while producing a
file the Node-based MCP client could not parse at all — surfacing hours later, unattended, as every MCP
server failing to start, including the one PHASE 0 reads instructions from. The fix requires the write
to survive an actual Node `JSON.parse`, not a byte-signature check, because a byte check "encodes the
assumption that the only thing that can ever go wrong is the thing that already went wrong."

## Journal write safety

`raw-append-reopen-sweep.mjs` guards a specific defect in how the agent finds the end of its own last
turn: it searches forward for the next `## ` heading, and when there is none — the normal shape for a
journal whose newest turn is the agent's — it treats the entire remainder of the file, including
anything a user appends without a heading or an attribution marker, as still inside the agent's own
turn. The consequence is a false "already answered" that silently swallows a user's message with no
trace anywhere that it happened. Its own mutation check exists because the sweep once printed a nonzero
exposure count and exited 0 for weeks — "the number was computed correctly and wired to nothing."

## MCP process reaping

`reap-stale-mcp.ps1` exists because 82 orphaned Node processes once consumed roughly 7GB of memory,
leaving the machine with 3.2GB free, which killed the email MCP server mid-run with an allocation
failure — silently dropping the ability to receive emailed instructions. A kill requires five conditions
simultaneously: a matching process image name; a command line matching a known MCP launch signature; no
live owning session anywhere in its ancestor chain (a direct measurement replaced an earlier, unverified
assumption that one host process serves many successive runs — it does not, each session owns its own
host); no superseded-cohort veto (a pooled, reused host process across successive, non-concurrent
sessions must still only protect its *newest* cohort, not every one that ever ran through it); an age
past a minimum floor (a secondary check, not the safety mechanism — set to roughly match the reaper's
own position at the very start of a run, not a full extra schedule cycle of tolerance); and no overlap
with the current tool-shell's own process tree. An additional idle-veto expiry ensures a wedged session
that exists forever while doing nothing cannot indefinitely shield its own orphaned servers — presence
is not liveness. A "stillborn host" class (a server whose client died before ever driving it) is
separately detected by checking whether its startup banner is still the *last* thing it ever logged, not
merely present in the log, reading the file with sharing permissions that tolerate the still-open
handle rather than throwing and silently reporting a false-healthy zero.

## Browser-slot health

`check-browser-slots.ps1` is a read-only preflight — it never launches or kills a browser, because the
automation slots are the user's own windows and may hold in-flight state. It distinguishes a "zombie"
slot (the port still answers and existing tabs render, but the browser binary was auto-updated
underneath the running process, so any *new* tab crashes) from a "wedged" slot (the port and its API all
answer, but existing pages are frozen in the browser's lifecycle model — timers and animation frames
never fire). Wedged detection specifically probes *existing* pages with a promise resolved by a timer,
because a fresh tab is never frozen and would report every wedged slot as healthy. `browser-watchdog.ps1`
rewires the supervisor to use this real verdict instead of a bare TCP connect check — the two were once
measured 40 minutes apart with nothing in between, a healthy TCP-only check followed shortly by every
slot being found stuck. The slot list itself is a reconciled table in `user-settings.md`, never hardcoded
in any script, and is refused outright (not guessed at) if malformed, missing required columns, or
carrying duplicate ports or profile directories.

## The mutation-tested sweep harness

Across this domain, a passing check is not treated as proof of anything: a `mutcheck-*` script
establishes a baseline (the real subject, unmutated, classifies every fixture correctly), mutates
exactly one guard or arm — read directly off disk and extracted by brace-matching so a nested block
cannot truncate the extraction — and re-runs the same fixtures, requiring the mutation to flip exactly
the fixture(s) that arm owns: not zero (the arm is decoration) and not fixtures belonging to a different
arm (the arms are entangled). A control mutation is sometimes included specifically to prove "every
edit breaks it" isn't itself a form of decoration. `run-sweeps.ps1` auto-discovers every `mutcheck-*`
file, so a new one joins the standing suite automatically rather than needing to be remembered. This is
the same harness family documented in [Domain: overnight-agent](Domain-overnight-agent) and the
executable evidence behind the dispatch/gate guarantees in [Prioritisation](Prioritisation).

## The `user-settings.md` reconcile loop

Every run resolves its real settings file through a fixed precedence: an explicit environment-variable
override, then a project-local copy, then the recommended cloud-synced copy (in the same OneDrive folder
as the board), then a last-resort local copy — seeding the cloud-synced location from the bundled
template on first run, since the bundled copy in the plugin itself is explicitly disposable and
overwritten by every plugin update. Every tunable it reconciles fails **narrow**, on purpose: a missing
Today-gate-backstop row, an unreadable file, or a value the agent cannot parse all resolve to the
narrowest, safest interpretation — never a value more permissive than what was actually configured — and
the run summary states plainly when a fallback occurred rather than quietly proceeding as if the
configured value had been read. The `## Browser slots` table follows the identical discipline: refused
rather than guessed at when malformed, and read by every script from that one table rather than each
script keeping its own hardcoded copy that could drift from it.
