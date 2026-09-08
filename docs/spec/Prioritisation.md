# Prioritisation

Prioritisation in this repository is a product behaviour, not one comparator. The durable inputs live
in markdown (`planner.md`, journals, `agent-gate.md`, `user-settings.md`); the web app edits those
inputs; `plugins/overnight-agent/skills/overnight-agent/oa-state.ps1` turns them into an ordered,
binding worklist; and dispatch then applies capacity, gating, and provenance rules before any task
runs. [Domain-overnight-agent](Domain-overnight-agent), [Reliability](Reliability), and
[Data-Formats](Data-Formats) describe adjacent parts of the system; this page describes the
selection logic end to end.

## 1. The durable priority signals on the board

The durable board is `planner.md`, not the React view layered on top of it. The board encodes
priority in six places:

1. **Section**: `## Today` outranks `## Deferred`; anything else is lower still.
2. **`Work Priority` cell**: `P0`, `P1`, `P2`, ... if present.
3. **Urgency icon cell**.
4. **Canonical `## Priorities` ordered list**: `1. 285`, `2. 191`, ...
5. **Row order as written** inside the section.
6. **Task id** as the final deterministic tie-break.

`src/boardRow.js` does not sort rows itself. Its job is narrower and more important: it is the one
canonical row/header alignment rule, so every reader and writer agrees on which cell is `Wake` and
which is `Linked ID`. That matters to prioritisation because snooze state and link structure are
part of eligibility and manager-priority resolution; if a row is misaligned, the scheduler reads
false data. `src/focusPlanOps.js` preserves the board as the durable source of truth: it moves rows
between sections, inserts new numbered `## Priorities` entries, and keeps row order meaningful.

For example, section moves preserve user-visible ordering rather than re-sorting on write:

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```js
/**
 * The moved rows are appended to the destination section in the supplied
 * order, immediately after the table separator row.
 */
// Insert in the caller-provided order (top-to-bottom as displayed).
const orderedRemoved = rawLines
  .map(l => removedByLine.get(l.trim()))
  .filter(v => v !== undefined)
  .map(line => transformRowForSection(line, fromTable.headers, toTable.headers))
lines.splice(toSectionInsertIndex, 0, ...orderedRemoved)
```


</details>
Likewise, the forward design is a single canonical `## Priorities` section. `src/App.jsx`
migrates legacy headings into that one heading, and `src/focusPlanOps.js` normalizes writes back to
`## Priorities`. That matters because the overnight agent's reader matches only `^##\s*Priorities\b`.
Legacy compatibility exists to get old files onto the canonical path, not as a competing design.

### The exact sort key as implemented

`oa-state.ps1 scan` is the executable priority order. The comparator is literal code:

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

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


</details>
That yields the following order.

| Precedence | Durable source | Scan field / function | Exact behaviour |
| --- | --- | --- | --- |
| 0 | Journal reply state | `reopened` or `Test-UnansweredUser` | A fresh reply, or a standing unanswered human message, preempts everything else. This is an interrupt above the ordinary board key. |
| 1 | Section heading | `Get-SectionRank` | `today = 0`, `deferred = 1`, everything else = `2`. |
| 2 | `Work Priority` cell | `Get-PriorityRank` | `P0`, `P1`, `P2`, ... sort numerically; anything else sorts as `9` (after every explicit `P<n>`). |
| 3 | Urgency icon | `Get-UrgencyRank` | Only four icons have distinct ranks in `scan`: 🔴 = `0`, 🟡 = `1`, 📖 = `2`, ⚪ = `3`, everything else = `4`. |
| 4 | `## Priorities` list | `priorities_rank` | First numbered entry wins, then second, etc. Missing ids sort after every listed id. |
| 5 | Physical row order | `board_pos` | Earlier row in the section wins. |
| 6 | Numeric id | `[int]$_.id` | Final deterministic tie-break. |

The urgency map is intentionally explicit:

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```powershell
$script:UrgencyRank = @{
  ([char]::ConvertFromUtf32(0x1F534)) = 0
  ([char]::ConvertFromUtf32(0x1F7E1)) = 1
  ([char]::ConvertFromUtf32(0x1F4D6)) = 2
  ([char]::ConvertFromUtf32(0x26AA))  = 3
}
```


