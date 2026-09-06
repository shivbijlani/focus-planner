# Prioritisation

Prioritisation is not one mechanism; it is four things that must agree: how a human expresses
priority on the board, how the overnight agent turns that into an ordered worklist, what gate stops
the agent from skipping ahead to easier work, and how much of that ordered list one run is allowed to
take on. All four are implemented once, in `plugins/overnight-agent/skills/overnight-agent/oa-state.ps1`
(`scan`, `session`, `mark`), enforced by the `mutcheck-*.ps1` suite alongside it, and read by
`SKILL.md`, which names this page and its section numbers directly (`§4`, `§4.1`) as the executable
contract behind its own instructions.

## 1. How priority is expressed on the board

A task's rank is a **sort key**, evaluated in this order (`Cmd-Scan` in `oa-state.ps1`):

| Order | Key | Source | Meaning |
| --- | --- | --- | --- |
| 0 | `reopened` / unanswered-user | journal | a live human reply always sorts first — rule 4 |
| 1 | `section` | which board heading the row is under | `## Today` before `## Deferred` |
| 2 | `work_priority` (`Work Priority` cell) | board row | P0 > P1 > P2 > unset |
| 3 | urgency icon | board row | 🔴 > 🟡 > 🔵 > ⚪ |
| 4 | `priorities_rank` | position in the `## Priorities` list, matched against the row's `Mngr Priority` cell | earlier in the list ranks higher |
| 5 | `board_pos` | row order within its section | a tie-break the user controls just by row order |
| 6 | `id` | task id | final, always-distinct tie-break |

Rule 4 pre-empting everything is deliberate: a live reply is the highest-value work there is,
regardless of section or urgency — the same reason `Test-UnansweredUser` (see §3) beats the Today gate
itself.

## 2. How the user changes priority

- **The board** — move a row between `## Today` / `## Deferred`, edit its urgency icon or `Work
  Priority` cell, or reorder rows within a section (all via `src/focusPlanOps.js`, [Domain-app](Domain-app)).
- **A journal reply** — typing under the agent's `turn-end` stamp reopens a task (`reopened`) and
  jumps it to sort position 0 regardless of section.
- **Snoozing** — `src/snooze.js` sets a `Wake` date; a snoozed row is never `eligible` (see §3) until
  it wakes, no matter its section/priority rank — snooze outranks both the section gate and the
  timers below it.
- **`agent-gate.md`** — does not change *rank*, but changes what the agent is allowed to do
  unsupervised once a row is selected (see [Domain-config](Domain-config)).
- **`user-settings.md`** — the `## Overnight Agent behaviour` section's `Overnight Agent concurrency`
  and Today-gate backstop/strict rows change how much of the ordered list one run takes on and how
  conservatively the gate behaves (see §4 and §5).

## 3. `scan`: from the board to an ordered, gated worklist

