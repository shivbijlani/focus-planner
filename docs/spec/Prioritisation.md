# Prioritisation

Prioritisation is not a background sort order; it is a product surface. A user expresses intent in
five ways on the board and one way in a journal reply, and the Overnight Agent's `scan` command
converts all of them into a single ordered worklist with a binding `eligible` flag per row. The rest
of this page is that conversion, in the order it actually runs.

## How priority is expressed

| Signal | Where it lives | Read by |
| --- | --- | --- |
| Section | `## Today` / `## Deferred` headings | `Get-BoardMap` |
| Urgency icon | column 2 of the row (🔴/🟡/📖/⚪…) | `Get-UrgencyRank` |
| `Work Priority` | column 4, matched `^P[0-9]$` | `Get-BoardMap` |
| `## Priorities` list | an ordered list of bare task ids at the foot of the board | `Get-PrioritiesRank` |
| Row order | physical position in the file | `board_pos` |
| Task id | column 1 | final tiebreak |

The user changes these by editing the board directly, by replying in a journal (a reply always
preempts the whole ranking — see below), by snoozing a row (`snooze.json` or the legacy
`<!-- snooze:YYYY-MM-DD -->` board comment), by editing `agent-gate.md` (which reversible actions the
agent needs no permission for), or by editing `user-settings.md` (the Today-gate and pacing tunables
covered later on this page).

## The full sort key, in order

`oa-state.ps1`'s `scan` command (`Cmd-Scan`) sorts every row with this exact key, most significant
first:

```powershell
$rows = $rows | Sort-Object `
  @{ Expression = { if ($_.reopened -or (Test-UnansweredUser $_)) { 0 } else { 1 } } }, `
  @{ Expression = { Get-SectionRank $_.section } }, `
  @{ Expression = { Get-PriorityRank $_.work_priority } }, `
  @{ Expression = { Get-UrgencyRank $_.urgency } }, `
  @{ Expression = { $_.priorities_rank } }, `
  @{ Expression = { $_.board_pos } }, `
  @{ Expression = { [int]$_.id } }
```

1. **`reopened OR unanswered_user`** (0 first) — a live reply or an unanswered message preempts
   everything else in the ranking.
2. **Section rank** — `today=0, deferred=1, default=2`.
3. **Work-priority rank** — `^P([0-9])$` → that digit; unset → `9`.
4. **Urgency rank** — red=0, yellow=1, book(📖)=2, white(⚪)=3, anything else (including blank)=4. Built
   from Unicode codepoints deliberately, to avoid a PowerShell 5.1 ANSI mis-comparison.
5. **`## Priorities` list position** — else `999999` (matches only `^\s*\d+\.\s+(\d+)\s*$`).
6. **Board row physical position** (`board_pos`).
7. **Numeric task id** — the final total-order tiebreak.

`Get-BoardMap` reads urgency and work-priority from fixed cell positions (`cells[1]`, `cells[3]`),
regardless of header names, because Today's header is `ID|urgency|Task|Work Priority|Added|Linked ID`
and Deferred inserts `Wake` before `Linked ID` — the first four cells line up in both. The id cell is
parsed as **leading digits**, not "digits only," because compound cells exist (`448,[176](...)`); a
whole-cell-integer regex silently dropped such rows from the board map entirely, emptying `today` and
leaving the gate permanently open — guarded by `mutcheck-board-compound-id.ps1`.

### Two readers, two sort keys, neither authoritative

The app's own display sort, `sortTasksByPriority` in `src/taskSort.js`, is materially different:

```javascript
const priorityOrder = { '🔴': 0, '🐸': 1, '🟡': 2, '🔵': 3, '📖': 4, '⚪': 5, '✅': 6 }
```