</details>
Two consequences are easy to miss:

- The overnight agent does **not** currently give distinct ranks to 🔵, 🐸, or ✅. In `scan`, they
  fall into the catch-all `4` bucket alongside blanks and unknown icons.
- The board UI has a **different presentation sort** in `src/taskSort.js` / `src/App.jsx`
  (`urgent first, then manager priority, then dependency depth, then icon`). That is a rendering
  convenience for humans. It is not the overnight agent's durable comparator.

`plugins/overnight-agent/skills/overnight-agent/mutcheck-priority-order.ps1` is the proof harness
for this section: it asserts Today-before-Deferred, `P0 < P1 < unset`, urgency tiebreaking,
`## Priorities` tie-breaking, determinism, Deferred ineligibility while Today still holds the gate,
and the corrected release behaviour once Today is exhausted.

## 2. How the user changes priority

The user changes priority through several different surfaces. Some rewrite the board order itself;
others change whether the selected row is allowed to run.

| Surface | Durable write | Code path | Priority effect |
| --- | --- | --- | --- |
| Priority orb / kebab menu | Row urgency icon | `src/App.jsx` `PriorityDropdown`, `handleChangePriority` | Changes the urgency term of the sort key. |
| Promote / remove / reorder in `## Priorities` | Numbered list lines | `ManagerPrioritiesSection`, `opUpdateManagerPriorities`, `opPromoteToManagerPriority`, `opRemoveFromManagerPriority` | Changes `priorities_rank`. |
| Add-and-prioritize | New Today row + appended numbered list entry | `handleAddAndPrioritize`, `opAddAndPrioritize` | Inserts a new row into Today and immediately lists its id in `## Priorities`. |
| Defer / Move to Today / Defer all below | Section membership and row position | `opMoveBetweenSections`, `opMoveLinesBetweenSections` | Changes the section term, and often the row-order tie-break too. |
| Snooze / reschedule / un-snooze | `Wake` date or legacy snooze marker | `handleSnoozeTask`, `opSnoozeTask`, `opApplySnoozeTransitions` | Does not alter the comparator directly; it suppresses eligibility and can move the row between Today and Deferred. |
| Journal reply | Appended `<!-- from: me -->` block | `appendJournalMessage` in `src/journalChat.js` | Raises the row above ordinary rank via `reopened` / `unanswered_user`. |
| Agent gate | `agent-gate.md` lists | `src/config/agentGate.js`, `src/AgentGateEditor.jsx`, `oa-state.ps1 gate/consent` | Does not change board order; it changes whether the agent may proceed automatically on a selected row. |
| Agent settings | `user-settings.md` values | `src/AgentSettingsEditor.jsx`, `oa-state.ps1` settings resolvers | Does not change board order; it changes gating, backstop, and capacity behaviour. |

The board UI exposes the urgency edit through one shared choice list:

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```js
const PRIORITY_CHOICES = [
  { icon: '🔴', label: 'Urgent & Important' },
  { icon: '🟡', label: 'Important' },
  { icon: '🔵', label: 'Urgent, Not Important' },
  { icon: '⚪', label: 'Low Priority' },
  { icon: '🐸', label: 'Frog (eat first)' },
  { icon: '📖', label: 'Learning' },
]
```


