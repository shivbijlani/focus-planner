# Prioritisation

Prioritisation is enforced in exactly one place: `plugins/overnight-agent/skills/overnight-agent/oa-state.ps1`.
The board (`planner.md`) is the user's own editable expression of priority; `scan` reads it, computes
a binding `eligible` flag and an `order` for every row, and everything downstream — plan proposal,
dispatch, the Telegram digest — acts on that computed worklist rather than re-deriving priority
itself.

## 1. How priority is expressed on the board

The full sort key, applied in `Cmd-Scan`, in order:

1. **Reopened / unanswered-user reply** — a row with `reopened` true or an unanswered user reply
   preempts everything else (rank 0 vs 1 for every other row).
2. **Section** — `## Today` (rank 0) before `## Deferred` (rank 1) before anything else (rank 2),
   via `Get-SectionRank`.
3. **`Work Priority`** — `P0` > `P1` > `P2` > unset, via `Get-PriorityRank` (regex `^P([0-9])$`;
   unset sorts to `9`, i.e. last).
4. **Urgency icon** — 🔴 (0) > 🟡 (1) > 📖 (2) > ⚪ (3) > unknown (4), via `Get-UrgencyRank`. The
   lookup table is built from Unicode codepoints, never literal emoji characters in source, because
   Windows PowerShell 5.1 ANSI-decodes a BOM-less script containing non-ASCII literals before it
   ever runs — a literal comparison would silently stop matching on that host.
5. **The user's own `## Priorities` ordered list rank** (`Get-PrioritiesRank`), parsed from lines
   like `1. 285` — a deliberate, user-editable override of everything below it in the key.
6. **Board row order** (`board_pos`) — the position the row already occupies in its section.
7. **Task id** — the final, deterministic tiebreak.

`Get-BoardMap` reads `## Today`/`## Deferred` by learning each table's own column indices from its
header (they differ — Deferred inserts a `Wake` column Today does not — see
[Data-Formats](Data-Formats) §1) and joins `Linked ID` across rows.

**How the user changes priority:** editing the board row directly (its `Work Priority` or urgency
cell), editing the `## Priorities` ordered list, replying in a task's journal (which sets
`reopened`/unanswered state), snoozing a task, and standing permissions recorded in `agent-gate.md`
(governs *what* the agent may do unasked, not board order). `user-settings.md`'s
`## Overnight Agent behaviour` table tunes the Today-gate backstop/strict flag and concurrency —
runtime dispatch parameters, not row order.

## 2. `scan`'s eligible flag

```powershell
if (-not $r.snoozed) {
  if (Test-ReopenedClosed $r) { $eligible = $false }
  elseif ($r.reopened) { $eligible = $true }                  # rule 4 beats the gate
  elseif (Test-UnansweredUser $r) { $eligible = $true }
  elseif ($r.section -eq 'today') { $eligible = (Test-Workable $r) }
  elseif ($todayHolding -eq 0) { $eligible = (Test-Workable $r) }
}
```

`eligible` is data the agent reads, never a judgement it makes in the moment — `scan` also emits
`order`, `holds_today_gate`, `today_release_reason`, `gate_backstop_hours` and `gate_strict` per row,
so a run's selection is fully auditable after the fact from the emitted JSON alone (see
[Data-Formats](Data-Formats) §9 for the row shape).

## 3. The Today→Deferred gate

A Today row **holds the gate** — blocks any Deferred row from being worked — unless it is not
workable, or a release fires. This has been wrong in both directions historically, and the current
design exists because of both failures:

- Keyed to *workability alone*: a single standing meta-task froze 121 Deferred rows forever
  (measured: 1 of 238 rows eligible).
- Keyed to *recency of the last turn*: one `mark` call released the entire backlog regardless of
  whether the Today row's work was actually done — this is the exact "agent authors the signal its
  own gate reads" failure (see §6).

**The exhaustion declaration** (`Set-ExhaustionDeclaration`) is the fix: a deliberate, separate call
that must name what was examined and must follow real work:

```json
{
  "today_exhausted": {
    "at": "2026-08-31T22:40:00-07:00",
    "examined": ["gh:197", "gh:179", "gh:139"],
    "note": "all three blocked on review",
    "today_hash": "<sha256 of the ## Today section text>"
  }
}
```

Rules: it cannot combine with `-Status`/`-Version`/`-PlanId`/timer flags in the same call; `-Exhausted`
must name something (empty is rejected); it requires a `last_turn_at` within an exhaustion TTL of
now (so it cannot be declared cold); and it does not touch the journal, so it cannot itself be
mistaken for a reply.

**The four things that cancel/release a declaration** (`Test-ExhaustionClaim`), each surfaced as a
`today_release_reason` value:

1. `exhaustion_expired` — the TTL lapsed (roughly one scheduled run).
2. `exhaustion_stale_board` — the `## Today` section's own text changed (hashed via
   `Get-TodaySectionHash`); the human revokes the declaration simply by editing the board.
3. `exhaustion_superseded` — a turn was written to the row after the declaration was made.
4. `holding:reopened` / `holding:unanswered_user` — a live or unanswered reply reclaims exclusivity
   outright, checked *above* the exhaustion claim.

