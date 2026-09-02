# Prioritisation

Prioritisation in Focus Planner is a **contract between three parties**: the board states what
matters, the user changes the board, and the Overnight Agent reads the board and works it in the
order the board implies. The contract has one governing rule, and every mechanism on this page
exists to protect it:

> **Selection order is data, not the agent's judgement.** Two runs over an unchanged board, an
> unchanged set of journals and unchanged agent state must produce the same order, and that order
> must be auditable after the fact without re-deriving anything.

The agent therefore never decides *what to work on next*. It asks
`plugins/overnight-agent/skills/overnight-agent/oa-state.ps1 scan`, which joins the board onto the
journals, sorts the result by a fixed key, and marks each row `eligible` or not. The agent's only
discretion is *how* to do the work on a row it was handed. Before this split existed, `scan` emitted
rows in task-id order and "Today first" lived only as prose in `SKILL.md` — advice to a model rather
than a mechanism.

See [Data-Formats](Data-Formats) for the board and journal file formats this page assumes,
[Domain-overnight-agent](Domain-overnight-agent) for the agent plugin as a whole, and
[Domain-app](Domain-app) for the React editor the user drives the board from.

---

## 1. How priority is expressed

All priority is expressed **in `planner.md`**, in five independent signals, plus the task id as a
final tiebreak. Nothing about priority lives in the agent's own state store; the agent's state
(`%LOCALAPPDATA%\overnight-agent\state\task-<id>.json`) records only what it has *done*.

| Signal | Where it lives | Read by |
| --- | --- | --- |
| **Section** | The `## Today` / `## Deferred` headings; anything else is `other` | `Get-BoardMap` |
| **Urgency icon** | Column 2 of the row (🔴 / 🟡 / 📖 / ⚪ …) | `Get-UrgencyRank` |
| **Work Priority** | Column 4 of the row, matched against `^P[0-9]$` | `Get-BoardMap` |
| **`## Priorities` list** | An ordered list of bare task ids at the foot of the board | `Get-PrioritiesRank` |
| **Board row order** | The physical order of rows within the file | `Get-BoardMap` (`board_pos`) |
| **Task id** | Column 1 | `Get-BoardRowId` |

```markdown
## Today

| ID | 🎯 | Task | Work Priority | Added | Linked ID |
|----|----|------|---------------|-------|-----------|
| 730 | 🔴 | Ship the release notes | P0 | 2026-08-30 |  |
| 710 | 🔴 | Fix the failing deploy  | P1 | 2026-08-30 |  |

## Deferred

| ID | 🎯 | Task | Work Priority | Added | Wake | Linked ID |
|----|----|------|---------------|-------|------|-----------|
| 740 | 🔴 | Rewrite the importer | P0 | 2026-08-30 | | |

## Priorities

1. 730
2. 710
```

### The board reader is positional, deliberately

`Get-BoardMap` takes the urgency from cell 1 and the Work Priority from cell 3 (zero-based) rather
than looking the columns up by header name. That is what lets the two tables share one reader:
`Today` is `ID | urgency | Task | Work Priority | Added | Linked ID`, and `Deferred` inserts a
`Wake` column *before* `Linked ID`, so the first four cells line up in both.

Two consequences a rebuilder must reproduce:

- **The id cell is parsed as "leading digits", not "digits only".** The ID column may carry external
  references after the id — `| 448,[176](https://github.com/owner/repo/issues/176) | 🔴 | … |`. A
  reader that requires the whole cell to be an integer silently drops such a row from the board map,
  and a dropped row is invisible to every downstream consumer at once. Because the board map is the
  Today→Deferred gate's only input, a board whose single `Today` row used the compound form produced
  *no* `Today` rows, which is indistinguishable downstream from "Today is finished": the gate stood
  permanently open and the one 🔴 Today task sorted behind all 121 Deferred rows. Guarded by
  `mutcheck-board-compound-id.ps1`.
- **The board must be decoded as UTF-8 explicitly.** The urgency cell is an emoji, and these files
  are BOM-less; a host-default read under Windows PowerShell 5.1 decodes them as the ANSI codepage,
  every icon arrives as mojibake, and every row ranks as "unknown urgency" — a total loss of one
  sort key with no error anywhere. For the same reason the icons in the script are built from
  codepoints (`[char]::ConvertFromUtf32(0x1F534)`) and never written as literals.

### The sort key, in order

`Cmd-Scan` sorts every row by these seven expressions, in this order:

```powershell
1. reopened first        # a live reply preempts everything
2. Get-SectionRank       # today = 0, deferred = 1, other = 2
3. Get-PriorityRank      # P0=0 … P9=9, unset = 9
4. Get-UrgencyRank       # red=0, yellow=1, book=2, white=3, anything else = 4
5. priorities_rank       # position in the `## Priorities` list, else 999999
6. board_pos             # physical row order in planner.md
7. [int]$_.id            # last-resort total order, so the sort is never unstable
```

Task id is present purely to make the ordering **total**: without it two otherwise-equal rows could
swap between runs, and "two runs agree" would be false. `Get-UrgencyRank` ranks four icons and files
everything else (including a blank cell) at 4, so an icon the table does not name contributes nothing
rather than sorting unpredictably.

Determinism is a property of the *whole* input, not of the board alone. `reopened` is the first sort
key and is computed by comparing the journal's hash against `processed_file_hash` in the agent's own
state, so a reply reorders rows without `planner.md` changing — and so does a `mark`, which
re-snapshots that hash without touching the journal. What must not vary is the order produced from
an identical board, journal set **and** state.

### The board has two readers with different sort keys

This is a real and intentional split, and a rebuilder who assumes one sort will get the other wrong:

- **The app's display sort** (`src/taskSort.js`, `sortTasksByPriority`) ranks 🔴 first, then
  manager-priority order resolved transitively through the `Linked ID` chain
  (`resolveManagerPriority`), then chain depth, then the icon.
- **The agent's selection sort** is the seven-key list above.

Both readers resolve a `## Priorities` entry **by bare task id**, and neither matches free text.
`Get-PrioritiesRank` matches only `^\s*\d+\.\s+(\d+)\s*$`, so a non-numeric entry is skipped
outright. `parseManagerPriorities` is laxer — it accepts any list-item text as a map key — but every
lookup against that map (`resolveManagerPriority`, and the app's own `managerPriorities[taskId]`
checks) is keyed by a task id, so a text entry can never match a row either. It is not inert,
though: it still consumes an ordinal and therefore shifts the rank of every entry below it in the
app's numbering. The app writes and removes entries as bare ids, so this only arises when a human
hand-edits the list.

Neither reader is authoritative over the other, because they answer different questions — "what
should the human look at" versus "what may the run touch".

---

## 2. How the user interfaces with prioritisation

The user has four channels. Three of them are files the agent may read but must not treat as its
own, and one — the gate — is a file the agent must never write at all.

### 2.1 The board

Editing `planner.md` is the primary act. It can be done in any text editor, or through the planner
web app, whose board mutations are pure functions in `src/focusPlanOps.js`: `opMoveBetweenSections`
(Today ⇄ Deferred), `opChangePriority` (the urgency icon), `opUpdateManagerPriorities` /
`opPromoteToManagerPriority` / `opRemoveFromManagerPriority` (the `## Priorities` list),
`opAddAndPrioritize`, and `opSnoozeTask`. Every one of them rewrites markdown
and nothing else, which is what keeps "edit the file directly" and "use the app" the same act.

The agent is correspondingly **conservative** about the board: while a task is in progress it must
not rewrite the row, must not reinterpret the user's urgency icons, and must never move a row to the
completed board — completion is the user's action in the app, and the agent records `done` in its
own state instead. The board is the user's instrument; the agent reads it and writes journals.

### 2.2 A reply in a task journal — `reopened`, which preempts everything

Appending prose below the agent's last turn in `journal/task-<id>.md` reopens the task. `scan`
reports `reopened: true` when the journal's hash differs from `processed_file_hash` *and* there is
user content trailing the agent's block. A reopened row sorts **first, above every other key**, and
is eligible regardless of the Today→Deferred gate. It also cancels a standing exhaustion declaration
on that row (`holding:reopened`), because a live reply is a change to the thing the declaration was
a claim about.

This reader **fails open**: unmarked prose below the turn boundary counts as the human. That default
is correct here — losing a user's message is worse than one extra look — and it is exactly wrong as
a *consent* boundary, which is why consent is a separate, fail-closed reader (`Test-TrailingHasUser`
versus `Test-TrailingHasConsent`). Reopening a task is reversible; acting on a forged approval is
not.

### 2.3 Snoozing — "not until this date"

A snooze is the user's explicit "not now", and it **outranks everything the agent computes**: a
snoozed row is never workable, never eligible, and reports `due_poll: false` / `due_recheck: false`
however overdue those timers are. The timer object itself is left armed, so it fires on its own once
the snooze lapses — snoozing does not silently disarm a poll.

**`snooze.json` is the snooze store.** It is a flat `{ "<task id>": "YYYY-MM-DD" }` map (optionally
wrapped in `tasks` or `snoozed`, and tolerating `{ "until": … }` values), owned by the web app and
**read-only** to the agent. It is typed, tiny, and does not ride on `planner.md` — the most
sync-conflicted and most human-edited file in the folder — which is why the snooze state lives in
its own file rather than in board prose.

A malformed store returns "no store" rather than an empty map, so a parse failure can never be read
as "nothing is snoozed". A date counts as snoozed while it is today or later, so the agent holds off
*through* the snooze date.