</details>
A journal reply becomes durable task priority by being appended with human provenance:

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```js
if (lastDate !== today) addition = `\n\n## ${today}\n\n${FROM_ME}\n${text}`
else if (attributed) addition = `\n${text}`
else addition = `\n\n${FROM_ME}\n${text}`
```


</details>
That `<!-- from: me -->` marker matters. The overnight agent treats a trailing human message as
higher-value work than any ordinary board rank, and it also uses the marker to distinguish a real
human reply from unattributed or agent-written text.

The two file-based controls deliberately affect different layers:

- `agent-gate.md` is a **standing permission** channel. Its two lists are `Do not gate these
  (reversible)` and `Always ask (safety floor)`. `src/config/agentGate.js` and
  `src/AgentGateEditor.jsx` are built around the one-way rule that the user writes this file and
  the agent only reads it. That lets the gate answer *may I do this without asking?* without using
  the task journal as the only consent surface.
- `user-settings.md` is a **runtime behaviour** channel. The tunables relevant here are `Today gate
  backstop`, `Today gate strict`, and `Overnight Agent concurrency`.

The shipped template states the concurrency rationale plainly:

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```md
| Overnight Agent concurrency | `1` — how many items the agent may have **in flight** at once. At `1` it works one thing at a time; giving a task its own session is *isolation*, not permission to run several at once. |
```


</details>
## 3. `scan` turns the board into a binding worklist

`oa-state.ps1 scan` joins five kinds of fact onto each task row: board placement, journal state,
completed-board closure, doc binding/comment state, and per-task session state. It emits a single
JSON worklist with `order`, `eligible`, `holds_today_gate`, `today_release_reason`, timers,
session facts, and provenance facts already computed.

The important point is that `eligible` is **binding**. The downstream run loop is not supposed to
re-argue with it. The executable rule is:

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```powershell
if (-not $r.snoozed) {
  if (Test-ReopenedClosed $r) { $eligible = $false }
  elseif ($r.reopened) { $eligible = $true }
  elseif (Test-UnansweredUser $r) { $eligible = $true }
  elseif ($r.section -eq 'today') { $eligible = (Test-Workable $r) }
  elseif ($todayHolding -eq 0) { $eligible = (Test-Workable $r) }
}
```


</details>
So the board order alone is never enough. `scan` can rank a Deferred row highly and still mark it
ineligible because Today is still holding the gate. Conversely, a reply can force a row eligible
regardless of where it sits on the board. `mutcheck-priority-order.ps1`,
`mutcheck-today-served.ps1`, and `mutcheck-awaiting-reply.ps1` all assert this “ordered and gated”
shape together, because a correct comparator with the wrong eligibility rule still produces the
wrong run.

## 4. The Today → Deferred gate

The Today gate is the core of the design. It answers one question: **does any Today row still
deserve exclusive attention, so Deferred must stay shut?**

`scan` emits the answer per Today row as `holds_today_gate` and `today_release_reason`. That field
exists so the system can distinguish, for example, a row that is genuinely exhausted from one that
was only released by the wedged-run backstop. Issue **#516** exists because collapsing those cases
into one word erased important meaning.

### What marks Today as exhausted

The release signal is an explicit declaration, not a side effect of writing a turn:

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```powershell
$examined = @(($Exhausted -split '[,;\r\n\t ]+') | ForEach-Object { $_.Trim() } | Where-Object { $_.Length -gt 0 })
if ($examined.Count -eq 0) {
  throw "-Exhausted must name what was examined ..."
}
...
Set-Member $st 'today_exhausted' ([pscustomobject]@{
    at         = Now-Iso
    examined   = $examined
    note       = "$ExhaustedNote"
    today_hash = Get-TodaySectionHash
  })
```


</details>
`Set-ExhaustionDeclaration` also refuses to combine `-Exhausted` with `-Status`, `-Version`,
`-PlanId`, `-Poll*`, or `-Recheck*` in the same call, and it requires a recent `last_turn_at`.
That means: write the turn first, then declare exhaustion separately, and only for work this run
really touched.

### What opens the gate

| `today_release_reason` | Meaning | Effect |
| --- | --- | --- |
| `not_workable` | The Today row is snoozed, waiting on the user, blocked/proposed without a due override, or terminal (`done` / `skip`). | This row no longer holds Deferred shut. |
| `declared_exhausted` | A valid exhaustion declaration is still standing. | This row stays eligible and keeps its board rank, but it no longer blocks Deferred. |
| `stale_turn_backstop` | Nothing has written a turn here for the configured backstop window. | Deferred opens as a wedged-run safety valve. |

### The four cancellation paths for a standing exhaustion declaration

`mutcheck-today-served.ps1` describes the design succinctly: the four things that cancel a
standing declaration are **the clock, the human's board, a live reply, and the run's own later
turns**.

| Cancellation vector | Where it is enforced | `today_release_reason` when it blocks release |
| --- | --- | --- |
| Clock / TTL expired | `Test-ExhaustionClaim` | `holding:exhaustion_expired` |
| Human edited `## Today` | `Test-ExhaustionClaim` compares `today_hash` | `holding:exhaustion_stale_board` |
| A later turn was written on the row | `Test-ExhaustionClaim` compares `last_turn_at` to declaration time | `holding:exhaustion_superseded` |
| A live reply arrived | `Get-TodayGateVerdict` checks `reopened` before the claim | `holding:reopened` |