Every run's *only* source of truth for "what to work on next" is `oa-state.ps1 scan`'s JSON: one row
per journal, already sorted by the key in §1, each carrying a binding `eligible` flag. Nothing above
this tool re-derives order — "ordering is data, not judgement" (issue #223) is enforced by making the
sort happen once, in one place, rather than trusting every caller to reproduce it.

```powershell
oa-state.ps1 scan
# -> [ { id, section, work_priority, urgency, priorities_rank, board_pos,
#        order, eligible, holds_today_gate, today_release_reason,
#        reopened, snoozed, session_verdict, doc_bound, ... }, ... ]
```

`eligible` is computed per row, after sorting, as:

- `false` if the row is snoozed, or if it is a reply on a task the user has already closed
  (`reopened_closed`, issue #501 — a reply must be *surfaced*, never *worked*, once its task is done);
- `true` if the row is `reopened` or carries an unanswered user message (rule 4 beats the gate);
- otherwise, for a Today row, `true` iff `Test-Workable`;
- for a Deferred row, `true` iff `Test-Workable` **and no Today row currently holds the gate**.

## 4. The Today → Deferred gate, and what releases it

The gate exists to stop a run skipping past a Today task it finds inconvenient to reach easier
Deferred work. `Get-TodayGateVerdict` computes, per Today row, whether it **holds** (blocks Deferred)
or releases, in this order:

1. `not_workable` (the row isn't actionable at all — releases; this row was never going to be worked
   this run regardless of Deferred).
2. `reopened` or an unanswered user message — **holds**, unconditionally, even over a standing
   exhaustion declaration (see below): "I examined everything Today holds" cannot be true of a row
   carrying a question nobody has answered.
3. A configured **strict** mode — **holds**, unconditionally (`user-settings.md`).
4. **`declared_exhausted`** — the agent's own recorded claim, from a prior turn this run, that it
   examined every workable Today row and found nothing to do — releases the gate.
5. The **staleness backstop** — if the row's last written turn is older than the configured backstop
   hours, the gate releases as `stale_turn_backstop`, regardless of any declaration.

**The exhaustion declaration is a claim, not a latch**, and four things stop it from standing
(`Test-ExhaustionClaim`):

| Cancels because | Reported as |
| --- | --- |
| the declaration is older than its TTL | `exhaustion_expired` |
| `## Today`'s text has changed since the claim was made | `exhaustion_stale_board` |
| a turn was written to this row *after* the declaration | `exhaustion_superseded` |
| the declaration names no examined item | `declaration_named_nothing` |

Three of these four are invalidated by state **the agent does not author**: a human editing the board
revokes "I examined everything Today holds" simply by editing the text the claim was about
(`exhaustion_stale_board`); a later turn on the same row refutes it by the run's own record
(`exhaustion_superseded`); the TTL is a clock, not a flag the agent sets. `today_release_reason` is
stamped on every Today row so which of these applied — or that none did and the gate is still holding
— can be audited after the fact without re-deriving anything.

**This is the shape of a recurring failure class in this codebase: the agent authoring the signal its
own gate reads.** A `mark -Done` releasing the gate directly, a re-`mark` silently clearing an
unanswered message, an exhaustion declaration with no expiry or no board-change check — every version
of this bug lets the agent close its own gate. The fix is always the same: key release on something
external (board text, wall-clock staleness, a genuinely new declaration each run) rather than on the
agent's own prior assertion.

## 5. Liveness mechanisms that keep a task from going quiet incorrectly

- **`awaiting_reply` parking** — a task with an open ask and no new user text is parked, not polled;
  it becomes live again the instant `HasTrailingUser` flips true, never on a timer.
- **Poll / recheck timers** — `due_poll` / `due_recheck` fire a row back into the worklist on a
  configured cadence, independent of section/priority rank, but are suppressed while the row is
  snoozed (snooze precedence, §2).
- **The staleness backstop** (§4) — keyed to the *absence* of a fresh turn, never to recency, so there
  is no way to reach this release by writing — the exact shape #310 was: a stamp that reset on every
  `mark` made "stale" mean "hasn't been marked recently" instead of "hasn't been worked recently."
- **Snooze precedence** — snooze suppresses only the eligibility verdict; the underlying timer object
  stays armed and fires again on its own once the snooze lapses, rather than being silently disarmed.

## 6. Pacing — how much of the worklist a run takes on

Ordering answers *what* to work on next; nothing above answers *how much*. Per `user-settings.md`
→ `## Overnight Agent behaviour`, **`Overnight Agent concurrency` defaults to 1**, resolved by
`Resolve-PacingSettings` and reported live by `oa-state.ps1 session -InFlight` as `admits` (how many
more items the priority wave may start). The setting is anchored to a bare whole number and **fails
narrow**: absent, unreadable, malformed, zero or negative all yield 1 — a dated note left in the cell
must never parse as a larger number, which is precisely the historical bug this anchoring closes.
**One item in flight is isolation, not concurrency**: giving a task its own session is *where* its
work happens, not permission to run three at once — an item already dispatched still counts against
the limit even though its work is elsewhere.

A run must **estimate before starting another item**, against the wall-clock remaining before the
next scheduled run, using the rate actually observed this run rather than an optimistic one — starting
work that cannot finish is worse than ending early, because the worklist is data and the next run
recomputes the same order unchanged. And **"done" means verified and published — tests green, the
deliverable where the user will see it, the journal updated — not code written**; a working tree with
unrun tests is not progress.

These three pacing rules are currently **run-loop guidance written in `SKILL.md`, tracked by issue
#391, and not yet a mechanism** — nothing in `oa-state.ps1` enforces the estimate-before-starting-
another rule or the verified-and-published definition of done; only the concurrency ceiling itself
(`session -InFlight` / `admits`) is code.

## 7. Dispatch precedence: collect vs. execute, and the two dispatch waves

A run separates **collect** — read the agent's mail inbox, fold new Telegram replies into journals,
run `scan` — from **execute**. Collect only gathers and hands work off to the worklist; it never
performs task work itself (issues #405, #404): a run measured writing task work directly inside its
own dispatch session, with nothing isolated and nothing recorded about where the work happened, is
exactly the failure this separation prevents.

Dispatch then runs in **two waves**:

1. **The priority wave** — items taken from the `scan` worklist in order, skipping `eligible: false`
   rows, bounded by `admits` from `session -InFlight`.
2. **The collect wave** — a wake that exists *because a collect-phase action just happened* (mail in
   the inbox, a folded Telegram reply, a journal reply) is dispatched **in addition to** the priority
   selection, past `session_at_capacity`, using `session ... -Force`.

**This is the single sanctioned exception to the default concurrency of 1**, and its justification is
provenance, not urgency: a human action may widen the run; the agent's own judgement may not. The
collect wave does not compound (it is not itself subject to a further exception) and it does not raise
the concurrency setting — `Overnight Agent concurrency` stays whatever the user configured, and the
next run resolves it fresh. It changes **when** a task is woken, never **where** its work happens: a
collect-woken task still gets its own dedicated session and workspace, exactly like a priority-wave
task (§ "For each task, resolve its session," `SKILL.md`).

Guarded by `mutcheck-pacing-concurrency.ps1` (the concurrency ceiling and its narrow-fail parsing),
`mutcheck-today-served.ps1` and `mutcheck-priority-order.ps1` (the sort key and gate order in §1/§4),
`mutcheck-parked-capacity.ps1` (that a parked `awaiting_reply` task never silently holds capacity), and
`mutcheck-awaiting-reply.ps1`/`mutcheck-cadence-rearm.ps1` (the liveness timers in §5) — these are the
executable statement of the behaviour this page describes; a change to `oa-state.ps1` that a mutation
proof does not kill is a change this page's guarantees no longer cover.