> The current implementation also still reads `<!-- snooze:YYYY-MM-DD -->` HTML-comment markers off
> board rows, and `Get-SnoozeMap` unions the two with the store winning. That reader is a transitional
> shim, not part of this specification: **a rebuild implements the store only.** Its removal is
> tracked by #207. It is recorded here solely because it is live in the code today, and one property
> of it is worth carrying as a lesson — the comment wrapper was required, because a task whose
> *title* contained `snooze:` would otherwise match its own title and hide itself from the board.
> Encoding state in prose invites exactly that collision, which is the reason the store exists.

**The `Wake` column is a third representation that the agent does not read, and this is a real gap.**
The app's snooze path is `opSnoozeTask`: a `Today` row is moved to `Deferred` carrying a `wakeUntil`
date, and a row already in `Deferred` is stamped in place with a `Wake` date (`src/snooze.js` owns
the cell format). `Get-SnoozeMap` reads neither the `Wake` column nor the `Deferred` table's dates,
so the row reports `snoozed: false`. Once no `Today` row holds the gate, that row **can become
eligible before its wake date** — being in `Deferred` deprioritises it but does not protect it; only
`Test-Workable` still applies, so it is spared merely by being terminal or waiting on the user, which
is unrelated to the snooze the user asked for. A rebuilder must close this: either write
`snooze.json` from the app, or teach `Get-SnoozeMap` the `Wake` column. Do not assume the three
representations agree. Tracked as #343.

### 2.4 `agent-gate.md` — the standing-permission channel, and why one-way matters

The gate is the user's standing answer to "when may you act without asking me". It holds two lists:

```markdown
## Do not gate these (reversible)

- Creating and publishing a pull request in any repository … do not gate it.

## Always ask (safety floor)

- Send-to-many (group/channel, mass email)
```

Order is load-bearing: the **floor is checked first** and overrides everything below it, including
an allow rule *and* a human approval typed in a journal; then the allow list; then control falls
through to the journal consent reader completely unchanged. Matching is deterministic, not
interpretive — `-Action` is a closed enum, and the verdict reports the verbatim rule that decided it
so a human can audit it.

**The property that makes the gate trustworthy is that the agent only ever reads it.** Journal prose
needs an attribution marker because the journal is a multi-writer surface the agent itself writes
into; text in `agent-gate.md` needs no marker at all, because the agent could not have put it there.
The file is seeded by the app (`src/config/agentGate.js`, edited via `src/AgentGateEditor.jsx`) only
when absent or blank, and never version-refreshed the way `AGENTS.md` is — rewriting a file whose
whole value is "the user wrote this" would destroy the thing that makes it worth reading.

That one-way property is currently **true and asserted by nothing** (issue #326), which is precisely
the kind of load-bearing invariant that should be a check rather than a comment.

A gate verdict is deliberately narrow: it answers *"am I authorised?"*, never *"should I?"*. When a
rule matches, the verdict short-circuits the journal's **consent evaluation** in both directions — a
floor rule outranks a human `approve` typed into the journal, and an allow rule is a standing
permission that by definition does not need re-granting per task. A standing permission any stray
sentence could cancel would not be standing, and the revocation channel is the file the user owns.
The journal is still *read* on that path: `consent` reports `trailing_has_user` alongside a
`gate-allowed` verdict, precisely so a caller can distinguish "nobody has said anything" from "he
replied ninety seconds ago" — and `SKILL.md` requires a fresh human "don't" to stop the run whatever
the verdict says. That flag means *someone may be waiting*, never *he refused*; collapsing the two
would let stray unattributed prose silently revoke a permission the user actually granted. Issue #302
tracks making a wrapper act on it.

### 2.5 `user-settings.md` — the tunables the user owns

Under `## Overnight Agent behaviour`:

| Setting | Value | Effect |
| --- | --- | --- |
| `Today gate backstop` | `6h` (default `6`; accepts `6`, `6h`, `off`) | How long a `Today` row may sit with no turn written to it before the backlog is released past it. |
| `Today gate strict` | `off` (accepts `on`/`yes`/`true`) | The one-switch rollback: a workable `Today` row gates forever, with no release path at all. |
| `Overnight Agent concurrency` | `1` (default `1`; any integer ≥ 1) | How many worklist items a run may hold in flight at once. At `1` — the default — one item at a time: isolation, not concurrency. Read by the run loop, not `oa-state.ps1`; described under §4, Pacing. Tracked by #391. |

These tunables are read **where they are used** — the gate tunables by `oa-state.ps1`, and the
concurrency limit by the run loop — not passed as flags by the agent. That is deliberate
and is the single most transferable lesson in this area: a forgotten *path* argument fails loudly —
the journal folder is not found and the run stops — but a forgotten *number* fails **silently** on
the built-in default while the run looks entirely normal. Reading the setting where it is used
removes the thing that can be forgotten.

Precedence is: an explicit command-line parameter, then the settings row, then the built-in default
(`BackstopHours = 6`, `Strict = false`). An absent, unreadable, empty or malformed settings file
yields the built-in defaults **exactly** — a settings file may change a value already in service, but
must never be the reason the gate stops working. `Today gate backstop` accepts `off`, `none` or
`disabled` to disable the backstop, and otherwise reads the value's **leading digits** as hours (so
`6`, `6h` and `6 hours` are all six); a value with no leading digit and no disable word is ignored
rather than guessed at, because a typo must not silently disable a safety backstop. `Today gate
strict` is on for `on`, `yes` or `true` and off otherwise. `scan` echoes the values that were
actually in force onto every `Today` row as `gate_backstop_hours` and `gate_strict`, so a configured
value that is not applying is visible rather than silent.