A fifth high-value hold exists beside those four: `holding:unanswered_user`. That is the standing
version of “reply preempts everything”: even if a hash re-snapshot hid the one-shot `reopened`
edge, an unanswered human message still reclaims exclusivity.

The full decision shape is:

- `holding:no_declaration` when nothing has been declared.
- `holding:strict` when `Today gate strict` is on.
- `holding:declaration_disabled`, `holding:declaration_named_nothing`, or
  `holding:declaration_unparseable` for malformed declaration state.
- `declared_exhausted`, `not_workable`, or `stale_turn_backstop` when the gate actually opens.

## 5. Liveness: how the gate avoids deadlock

The design has to do two opposite things at once: park rows that genuinely cannot progress, and
make sure those parked rows do not freeze the whole system.

| Mechanism | Implementation | Why it exists |
| --- | --- | --- |
| `awaiting_reply` park | `awaiting_reply = HasAgentBlock && HasBlockingAsk && !HasTrailingUser` | Turns an `in-progress` task with a real blocking ask into a waiting state, so it does not masquerade as workable. This is the fix behind issue **#487** and refined by **#560**. |
| Due poll / due recheck override | `Test-Workable` yields the park to `due_poll` / `due_recheck` | A recurring timer must not stop firing just because the user stopped replying. |
| Snooze precedence | `scan` suppresses due timers when `snoozed`, but leaves the timers armed | “Not until DATE” outranks both board rank and timers, without silently disarming the timer forever. |
| Staleness backstop | `stale_turn_backstop` based on `Today gate backstop` | A wedged Today row eventually releases Deferred instead of freezing the backlog. |
| Doc-observation freshness | `DocObservationFreshMinutes = 180` | A doc-bound task parks on comment silence only when silence was actually observed recently; stale or unread channels fail toward work, not invisible parking. This is the fix direction of **#500**. |
| Active-wake freshness | `ActiveWakeMinutes = 45` | A doc-bound task that somebody is actively working still counts as in flight, even if comments are quiet. This closes the over-dispatch side guarded by **#522**. |
| Capacity uncounts parked work | `Test-SessionHoldsCapacity` returns false for unworkable waiting tasks | A task waiting on a human reply or user pause does not consume the only dispatch slot. That closes **#487** and **#541** on the session-capacity surface. |

The key asymmetry is deliberate: when unsure, the system usually fails toward **holding** or
**refusing extra dispatch**, not toward silently widening work. That is why snooze suppresses
timers, stale wakes stop counting as active after 45 minutes, and a malformed concurrency setting
falls back to 1 instead of some guessed higher value.

### The ask is declared, not inferred (#560)

The `awaiting_reply` row above turns on `HasBlockingAsk`, and the question of *where that value
comes from* is the whole of #560. Originally it was recovered from the turn's prose by regex — so
the phrasing an agent chose while writing for a human decided whether its own task stayed
schedulable. Measured 2026-09-06, after an earlier narrowing: **2 eligible rows out of 249**, with
the skill's own boilerplate `**Your call:** reply below in plain English` present in 81 journals
and read back as blocking. The documented template was writing the sentence that starved the board.

The ask is now stated in the same act as writing the turn. `write-turn.ps1` requires
`-Ask blocking|offer|none` and stamps it into the turn as `<!-- oa-ask: VALUE -->` beneath the
turn's own provenance marker. `HasBlockingAsk` reads that declaration first, so **`blocking` parks
even when the wording opens dismissively, and `offer`/`none` do not park even when the wording
contains a blocking-shaped clause.** The preference lives inside `Get-BlockingAskVerdict`, which
`Get-JournalFacts` calls, so both the emitted `scan` row and the capacity reader inherit it from
one edit rather than two.