Plus a fifth, independent backstop: `stale_turn_backstop` fires if nothing has been written to the
row for `gate_backstop_hours` (default `6h`, from `user-settings.md`) — a "wedged run" safety net
keyed to **staleness only, never recency**, specifically so it cannot be gamed by writing a turn
that says nothing.

## 4. Liveness mechanisms

- **`awaiting_reply` parking** (`Test-Workable`): an `in-progress` task whose newest turn carries a
  blocking ask and no trailing user reply is treated as waiting on the user, exactly like a
  `proposed` task — unless a due poll/recheck timer overrides it, because read-only follow-up work
  needs no reply. The parking expression is
  `HasAgentBlock AND HasBlockingAsk AND NOT HasTrailingUser`, duplicated in `Cmd-Scan` (the emitted
  row) and `Test-SessionHoldsCapacity` (the capacity reader) and kept **textually identical** on
  purpose: an emitted field that disagrees with the gated field is its own failure shape (#545).
  - **The ask is declared, not inferred (#560).** `write-turn.ps1` requires
    `-Ask blocking|offer|none` and stamps it into the turn as `<!-- oa-ask: VALUE -->` beneath the
    turn's own provenance marker. `HasBlockingAsk` reads that declaration first, so **`blocking`
    parks even when the wording opens dismissively, and `offer`/`none` do not park even when the
    wording contains a blocking-shaped clause.** The preference lives inside
    `Get-BlockingAskVerdict`, which `Get-JournalFacts` calls, so both readers above inherit it from
    one edit rather than two.
  - **The textual reading survives as a documented fallback**, for turns written before the flag
    existed (~81 journals at the time of the change), where the pre-#560 semantics apply exactly:
    `**Your call:**` parks; a `**Needs from you:**` whose value opens dismissively (`none`/
    `nothing`) does **not** park, and an explicitly optional remainder after the clause break does
    not re-create an obligation. These are **fallback-only** semantics — a declared turn never
    reaches them — and arms L1/L2/Q/R of `mutcheck-awaiting-reply.ps1` still pin them.
  - **`ask_source: declared | inferred`** is emitted on every `scan` row, with the declared value
    itself as `ask_declared`, so the fallback's share is a number that can be watched shrinking
    rather than assumed gone. Every row reports one of the two, including rows with no agent turn
    (which read `inferred`, since nothing could have declared).
  - The gate's "blocking" reading stays deliberately stricter than the digest's `has_open_ask`, and
    a declaration can only ever **add** visibility there: `blocking`/`offer` short-circuit it to
    true, while `none` still falls through to the generous textual reading. Only the *newest* agent
    turn is consulted, for the declaration and the text alike.
- **Poll/recheck timers**: `due_poll`/`due_recheck` fields, re-armed via `mark -PollDone`/
  `-RecheckDone`/`-RecheckClear`.
- **The staleness backstop**: `stale_turn_backstop`, above.
- **Snooze precedence**: a snoozed row is never eligible, and snooze suppresses only the *due*
  verdict — the timer itself stays armed and fires again once the snooze lapses, rather than being
  disarmed by it.

**Grounding.** The parking rule is guarded by `mutcheck-awaiting-reply.ps1` (the state itself, the
gate it opens, the dismissive-ask boundary, and that a reply or a due timer un-parks) and by
`mutcheck-declared-ask.ps1` (that a declaration outranks the prose in *both* directions, that an
undeclared turn still reads exactly as it did before, that `ask_source` is honest, and that
`has_open_ask` does not regress) — both of which drive the real `oa-state.ps1` and, for the second,
the real `write-turn.ps1`, and mutate those files rather than a re-implementation of their logic.

## 5. The recurring failure class: the agent authors the signal its own gate reads

Stated verbatim in `oa-state.ps1`'s `Get-TodayGateVerdict` comment as the third instance of one
failure class in the repository: the agent's own unmarked prose read back as the human's consent
(consent gate); the agent's own closing courtesy line parking its own task via the
`awaiting_reply` ratchet (186 of 238 rows parked, 0 eligible); and a `mark` call resetting the
Today-gate's release signal. Every mechanism in §3 and §4 above is built to guarantee the *release*
signal always traces back to either a genuine user action (a board edit, a reply) or a deliberate,
constrained, work-following declaration — never an incidental agent write.

**The `awaiting_reply` instance was narrowed twice before it was closed, and the difference is the
lesson.** The dismissive-ask boundary (a `**Needs from you:** none…` does not park) was a
*narrowing*: it stopped the worst of the starvation, but the agent still authored the text its own
gate read, so a phrasing choice inside prose written for a human still decided schedulability.
Measured after that narrowing, 2026-09-06: **2 eligible rows out of 249**, with the skill's own
boilerplate `**Your call:** reply below in plain English` present in 81 journals and read back as
blocking — the documented template writing the sentence that starved the board. #560 *closes* it by
making the ask **declared** (`write-turn.ps1 -Ask blocking|offer|none`, §4).

That closure is worth stating precisely, because a declared ask is still agent-authored. The
distinction that matters is not *who* authors the signal but **how**: a declaration is a deliberate,
structural statement made in the same act as writing the turn, not a value reconstructed afterwards
from narrative. That is the same move `-Exhausted` made for the Today gate, and it is why both
remain subject to the cancelling conditions in §3 rather than being trusted outright.

## 6. Pacing

`user-settings.md`'s `## Overnight Agent behaviour` table:

```markdown
| Setting | Value |
| --- | --- |
| Overnight Agent concurrency | `1` |
```

**`1` is the default and the fail-narrow floor**: how many items the agent may have in flight at
once. Giving a task its own session is *isolation*, not permission to run several at once — raising
the value does not make a run faster, it makes each result harder to check. The cell must be a bare
whole number; any explanation must live outside the cell, because a value like
`2026-09-02: set to 1 by Shiv` does not parse as `1` under a naive leading-integer read — it parsed
as `2026`, a silent *widening* of the one control that stops a run over-committing. The parse is
therefore anchored (`^\s*(\d+)\s*$`); a missing row, an unreadable file, or an unparseable value all
resolve to `1`, reported as `concurrency_source: settings-malformed` (versus `default`/`settings`/
`argument`) so a broken setting is visible rather than silently indistinguishable from an
intentional `1`. Precedence: an explicit `-Concurrency` argument outranks the settings-file row,
which outranks the built-in default.

**The estimate-before-starting-another rule** (`SKILL.md`): estimate using the rate actually
observed *this run*, never an optimistic one, against the time left before the next scheduled run —
starting what cannot be finished is worse than ending early.

**"Done" means verified and published**, not code written: tests green, the deliverable written
where the user will see it, the journal updated. Code sitting in a working tree is not progress.

**This is currently run-loop guidance, not (fully) a mechanism.** Issue #391 states the gap
explicitly: the pacing discipline was written down for a sibling skill but was not encoded for the
overnight agent, and `SKILL.md`'s dispatch phase iterated the worklist with no stop condition keyed
to a run's remaining budget. Since #391, the `Overnight Agent concurrency` ceiling *has* shipped as a
real mechanism (guarded by `mutcheck-pacing-concurrency.ps1` for resolution and
`mutcheck-per-task-session.ps1` for enforcement) — but the "estimate before starting another" and
"done means published" rules remain prose-only guidance in `SKILL.md`; nothing yet stops a run
starting work it cannot finish before the next schedule fires.

## 7. Dispatch precedence

A run separates **collect** from **execute**. Collect — the agent inbox, Telegram replies folded
down by `sync-down`, and `oa-state.ps1 scan` itself — must **hand off, never perform work**. Issue
#405 records the concrete failure this rule exists to close: a run began acting on a preservation
request immediately during collect, when the expectation was "collect first, then work on what is
priority in execute."

**Dispatch runs in two waves.** The **priority wave** dispatches at most `admits` items (the
capacity remaining under the concurrency ceiling in §6), selected by the sort key in §1. The
**collect wave** is the single sanctioned exception: a wake that exists *because the user did
something* — mail in the agent inbox, a folded Telegram reply, a journal reply — is dispatched **in
addition to** the priority selection, never instead of it, and never compounding or raising the
concurrency setting itself. Per issue #405's own resolution: *"first you would wake up the sessions
for the tasks that are priority based on priority. then you would wake up the tasks that need to be
woken up based on the collect phase... This does increase concurrency - but that's ok since it came
from user explicit action."*

**Why sanctioned: provenance, not urgency or judgement.** `SKILL.md` states the rule directly: *"A
human action may widen the run; your own judgement may not. It does not compound, it does not raise
the setting."* This is the same principle §5 names for the gate — a signal the agent authors for
itself must never carry the authority a signal from the user carries.

**It changes *when* a task is woken, never *where* its work happens.** The "where" — per-task
session/workspace isolation — is a separate mechanism from issue #404: before it, the agent did task
work inside the run's own session, with no per-task workspace and no memory of where a task's work
was last done (`Cmd-Session`/`Get-SessionVerdict` — verdicts `paused|create|reuse|replace` — fixed
this). Issue #405's precedence rule sits *on top of* that isolation substrate and is purely about
wake timing and count.

**Grounding.** `Get-LiveSessionCount`/`Test-SessionHoldsCapacity` in `oa-state.ps1` compute
`in_flight`/`admits`, guarded by `mutcheck-per-task-session.ps1` (session binding/reuse/isolation) and
`mutcheck-parked-capacity.ps1` (every status `Test-Workable` calls unworkable must also be uncounted
against capacity, unless a due timer overrides — the three deadlocks in #487/#500/#541 were all this
agreement drifting). `mutcheck-pacing-concurrency.ps1` separately guards the concurrency *resolution*
(parse anchoring, malformed-visibility, argument-over-file precedence). The two-wave dispatch
ordering itself — priority wave first, collect wave in addition — is stated as `SKILL.md` prose
citing this page; no dedicated mutcheck currently enforces the wave ordering as a standalone
property, which is a documented gap rather than an oversight.