The rollback switch is `-TodayGateStrict`. (The current implementation also honours a retired
`-TodayServedMinutes 0` spelling for the same effect; it is a deprecated alias scheduled for removal
under #207, and a rebuild implements only `-TodayGateStrict`.)

The exhaustion TTL is deliberately **not** exposed, because it currently governs two different
things at once — how long a declaration survives, and how recently a turn must have been written to
make one — so raising it would let one run declare itself finished on the strength of a previous
run's work. Issue #330 tracks splitting it, and also records that the 30-minute default is sized
against the *schedule* interval rather than against run *duration*, which by that issue's
measurements regularly exceeds it.

---

## 3. How the agent interfaces with prioritisation

### 3.1 `scan` is the worklist, and `eligible` is binding

Every run begins with one `scan`. Its output is a JSON array, already sorted, one object per journal:

```jsonc
{
  "id": "730",
  "status": "in-progress",
  "reopened": false,
  "snoozed": false,
  "section": "today",
  "urgency": "🔴",
  "work_priority": "P0",
  "board_pos": 1,
  "priorities_rank": 0,
  "due_poll": false,
  "due_recheck": false,
  "awaiting_reply": false,
  "has_open_ask": true,
  "consent_ok": false,
  "last_turn_at": "2026-08-31T22:20:14-07:00",
  "exhaustion": null,

  "order": 1,                              // rank this run
  "eligible": true,                        // ← the only field that grants permission
  "holds_today_gate": true,                // does this row keep Deferred shut?
  "today_release_reason": "holding:no_declaration",
  "gate_backstop_hours": 6,                // resolved settings, Today rows only
  "gate_strict": false
}
```

**The agent must never work a row with `eligible: false`.** Eligibility is computed after the sort,
from the whole set:

```powershell
$eligible = $false
if (-not $r.snoozed) {
  if     ($r.reopened)          { $eligible = $true }               # a live reply beats the gate
  elseif ($r.section -eq 'today') { $eligible = (Test-Workable $r) }
  elseif ($todayHolding -eq 0)  { $eligible = (Test-Workable $r) }  # Deferred waits on the gate
}
```

`Test-Workable` answers "could the run actually do something with this row": snoozed is never
workable; `reopened` always is; a row parked on `awaiting_reply` is not, unless a poll or recheck is
due; a due recheck on a `blocked` row is workable; otherwise `done`, `skip`, `proposed` and `blocked`
are not. `done` and `skip` are never yielded by any branch, so a timer can never reopen a closed task
— issue #170 covers the case where the agent writes into an already-closed task by another route.

### 3.2 The Today→Deferred gate, and what releases it

Rule 1 of the ordering design is *Today before Deferred*: a Deferred row is ineligible while any
`Today` row still **holds the gate**. "Holds the gate" is narrower than "is workable", and the only
hard question in this whole system is what releases it.

**This has been answered wrongly twice, in opposite directions.** Both readings are recorded here,
in the code, and in `mutcheck-today-served.ps1`, because the current design is only defensible as the
thing that satisfies both at once.

| Release keyed to | What goes wrong | Measured |
| --- | --- | --- |
| **Workability** | Never opens for an unbounded row. A single standing meta-task ("triage, fix and ship GitHub issues") is `in-progress` and workable *forever*, so it holds the whole backlog shut on every run. | 1 eligible row out of 238; 121 Deferred rows frozen; three runs in one night each re-worked that one task and touched nothing else. |
| **Recency** | Opens the moment the agent *types*. `mark` stamps `last_turn_at` on every turn, so one turn — any content, at any completion state — released the entire backlog for the rest of the run. This was GitHub issue 310. | After one turn on a row that was still `in-progress` with four criticals unworked, eligibility went 1 → 13 and the run moved to a Deferred-adjacent task at order 181. |

The correction: **the gate releases on a declared exhaustion**, and exhaustion is an affirmative
declaration the run makes on purpose, in its own call, naming what it examined:

```powershell
oa-state.ps1 mark -Id 463 -Status in-progress                    # 1. write the turn (releases nothing)
oa-state.ps1 mark -Id 463 -Exhausted 'gh:197,gh:179,gh:139' `    # 2. then declare, separately
                          -ExhaustedNote 'all three blocked on review'
```

The shape of that call is the whole design. `-Exhausted` **cannot** be combined with
`-Status`/`-Version`/`-PlanId` or any timer flag, so releasing the gate can never ride along on the
act of writing a turn. It **must name at least one examined item**, because a claim that names no set
asserts nothing and would be a shrug carrying the authority of a decision. It **must follow recent
work** — there must be a `last_turn_at` within `-ExhaustionTtlMinutes` — so a row nothing has touched
lately cannot be declared. And it **does not touch the journal**: no turn boundary, no re-snapshot,
no `last_turn_at`, so a declaration can neither absorb a reply that arrived meanwhile nor refute
itself.

**"This run" is an approximation, not an identity.** No run id is stored or compared: both the
precondition above and the expiry below are pure timestamp arithmetic against
`-ExhaustionTtlMinutes` (default 30). The intent is that a declaration covers the run that made it
and the next run looks again, and the TTL stands in for a run boundary. Issue #330 records that the
substitution is unsound in both directions — a run longer than the TTL sees its own declaration
expire mid-run (fail-closed), and simply raising the number would let one run declare on a previous
run's work (fail-open) — which is why the remedy is to split the parameter rather than retune it.

A declaration is a **claim, not a latch**. Four things cancel it:

| `today_release_reason` | Meaning |
| --- | --- |
| `not_workable` | Terminal (`done`/`skip`) or waiting on the user (`proposed`, `blocked`, `awaiting_reply`, snoozed). Snooze is absolute; a due poll **or** recheck lifts `awaiting_reply`, and a due recheck alone lifts `blocked` (see 3.3). Does not hold, and never did. |
| `declared_exhausted` | A standing declaration. The row stays *eligible* at its own rank but stops monopolising the run. |
| `stale_turn_backstop` | Nobody has written a turn here for `Today gate backstop` hours: the run is wedged, so the backlog is released rather than frozen behind it. |
| `holding:reopened` | A live reply reclaimed exclusivity. |
| `holding:strict` | `Today gate strict` is on; there is no release path. |
| `holding:exhaustion_expired` | Older than the TTL. A declaration is *intended* to cover one run, so the next run must look again. |
| `holding:exhaustion_stale_board` | The `## Today` section has changed since the claim. The human revokes it simply by editing the board. |
| `holding:exhaustion_superseded` | A turn was written to this row *after* the declaration. Writing more work on a row you just called exhausted refutes the claim by the run's own record. |
| `holding:declaration_named_nothing` | The claim names no examined item. |
| `holding:no_declaration`, `holding:declaration_disabled`, `holding:declaration_unparseable` | No standing claim to evaluate. |

Three properties follow, and a rebuilder should treat them as requirements rather than incidentals:

1. **Writing is necessary but not sufficient.** You cannot declare a row nothing has touched
   recently, and a turn written after a declaration cancels it. Typing can therefore only ever make
   the gate hold *longer* — the exact inversion of the defect. Three of the four cancellations are
   state the agent does not author (the clock, the board's `## Today` section, a live reply); the
   fourth, `exhaustion_superseded`, *is* agent-authored, but it can only ever **cancel** a release,
   never cause one, so it cannot be exploited in the unsafe direction. The comparison is strictly
   `>` on stamps of one-second resolution, so "after" means *strictly* after: a turn recorded in the
   same second as the declaration does not refute it, which is what stops a declaration made
   immediately after its own turn from cancelling itself.
2. **The backstop is keyed to staleness, never recency.** It fires because the agent has *not*
   written, and any turn resets it. There is no path from typing to a release. A row the agent has
   never worked (`last_turn_at` absent) is exempt and keeps gating, because "never touched" is the
   state that most deserves the run's attention. Issue #261 is the complementary failure at the
   scheduler level: a stuck run with no run-level timeout.
3. **Releasing exclusivity must not cost ordering.** A declared row keeps its rank and stays
   eligible, so the run never abandons its own top-priority task; only the monopoly lapses. Every
   branch that is unsure **holds**, so an unknown or unparseable input preserves Today-first
   exclusivity rather than opening the backlog by accident.

`Test-ExhaustionClaim` returns `declared_exhausted` or a `holding:<why-not>` string, and that string
becomes the row's `today_release_reason` — except that a failed claim is still tested against the
backstop, so a row whose claim expired *and* whose last turn is older than the backstop window
reports `stale_turn_backstop` rather than the `holding:` string. Three verdicts never reach the claim
logic at all: `not_workable` short-circuits ahead of it, and `holding:reopened` and `holding:strict`
are decided before it.

Deferred work is legitimate in exactly two situations: a Deferred row that is itself `reopened`
(rule 4 preempts the gate outright), or — for every other Deferred row — *every* `Today` row's
verdict having `holds = false`, whether by `not_workable`, `declared_exhausted` or
`stale_turn_backstop`, with the Deferred row itself still workable. What `today_release_reason`
makes checkable is that some such reason is recorded for each Today row: a run that touched a
non-reopened Deferred row while a Today row still reads `holding:…` skipped work it was not
permitted to skip.

### 3.3 Liveness — the mechanisms that stop work stalling

A gate that is too eager starves the backlog; a board that never re-surfaces a task starves the
task. Four mechanisms keep work moving, and they are ordered against each other deliberately.

- **`awaiting_reply` parking.** `awaiting_reply` is true when the agent spoke last, its newest turn
  still carries a blocking ask, and no user prose follows. Such a row is *not workable*: it gets
  neither a stacked turn nor the right to hold the gate. Without it, one unanswered Today row froze
  the whole backlog — measured at 55 workable Deferred rows made ineligible by a single row. What
  un-parks it: a reply (`reopened`), or a due poll/recheck.
- **The ask reader is deliberately narrow.** `has_open_ask` feeds the Telegram digest, whose job is
  *visibility*, so it reads generously. The gate's job is the opposite: a false positive parks a task
  the agent could have worked. Feeding the generous reading into the gate turned it into a
  **ratchet**, because the agent writes the text the gate reads and it ends nearly every turn with a
  courtesy offer — so every turn parked its own task and only a human could release it. Measured:
  186 of 238 rows parked, every other row terminal, zero eligible rows anywhere. A
  `**Needs from you:**` whose value opens dismissively (`none`, `nothing`, `n/a`, `no`, …) no longer
  parks; a non-dismissive one, and a bare `**Your call:**`, still do. Both markers are matched only
  in their bold form, at the start of a line, and only within the **newest** agent turn — an ask
  answered three turns ago must not park the task forever. Guarded by `mutcheck-awaiting-reply.ps1`.
- **Polls and rechecks — timers for work no reply will ever trigger.** `scan` only flags journals the
  *user* touched, so a recurring duty ("check the drop folder daily") is invisible to it and stops
  silently the moment the user stops replying. `-Poll <cadence>` arms a timer in the agent's own
  state (never in the journal, so the user sees nothing), and the run acts on any row with
  `due_poll: true` and calls `mark -PollDone` to re-arm. A `blocked` task has the same invisibility
  for a worse reason — it waits on a *prerequisite*, so nothing will ever change its journal — and
  `-Recheck` aims the same machinery at the blocker. Cadence grammar is
  `hourly | daily | weekly | <N>h | <N>d | <N>m`; a freshly armed timer is due immediately, and a
  timer with no `next_due` is treated as due. `-Recheck` is *documented* as being for a blocked
  task's blocker, and `Test-Workable`'s bypass is written on that assumption, but nothing enforces
  it: `mark -Recheck` never inspects status, so a recheck armed on a task that later goes `done`
  stays armed and simply never earns the bypass. Only machine-checkable blockers should be armed (a
  token that may have been renewed, CI that may have gone green); a blocker needing a human decision
  stays a question. A due recheck grants no new permission — it is a read-only look.
  `mutcheck-blocked-recheck.ps1` guards it.
- **Precedence between them.** A due poll or recheck **outranks** the `awaiting_reply` park, because
  a timer is read-only agent work that needs no reply and must not be silenced by waiting on the
  user. A due recheck also yields the `blocked` *status* gate — without that, the timer fired
  correctly and the verdict was discarded one line later, making the whole feature inert. **Snooze
  outranks both timers**, because it is the user's explicit instruction and the user always wins.

### 3.4 The recurring failure classes, and the design rules they produce

One failure has occurred three times in this system, in three unrelated readers:

| Instance | The self-authored signal |
| --- | --- |
| Consent (GitHub issues 227 and 272) | The agent's own unmarked prose in a journal read back as the human's approval. |
| The `awaiting_reply` ratchet | The agent's closing courtesy line parked its own task, so every turn made the board strictly less workable. |
| The Today gate (GitHub issue 310) | `last_turn_at`, stamped by the agent's own `mark`, released the agent's own gate. |

Each reader was correct in isolation and wrong because the thing it read was agent-authored. **A gate
whose release signal the agent writes is not a gate.** That produces the first three rules below; the
fourth is a second, cross-cutting class, and it is the one that lets the others go unnoticed. A
rebuilder should apply all four to any new gate before shipping it:

1. **Prefer a signal derived from state the agent cannot author** — the clock, the user's board, the
   user's reply, a file the agent only reads. Three of the four things that cancel an exhaustion
   declaration are of exactly this kind, and `agent-gate.md` is trusted for exactly this reason.
   Where an agent-authored signal is unavoidable, admit it only in the **safe direction**: a later
   turn is agent-authored, and it can only ever cancel a release, never grant one.
2. **Where that is impossible, make the claim specific, expiring and self-refuting.** The exhaustion
   declaration must name what it examined (specific), expires on a TTL that stands in for a run
   boundary (expiring), and is cancelled by the run's own later turns on the row (self-refuting).
   That is what makes it cheap to make honestly and awkward to make falsely.
3. **Assert the consequence, not the signal.** Both the recheck bug and the parking bug survived
   because a check asserted that a signal was computed (`due_recheck: true`) and never that it had an
   effect (`eligible: true`). A fired-and-ignored timer reads as healthy.
4. **A reader must be able to tell "absent" from "present but unreadable."** This is the rule the
   other three depend on, because it is the mechanism by which a violation of any of them stays
   invisible. Every hazard on this page has the same anatomy: the failure does not produce an
   *invalid* value, it produces a *valid* one that is wrong, and every consumer downstream then
   behaves correctly on a lie.

   | Unreadable input | Decodes to | Which is indistinguishable from |
   | --- | --- | --- |
   | A compound ID cell (`448,[176](…)`) the row parser rejects | no `Today` rows | "Today is finished" — gate wide open |
   | A board read with the host's default decoder | every urgency icon "unknown" | "the user set no icons" |
   | A `Wake`-column snooze (#343) | `snoozed: false` | "the user never snoozed it" |
   | A `## Priorities` entry that is not a bare id | no rank | "this task is not prioritised" |
   | A malformed `snooze.json` read as `@{}` | nothing snoozed | "the user unsnoozed everything" |

   Only the `snooze.json` case is defended by making the distinction *representable*:
   `Get-SnoozeFromStore` returns `$null` for a parse failure and an empty map for an empty store, so
   the caller can tell "no store" from "nothing snoozed" and falls back to the markers instead of
   acting. The first two were instead fixed by removing the misread at source — teaching the row
   parser the real ID format, and decoding the board as UTF-8 explicitly — which works but leaves
   the next misread of the same shape undefended. The fourth is by design rather than a defect. The
   design test is: **does this failure yield an invalid value, or a valid one that is wrong?** The
   first is caught by any check. The second is caught only by asking, deliberately and in advance,
   whether the reader can tell missing from unparsed — because by construction nothing downstream
   will ever raise it.

   [Reliability](Reliability) carries this same rule as its own fourth principle, reached from the
   supervision side: age-only stuck detection, which collapsed "working hard" and "hung" into one
   observable, is this hazard exactly. The two pages are halves of one discipline — *the observer
   must not be inside the thing it observes*. This page applies it to **who wrote the signal** a
   gate reads; that one applies it to **who watches the watcher**.

This is a narrowing of the hole, not a closure of it, and the spec should say so: **nothing verifies
the *content* of a declaration.** A run can name three items it never looked at, and `oa-state.ps1`
cannot tell — it has no way to see GitHub. The guard is on the *shape* of the claim, never on its
truth. Issue #322 tracks verifying exhaustion against a drained queue instead of taking the run's
word for it; issue #250 tracks the same residual one level down, where consent still rests on a
marker the agent's own software writes.

---

## 4. Pacing — how much of the worklist a run takes on

Selection order answers *what to work on next*; it does not answer *how much*. A scheduled run is
bounded twice over — by the context window it may spend, and by the wall-clock before the next
`*/30` run starts — and an ordered worklist says nothing about either. Pacing is the discipline that
keeps a run from starting more than it can finish. Where §3.3's liveness mechanisms stop a run doing
*too little*, pacing stops it committing to *too much*.

Unlike the gate, pacing is **not** a mechanism inside `oa-state.ps1`; it is run-loop guidance in
`plugins/overnight-agent/skills/overnight-agent/SKILL.md`, and issue #391 tracks encoding it there.
Three rules govern it.

- **Concurrency is a user-owned tunable, default 1.** `user-settings.md` carries an
  `Overnight Agent concurrency` value under `## Overnight Agent behaviour`; absent, unreadable or
  malformed, it is **1**. At 1 the run holds a single item in flight — **per-item sub-sessions are
  isolation, not concurrency**: one task, one workspace, one thing being verified at a time. A value
  above 1 permits more items in flight but does not make the run faster; it makes each result harder
  to verify and turns a clean pass into a tangle nobody can review. That is why the default is 1 and
  raising it is a deliberate act, not the normal case.
- **Before starting another item, estimate.** Take the rate actually observed *this run* — not an
  optimistic one — and measure it against the time left before the next scheduled run. **Starting
  what you cannot finish is worse than ending early.** An unfinished item costs a half-written branch
  and a half-true report and a reader who must work out which half is which; ending early costs
  nothing, because the worklist is data and the next run recomputes the same order unchanged.
- **Done means verified and published, not code written.** An item is finished when the change is
  proven and shipped where it takes effect — tests green, the deliverable written where the user will
  see it, the journal updated. Code that exists only in a working tree is not progress, and counting
  it as progress is how a run reports more than it delivered.

```markdown
## Overnight Agent behaviour

Overnight Agent concurrency: 1
```

Like the §2.5 tunables, the concurrency value is read where it is used rather than passed as a flag,
and the precedence is the same: an explicit argument, then the settings row, then the built-in
default of 1; an absent, unreadable or malformed value yields 1 exactly, so a typo can never widen
concurrency by accident. This is the safe direction for a pacing control — the failure of the
setting narrows a run, never widens it.

*Set by Shiv, 2026-09-02.*

---

## 5. Verification model

Prioritisation's *selection* logic has no vitest unit tests; it is guarded by **mutation checks**,
which is the right shape for it. (The app's *display* sort is separately unit-tested —
`src/taskSort.test.js` covers `sortTasksByPriority` and `resolveManagerPriority`, and
`src/snooze.test.js` covers the `Wake`/marker parsing.) Each mutation check builds a synthetic board
and journal folder, runs the *real* `oa-state.ps1` against an isolated `-JournalDir` / `-StateDir` /
`-PlannerBoard` / `-SnoozeStore`, and asserts the order and eligibility that `scan` emits.

`mutcheck-today-served.ps1` additionally pins `-UserSettings` at a sandbox file, and must: two of the
gate's tunables are read from `user-settings.md` by the script under test, and the resolver's
production fallbacks include the real planner folder, which exists on the author's machine. Without
that override the suite would read the user's live configuration, and a `Today gate backstop = off`
row would change results here for a reason no arm names.

| Check | Asserts |
| --- | --- |
| `mutcheck-priority-order.ps1` | Today before Deferred; `P0 < P1 < unset`; red before yellow; the `## Priorities` list breaks ties; Deferred is *gated* and not merely sorted lower; a terminal Today row lets Deferred through; `reopened` preempts; the sort is deterministic; a declared row releases but keeps its rank; the strict rollback re-shuts the gate; a reply reclaims exclusivity; writing does not release. |
| `mutcheck-today-served.ps1` | The release signal itself: 14 arms covering writing-does-not-release, a named declaration does, expiry/board-edit/supersede/empty-claim cancellation, the separate-call and recent-turn preconditions, the strict rollback, the backstop, and that the backstop comes from `user-settings.md` but an explicit argument outranks it. |
| `mutcheck-awaiting-reply.ps1` | Parking, un-parking by reply and by due timer, newest-turn-only reading, and both directions of the dismissive-ask boundary. |
| `mutcheck-blocked-recheck.ps1` | The recheck timer arms, echoes its `kind`, re-arms on `-RecheckDone`, retires on `-RecheckClear`; snooze suppresses both timers' verdicts, and a lapsed snooze lets the poll fire again — proving snooze *suppresses* rather than disarms; and a due recheck on a `blocked` row is actually `eligible` — the consequence, not just the signal. |
| `mutcheck-board-compound-id.ps1` | A compound ID cell still yields a board row. |

Two disciplines in these checks are worth copying:

- **Arms pull against each other, so no arm can be satisfied by deleting the feature.** "A
  declaration must open the gate" is in direct tension with "writing must not open it"; "a wedged run
  must eventually open it" with "it must otherwise stay shut". Run with `-Matrix`,
  `mutcheck-today-served.ps1` patches the real script once per mutant, re-runs every arm against
  each, and fails if any mutant is killed by zero arms (a claim nothing pins) or by more than one
  (two arms asserting the same thing).
- **The mutant targets are pre-flighted unconditionally.** Every mutant is a literal patch, so it
  stops biting the moment someone reformats the line it matches — and the arms do not notice, because
  they test the real script, which still works. A run that prints "12 passed" with every mutant
  silently dead is a worse failure than a red one, because nothing in its output is false; it merely
  implies a check it never performed.

## 6. Known gaps

| Issue | Gap |
| --- | --- |
| #322 | The exhaustion declaration's *content* is unverified; the release is still, at bottom, the agent talking about itself. |
| #330 | `-ExhaustionTtlMinutes` is one parameter doing two jobs, and runs regularly outlast its 30-minute default, so a declaration can expire mid-run. |
| #326 | "`oa-state.ps1` never writes `agent-gate.md`" is load-bearing for the whole permission channel, currently true, and asserted by nothing. |
| #302 | A `gate-allowed` verdict is decided without consulting the journal. `trailing_has_user` is reported so a caller can notice a fresh human message, but nothing yet acts on it. |
| #250 | Consent still rests on a `from: me` marker written by software the agent runs. |
| #170 | The agent can write turns into tasks that are already closed. |
| #261 | A stuck run has no run-level timeout, which is the condition the staleness backstop mitigates rather than fixes. |
| #343 | The board's `Wake` column is invisible to `Get-SnoozeMap`, so a task snoozed in the app can become eligible before its wake date (see 2.3). |
| #328 | A bare `#NNN` is ambiguous — GitHub numbers and planner task ids already collide — so this page names the namespace explicitly wherever a number appears. |
| #391 | Pacing is documented here but not yet a mechanism: the `Overnight Agent concurrency` tunable (default 1) and the estimate-before-starting rule are run-loop guidance in `SKILL.md`, enforced by no `oa-state.ps1` reader or `mutcheck`. |