**The textual reading survives as a documented fallback** for turns written before the flag
existed (~81 journals at the time of the change), where the pre-#560 semantics apply exactly:
`**Your call:**` parks; a `**Needs from you:**` whose value opens dismissively (`none`/`nothing`)
does not park; and an explicitly optional remainder after the clause break does not re-create an
obligation. These are fallback-only — a declared turn never reaches them — and arms L1/L2/Q/R of
`mutcheck-awaiting-reply.ps1` still pin them.

`ask_source: declared | inferred` is emitted on every `scan` row, with the declared value itself as
`ask_declared`, so the fallback's share is a number that can be watched shrinking rather than
assumed gone. Every row reports one of the two, including rows with no agent turn (which read
`inferred`, since nothing could have declared).

A declared ask is still agent-authored, and §6 is the reason that matters. The distinction is not
*who* authors the signal but **how**: a declaration is a deliberate, structural statement made
while writing the turn, not a value reconstructed afterwards from narrative. That is the same move
`-Exhausted` made for the Today gate, and it is why both remain subject to the cancelling
conditions above rather than being trusted outright.

**The parking expression is duplicated on purpose.** `Cmd-Scan` (which emits `awaiting_reply` on
the worklist row) and `Test-SessionHoldsCapacity` (which gates whether that row's session counts
against the concurrency ceiling) each compute `$facts.HasAgentBlock -and $facts.HasBlockingAsk -and
-not $facts.HasTrailingUser` independently, and the source keeps the two copies **textually
identical** rather than factoring them into one shared function. The declared-ask preference
itself lives once, inside `Get-BlockingAskVerdict` (called by `Get-JournalFacts`, which both
readers call), so a `#560` declaration reaches both readers from one edit. But had that resolution
happened inside `Cmd-Scan` instead, the emitted row would say `declared` while
`Test-SessionHoldsCapacity` kept inferring from prose — **#545's "emitted field disagrees with
gated field" shape**, on the exact reader pair the design calls out as needing to stay
synchronized. Textual duplication, checked by review and by `mutcheck-awaiting-reply.ps1` rather
than hidden behind an abstraction, is the guard against the two readers drifting apart again.

`has_open_ask` is unchanged in the non-regressing direction by all of this: a declaration only ever
adds visibility onto a row that already had an open ask under the old inference; it never manufactures
an ask that was not there, and `mutcheck-declared-ask.ps1` pins that direction explicitly.

**Grounding.** `mutcheck-declared-ask.ps1` pins that a declaration outranks the prose in *both*
directions, that an undeclared turn still reads exactly as it did before, that `ask_source` is
honest, and that `has_open_ask` does not regress. It drives the real `oa-state.ps1` and the real
`write-turn.ps1`, mutating those files rather than a re-implementation of their logic.

## 6. The recurring failure class: the agent authoring the signal its own gate reads

This page's design exists to avoid one recurrent bug class: the agent writes a signal and then
later trusts that signal as if it came from the user or from the world.

The repository has already hit that class in several forms:

- a consent surface that could be satisfied by text on a multi-writer journal;
- the `awaiting_reply` ratchet, where the agent's own polite closing language parked its own task;
- a Today-gate release keyed to `last_turn_at`, so writing any turn opened Deferred;
- a wake token (`last_woken_at`) whose author mattered, the defect behind issue **#514**.

The guard pattern is consistent across all of them:

- **standing permissions move to a one-way human-authored file** (`agent-gate.md`),
- **replies are read from human provenance or structural position**, not from the agent's own
  summary of what happened,
- **Today release comes from a separate declaration plus human-controlled invalidations**,
- **capacity trusts user-originated pauses more than agent-originated claims of completion**, and
- **dispatch exceptions are justified by provenance**: a user action may widen the run; the
  agent's own judgement may not.

That is the causal logic behind the whole page. The system is not merely ranking tasks; it is
choosing which signals are allowed to carry authority.

## 7. Pacing and dispatch

Pacing and ordering are related but different. Ordering answers *which row is next*; pacing answers
*how much work may this run take on before the next scheduled run arrives*.

### Enforced mechanism: the concurrency ceiling