It splits on urgent-vs-not first, then resolves manager priority via the `Linked ID` chain
(`resolveManagerPriority`), then chain depth, then this 7-icon table — which includes 🐸/🔵/✅ that
`Get-UrgencyRank` doesn't recognize at all (they'd rank "4/unknown" to the agent), and uses a
dependency-chain tiebreak instead of the flat `## Priorities` list. Both are correct for their own
purpose — one drives what a human sees on screen, the other drives what an unattended agent works
next — but a rebuilder must not assume they agree, and must not merge them into one shared function:
they read genuinely different signals for genuinely different consumers.

## Eligibility

`scan`'s exact eligibility computation:

```powershell
$eligible = $false
if (-not $r.snoozed) {
  if (Test-ReopenedClosed $r) { $eligible = $false }
  elseif ($r.reopened) { $eligible = $true }                  # a reply always beats the gate
  elseif (Test-UnansweredUser $r) { $eligible = $true }
  elseif ($r.section -eq 'today') { $eligible = (Test-Workable $r) }
  elseif ($todayHolding -eq 0) { $eligible = (Test-Workable $r) }
}
```

`$todayHolding` is the count of Today rows whose gate verdict `holds` is true. A Deferred row is only
ever eligible once **no** Today row is holding the gate. `Test-Workable` itself checks, in order:
snoozed → false; a reply landed on a task the user had already closed (`Test-ReopenedClosed`) → false;
`reopened` → true; an unanswered user message → true; `awaiting_reply` with no due poll/recheck →
false (parked); a due recheck on a `blocked` task → true; otherwise the row is workable unless its
status is in `{done, skip, proposed, blocked}`.

## The Today→Deferred gate and what releases it