`user-settings.md` exposes `Overnight Agent concurrency`, defaulting to `1`. `oa-state.ps1`
resolves it itself, not by trusting the caller to remember a flag. The capacity view is emitted by
`session -InFlight`:

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```powershell
return ([pscustomobject]@{
    concurrency = [int]$script:ConcurrencyLimit
    concurrency_source = "$script:ConcurrencySource"
    in_flight   = [int]$live
    at_capacity = [bool]($live -ge $script:ConcurrencyLimit)
    admits      = [int][Math]::Max(0, $script:ConcurrencyLimit - $live)
  } | ConvertTo-Json -Depth 4)
```


</details>
`mutcheck-pacing-concurrency.ps1` proves the resolver's sharp edges: the setting must be a **bare
whole number**, an explicit `-Concurrency` argument outranks the file, malformed prose reports
`concurrency_source: settings-malformed`, and every failure narrows to `1` rather than widening the
run. That is the executable part of issue **#391**.

### Guidance, not yet a full mechanism

The rest of pacing still lives in `plugins/overnight-agent/skills/overnight-agent/SKILL.md` as
run-loop doctrine, and issue **#391** tracks that gap explicitly. The three rules are:

1. one item in flight by default;
2. estimate before starting another, using the rate observed this run against the time left before
   the next scheduled run;
3. done means **verified and published**, not code merely written.

The concurrency ceiling is enforced today. The broader “should this run spend its remaining admits
on another item?” rule is still guidance, not a fully enforced mechanism. That is why this page has
to say both things at once: the system already has a real cap, but it does not yet mechanically
prove that every additional admitted item can be finished, verified, and published before the next
wake.

`plugins/overnight-agent/checks/mutcheck-deliverable-gate.mjs` and
`plugins/overnight-agent/checks/deliverable-gate-sweep.mjs` are relevant here because they guard
the meaning of “done”: a stale reversible offer inside a deliverable does not count as live work if
the live journal already says that verb family was delivered, and a task written today or already
terminal is suppressed rather than re-flagged as if unfinished.

### Dispatch precedence: collect first, then execute in two waves

The run session does **not** do task work. Issue **#404** is the concrete reason: without per-task
sessions and workspaces, the overnight run accumulates every task's context and edits in one place,
and the next run cold-starts anyway.

Within that isolated design, issue **#405** fixes the precedence rule for wakes discovered during
collection:

1. **COLLECT** gathers inbox messages, folded Telegram replies, doc-comment observations, and the
   `scan` worklist.
2. **EXECUTE** dispatches work.
3. Dispatch happens in **two waves**: the **priority wave** first, then the **collect wave**.
4. A collect-phase wake is dispatched **in addition to** the priority selection, not instead of it.

The sanctioned exception is encoded in the session-capacity refusal text itself:

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```powershell
throw ("session_at_capacity: ... -Force is for the collect-wave exception only " +
  '(Prioritisation.md 4.1): a wake that exists because the USER did something may widen ' +
  "the run; the agent's own judgement may not.")
```


</details>
That exception does **not** raise the configured setting, compound it, or move work back into the
run session. It changes **when** a task is woken, not **where** its work happens. The rationale is
provenance: a mail reply, a Telegram reply, or a journal reply is explicit user action, so it may
widen the run once. The agent's own belief that “this seems urgent” does not get the same power.

The executable statement of intended behaviour for this page is therefore spread across a small,
important set of files:

- `plugins/overnight-agent/skills/overnight-agent/oa-state.ps1`
- `plugins/overnight-agent/skills/overnight-agent/mutcheck-priority-order.ps1`
- `plugins/overnight-agent/skills/overnight-agent/mutcheck-today-served.ps1`
- `plugins/overnight-agent/skills/overnight-agent/mutcheck-awaiting-reply.ps1`
- `plugins/overnight-agent/skills/overnight-agent/mutcheck-pacing-concurrency.ps1`
- `plugins/overnight-agent/checks/mutcheck-deliverable-gate.mjs`
- `plugins/overnight-agent/checks/deliverable-gate-sweep.mjs`

Together they define prioritisation as the product actually behaves: board order, reply interrupts,
Today gating, liveness, capacity, and the one provenance-based exception to the default one-item
isolation model.