The gate exists because two earlier designs both failed, measurably. Keying release to plain
workability never opened for an unbounded meta-task (measured: 1/238 rows eligible, 121 Deferred rows
frozen, three consecutive runs re-working the same task). Keying release to recency
(`last_turn_at`) opened the instant the agent typed anything: one turn on a task sent eligibility from
1 to 13 and dispatched a Deferred row (issue #310). The shipped design instead requires an explicit,
falsifiable **exhaustion declaration**.

**`Get-TodayGateVerdict`**, in order:

1. Not workable → `holds=false, reason='not_workable'`.
2. `reopened` → `holds=true, reason='holding:reopened'`.
3. Unanswered user message → `holds=true, reason='holding:unanswered_user'` — checked *before* the
   exhaustion claim on purpose: "I examined everything Today holds" cannot be true of a row carrying an
   unanswered question. This closes issue #245, where a self-declared `done` opened the gate while
   three unanswered messages sat on the row.
4. Strict-mode setting → `holds=true, reason='holding:strict'`.
5. `Test-ExhaustionClaim` → `declared_exhausted` releases the gate.
6. Staleness backstop (below) → releases the gate if it fires.
7. Otherwise → holds, with the specific `holding:<why-not>` reason.

**Declaring exhaustion** is two separate calls — writing a turn does not itself release anything:

```powershell
oa-state.ps1 mark -Id 463 -Status in-progress
oa-state.ps1 mark -Id 463 -Exhausted 'gh:197,gh:179,gh:139' -ExhaustedNote 'all three blocked on review'
```

`-Exhausted` must name the examined set and cannot combine with `-Status`/`-Version`/`-PlanId`/timer
flags.

**The four things that cancel a declaration**, all checked inside `Test-ExhaustionClaim`:

1. `holding:exhaustion_expired` — older than the TTL (default 30 minutes).
2. `holding:exhaustion_stale_board` — the `## Today` section text changed since the declaration
   (hash mismatch).
3. `holding:exhaustion_superseded` — a turn was written to the row *after* the declaration.
4. `holding:reopened` — a reply reclaims exclusivity outright, checked earlier than the claim is even
   evaluated.

**`today_release_reason`** is recorded on every Today row and takes one of: `not_workable`,
`declared_exhausted`, `stale_turn_backstop`, `holding:reopened`, `holding:unanswered_user`,
`holding:strict`, `holding:exhaustion_expired`, `holding:exhaustion_stale_board`,
`holding:exhaustion_superseded`, `holding:declaration_named_nothing`, `holding:no_declaration`,
`holding:declaration_disabled`, `holding:declaration_unparseable`.

## Liveness mechanisms

- **`awaiting_reply` parking**: `HasAgentBlock AND HasBlockingAsk AND NOT HasTrailingUser`, computed
  identically (kept textually synchronized) in `Cmd-Scan` and in `Test-SessionHoldsCapacity`
  (the #487 capacity fix — a parked task must not also silently occupy a concurrency slot). A row is
  un-parked by a reply (`reopened`) or a due `poll`/`recheck` timer. The "blocking" reader is
  deliberately stricter than the digest's "open ask" reader: a dismissive `**Needs from you:**
  none/nothing` does not park, and only the *newest* agent turn's ask counts.
- **Poll/recheck timers**: cadence grammar `hourly|daily|weekly|<N>h|<N>d|<N>m`. A freshly armed timer,
  or one with no `next_due`, is due immediately. `-Poll` re-checks in general; `-Recheck` targets a
  specific `blocked` task's blocker and is the only path that yields the `blocked` status a workable
  verdict.
- **The staleness backstop**: the `Today gate backstop` setting in `user-settings.md`, default 6 hours.
  `off|none|disabled` disables it; an unparseable value is ignored rather than silently disabling a
  safety mechanism ("a typo must not silently disable a safety backstop"); an explicit
  `-TodayGateBackstopHours` argument outranks the file.
- **Snooze precedence**: the flat `snooze.json` store (read-only to the agent) wins on conflict over
  the legacy in-board `<!-- snooze:YYYY-MM-DD -->` comment marker. A snoozed row suppresses `due_poll`
  and `due_recheck` while leaving the timer object itself armed.

## The failure class this design guards against

The Today gate's own source comment names a pattern, verbatim: **"the agent authors the signal that
its own gate reads."** Three instances have occurred in this repository:

1. **Consent-marker authorship** (#227/#272) — the agent's own unmarked journal prose was read back as
   human approval.
2. **The `awaiting_reply` ratchet parking itself** — the agent's own closing courtesy line satisfied
   its own "has an agent block, has an ask" test and parked its own task (measured: 186/238 rows
   parked, 0 eligible, before the dismissive-ask boundary was fixed).
3. **The Today gate release** (#310) — `last_turn_at`, stamped by the agent's own `mark` call, released
   the agent's own gate the instant it wrote anything.

The generalized rule this repository now follows: prefer a signal the agent cannot author (a clock, the
board text, a reply, `agent-gate.md`); where an agent-authored signal is unavoidable, admit it only in
the cancelling direction, never the granting one — `exhaustion_superseded` can only take the gate back
to holding, never release it early. `agent-gate.md`'s one-way property is guarded the same way:
`mutcheck-agent-gate.ps1` proves the file is seeded by the app (`src/config/agentGate.js`) and never
written by `oa-state.ps1`, closing the earlier bug where the file existed but was entirely decorative.

## Pacing

The `Overnight Agent concurrency` tunable in `user-settings.md` defaults to **1**. One item in flight
is isolation, not concurrency — giving a task its own session is a correctness property (workspace
separation, per-task state), not a grant to run several things at once. Resolution precedence is an
explicit `-Concurrency` argument, then the settings row, then the built-in default of 1; the settings
cell is parsed with an anchored whole-cell match (`^\s*(\d+)\s*$`), not a leading-integer scan, because
a prose annotation like `2026-09-02: set to 1 by Shiv` previously parsed as `2026`. An unparseable
non-empty value is surfaced as `concurrency_source: settings-malformed` rather than silently defaulting
to 1.

Beyond the count, `SKILL.md` states two further rules as run-loop guidance, not as an enforced
mechanism: **estimate before starting another** — use the rate actually observed this run, not an
optimistic one, against the time left before the next scheduled run, because starting what cannot be
finished is worse than ending early — and **done means verified and published**, not code sitting in a
working tree: tests green, the deliverable placed where the user will see it, the journal updated.
Neither rule has a corresponding field in the per-task state store, and `oa-state.ps1` has no code path
measuring elapsed rate or remaining wall-clock time; the only mechanical enforcement in this area is
the concurrency *count*. Issue #391 tracks encoding pacing as an actual mechanism rather than prose; it
is open, and its own text distinguishes the two halves plainly: "Priority order is already enforced as
data... this half is correct and mechanically guarded" against "Pacing is absent... nothing caps how
many items are in flight" — precisely the state described above.

## Dispatch precedence

A run separates two steps: **collect** (the agent inbox, folded Telegram replies, `scan`) and
**execute** (the two dispatch phases below). Collect gathers and hands off; it must not perform work
itself — issue #405 documents a measured incident where a Telegram reply folded into a task was fully
worked (journal read, four deliverables rewritten, a turn written) inside the collect step itself,
before any priority comparison ever ran.

Dispatch then runs in **two waves**: the **priority wave** first (the `scan` worklist in the order
returned, skipping `eligible: false`), then the **collect wave** — any wake that arrived from the
collect step (a folded reply, an approval) is dispatched *in addition to* the priority selection, even
though this can push the run above its configured concurrency. This is the single sanctioned exception
to the default concurrency of 1, and it is justified by **provenance**, not urgency: a user's own action
(a reply) may widen the run; the agent's own judgement may not. Capacity is checked first via
`oa-state.ps1 session -InFlight`, which reports:

```powershell
concurrency   = [int]$script:ConcurrencyLimit
in_flight     = [int]$live
at_capacity   = [bool]($live -ge $script:ConcurrencyLimit)
admits        = [int][Math]::Max(0, $script:ConcurrencyLimit - $live)   # never negative
```

The priority wave may dispatch at most `admits` items. The collect wave is the one case where binding a
session with `-Force` past `session_at_capacity` is correct — the code's own guard message states it
plainly: `-Force is for the collect-wave exception only: a wake that exists because the USER did
something may widen the run; the agent's own judgement may not.` Re-binding an already-live session, or
replacing a dead one, is not charged against capacity at all, since neither actually adds an item to the
run.

Critically, the exception **does not compound or raise the setting**: it widens a single run by exactly
the wakes the collect step actually found, it does not touch `$script:ConcurrencyLimit` or
`concurrency_source`, and the priority wave still holds one item in flight at the default on every
subsequent run. Nor does it license the run session itself to do the work — a trumping wake is
dispatched to the task's own session like any other item (issue #404); the exception changes **when** a
task is woken, never **where** its work happens. Issue #404 is the companion fix that gave every task
its own session, workspace isolation, and a persisted session id in the first place — before it landed,
the run session had no session field at all and did every task's work directly in itself, which is what
made the #405 incident possible.

This is grounded directly in `plugins/overnight-agent/skills/overnight-agent/oa-state.ps1` (the `scan`,
`Get-TodayGateVerdict`, `Test-Workable`, `Resolve-PacingSettings`, and `Cmd-Session` machinery) and
proven, arm by arm, by the `mutcheck-*.ps1` family — `mutcheck-awaiting-reply.ps1`,
`mutcheck-today-served.ps1`, `mutcheck-pacing-concurrency.ps1`, `mutcheck-parked-capacity.ps1`, and
`mutcheck-agent-gate.ps1` — which is the executable statement of the intended behaviour: each mutates
one guard, re-runs the target fixture, and requires the sweep's verdict to flip.

See [Domain: overnight-agent](Domain-overnight-agent) for the module family these mutchecks belong to,
and [Reliability](Reliability) for how the agent that reads this worklist is itself kept running.
