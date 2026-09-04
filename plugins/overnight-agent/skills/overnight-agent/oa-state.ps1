<#
.SYNOPSIS
  Skill-owned memory for the Overnight Agent. Tracks, per task, what the agent has
  already processed in each journal — so a user message appended at the BOTTOM of a
  journal (the natural way the Focus Planner app journals) reliably reopens the task.

.WHY
  The journal .md is the only thing the user touches; it stays pure prose. NO machine
  metadata lives in it. All structured state lives HERE, in the skill's own working dir
  ($env:LOCALAPPDATA\overnight-agent\state), which is local and never OneDrive-synced
  (so it can't hit the planner's sync-conflict bug). The user never sees or edits any of it.

.MODEL
  "Has the USER changed this journal since I last wrote to it?"  ==  reopen.
  We answer it by hashing the journal and remembering the hash the agent left behind:
    - reopened = current-file-hash != processed_file_hash   (the user/app edited it)
    - on first sight of a journal (no state yet), reopened = there is user prose AFTER
      the agent's last block (catches already-reopened tasks like #293 on the first run).
  The agent calls `mark` after it writes its turn, which re-snapshots the hash.

  "The user" means the human, `<!-- from: me -->`, and nothing else. These journals are
  shared: sibling skills (dance-church, instagram-publisher-monitor, kranbox-backup, ...)
  append their own turns with their own `<!-- from: ... -->` stamps. Those are machine
  turns. Counting one as user prose pins the task at `reopened` permanently -- there is no
  human message to answer, and the sibling skill re-appends on its own schedule.

.COMMANDS
  seed   [-Force]                Initialise state for every journal (one-time / migration).
  scan                          Emit the per-run worklist as JSON (what changed / reopened /
                                due_poll).
  get    -Id <id>               Print one task's state JSON.
  consent -Id <id>              Print the CONSENT verdict for one task's journal as it stands
                                now: has the HUMAN provably authorized something? Fail-CLOSED
                                (see .CONSENT below). Ask this before any irreversible action.
          [-Action <kind>]      Also consult the AGENT GATE (see .GATE below) for this action
                                kind, from a FIXED enum. Omit it and the output is unchanged.
          [-Repo <name>]        The repository the action targets, so a repo-scoped gate rule
                                can be matched exactly. A repo-scoped rule NEVER matches when
                                this is omitted.
  gate                          Print the parsed agent gate as JSON:
                                { path, exists, state, version, allow[], ask[], mtime }.
                                Rule text is preserved VERBATIM so a verdict can be audited.
  extract -Id <id>              Print a BOUNDED, read-only extract of one journal: the user's
                                framing at the top, the agent's newest turn, any unanswered
                                trailing user prose, and the open asks -- each region capped,
                                with every elision stated in bytes. See .BOUNDED READ below.
          [-BudgetKB <n>]       Total byte ceiling for the emitted regions (default 24).
          [-Json]               Emit the same extract as JSON instead of markdown.
          [-Verify]             Additionally PROVE the extract: assert every emitted region is
                                a verbatim substring of the source and that the output honours
                                the declared ceiling. Non-zero exit if either fails.
  mark   -Id <id> [-Status s] [-Version n] [-PlanId p]
                                Record that the agent has processed the journal as it now
                                stands (re-snapshots processed_file_hash + updates fields).
         [-Poll <cadence>]      Register/update a recurring poll on the task so `scan` surfaces
                                it on a timer even when the journal is untouched. Cadence is one
                                of: hourly | daily | weekly | <N>h | <N>d | <N>m. A freshly
                                registered poll is due immediately (next scan reports due_poll).
         [-PollDone]            Record that the poll just ran: stamp last_polled = now and push
                                next_due forward by the cadence interval.
         [-PollClear]           Remove the poll from the task.
         [-Recheck <cadence>]   Register/update a recurring recheck of a BLOCKED task's
                                prerequisite, so `scan` surfaces it on a timer (due_recheck).
                                Same cadence grammar as -Poll. Freshly armed = due immediately.
         [-RecheckKind <kind>]  Free-text note of WHAT to recheck (e.g. 'oauth', 'ci', 'date',
                                'browser-slot'). Echoed back by scan so a run can pick only the
                                checks it can actually perform. Optional.
         [-RecheckDone]         Record that the recheck just ran: stamp last_rechecked = now and
                                push next_due forward by the cadence interval.
         [-RecheckClear]        Remove the recheck from the task (e.g. once it is unblocked).
         [-Exhausted <list>]    DECLARE this Today row exhausted for THIS RUN, naming what was
                                examined (see .EXHAUSTION). This is what opens the
                                Today->Deferred gate. It is a SEPARATE call: it cannot be
                                combined with -Status/-Version/-PlanId or any timer flag.
         [-ExhaustedNote <s>]   Optional free-text note recorded alongside the declaration.
         [-ExhaustionClear]     Withdraw a standing declaration (the row gates again at once).
  session [-Id <id>]            The per-task SESSION binding (#404). Without any write flag this
                                is a read: it prints the binding and a VERDICT -- `create`,
                                `reuse` or `replace` -- so the run loop never decides for itself
                                whether a second session is needed. See .SESSIONS below.
          [-SessionId <sid>]    Bind the session that was just created for this task. Binding a
                                DIFFERENT id over a LIVE one throws `session_bind_conflict`;
                                binding over a DEAD one is the replacement path and records the
                                prior id. `-Force` overrides.
          [-SessionKind <k>]    `code` or `folder`. `code` REQUIRES -SessionProject and
                                -SessionWorkspace, and refuses the run session's own workspace.
          [-SessionProject <p>] The project the session must be created in -- the repository
                                project for a code task, NOT the run session's project.
          [-SessionWorkspace <p>] The worktree/branch/folder path the session works in.
          [-WorkspaceType <t>]  `worktree` | `branch` | `folder`. Defaults from -SessionKind.
          [-RunWorkspace <p>]   This run session's own workspace, so a bind that would reuse it
                                can be refused. Defaults to the current directory.
          [-SessionDead]        Record that the session could not be woken. Flips the verdict to
                                `replace` and arms the continuation kickoff.
          [-SessionWoken]       Record that the run reused this session (stamps last_woken_at).
          [-SessionRelease]     Retire the binding (task finished, workspace torn down). Prints
                                the teardown command; never runs it.
          [-InFlight]           Omit -Id for the run-loop capacity view: the resolved
                                concurrency, how many tasks hold a live session, and whether the
                                run is at capacity.
          [-Concurrency <n>]    Override the `Overnight Agent concurrency` setting for one call.
  resnapshot                    One-time migration after a change to how journals are decoded
                                or hashed: re-baseline processed_file_hash for tasks with
                                nothing pending. SKIPS any journal with trailing user content,
                                so a real unanswered reply is never baselined away. Never
                                writes to a journal.

.POLLING (why this exists)
  `scan` only flags journals the USER has touched, so a purely time-triggered job (e.g. #400's
  daily "check the video-backup folder and upload any drops") is invisible to it — if the user
  never replies, the agent never gets reminded and the poll silently stops. A poll lives in the
  skill's own state (never in the journal), so the agent can register it once, then every run:
  read `scan`, act on any row with `due_poll: true`, and `mark -PollDone` to re-arm it. The user
  sees nothing about it.

.RECHECKING BLOCKED TASKS (#395 / #400)
  A `blocked` task has the same invisibility problem, for a worse reason: it is waiting on a
  PREREQUISITE, not on the user, so nothing about it will ever change the journal. It therefore
  never appears in a worklist again and parks indefinitely — which is exactly how tasks sat for
  40-59 days. `-Recheck` arms the same timer machinery against the blocker, so `scan` re-surfaces
  the task when its prerequisite is worth re-testing.

  Only blockers with a MACHINE-CHECKABLE prerequisite should be armed (an OAuth token that may
  have been renewed, a CI result that may have gone green, a browser slot that may now be signed
  in, a date that may have arrived). A blocker that needs a human decision must stay a question in
  **Needs from you** — re-asking it on a timer is noise, not progress.

  A due recheck grants NO new permission: it is a read-only look at whether the blocker is gone.
  Acting on the result still obeys the reversibility gate.

.SESSIONS (#404 -- one task, one session, one workspace)
  Before this, the overnight agent DID THE WORK ITSELF, in the run session. Measured live on
  2026-09-02 against task #451: the run read the journal, edited four deliverable files and wrote
  the turn entirely inside the main overnight-agent session. Nothing was isolated, and nothing
  recorded where the work had happened -- so the next run cold-started the same task. #391 already
  states the rule ("per-item sub-sessions are isolation, not concurrency: one task, one workspace,
  one thing being verified at a time"), but it stated it about a mechanism that did not exist.
  This is that mechanism.

  The binding lives HERE, in skill state, for the same reason every other machine fact does: the
  journal is the user's prose and carries no metadata. A `session` member holds the session id,
  the project and workspace it was created in, its liveness, and -- when it replaced one that
  could not be woken -- the id it continues.

  THE COMMAND RETURNS A VERDICT, NOT A FIELD. `session -Id <id>` answers the only question the
  run loop actually has -- create, reuse, or replace? -- so that answer is computed from state
  rather than inferred by the agent from a raw id. The three verdicts:

    create   nothing bound. Create a session, then bind it with -SessionId.
    reuse    bound and live. Wake THAT session. Do not create a second one.
    replace  bound but marked dead by a previous `-SessionDead`. Create a fresh session whose
             kickoff is `kickoff_continuation` (emitted verbatim), which names the task and the
             prior session id, then bind it -- which records `prior_session_id`.

  TWO REFUSALS CARRY THE WEIGHT, and both fail closed.

    session_bind_conflict   Binding a different id over a LIVE one. Without this, "reuse the
                            persisted session" is a suggestion: the second session gets created
                            anyway and simply overwrites the pointer to the first, which then
                            leaks (#345) with nothing recording that it ever existed.

    session_workspace_inherited   A `code` bind whose workspace is the RUN SESSION's own. This is
                            not hypothetical: the first attempt to delegate #404 called the
                            session API without naming a project, so it defaulted to the run
                            session's project -- a FOLDER project with no git repo -- and produced
                            a "per-task session" sharing the run session's workspace. That is
                            precisely the isolation failure this issue exists to prevent,
                            reintroduced by the delegation step itself. Inheritance is the
                            default everywhere, so it has to be refused explicitly.

  CONCURRENCY (#391). `session -InFlight` reports the resolved `Overnight Agent concurrency`
  (precedence: -Concurrency > the user-settings.md row > the built-in 1; absent, unreadable or
  malformed yields 1 exactly), how many tasks hold a live session, and whether the run is at
  capacity. A bind that would exceed capacity is refused with `session_at_capacity`. `-Force` is
  the escape hatch, and it exists for exactly one sanctioned case: the collect-wave exception in
  Prioritisation.md 4.1, where a wake exists BECAUSE THE USER DID SOMETHING. A human action may
  widen the run; the agent's own judgement may not.

  CLEANUP is emitted, never performed. `-SessionRelease` prints the teardown command
  (`scripts/remove-worktree.ps1`), because the raw `git worktree remove --force` deletes THROUGH a
  `node_modules` junction (#321) and this script must not be the thing that runs it.

.CONSENT (#227 -- why this is NOT the same read as `reopened`)
  Approval for an irreversible action must not be inferable from text the agent can write.
  The journal is a MULTI-WRITER surface: this agent, sibling skills, and the Telegram bridge
  all append to it, and the bridge stamps `<!-- from: me -->` on the human's behalf. So the
  reopen reader's `no marker -> treat as the human` default -- which is CORRECT for reopen,
  because losing a user's message is worse than an extra look -- is exactly wrong as a consent
  boundary: it attributes ANY unmarked prose below the turn-end stamp to the human.

  Hence two readers with opposite defaults:

    reopened   (Test-TrailingHasUser)     FAIL OPEN   unmarked prose counts AS the human
    consent_ok (Test-TrailingHasConsent)  FAIL CLOSED unmarked prose is NOT the human

  Consent requires an affirmative phrase inside a segment POSITIVELY attributed to the human.
  Attribution is positional -- a marker owns the text following it -- so agent text under a
  user's heading cannot inherit the user's provenance. A writer that forgets its marker fails
  closed, which is the guarantee a stamping convention cannot give.

  This is a floor, not the whole story: the marker is still written by software. Carrying
  consent on an identity the agent cannot forge (e.g. the Telegram `from_user` id captured at
  fold time) is the follow-up; this makes the reader stop treating absence as permission.

.GATE (#297 -- the standing permission channel the user owns)
  `consent` above answers "did the human approve THIS TASK?" from the journal. That is the only
  consent channel the agent had, and it has a structural ceiling: the journal is a surface the
  AGENT WRITES, so every permission has to be re-granted, per task, in a file the agent itself
  edits. A standing instruction ("this repo is YOLO, stop asking") has nowhere to live.

  `agent-gate.md` is that second channel. It sits in the planner folder next to planner.md, the
  Planner web app seeds and edits it, and THIS AGENT ONLY EVER READS IT -- never writes it. That
  one-way property is the whole point: text in it needs no attribution marker to be trusted,
  because the agent could not have put it there. It holds two lists:

    ## Do not gate these (reversible)   -> ALLOW  : the agent may act without asking
    ## Always ask (safety floor)        -> FLOOR  : the agent always stops and asks

  ORDER IS LOAD-BEARING, and it is the one thing that must not be got backwards:

    1. FLOOR first. A matching floor rule denies, `reason: gate-floor-blocks`, and it OVERRIDES
       everything below it -- including an allow rule AND a human `approve` in the journal. The
       floor is the user saying "not even if I said yes in a hurry".
    2. ALLOW next. A matching allow rule returns `consent_ok: true`, `reason: gate-allowed`.
    3. Otherwise fall through to the journal reading above, completely unchanged.

  MATCHING IS DETERMINISTIC, NOT INTERPRETIVE. `-Action` is a fixed enum (see the param block);
  a rule maps to action kinds through the explicit keyword table in $script:GateActionKinds, and
  the verdict reports the VERBATIM rule that decided it (`gate_rule`) so a human can audit it.
  There is no fuzzy matching and no model in the loop.

  TWO ASYMMETRIES, both deliberately biased fail-CLOSED:

    * REPO SCOPE applies to ALLOW rules only. A rule naming a repository matches only that
      repository, and never matches at all when `-Repo` is omitted. It is NOT applied to floor
      rules: narrowing the floor would REMOVE protection, and 'Send-to-many' must keep blocking
      everywhere. Being over-eager about "this looks repo-scoped" therefore only ever grants
      LESS.
    * BLANKET GRANTS ('yolo', 'dont ask just do', 'no need to ask') apply to ALLOW rules only,
      because that is grant-shaped language. They cover every action kind -- and the floor still
      wins over them.

  ABSENT / UNREADABLE / EMPTY / MALFORMED GATE == TODAY'S BEHAVIOUR, EXACTLY. Both lists come
  back empty, no rule can match, and the journal reader decides as it always did. The gate may
  only ever ADD permission via the allow list or REMOVE it via the floor; it can never weaken
  the fail-closed default. Asserted by mutcheck-agent-gate.ps1.

  A WORKED EXAMPLE, because this is exactly where a careless reading grants what was never
  given. It uses a HYPOTHETICAL gate, quoted in full here, and deliberately says NOTHING about
  what the live gate currently contains -- see the warning below. Suppose the allow list holds
  exactly:

      "some-other-repo is in YOLO mode, dont ask just do"
      "Creating and publishing a pull request in any repository ... do not gate it"

  and the floor holds "Send-to-many (group/channel, mass email)". Then for a repo named
  `some-repo`, neither allow rule authorises MERGING a pull request there: the first names a
  DIFFERENT repo, and the second covers CREATING a PR, not merging one. So:

    consent -Id 463 -Action merge_pr -Repo some-repo                    -> falls through (no rule)
    consent -Id 463 -Action open_pr                                     -> gate-allowed
    consent -Id 463 -Action merge_pr -Repo some-other-repo              -> gate-allowed (blanket)
    consent -Id 463 -Action send_email_many                             -> gate-floor-blocks

  The two lessons are (a) repo scope is whole-token, so a repo whose name is a PREFIX of the one
  a rule names is NOT covered, and (b) an allow rule about creating a PR does not reach merging.
  Both hold no matter what is in the live file.

  DO NOT "UPDATE" THIS EXAMPLE TO MIRROR THE LIVE GATE. It used to do exactly that -- it named
  the real repos and asserted their real verdicts -- and it silently went stale the moment Shiv
  edited `agent-gate.md`, which he can do at any time without touching this repo. Measured
  2026-09-01: within ~20 minutes of a gate edit, two of the four lines above were INVERTED
  against the live file, while the two that never depended on gate contents stayed correct. That
  is the whole diagnosis. A reader reasoning from the stale text would have DECLINED a merge
  Shiv had explicitly permitted -- a wrong refusal, which is the safe direction, but the same
  defect points the other way the moment a permission is narrowed rather than widened.

  The gate is DATA and this file is DOCUMENTATION; documentation that restates data drifts from
  it by construction. To learn what is actually permitted right now, ask -- never remember, and
  never read it off this comment:

    oa-state.ps1 gate                                     # the live lists, verbatim
    oa-state.ps1 consent -Id <id> -Action <kind> [-Repo <repo>]   # the verdict, with gate_rule

.EXHAUSTION (#310 -- what actually opens the Today->Deferred gate)
  Rule 1 of #223 is "Today before Deferred": a Deferred row is ineligible while a Today row
  still holds the gate. The only hard question is WHAT RELEASES IT, and that has been answered
  wrongly twice, in opposite directions:

    keyed to WORKABILITY   never opens for an unbounded row. The live `## Today` held one
                           standing meta-task ("triage fix and ship GitHub issues"), workable
                           forever, so it froze 121 Deferred rows on every run -- measured at
                           1 eligible row out of 238.
    keyed to RECENCY       opens the moment the agent TYPES. `mark` stamps `last_turn_at` on
                           every turn, so one turn -- any content, any completion state --
                           released the whole backlog for the rest of the run.

  The second is the repo's recurring failure class: THE AGENT AUTHORS THE SIGNAL ITS OWN GATE
  READS (cf. #227/#272 consent, and the `awaiting_reply` ratchet). So the release is now an
  affirmative DECLARATION the run has to make on purpose, and the things that CANCEL it are
  state the agent does not author:

    mark -Id <today-id> -Exhausted 'gh:197,gh:179,gh:139' -ExhaustedNote 'all blocked on review'

  A declaration stands only while ALL of these hold. `scan` reports which one failed, per row,
  as `today_release_reason`:

    * it named at least one examined item             (an unnamed claim asserts nothing)
    * it is younger than -ExhaustionTtlMinutes        (scoped to one run; look again next run)
    * the board's `## Today` section is UNCHANGED     (the human revokes it by editing Today)
    * no turn has been written to the row SINCE it    (writing more work refutes "exhausted")
    * the row is not `reopened`                       (a live reply reclaims exclusivity)

  Writing a turn is now NECESSARY BUT NOT SUFFICIENT: you cannot declare a row you never
  opened, and every turn written after a declaration cancels it. That is the exact inversion of
  the defect -- typing can only ever make the gate hold LONGER.

  BACKSTOP. -TodayGateBackstopHours (default 6, from user-settings.md) releases a Today row
  nobody has written a turn to for that long, so a wedged run cannot freeze the backlog behind a
  row it cannot move. It is keyed to STALENESS, so writing resets it; there is no path from
  typing to a release.

  ROLLBACK. -TodayGateStrict (or the legacy -TodayServedMinutes 0) disables every release path:
  a workable Today row gates forever, exactly as before #223's correction. Also settable as
  `Today gate strict = on` in user-settings.md.

.BOUNDED READ (#291 -- why `extract` exists, and why it never writes)
  SKILL.md tells the agent to read a task's linked journal(s) IN FULL before planning or
  executing ("Gather linked-task context FIRST", and again at PHASE 1 and PHASE 2). Journals
  are append-only and nothing prunes them, so the cost of obeying that instruction grows
  without bound. Measured on the live folder 2026-09-01: 239 journals, 4.01 MB, median 8.3 KB
  -- but task-400.md at 272 KB (~70K tokens) and task-463.md at 186.6 KB (~48K tokens), with 8
  journals over the 64 KB read-path budget. One task linking two of those costs more context to
  PLAN than the entire settings file cost at the peak of #262.

  #262 is the same defect one file over, and it is the reason this is not theoretical: an
  unbounded, agent-appended markdown file that is always read whole reached ~97% of the context
  window per call, made 49 round-trips, sat in `running` for ~9 hours, never finished, and froze
  the */30 schedule. #261 (run-level timeout) is the circuit breaker for that and has not landed,
  so today there is no automatic recovery.

  THE CHOICE: READ LESS, NOT WRITE SMALLER.
  ----------------------------------------
  The tempting fix is the one #262 got -- a script that rewrites the file. That is the wrong
  instrument here, and the difference is not stylistic:

    user-settings.md   owner 'user', writer 'app'. A settings file. Rewritable.
    journal/task-N.md  THE HUMAN SOURCE OF TRUTH. SKILL.md: if the state store and the journal
                       prose ever disagree, THE JOURNAL PROSE WINS.

  A journal is also the most dangerous file in the system to rewrite, because four independent
  readers key off its exact bytes:
    - `reopened`   hashes the file and the position of the last turn-end stamp (this script)
    - `consent_ok` reads `<!-- from: me -->` attribution POSITIONALLY (this script, #227)
    - the Telegram bridge anchors on `^##\s*<moon>` and the turn-end / provenance markers
    - the OVERNIGHT-AGENT sentinel divides the user's space from the agent's
  A rewriter that moved one byte across any of those boundaries would either silently re-answer
  finished tasks forever, or fail the consent gate OPEN. And it would generate a OneDrive sync
  event on 239 files every 30 minutes.

  So `extract` is a READER. It never opens a journal for writing -- which is not a promise, it
  is a property: there is no write path in it to get wrong. Every hard constraint above is
  therefore satisfied by construction rather than by a proof about a risky write. Zero bytes
  move, so `scan` and `consent` return byte-identical verdicts before and after.

  WHAT IT EMITS, AND WHY THOSE FOUR REGIONS
  -----------------------------------------
  SKILL.md's own list of what the agent needs from a linked journal is: "the user's notes at the
  top (decisions, constraints, 'we already chose X', 'don't do Y') AND your agent block's Run
  log / deliverables (what already got done, what's still open)". That is a bounded set. The
  full chronology of every previous night is not on it.

    HEAD           everything above the first machine turn -- the user's framing.
    OPEN ASKS      the newest turn's `Needs from you:` / `Your call:` values.
    LATEST TURN    the agent's newest turn only: current status, plan, last run-log entry.
    TRAILING       prose below the turn-end stamp -- the unanswered reply, if any.
    POINTERS       linked task ids, deliverable files, and the byte count NOT shown.

  The LINKED pointer reads BOTH sources SKILL.md names -- the board's `Linked ID` column and the
  journal's `**Linked:** #N` line -- and merges them (#408). It used to read only the journal, so
  a task whose parent was recorded on the board (the normal case; task 468 -> 463 on 2026-09-02)
  reported `linked: (none)` and the mandated upstream walk silently never happened. `(none)` is
  now only ever printed when both sources were consulted and both were empty; if the board could
  not be read the line says THAT instead, because a pointer block that cannot fail is worse than
  one that reports its own gaps.

  Everything is sliced with the SAME parsers the reopen and consent readers use
  (Get-AgentEndIndex, Get-NewestAgentTurn, Get-AuthorSegments, Read-JournalText). Re-deriving
  those boundaries with a second, private parser is the drift bug this deliberately refuses to
  introduce: the extract cannot disagree with the gate about where a turn ended, because it asks
  the same function.

  ITS TWO GUARANTEES, BOTH CHECKABLE (`-Verify`)
  ----------------------------------------------
  1. VERBATIM. Every emitted region is a contiguous substring of the source file. The extract
     never paraphrases, summarises or re-words the user -- a lossy summary of Shiv's own
     decisions would be exactly the byte loss this file refuses to risk. `-Verify` asserts each
     emitted fragment with IndexOf against the source and fails loudly if one is not found.
  2. BOUNDED. Total emitted bytes are <= -BudgetKB regardless of input size, so a 272 KB journal
     and an 8 KB journal cost the same ceiling to read. Elision is never silent: each region
     that was cut prints how many bytes were dropped, and the footer prints the total, so the
     agent can always choose to open the file directly.

  Truncation being VISIBLE is the point. A silent cap would be a new way to lose the user's
  words; a stated one is a bounded read with a named escape hatch.

.SETTINGS (which values the user owns)
  Most parameters here are paths the agent passes in. TWO are read from `user-settings.md` by
  THIS SCRIPT instead, under `## Overnight Agent behaviour`:

    Today gate backstop   hours, default 6, accepts `off`   -> -TodayGateBackstopHours
    Today gate strict     on|off, default off               -> -TodayGateStrict

  Read here rather than passed in, on purpose. A forgotten PATH argument fails loudly -- the
  journal folder is not found and the run stops. A forgotten NUMBER fails SILENTLY: the gate uses
  its built-in default, the run looks entirely normal, and the user's configured value simply
  never applied. That is the same class of defect as #310 itself, so the setting is read where it
  is used and there is nothing to forget.

  Precedence: an explicit command-line parameter, then the settings file, then the built-in
  default. An absent, unreadable, empty or malformed settings file yields the built-in defaults
  EXACTLY -- a settings file can change a value that is already in service, but can never be the
  reason the gate stops working. `scan` reports the resolved values per Today row
  (`gate_backstop_hours`, `gate_strict`), so a configured value that is not applying is visible.

  The exhaustion TTL is deliberately NOT exposed: it currently governs both how long a
  declaration survives and how recently a turn must have been written to make one, so raising it
  would let one run declare on another run's work. It stays in code until #330 splits it.

.SNOOZE PRECEDENCE
  Snooze is the user's explicit "not until <date>", so it outranks both timers: a snoozed task
  reports `due_poll: false` and `due_recheck: false` regardless of how overdue the timer is. The
  timer itself is left untouched and simply fires again once the snooze lapses — snoozing does not
  silently disarm a poll.

.EXAMPLES
  pwsh oa-state.ps1 seed
  pwsh oa-state.ps1 scan
  pwsh oa-state.ps1 get  -Id 293
  pwsh oa-state.ps1 consent -Id 276                    # may I take the irreversible step on #276?
  pwsh oa-state.ps1 gate                               # what standing permissions has the user granted?
  pwsh oa-state.ps1 consent -Id 463 -Action merge_pr -Repo focus-planner
  pwsh oa-state.ps1 consent -Id 463 -Action send_email_many
  pwsh oa-state.ps1 mark -Id 305 -Status proposed -Version 1 -PlanId t305-v1
  pwsh oa-state.ps1 mark -Id 400 -Poll daily          # arm a daily poll on #400
  pwsh oa-state.ps1 mark -Id 400 -PollDone            # after running it this run
  pwsh oa-state.ps1 mark -Id 400 -PollClear           # stop polling #400
  pwsh oa-state.ps1 mark -Id 357 -Status blocked -Recheck 12h -RecheckKind ci
  pwsh oa-state.ps1 mark -Id 357 -RecheckDone         # still blocked; re-arm the timer
  pwsh oa-state.ps1 mark -Id 357 -RecheckClear        # prerequisite cleared
  pwsh oa-state.ps1 mark -Id 463 -Status in-progress  # 1. write the turn
  pwsh oa-state.ps1 mark -Id 463 -Exhausted 'gh:197,gh:179,gh:139' `
                         -ExhaustedNote 'all three blocked on review'   # 2. then declare
  pwsh oa-state.ps1 mark -Id 463 -ExhaustionClear     # withdraw it; the row gates again
#>

[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('seed', 'scan', 'get', 'mark', 'resnapshot', 'consent', 'gate', 'extract', 'doc', 'session')]
  [string]$Command = 'scan',

  [string]$Id,
  [string]$Status,
  # #477: overrides the author recorded by `mark`. Exists so the guard's arms can drive it from
  # a fixture; a real run leaves it unset and the identity comes from the runtime.
  [string]$TurnBy,
  [int]$Version,
  [string]$PlanId,
  [switch]$Force,

  # The bounded journal read (#291). See .BOUNDED READ in the header.
  [int]$BudgetKB = 24,
  [switch]$Json,
  [switch]$Verify,

  # The agent gate (#297). `-Action` is a CLOSED ENUM on purpose: free text would put the
  # matcher's input under the control of whatever prose the agent happened to generate, which is
  # the same self-authored-permission hole #227 closed one level down. A caller that cannot name
  # its action in this vocabulary does not get a gate verdict and falls through to the journal
  # reader -- which is the safe direction. Adding a kind is a deliberate, reviewable edit here.
  [ValidateSet(
    'merge_pr', 'open_pr', 'push_main', 'delete_branch',
    'send_email_self', 'send_email_reply', 'send_email_new_thread', 'send_email_many',
    'post_public', 'spend_money', 'delete_data', 'deploy', 'publish_release')]
  [string]$Action,
  # The repository the action targets, so a repo-scoped ALLOW rule can be matched exactly.
  # Accepts `name` or `owner/name`. Omitting it makes every repo-scoped rule non-matching.
  [string]$Repo,

  # Polling (time-triggered worklist). See .POLLING in the header.
  [string]$Poll,
  [switch]$PollDone,
  [switch]$PollClear,

  # Durable task -> catch-up-doc binding (#423). See Cmd-Doc for the full rationale.
  #
  # `-DocId` BINDS. It is deliberately not idempotent-by-overwrite: binding a DIFFERENT id over
  # an existing one throws, because silently rebinding is how the user's comments end up on an
  # orphaned document. `-Force` is the explicit, auditable override.
  [string]$DocId,
  [string]$DocUrl,
  # A file holding the comments as read from the live surface -- either the Google Workspace
  # MCP's `list_document_comments` text dump, or a JSON array of `{ id, created }`. Reports
  # which are NEW against the watermark, and deliberately does NOT advance it.
  [string]$Observe,
  # Advance the watermark through the last `-Observe`. The second phase, on purpose.
  [switch]$Ack,
  # Drop the binding entirely (rare; the doc was deleted or replaced deliberately).
  [switch]$Unbind,

  # Blocked-task rechecks (time-triggered re-test of a blocker). See .RECHECKING in the header.
  [string]$Recheck,
  [string]$RecheckKind,
  [switch]$RecheckDone,
  [switch]$RecheckClear,

  # The per-task session binding (#404). See .SESSIONS in the header for the full rationale.
  #
  # `-SessionKind` is a CLOSED ENUM for the same reason `-Action` is: it selects which refusals
  # apply, so free text would let the caller opt out of the workspace guard by mis-spelling the
  # kind. `code` is the constrained one -- it demands a project and a workspace and refuses the
  # run session's own.
  [string]$SessionId,
  [ValidateSet('code', 'folder')]
  [string]$SessionKind,
  [string]$SessionProject,
  [string]$SessionWorkspace,
  [ValidateSet('worktree', 'branch', 'folder')]
  [string]$WorkspaceType,
  # This run session's own workspace. Defaults to the current directory, which is where the run
  # session actually is -- so the inheritance refusal works without the caller having to opt in.
  [string]$RunWorkspace,
  [switch]$SessionDead,
  [switch]$SessionWoken,
  [switch]$SessionRelease,
  # The path of a workspace that has just been REMOVED. Marks any binding pointing at it dead,
  # so the next verdict is `replace` rather than `reuse` at a workspace that is gone (#452).
  [string]$WorkspaceGone,
  [switch]$InFlight,
  # Overrides the `Overnight Agent concurrency` settings row for one invocation. -1 is the
  # "not specified" sentinel; see Resolve-PacingSettings for the precedence.
  [int]$Concurrency = -1,

  # Overridable so the skill stays shareable; defaults match user-settings.md.
  [string]$JournalDir = "$env:USERPROFILE\OneDrive\Apps\Focus Planner\journal",
  [string]$StateDir = "$env:LOCALAPPDATA\overnight-agent\state",
  # The board, so `scan` can tell the agent which tasks are currently snoozed
  # (<!-- snooze:YYYY-MM-DD --> markers, from the #353 snooze feature). Sits next to the
  # journal dir by default; override to match a non-standard planner layout.
  [string]$PlannerBoard = "$env:USERPROFILE\OneDrive\Apps\Focus Planner\planner.md",
  # Structured snooze store, written by the Planner web app and read-only here (#391).
  # Preferred over the in-markdown markers above; see Get-SnoozeMap.
  [string]$SnoozeStore = "$env:USERPROFILE\OneDrive\Apps\Focus Planner\snooze.json",
  # The agent gate (#297): the user's standing permissions. Seeded and edited by the Planner web
  # app, READ-ONLY here -- nothing in this script ever writes it, which is what makes its contents
  # trustworthy without an attribution marker. Sits next to planner.md by default.
  [string]$GatePath = "$env:USERPROFILE\OneDrive\Apps\Focus Planner\agent-gate.md",
  # --- The Today->Deferred gate (#223, corrected 2026-08-31, corrected again in #310) ------
  #
  # DEPRECATED, and kept for exactly one value. `0` is the one-flag rollback to the STRICT gate
  # (a workable Today row always holds Deferred shut, the pre-#223-fix behaviour). The old
  # NON-ZERO meaning -- "a Today row is served for N minutes after the agent last wrote a turn
  # to it" -- WAS the #310 defect, and it is gone: any other value is now ignored. New callers
  # should say `-TodayGateStrict` instead, which names the same thing honestly.
  [int]$TodayServedMinutes = -1,
  # The rollback, named for what it does: no release path at all.
  [switch]$TodayGateStrict,
  # How long an exhaustion DECLARATION stays valid, in minutes. Sized to ONE scheduled run
  # (~30 min): a declaration covers the run that made it, and the next run must look again and
  # declare again -- which is what "exhausted for this run" has to mean if it is to mean
  # anything. Expiry fails CLOSED (the gate re-shuts), so a window that is too short costs one
  # cheap re-declaration and never a wrong release. `0` disables the declaration path entirely.
  [int]$ExhaustionTtlMinutes = 30,
  # Wedged-run backstop, in hours (#310, and the "still plenty of time" clause of #223). If a
  # Today row is holding the gate and the agent has NOT written a turn to it for this long, the
  # run cannot work it, so the backlog is released rather than frozen behind a row nobody is
  # moving. This is the exact INVERSE of the #310 defect: writing RESETS the timer, so the agent
  # can only ever DELAY this release, never cause it. A row the agent has never worked is exempt
  # (`last_turn_at` absent keeps gating), because "never touched" is the one state that most
  # deserves the run's attention. `0` disables.
  #
  # DEFAULTED FROM user-settings.md, not from this line. The value here is the LAST resort; the
  # user's `Today gate backstop` row wins over it, and an explicit `-TodayGateBackstopHours` on
  # the command line wins over both. See Resolve-GateSettings for the precedence and for why the
  # file is read HERE rather than being passed in by the agent.
  [int]$TodayGateBackstopHours = -1,
  # Where the user's real settings live. Resolved exactly as SKILL.md documents when omitted;
  # override it to point at a sandbox copy (which is the only way to test the resolution without
  # touching the live planner folder).
  [string]$UserSettings,
  # The exhaustion DECLARATION itself (#310). See .EXHAUSTION in the header and
  # Set-ExhaustionDeclaration below. Value is the list of things the run examined; it is
  # REQUIRED to be non-empty, because a declaration that names nothing is indistinguishable
  # from a shrug.
  [string]$Exhausted,
  [string]$ExhaustedNote,
  [switch]$ExhaustionClear
)

$ErrorActionPreference = 'Stop'

# --- The gate tunables, resolved from user-settings.md (#310 follow-up) --------------------
#
# WHY THIS SCRIPT READS THE FILE ITSELF, rather than the agent passing flags.
#
# Every other setting in user-settings.md reaches this script as a command-line argument the
# agent is instructed to pass. That works for a PATH, because omitting it fails loudly -- the
# journal folder is not found and the run stops. It fails SILENTLY for a NUMBER: forget the flag
# and the gate quietly uses the built-in default, the run looks completely normal, and the user's
# configured value never applied. Nobody ever finds out.
#
# That is the same failure this whole area has now been fixed for twice -- a signal that decides
# behaviour and is not actually checked -- so the setting is read where it is USED. Forgetting is
# no longer possible, because there is nothing to forget.
#
# PRECEDENCE, highest first:
#   1. an explicit command-line parameter   (so a sandbox/test can pin a value, and so an
#      operator can override the file for one invocation without editing it)
#   2. the user's user-settings.md row
#   3. the built-in default named below
#
# An ABSENT, UNREADABLE, EMPTY or MALFORMED settings file yields the built-in defaults exactly --
# the same fail-safe contract Read-AgentGate documents. A settings file can only ever change a
# value that is already in service; it can never be the reason the gate stops working.
$script:GateDefaults = @{ BackstopHours = 6; Strict = $false }
# Captured at SCRIPT scope on purpose. Inside a function, `$PSBoundParameters` is that function's
# own bound parameters -- an empty hashtable here -- so reading it from Resolve-GateSettings would
# report every parameter as "not explicitly passed" and the file would silently outrank the command
# line. Exactly the kind of always-true test this file has had to fix twice.
$script:ExplicitArgs = $PSBoundParameters

function Get-UserSettingsPath {
  # The resolution order SKILL.md documents, first hit wins. The bundled template is deliberately
  # NOT in this list: it ships inside the plugin full of `<placeholders>`, so reading it would
  # feed `<hours>` to an [int] parse on a machine that has never been configured.
  if ($UserSettings) { return $UserSettings }
  $candidates = @(
    $env:OVERNIGHT_AGENT_SETTINGS,
    (Join-Path (Get-Location).Path 'user-settings.md'),
    (Join-Path (Split-Path -Parent $PlannerBoard) 'user-settings.md'),
    "$env:USERPROFILE\OneDrive\Apps\Focus Planner\user-settings.md",
    "$env:LOCALAPPDATA\overnight-agent\user-settings.md"
  )
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}

function Get-SettingRow([string]$text, [string]$name) {
  # One `| Setting | Value |` row, matched on the setting name at the start of the cell. Returns
  # the raw value cell, or $null. Case-insensitive, tolerant of surrounding whitespace and of the
  # backticks the template uses, because a user who copies the formatting must not be punished.
  if (-not $text) { return $null }
  $re = '(?im)^\s*\|\s*' + [regex]::Escape($name) + '\s*\|\s*([^|\r\n]*?)\s*\|'
  $m = [regex]::Match($text, $re)
  if (-not $m.Success) { return $null }
  return ($m.Groups[1].Value -replace '`', '').Trim()
}

function Resolve-GateSettings {
  # Fills in whatever the caller did not specify. Called once, before anything reads the values.
  $explicitBackstop = $script:ExplicitArgs.ContainsKey('TodayGateBackstopHours')
  $explicitStrict = $script:ExplicitArgs.ContainsKey('TodayGateStrict')

  $backstop = $script:GateDefaults.BackstopHours
  $strict = $script:GateDefaults.Strict

  if (-not ($explicitBackstop -and $explicitStrict)) {
    $path = Get-UserSettingsPath
    if ($path) {
      $text = $null
      # Never let a settings problem take down a run: a locked, half-synced or unreadable file
      # falls through to the defaults rather than throwing. OneDrive makes that a real case.
      try { $text = Read-JournalText $path } catch { $text = $null }
      if ($text) {
        $v = Get-SettingRow $text 'Today gate backstop'
        if ($v) {
          # Accepts `6`, `6h`, `6 hours`, `off`. Anything else is ignored rather than guessed at,
          # because a typo must not silently disable a safety backstop.
          if ($v -match '^(?i)(off|none|disabled)$') { $backstop = 0 }
          elseif ($v -match '^\s*(\d+)') { $backstop = [int]$Matches[1] }
        }
        $s = Get-SettingRow $text 'Today gate strict'
        if ($s -match '^(?i)(on|yes|true)$') { $strict = $true }
      }
    }
  }

  if (-not $explicitBackstop) { $script:BackstopHours = $backstop } else { $script:BackstopHours = $TodayGateBackstopHours }
  # The legacy `-TodayServedMinutes 0` spelling still forces strict, whatever the file says: it is
  # an explicit instruction on the command line and outranks a stored preference.
  if ($explicitStrict) { $script:GateStrict = [bool]$TodayGateStrict }
  else { $script:GateStrict = [bool]$strict }
  if ($TodayServedMinutes -eq 0) { $script:GateStrict = $true }
  # A negative backstop is the "not specified" sentinel leaking through an explicit -1; treat it
  # as the default rather than as "never fires", so the sentinel can never disable the backstop.
  if ($script:BackstopHours -lt 0) { $script:BackstopHours = $script:GateDefaults.BackstopHours }
}

# --- Pacing: the concurrency tunable (#391, read here for #404) ----------------------------
#
# Same contract as the gate tunables above, and for the same reason: a NUMBER that reaches this
# script as a flag the agent is told to pass fails SILENTLY when the flag is forgotten. So it is
# read where it is used.
#
# The failure direction is deliberate and is the only one that is safe for a pacing control. An
# absent, unreadable or malformed value yields 1 EXACTLY -- never "unlimited", never the last
# value seen. A typo can therefore narrow a run; it can never widen one. A value below 1 is
# clamped to 1, because "hold zero items in flight" is not a pacing setting, it is a stopped run.
#
# THAT LAST GUARANTEE USED TO BE FALSE, and the way it failed is worth stating because it reads
# as harmless. The parse was a LEADING-integer match, so that `2 tasks` would work -- but this
# file's cells are prose, and prose in this settings file characteristically opens with a DATE.
# Measured against the live user-settings.md conventions:
#
#     | Overnight Agent concurrency | 2026-09-02: set to 1 by Shiv |   ->  concurrency 2026
#     | Overnight Agent concurrency | 3 - raised for the backlog   |   ->  concurrency 3
#
# A note about setting it to 1 therefore set it to 2026: unbounded in every practical sense, on
# the one control whose entire job is to stop a run over-committing, silently, and in the exact
# direction the paragraph above promises is impossible. So the parse is now ANCHORED: the cell
# must be a bare whole number and nothing else.
#
# Anchoring costs the `2 tasks` leniency, and that trade is only safe because of the second half
# of this change: a cell that does not parse is now REPORTED (`concurrency_source` =
# `settings-malformed`) instead of silently becoming 1. Narrowing a run that the user can SEE was
# narrowed is recoverable; widening one nobody can see is not.
$script:PacingDefaults = @{ Concurrency = 1 }

function Resolve-PacingSettings {
  $explicit = $script:ExplicitArgs.ContainsKey('Concurrency')
  $value = $script:PacingDefaults.Concurrency
  # Where the value in force came from, so a cell that did not parse is visible rather than
  # silently indistinguishable from an unset one. `settings-malformed` is the whole point: it is
  # the difference between "1 because you asked for 1" and "1 because your row is a sentence".
  $source = 'default'

  if (-not $explicit) {
    $path = Get-UserSettingsPath
    if ($path) {
      $text = $null
      try { $text = Read-JournalText $path } catch { $text = $null }
      if ($text) {
        $v = Get-SettingRow $text 'Overnight Agent concurrency'
        # ANCHORED: the cell must be a bare whole number. `2` parses; `two`, `many`, `2 tasks`,
        # `-3` and `2026-09-02: set to 1 by Shiv` do not, and all fall through to 1. See the
        # block comment above for why the leading-integer form had to go -- it read a dated note
        # as 2026, which is a WIDENING, and no pacing control may ever widen by accident.
        if ($null -ne $v -and $v -ne '') {
          $source = 'settings-malformed'
          if ($v -match '^\s*(\d+)\s*$') {
            $n = [int]$Matches[1]
            if ($n -ge 1) { $value = $n; $source = 'settings' }
          }
        }
      }
    }
  }
  else { $value = $Concurrency; $source = 'argument' }

  if ($value -lt 1) {
    $value = $script:PacingDefaults.Concurrency
    if ($source -eq 'argument') { $source = 'default' }
  }
  $script:ConcurrencyLimit = $value
  $script:ConcurrencySource = $source
}

function Ensure-StateDir {
  if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Path $StateDir -Force | Out-Null }
}

function Get-Sha256([string]$text) {
  # Normalise newlines so OneDrive CRLF/LF churn never looks like a user edit.
  $norm = ($text -replace "`r`n", "`n")
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($norm)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '' }
  finally { $sha.Dispose() }
}

# A journal turn is stamped with a provenance marker, `<!-- from: <author> -->`. Exactly ONE
# author is the human -- `me`. Every other author is a machine: this agent
# (`overnight-agent`) and the sibling skills that also append turns to these same journals
# (`dance-church`, `instagram-publisher-monitor`, `kranbox-backup`, ...).
#
# Markers are matched at the START OF A LINE, because journals legitimately *discuss* these
# markers in prose; a quoted marker must not be mistaken for a real turn boundary.
$script:HumanAuthor   = 'me'
$script:SelfAuthor    = 'overnight-agent'
$script:ProvenanceRe  = '(?m)^[ \t]*<!--[ \t]*from:[ \t]*([^>\r\n]*?)[ \t]*-->'
$script:LegacyStateRe = '(?m)^[ \t]*<!--[ \t]*oa-state'

# --- Fenced code blocks are QUOTED TEXT, not markup (#320 / #325) -----------------------
# The line-start anchor above stops a marker quoted MID-LINE in prose. It does nothing about
# the way this repo actually quotes journal markup: a fenced example. Inside a fence the
# marker sits at COLUMN 0, where the anchor matches it happily -- so the reader cannot tell
# an illustration of a turn from a turn.
#
# That single blind spot produces BOTH failure directions, and each was reproduced against
# the deployed reader with a control that flips only the fenced marker:
#
#   #320 (false POSITIVE, the dangerous one). An agent postmortem about attribution -- no
#        human anywhere in the file -- containing a fenced example whose marker reads `me`,
#        plus the word `yes`. Verdict: consent_ok=TRUE, `human-authored-affirmative`. The
#        agent authored its own approval, which is the one thing #227 exists to prevent.
#        Control: change the fenced marker to an agent name and it correctly returns false,
#        proving the fence is parsed as live markup rather than ignored as text.
#
#   #325 (false NEGATIVE). A GENUINE human approval that also pastes a fenced example --
#        quoting the docs while asking a question, in one message, which is how people type.
#        The fenced `<!-- from: overnight-agent -->` is read as the agent's newest marker, so
#        the turn boundary is dragged BELOW the human's reply and the trailing region
#        collapses: `no-trailing-content`. The approval does not merely fail to count; the
#        reader concludes nobody spoke at all. Control: the same approval without the fence
#        returns consent_ok=true.
#
# The fix is to give the reader the concept it was missing. Fenced spans are neutralised in
# a MASK -- a same-length copy where fenced characters become spaces and every newline is
# preserved -- so `(?m)^` anchors and every `.Index` offset stay valid and callers keep
# substringing the ORIGINAL text. Masking, not stripping, is what makes this safe to drop in
# at each scan site without re-deriving a single offset.
#
# Scope is deliberately narrow: only the structural scans (provenance markers, the turn-end
# terminator, `## ` headings, the legacy state block) read the mask. Prose content is
# untouched, so an affirmative typed inside a fence by the human still counts -- the fence
# changes what is MARKUP, not what is SAID.
$script:FenceOpenRe  = '^[ ]{0,3}(?<f>`{3,}|~{3,})(?<info>[^\r\n]*)$'
$script:FenceCloseRe = '^[ ]{0,3}(?<f>`{3,}|~{3,})[ \t]*$'

function Get-FenceMaskedText([string]$text) {
  # Same-length copy of $text with fenced-code characters replaced by spaces. Newlines are
  # never masked, so line numbering, `(?m)` anchors and all offsets are identical to $text.
  if ([string]::IsNullOrEmpty($text)) { return $text }
  if ($text.IndexOf('`') -lt 0 -and $text.IndexOf('~') -lt 0) { return $text }

  $sb = [System.Text.StringBuilder]::new($text.Length)
  $i = 0
  $len = $text.Length
  $inFence = $false
  $fenceChar = ''
  $fenceLen = 0

  while ($i -lt $len) {
    $nl = $text.IndexOf("`n", $i)
    $lineEnd = if ($nl -lt 0) { $len } else { $nl }
    $raw = $text.Substring($i, $lineEnd - $i)
    $line = $raw.TrimEnd("`r")

    $mask = $false
    if (-not $inFence) {
      $m = [regex]::Match($line, $script:FenceOpenRe)
      if ($m.Success) {
        # An info string may not contain a backtick when the fence is backticks (CommonMark),
        # which keeps inline code like `a``b` from opening a block.
        $f = $m.Groups['f'].Value
        $info = $m.Groups['info'].Value
        if (-not ($f[0] -eq '`' -and $info.Contains('`'))) {
          $inFence = $true
          $fenceChar = [string]$f[0]
          $fenceLen = $f.Length
          $mask = $true
        }
      }
    }
    else {
      $mask = $true
      $c = [regex]::Match($line, $script:FenceCloseRe)
      if ($c.Success) {
        $cf = $c.Groups['f'].Value
        if ([string]$cf[0] -eq $fenceChar -and $cf.Length -ge $fenceLen) { $inFence = $false }
      }
    }

    if ($mask) {
      # Blank the visible characters; keep any trailing CR so CRLF files round-trip exactly.
      [void]$sb.Append(' ', $line.Length)
      if ($raw.Length -gt $line.Length) { [void]$sb.Append($raw.Substring($line.Length)) }
    }
    else {
      [void]$sb.Append($raw)
    }

    if ($nl -lt 0) { break }
    [void]$sb.Append("`n")
    $i = $nl + 1
  }

  return $sb.ToString()
}

# --- Consent (#227) --------------------------------------------------------------------
# The affirmative vocabulary SKILL.md tells the agent to read as approval. Kept here, next
# to the provenance markers, because consent is (phrase AND author) and the two halves must
# not drift apart in different files.
#
# Word-bounded on both sides so `go` does not fire inside `going` and `do it` does not fire
# inside `redo it`. Phrase precision is deliberately NOT the subject of #227 -- authorship is
# -- so this list mirrors SKILL.md rather than trying to improve on it.
#
# `merge[ \t]+#?\d+` is the one COMMAND-shaped affirmative (#301). For months the agent has
# ended merge asks with "reply `merge 300`", a phrase that was absent here, so a correctly
# attributed `merge 300` returned `human-spoke-but-no-affirmative` -- silently identical to the
# user declining. It cannot be fixed by adding a bare `merge` token: "merge", "merged" and
# "merge it later" run through the agent's OWN prose constantly, and since #272 an unstamped
# agent turn reads as `unknown` (not `me`), so a broad token would widen exactly the
# self-authorised-consent surface #227 exists to close. `merge` followed by a PR number is
# imperative and does not occur in narrative, so it is safe where bare `merge` is not; bare
# `merge`, `merged` and `merge it later` still match nothing. The `merge <n>` form the ask
# advertises in SKILL.md is held identical to what this line accepts by
# `mutcheck-consent-vocab-drift.ps1`, so the operative instruction and the reader cannot drift
# apart (the #297 failure mode). The narrowness itself is proven load-bearing by
# `mutcheck-consent-vocab.ps1`.
$script:ConsentAffirmRe = '(?i)(?<![\w-])(approved?|approve it|yes|yep|yeah|go ahead|go for it|go|lgtm|ship it|do it|vibe it|send it|make it so|proceed|merge[ \t]+#?\d+)(?![\w-])'

# --- The agent gate (#297) --------------------------------------------------------------
# Everything below reads `agent-gate.md`. NOTHING below writes it, and nothing anywhere in this
# script does either. That is not an implementation detail -- it is the property that makes the
# file a trustworthy consent channel (see .GATE in the header), so any future edit that adds a
# write here destroys the guarantee rather than extending the feature.

# --- structure: kept in lockstep with src/config/agentGate.js -----------------------------
# The web app is the WRITER of this file and this is the READER, so the two must agree on
# structure or the user edits a list the agent cannot see. These four constants are the
# PowerShell mirror of SECTION_MATCHERS / HEADING_RE / BULLET_RE over there; the section keys
# are renamed (reversible -> allow, alwaysAsk -> ask) to match the vocabulary of the verdict.
$script:GateHeadingRe = '^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$'
$script:GateBulletRe = '^\s*[-*+]\s+(.*)$'
$script:GateVersionRe = '(?i)<!--\s*planner-agent-gate\s+v(\d+)'
$script:GateSectionMatchers = @(
  @{ Key = 'allow'; Phrases = @('do not gate', "don't gate", 'reversible') },
  @{ Key = 'ask'; Phrases = @('always ask', 'safety floor') }
)

# --- action vocabulary --------------------------------------------------------------------
# Kind -> an array of regex GROUPS. A rule covers the kind when it matches EVERY group (an AND
# of ORs). Two groups is the usual shape: a verb and the thing the verb acts on, which is what
# keeps the kinds apart from each other.
#
# THE DISCRIMINATION THIS TABLE EXISTS FOR. #297 is explicit that a rule about CREATING a pull
# request must never authorise MERGING one -- the live gate has exactly such a rule, and reading
# it as a merge grant would hand out a permission the user never gave. That falls out of the
# table rather than out of a special case: `merge_pr` requires a merge verb, `open_pr` requires
# a create verb AND a pull-request noun, and no create verb implies a merge verb.
#
# The verb/object split also keeps near-neighbours separate, and the near misses are the point:
#   * `publish_release` needs a RELEASE noun, so "publishing a pull request" is not a release.
#   * `post_public` needs `\bpublic(ly)?\b`, which does NOT fire inside "publishing" (there is
#     no word boundary after "public" in "publishing").
#   * `send_email_many` needs a many-audience word, so a 1-1 reply rule never blocks itself.
# Matching is case-insensitive (PowerShell `-match` default) and word-bounded throughout.
$script:GateActionKinds = [ordered]@{
  merge_pr              = @('\bmerg(?:e|es|ed|ing)\b|\bauto-?merges?\b|\bland(?:s|ed|ing)? (?:the |a |it )?(?:pr|pull request)\b')
  open_pr               = @(
    '\b(?:creat(?:e|es|ed|ing)|open(?:s|ed|ing)?|publish(?:es|ed|ing)?|rais(?:e|es|ed|ing)|draft(?:s|ed|ing)?|submit(?:s|ted|ting)?|fil(?:e|es|ed|ing))\b',
    '\bpull[- ]requests?\b|\bprs?\b'
  )
  push_main             = @(
    '\bpush(?:es|ed|ing)?\b|\bforce-?push(?:es|ed|ing)?\b',
    '\bmain\b|\bmaster\b|\btrunk\b|\bdefault branch\b'
  )
  delete_branch         = @(
    '\bdelet(?:e|es|ed|ing)\b|\bremov(?:e|es|ed|ing)\b|\bprun(?:e|es|ed|ing)\b',
    '\bbranch(?:es)?\b'
  )
  send_email_self       = @(
    '\bemail(?:s|ing|ed)?\b|\be-mail(?:s|ing|ed)?\b|\bsend(?:s|ing)?\b|\bsent\b|\bmail(?:s|ing|ed)?\b',
    '\bmyself\b|\bmy own\b|\bto me\b|\bself\b'
  )
  send_email_reply      = @(
    '\brepl(?:y|ies|ied|ying)\b|\brespond(?:s|ed|ing)?\b|\bresponses?\b|\banswer(?:s|ed|ing)?\b',
    '\bemail(?:s|ing|ed)?\b|\be-mail(?:s|ing|ed)?\b|\bchat\b|\bmessages?\b|\bdms?\b|\binteractions?\b|\bthreads?\b|\bconversations?\b'
  )
  send_email_new_thread = @(
    '\bstart(?:s|ed|ing)?\b|\binitiat(?:e|es|ed|ing)\b|\bfresh\b|\bcold\b|\bnew\b|\breach(?:es|ed|ing)? out\b',
    '\bconversations?\b|\bthreads?\b|\bemail(?:s|ing|ed)?\b|\be-mail(?:s|ing|ed)?\b|\bchat\b|\bmessages?\b|\boutreach\b'
  )
  send_email_many       = @(
    '\bsend-to-many\b|\bgroups?\b|\bchannels?\b|\bmanager\b|\bmass\b|\bbroadcast\b|\bdistribution list\b|\beveryone\b|\ball-hands\b|\bmany\b|\bbulk\b',
    '\bemail(?:s|ing|ed)?\b|\be-mail(?:s|ing|ed)?\b|\bmessages?\b|\bchat\b|\bchannels?\b|\bgroups?\b|\bsend(?:s|ing)?\b|\bsent\b|\bpost(?:s|ed|ing)?\b'
  )
  post_public           = @(
    '\bpost(?:s|ed|ing)?\b|\bpublish(?:es|ed|ing)?\b|\btweet(?:s|ed|ing)?\b|\bshar(?:e|es|ed|ing)\b|\bannounc(?:e|es|ed|ing)\b',
    '\bpublic(?:ly)?\b|\bsocial\b|\btwitter\b|\blinkedin\b|\binstagram\b|\bblog\b|\bwebsite\b|\bfeed\b'
  )
  spend_money           = @(
    '\bspend(?:s|ing)?\b|\bspent\b|\bpurchas(?:e|es|ed|ing)\b|\bbuy(?:s|ing)?\b|\bbought\b|\bpay(?:s|ing)?\b|\bpaid\b|\bsubscrib(?:e|es|ed|ing)\b',
    '\bmoney\b|\bpurchases?\b|\bpayments?\b|\bcards?\b|\bdollars?\b|\bcosts?\b|\bcharges?\b|\bsubscriptions?\b|\borders?\b|\$'
  )
  delete_data           = @(
    '\bdelet(?:e|es|ed|ing)\b|\bdrop(?:s|ped|ping)?\b|\bdestroy(?:s|ed|ing)?\b|\bwip(?:e|es|ed|ing)\b|\bpurg(?:e|es|ed|ing)\b',
    '\bdata\b|\bdatabases?\b|\bdbs?\b|\bfiles?\b|\brecords?\b|\btables?\b|\brows?\b|\bfolders?\b'
  )
  deploy                = @('\bdeploy(?:s|ed|ing|ment|ments)?\b|\brollouts?\b|\broll out\b|\bship(?:s|ped|ping)? to prod(?:uction)?\b')
  publish_release       = @(
    '\bpublish(?:es|ed|ing)?\b|\breleas(?:e|es|ed|ing)\b|\bcut(?:s|ting)?\b|\btag(?:s|ged|ging)?\b',
    '\breleases?\b|\bversions?\b|\bpackages?\b|\bnpm\b|\btags?\b|\bchangelog\b'
  )
}

# --- outcome-shaped floor vocabulary --------------------------------------------------------
# Kind -> a regex of OUTCOME words. Applied to FLOOR (ask) rules ONLY. This is the mirror image
# of the blanket-grant asymmetry below, pointing the other way.
#
# WHY THE TABLE ABOVE IS NOT ENOUGH. It is VERB+OBJECT shaped, because that is how a PERMISSION
# is written -- "Emailing myself", "Creating and publishing a pull request". A PROHIBITION is not
# written that way. Asked to name what he wants stopped, a human names the OUTCOME he is afraid
# of, not the verb that gets there. Shiv's live floor rule is:
#
#     Outcome can result in permanent data loss
#
# which carries the OBJECT (`data`) and no verb `delete_data` knows, so the rule matched nothing
# and the blanket YOLO grant in the allow list won by default. Measured on the live gate before
# this fix, with everything else in this file working exactly as designed:
#
#     consent -Action delete_data -Repo focus-planner  ->  consent_ok: true (gate-allowed)
#
# The one rule standing between the agent and permanent data loss was inert, and nothing said so.
# It is the #304 vocabulary wall on the floor side, where the direction of error is dangerous
# rather than merely annoying.
#
# THE DIRECTION OF ERROR IS THE DESIGN, again. A floor rule that matches too eagerly costs one
# unnecessary question; a floor rule that matches too little costs the data. So this vocabulary
# is deliberately generous, and it is confined to the ask list -- where generous is the safe
# direction -- by a per-stage flag rather than by where the lookup happens to sit.
#
# It stays anchored to the kind's OBJECT group, so a floor rule about some other permanent thing
# cannot be dragged into `delete_data` by the word "permanent" alone.
$script:GateOutcomeKinds = @{
  delete_data = '\bdata ?loss\b|\blos(?:e|es|ing)\b|\blost\b|\bloss\b|\bunrecoverable\b|\birrecoverable\b|\birreversible\b|\bpermanent(?:ly)?\b|\bcannot be undone\b|\bcan(?:no|'')?t be undone\b|\bcannot be recovered\b|\bcan(?:no|'')?t be recovered\b|\bno backup\b|\bdestructive\b'
  spend_money = '\bcosts?\b|\bexpensive\b|\bbilled?\b|\bbilling\b|\bcharged?\b|\bnon-?refundable\b|\bout of pocket\b'
}

# --- blanket grants -------------------------------------------------------------------------
# A rule that says "stop asking me" rather than naming an action. Applied to ALLOW rules ONLY,
# because this is grant-shaped language: a floor rule is a prohibition and never phrases itself
# this way, and letting a blanket phrase widen the floor would turn one careless sentence into a
# total shutdown. The floor still outranks a blanket grant, because the floor is checked first.
#
# Deliberately NOT in this list: 'anything', 'everything', and 'do not gate'. The live gate's
# fourth rule ends "do not gate it" while covering only PR CREATION -- reading that as a blanket
# grant is precisely the #297 trap, so the vocabulary is limited to phrases that unambiguously
# mean "I am switching the gate off", not "this particular thing is fine".
$script:GateBlanketRe = '(?i)\byolo\b|\bdo ?n[o'']?t ask\b|\bno need to ask\b|\bnever ask\b|\bwithout asking\b|\bjust do\b|\bstop asking\b'

# --- repo scoping ---------------------------------------------------------------------------
# A repo token is a hyphenated identifier, optionally `owner/name`. English hyphenations that
# turn up in safety prose are excluded so they do not silently neuter a rule.
#
# THE DIRECTION OF ERROR IS THE DESIGN. Repo scope only ever NARROWS an allow rule, and it is
# applied to allow rules only. So a token wrongly read as a repo name grants LESS (fail closed);
# a repo name wrongly read as English grants MORE, which is why the stop list is short, holds
# only unmistakable English, and must not be grown casually.
#
# Substring matching is banned outright here, and this is the live trap: repo names NEST, and
# `focus-planner` is a PREFIX of `focus-planner-ado-codeapp`. Under `rule.Contains($repo)` a rule
# naming the LONGER name would be reported as authorising the SHORTER repo -- so a blanket YOLO
# rule written for the ADO app would silently grant merges in the planner repo. That is the exact
# false grant #297 was filed over. The hazard is the NAME SHAPE, not today's gate contents: which
# of the two is actually in YOLO is live data and changes without this repo being touched, so do
# not rewrite this comment to track it. Comparison is whole-token equality, case-insensitive.
$script:GateRepoTokenRe = '(?:[A-Za-z0-9_.]+/)?[A-Za-z0-9_.]+(?:-[A-Za-z0-9_.]+)+'
$script:GateRepoStopWords = @(
  'e-mail', 'e-mails', 'follow-up', 'follow-ups', 'read-only', 'sign-in', 'sign-off',
  'check-in', 'one-off', 'day-to-day', 'up-to-date', 'so-called', 'pull-request',
  'pull-requests', 'send-to-many', 'all-hands', 'long-running', 'non-trivial',
  'end-to-end', 'write-up', 'back-and-forth', 'out-of-office', 'opt-in', 'opt-out',
  'double-check', 'third-party', 'first-party', 'real-time', 'on-call', 'ad-hoc',
  'force-push', 'auto-merge', 'case-by-case', 'one-to-one', 'well-known', 'up-front'
)

function Get-GateSectionKey([string]$headingText) {
  $t = "$headingText".ToLowerInvariant()
  foreach ($m in $script:GateSectionMatchers) {
    foreach ($p in $m.Phrases) { if ($t.Contains($p)) { return $m.Key } }
  }
  return $null
}

function Parse-AgentGateText([string]$md) {
  # Mirrors parseAgentGate() in src/config/agentGate.js: a section runs from its heading to the
  # next heading of the same-or-shallower depth, the FIRST heading naming a list wins, and only
  # bullet lines inside it are rules. Tolerant by construction -- CRLF, `*`/`+` bullets, prose
  # mixed among the bullets, and a file with only one of the two sections all parse without
  # throwing, because a gate that throws is a gate that stops the run.
  $normalised = ("$md" -replace "`r`n", "`n") -replace "`r", "`n"
  $lines = $normalised -split "`n"
  $out = [ordered]@{ Version = $null; Allow = @(); Ask = @() }

  $v = [regex]::Match($normalised, $script:GateVersionRe)
  if ($v.Success) { $out.Version = [int]$v.Groups[1].Value }

  $seen = @{}
  for ($i = 0; $i -lt $lines.Count; $i++) {
    $h = [regex]::Match($lines[$i], $script:GateHeadingRe)
    if (-not $h.Success) { continue }
    $key = Get-GateSectionKey $h.Groups[2].Value
    if (-not $key) { continue }
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    $depth = $h.Groups[1].Value.Length
    $end = $lines.Count
    for ($j = $i + 1; $j -lt $lines.Count; $j++) {
      $n = [regex]::Match($lines[$j], $script:GateHeadingRe)
      if ($n.Success -and $n.Groups[1].Value.Length -le $depth) { $end = $j; break }
    }
    $items = @()
    for ($j = $i + 1; $j -lt $end; $j++) {
      $b = [regex]::Match($lines[$j], $script:GateBulletRe)
      if (-not $b.Success) { continue }
      $text = $b.Groups[1].Value.Trim()
      if ($text) { $items += $text }
    }
    if ($key -eq 'allow') { $out.Allow = @($items) } else { $out.Ask = @($items) }
  }
  return [pscustomobject]$out
}

function Read-AgentGate([string]$path) {
  # READ ONLY. A missing, unreadable, blank or unparseable file yields two EMPTY lists, which is
  # the same thing as "no rule matched" -- so every one of those states degrades to exactly the
  # pre-#297 behaviour rather than to a special case that could drift away from it. `state` is
  # reported so a run can tell "the user granted nothing" from "I could not read the grants".
  $result = [ordered]@{
    path = "$path"; exists = $false; state = 'absent'
    version = $null; allow = @(); ask = @(); mtime = $null
  }
  if ([string]::IsNullOrWhiteSpace($path) -or -not (Test-Path -LiteralPath $path -PathType Leaf)) {
    return [pscustomobject]$result
  }
  $result.exists = $true
  $text = $null
  try {
    # Same explicit UTF-8 decode as the journals, and for the same reason: the default decoder
    # is host-dependent, so a rule containing an em-dash or a smart quote would match under one
    # host and not the other. See Read-JournalText.
    $text = [IO.File]::ReadAllText($path, (New-Object Text.UTF8Encoding($false)))
    $result.mtime = (Get-Item -LiteralPath $path).LastWriteTimeUtc.ToString('o')
  }
  catch {
    $result.state = 'unreadable'
    return [pscustomobject]$result
  }
  if ([string]::IsNullOrWhiteSpace($text)) { $result.state = 'empty'; return [pscustomobject]$result }
  $parsed = Parse-AgentGateText $text
  $result.version = $parsed.Version
  $result.allow = @($parsed.Allow)
  $result.ask = @($parsed.Ask)
  $result.state = if ($result.allow.Count -eq 0 -and $result.ask.Count -eq 0) { 'malformed' } else { 'ok' }
  return [pscustomobject]$result
}

function Get-GateRepoTokens([string]$rule) {
  $out = @()
  foreach ($m in [regex]::Matches("$rule", $script:GateRepoTokenRe)) {
    $t = $m.Value.ToLowerInvariant().TrimEnd('.', ',', ')', '-')
    $bare = ($t -split '/')[-1]
    if ($bare.Length -lt 6) { continue }              # too short to be a repo name
    if ($bare -notmatch '[a-z]') { continue }         # digits only, e.g. `1-1`
    if ($script:GateRepoStopWords -contains $bare) { continue }
    if ($out -notcontains $bare) { $out += $bare }
  }
  # NOT `return , $out`. The comma operator wraps the list in an outer array, the pipeline
  # unrolls exactly one level, and an EMPTY list therefore arrives at the caller as a single
  # empty-array element -- `@(...).Count -eq 1`. That reads as "this rule is repo-scoped" for
  # every rule in the file, so nothing but a blanket grant can ever match. Caught by the
  # 'Emailing myself' fixture. Plain `return` lets the caller's `@(...)` normalise correctly.
  return $out
}

function Test-GateRuleCovers([string]$rule, [string]$action, [bool]$applyRepoScope, [string]$repo, [bool]$allowOutcomePhrasing) {
  if ([string]::IsNullOrWhiteSpace($rule)) { return $false }
  if ([string]::IsNullOrWhiteSpace($action)) { return $false }
  $text = "$rule"

  if ($applyRepoScope) {
    $tokens = @(Get-GateRepoTokens $text)
    if ($tokens.Count -gt 0) {
      # A repo-scoped rule with no -Repo to check against cannot be shown to apply, so it does
      # not. This is the fail-closed half of scoping and it is what stops a bare
      # `consent -Action merge_pr` from collecting another repo's YOLO grant.
      if ([string]::IsNullOrWhiteSpace($repo)) { return $false }
      $want = "$repo".Trim().ToLowerInvariant()
      $wantBare = ($want -split '/')[-1]
      $hit = $false
      foreach ($t in $tokens) { if ($t -eq $want -or $t -eq $wantBare) { $hit = $true; break } }
      if (-not $hit) { return $false }
    }
    if ($text -match $script:GateBlanketRe) { return $true }
  }

  $groups = $script:GateActionKinds[$action]
  if (-not $groups) { return $false }
  $allGroups = $true
  foreach ($g in $groups) { if ($text -notmatch $g) { $allGroups = $false; break } }
  if ($allGroups) { return $true }

  # Outcome-shaped phrasing -- FLOOR ONLY, and gated on the caller's per-stage flag rather than
  # on anything about the rule text, so an allow rule can never reach it however it is worded.
  # See the .GATE header note on $script:GateOutcomeKinds: a prohibition names the outcome, not
  # the verb, and "permanent data loss" is the live proof.
  if ($allowOutcomePhrasing) {
    $outcome = $script:GateOutcomeKinds[$action]
    if ($outcome -and $text -match $outcome) {
      # Still anchored to the kind's OBJECT group (the last one), so "permanent" on its own
      # cannot drag an unrelated prohibition into this action kind. Single-group kinds have no
      # object to anchor to, so the outcome word alone carries them.
      if ($groups.Count -lt 2 -or $text -match $groups[-1]) { return $true }
    }
  }
  return $false
}

function Get-GateVerdict($gate, [string]$action, [string]$repo) {
  # ORDER IS THE GUARANTEE, so it is written down as DATA rather than as the order two `foreach`
  # blocks happen to appear in. The floor stage is first and the first stage to match returns, so
  # a floor rule outranks an allow rule AND -- because the caller consults this before reading the
  # journal -- outranks a human `approve` too. Reversing these two entries silently converts the
  # safety floor into a suggestion, which is the worst available bug in this file;
  # mutcheck-agent-gate.ps1 asserts it with a mutation that reverses exactly this list.
  #
  # `Scoped` is per stage and is $false for the floor on purpose: repo scope NARROWS a rule, and
  # narrowing a prohibition removes protection. `Outcome` is the mirror: it is $true for the floor
  # only, because a prohibition names the OUTCOME it fears rather than a verb, and matching too
  # eagerly on the floor costs a question while matching too little costs the data. Both live here
  # as stage DATA so each asymmetry has one precise mutation target.
  $stages = @(
    [pscustomobject]@{ Decision = 'floor'; List = 'ask'; Rules = @($gate.ask); Scoped = $false; Outcome = $true },
    [pscustomobject]@{ Decision = 'allow'; List = 'allow'; Rules = @($gate.allow); Scoped = $true; Outcome = $false }
  )

  $verdict = [ordered]@{ decision = 'none'; list = $null; rule = $null }
  if ([string]::IsNullOrWhiteSpace($action)) { return [pscustomobject]$verdict }

  foreach ($stage in $stages) {
    foreach ($rule in @($stage.Rules)) {
      if (Test-GateRuleCovers $rule $action ([bool]$stage.Scoped) $repo ([bool]$stage.Outcome)) {
        $verdict.decision = $stage.Decision
        $verdict.list = $stage.List
        $verdict.rule = $rule
        return [pscustomobject]$verdict
      }
    }
  }
  return [pscustomobject]$verdict
}


# --- The turn terminator ---------------------------------------------------------------
# An HTML comment (invisible when the journal renders) that marks the exact END of this
# agent's turn. `mark` writes it; `Get-AgentEndIndex` trusts it.
#
# WHY IT EXISTS. Without it the end of the agent's turn is found by scanning FORWARD for
# the next `## ` heading, and when the agent's turn is the newest -- the normal state --
# there is no such heading, so the boundary falls to EOF and the WHOLE FILE counts as the
# agent's turn. A reply typed at the bottom with no `## <date>` heading therefore lands
# INSIDE the agent's own turn and is never seen.
#
# That is the dangerous direction. A false "reopened" costs one needless look; a false
# "already answered" silently swallows the user's message with no trace anywhere. It is
# not hypothetical: task #426580 sat for a day with two unanswered questions
# ("were you able to ... create the event in Google calendar?") appended exactly this way,
# and 216 of 239 live journals were in the same shape.
#
# The boundary is genuinely ambiguous from CONTENT alone -- an agent turn may legitimately
# end in a plain prose paragraph, which is indistinguishable from a short human reply. So
# the fix is not a cleverer heuristic; it is to stop guessing and write the boundary down
# at the moment the agent already knows it.
$script:TurnEndMarker = '<!-- /overnight-agent turn-end -->'
$script:TurnEndRe     = '(?m)^[ \t]*<!--[ \t]*/overnight-agent[ \t]+turn-end[ \t]*-->[ \t]*\r?$'

# `### Run log` is SKILL.md's managed heading for this agent's execution record. Only this
# agent writes it, so it is a reliable machine-turn marker even in the many historical
# journals where the agent replied without stamping a `<!-- from: overnight-agent -->`
# provenance marker at all.
#
# The trailing `\r?` is load-bearing: these journals round-trip through OneDrive and the
# planner web app, so CRLF is common. `$` in .NET multiline mode matches before the `\n`,
# which leaves the `\r` unconsumed -- and `[ \t]` does not match `\r`. Without it the
# heading is simply never found on a CRLF file and the whole recovery silently no-ops.
$script:RunLogRe = '(?m)^[ \t]*###[ \t]+Run log[ \t]*\r?$'

# The shape of a run-log body: the heading itself, blank lines, the bold date line
# (`**2026-08-26 (overnight):**`), list items, and indented wrapped continuations.
# Anything else in that region is prose this agent did not write.
$script:RunLogBodyLineRe = '^(?:[ \t\r]*$|[ \t]*###[ \t]+Run log[ \t\r]*$|[ \t]*\*\*.*$|[ \t]*[-*+][ \t].*$|[ \t]*\d+\.[ \t].*$|[ \t]+\S.*$)'

# `## <moon> Overnight Agent` is SKILL.md's managed heading for one of THIS agent's turns.
# Only this agent writes it, so it can never be a user turn -- which makes it a boundary the
# walk in Get-AgentEndIndex must step OVER rather than stop at.
#
# WARNING: match the ASCII phrase, NOT the moon glyph. These journals are UTF-8 with NO BOM,
# Windows PowerShell's default decoding for a BOM-less file is the ANSI codepage -- so the
# same heading arrives as `## <moon> Overnight Agent` in one invocation and as the Latin-1
# mojibake `## AdYS Overnight Agent` in another. A glyph-based pattern therefore matches or
# silently fails depending on how the file happened to be decoded, which is the worst kind of
# bug: it no-ops with exit code 0 and the guard it protects reads clean. `Overnight Agent` is
# pure ASCII, so it is byte-identical under both decodings and cannot drift.
#
# The dated heading the planner app writes above a user reply (`## 2026-08-27`) never
# contains this phrase, so the discrimination stays exact.
$script:ManagedHeadingRe = '^##[^\r\n]*Overnight Agent'

function Get-LastIndexOfPattern([string]$content, [string]$pattern) {
  $idx = -1
  foreach ($m in [regex]::Matches($content, $pattern)) { $idx = $m.Index }
  return $idx
}

function Test-IsRunLogBodyOnly([string]$region) {
  # Is this region nothing but the agent's own run-log entry? Used as a GUARD, so it must
  # answer "no" whenever it is unsure: a false "no" costs one needless look at a settled
  # task, a false "yes" silently swallows the user's message.
  foreach ($line in ($region -split "`r?`n")) {
    if ($line -notmatch $script:RunLogBodyLineRe) { return $false }
  }
  return $true
}

# --- Awaiting the user's reply: the selection gate's missing waiting state --------------
# `Test-Workable` excludes `done`/`skip`/`proposed`/`blocked` because they are terminal or
# waiting on the user. `in-progress` has a case that model misses: a run that finishes a step
# and hands back an open question leaves the task `in-progress`, yet it is now waiting on the
# user exactly as much as a `proposed` one is.
#
# That gap is load-bearing because of the OTHER rule the run obeys -- user-settings.md's "do
# NOT stack a new turn on an unanswered one", which says an unanswered agent turn must be
# REPLACED rather than appended to. So this state describes a task the run must not simply
# write to, while `Test-Workable` still called it workable and therefore held the
# Today->Deferred gate shut.
#
# Measured on the live board 2026-08-30 21:30 PT: ONE Today row in this state (#451, an
# unanswered `Your call:` from 14 minutes earlier) made all 55 workable Deferred rows
# ineligible, so the run had no permitted work anywhere on the board. Nothing errored -- the
# gate was behaving exactly as written, which is why it reads clean and starves silently.
#
# Detection deliberately mirrors the vocabulary the Telegram digest already parses, so the two
# surfaces cannot drift: `**Your call:**` is always an ask, and `**Needs from you:**` is an ask
# unless it is purely dismissive. A dismissive clause dismisses only ITSELF -- `none - but tell
# me X` is still an ask -- which is the precedence error the bridge already had to fix once.
#
# ...BUT THE TWO SURFACES WANT OPPOSITE SAFE DEFAULTS, AND SHARING ONE READING STARVED THE BOARD
# (measured 2026-08-31 00:50 PT). The digest asks "should the user SEE this?" -- a miss there
# hides a question, so it is right to read generously. The gate asks "may the run PROCEED?" -- a
# false yes parks a task the agent could have worked, which `Test-AskTextIsOpen` says in its own
# comment. Feeding the generous reading into the gate turns the digest's deliberate generosity
# into the scheduler's starvation condition.
#
# It is a RATCHET, which is why it ends in total starvation rather than in a slow leak: the agent
# writes the text the gate reads, and it ends nearly every turn politely offering an optional
# extra ("nothing needed - say the word and I'll pick it up"). Under the shared reading that
# closing courtesy is an open ask, so EVERY turn the agent writes parks its own task, and only a
# human reply ever releases it. Measured on the live board that night: 186 of 238 rows parked,
# every remaining row terminal, and therefore ZERO eligible rows -- no permitted work anywhere.
# 71 of the 186 were parked by a turn in which the agent had explicitly said it needed nothing.
# The single Today row (#448) was parked by its own previous turn's closing line.
#
# The fix keeps `has_open_ask` exactly as it was -- the digest must keep showing these -- and
# gives the GATE a stricter question: is this ask BLOCKING? A dismissive opener is the agent
# stating, about its own state, that it is not blocked; anything after the clause break is an
# OFFER, not a blocker, and silence is a valid answer to an offer. A non-dismissive
# `Needs from you:` still parks, and `**Your call:**` still parks, so the gate only loosens for
# turns that declared themselves unblocked.
$script:NeedsFromYouRe  = '(?im)^[ \t]*\*\*[ \t]*Needs from you[ \t]*:?[ \t]*\*\*[ \t]*:?(.*)$'
$script:YourCallRe      = '(?im)^[ \t]*\*\*[ \t]*Your call[ \t]*:?[ \t]*\*\*[ \t]*:?(.*)$'
$script:DismissiveAskRe = '(?i)^[ \t]*(none|nothing|nada|n/a|no)\b'
# A clause break after a dismissive opener means real content follows: `.` `;` `:`, an en/em
# dash, or a SPACED hyphen. Written as \u escapes, never as literal glyphs: a BOM-less .ps1 is
# decoded as the ANSI codepage under Windows PowerShell 5.1, so a literal dash here would be
# silently mangled on the way in (this is what ps1-encoding-sweep.mjs exists to catch).
$script:AskClauseBreakRe = '[.;:]|\u2014|\u2013|(?<=\s)-(?=\s)'
# ...and a dismissive opener whose remainder marks ITSELF optional is still not an ask. This is
# the third shape the two-way split above misses, and it is the one that starves the board:
#
#   **Needs from you:** nothing. Both items above are optional; say the word and I'll pick it up.
#
# The agent said no blocker, then offered extras. Nothing is owed, so parking the task contradicts
# the turn's own first word -- precisely the "false yes" this function is documented to avoid,
# because a false yes parks a genuinely workable task.
#
# Measured on the live board 2026-08-31 00:30 PT: 21 of the 83 open board asks opened with a
# dismissive, and one of them was #448 -- the ONLY row in Today. With Deferred correctly held
# behind Today, that single false park left 0 of 238 rows eligible and the run no permitted work
# anywhere. Same silent-starvation shape as the #451 case above, reached from the other side.
#
# Deliberately narrow, because a false NO is the dangerous direction here (it would let a run
# stack a turn onto a genuinely unanswered ask): this is consulted ONLY after a dismissive opener
# has already matched, so an ordinary ask never reaches it, and `none - but tell me X` has no
# optionality marker and therefore still parks.
$script:OptionalRemainderRe = '(?i)\b(optional(ly)?|if you want|if you would like|if you ?d like|if you like|when you ?re ready|when you are ready|when you get to it|when you have time|no rush|not urgent|up to you|self-serve|whenever you)\b'

function Get-NewestAgentTurn([string]$agentLeft) {
  # The agent's LAST turn only. Scoping is what keeps this honest: an ask answered three turns
  # ago is not an open ask, and testing the whole block would leave a task awaiting forever.
  if ([string]::IsNullOrEmpty($agentLeft)) { return '' }
  # Scan the fence mask so a heading or marker inside a quoted example cannot be mistaken for
  # the start of a real turn (#320). Offsets are mask-identical, so the substring is of the
  # original text.
  $scan = Get-FenceMaskedText $agentLeft
  $idx = Get-LastIndexOfPattern $scan ('(?m)' + $script:ManagedHeadingRe)
  if ($idx -lt 0) { $idx = Get-LastIndexOfPattern $scan $script:ProvenanceRe }
  if ($idx -lt 0) { return $agentLeft }
  return $agentLeft.Substring($idx)
}

function Test-AskTextIsOpen([string]$value) {
  # Does this `Needs from you:` value carry a real ask? Used to OPEN the gate, so it answers
  # "no" when unsure: a false "no" merely keeps today's behaviour, a false "yes" would park a
  # genuinely workable task.
  $v = "$value".Trim()
  if ($v.Length -eq 0) { return $false }
  if ($v -notmatch $script:DismissiveAskRe) { return $true }
  $m = [regex]::Match($v, $script:AskClauseBreakRe)
  if (-not $m.Success) { return $false }
  $rest = ($v.Substring($m.Index + $m.Length)).Trim()
  if ($rest.Length -eq 0) { return $false }
  # The turn already said nothing is needed. An explicitly OPTIONAL remainder is an offer, so it
  # does not re-create an obligation the same sentence just disclaimed. Apostrophes are folded
  # first so `when you're ready` and the curly-quote form both reach the pattern. The curly quote
  # is built with [char]0x2019 rather than written literally: this .ps1 is BOM-less, so PS 5.1
  # decodes it as the ANSI codepage and a literal glyph would be silently mangled on the way in.
  $flat = $rest -replace ("[" + [char]0x2019 + "']"), ' '
  if ($rest -match $script:OptionalRemainderRe -or $flat -match $script:OptionalRemainderRe) { return $false }
  return $true
}

function Test-HasOpenAsk([string]$agentLeft) {
  # VISIBILITY reading (`has_open_ask`, consumed by the digest surface). Deliberately generous:
  # anything the user could reasonably answer counts, so the queue never hides a question.
  $turn = Get-NewestAgentTurn $agentLeft
  if ($turn.Length -eq 0) { return $false }
  if ([regex]::IsMatch($turn, $script:YourCallRe)) { return $true }
  foreach ($m in [regex]::Matches($turn, $script:NeedsFromYouRe)) {
    if (Test-AskTextIsOpen $m.Groups[1].Value) { return $true }
  }
  return $false
}

function Test-AskTextIsBlocking([string]$value) {
  # Does this `Needs from you:` value BLOCK the run? Stricter than Test-AskTextIsOpen: a
  # dismissive opener is the agent's own statement that it is not blocked, so whatever follows
  # the clause break is an OFFER the user may decline by silence -- not a blocker.
  #
  # This is the one place the gate must NOT inherit the digest's reading. `Test-AskTextIsOpen`
  # keeps its meaning for `has_open_ask`, so the offer still reaches the user; it just no longer
  # stops the agent from doing the work it already said it could do unaided.
  $v = "$value".Trim()
  if ($v.Length -eq 0) { return $false }
  return ($v -notmatch $script:DismissiveAskRe)
}

function Test-HasBlockingAsk([string]$agentLeft) {
  # GATE reading (`awaiting_reply`). `**Your call:**` still parks -- it is a direct hand-back
  # with no accompanying claim of self-sufficiency, and arms I/J of mutcheck-awaiting-reply
  # depend on that. Only the declared-unblocked case loosens.
  $turn = Get-NewestAgentTurn $agentLeft
  if ($turn.Length -eq 0) { return $false }
  if ([regex]::IsMatch($turn, $script:YourCallRe)) { return $true }
  foreach ($m in [regex]::Matches($turn, $script:NeedsFromYouRe)) {
    if (Test-AskTextIsBlocking $m.Groups[1].Value) { return $true }
  }
  return $false
}

function Get-AgentEndIndex([string]$content) {
  # End offset of THIS agent's last turn: the latest of its own provenance marker, the legacy
  # managed `<!-- oa-state ... -->` block, or the OVERNIGHT-AGENT sentinel. The turn runs
  # until the next `## ` section heading (the following entry) or EOF.
  #
  # NOTE the boundary is deliberately *this agent's* turn, not the last machine turn of any
  # kind. If it were the latter, a sequence of [user reply] -> [sibling skill turn] would put
  # the user's unanswered message ABOVE the boundary and silently swallow it.
  #
  # Every STRUCTURAL scan below reads `$scan`, the fence mask, so a marker, terminator or
  # heading that only exists inside a quoted example cannot move the boundary (#320/#325).
  # The mask is the same length as $content, so all offsets below are interchangeable and
  # every Substring still reads the original text.
  $scan = Get-FenceMaskedText $content
  $sentinelMarker = $scan.LastIndexOf('OVERNIGHT-AGENT do not edit')
  $selfMarker = -1
  foreach ($m in [regex]::Matches($scan, $script:ProvenanceRe)) {
    if ($m.Groups[1].Value.Trim() -eq $script:SelfAuthor) { $selfMarker = $m.Index }
  }

  $markers = @(
    $selfMarker,
    (Get-LastIndexOfPattern $scan $script:LegacyStateRe),
    $sentinelMarker
  )
  $agentMarker = ($markers | Measure-Object -Maximum).Maximum
  if ($agentMarker -lt 0) { return -1 }

  # --- The written-down boundary ----------------------------------------------------------
  # If this agent has stamped a turn-end terminator at or after its last anchor, that is
  # where its turn ended. It was written by `mark` at the moment the agent knew the answer,
  # so it needs no inference and cannot be fooled by a turn that happens to end in prose.
  #
  # Taking the LAST such marker is deliberate: a journal accumulates turns, and only the
  # newest terminator describes the current boundary.
  #
  # It is a starting point rather than the final answer, because the agent can append a
  # NEWER turn below it (see the managed-heading walk); a terminator with one of this
  # agent's own turn headings underneath it is simply stale.
  $turnEnd = -1
  foreach ($m in [regex]::Matches($scan, $script:TurnEndRe)) {
    if ($m.Index -ge $agentMarker) { $turnEnd = $m.Index + $m.Length }
  }
  if ($turnEnd -ge 0) {
    # Consume the newline that ends the marker line so the trailing region starts clean.
    if ($turnEnd -lt $content.Length -and $content[$turnEnd] -eq "`r") { $turnEnd++ }
    if ($turnEnd -lt $content.Length -and $content[$turnEnd] -eq "`n") { $turnEnd++ }
  }

  # --- Walk past MANAGED headings ---------------------------------------------------------
  # An H2 heading only ends the agent's turn if a *human* could have written it. Two shapes
  # are managed by this agent and must be stepped over instead:
  #
  #   1. `## <moon> Overnight Agent` -- SKILL.md's turn heading. When the agent writes another
  #      turn it opens one of these, so the previous turn's anchor is followed by a heading
  #      that is the agent's OWN newer turn. Stopping there puts that whole turn in the
  #      "trailing" region, where the no-marker branch of Test-TrailingHasUser reads it as
  #      user prose and pins the task at reopened with no message in it to answer.
  #   2. The first H2 after the sentinel, which is that same managed heading in older
  #      journals written before the <moon> convention existed.
  #
  # Anything else -- notably `## 2026-08-27`, the dated heading the planner app writes above
  # a user reply -- is a genuine boundary and stops the walk, so a real reply still reopens.
  #
  # Matching with `(?m)^` rather than IndexOf("`n## ") is load-bearing: after a terminator the
  # search resumes exactly at the start of a line, and a heading sitting flush at that offset
  # has no preceding newline inside the search region for IndexOf to find.
  $from = if ($turnEnd -ge 0) { $turnEnd } else { $agentMarker }
  $boundary = -1
  $sawManaged = $false
  $isFirstHeading = $true
  foreach ($h in [regex]::Matches($scan, '(?m)^##[ \t][^\r\n]*')) {
    if ($h.Index -lt $from) { continue }
    $managed = $h.Value -match $script:ManagedHeadingRe
    # Older journals opened the managed block with a heading that predates the naming
    # convention. Only the FIRST heading after the sentinel gets that benefit of the doubt --
    # consuming the allowance here, rather than on the first *unmanaged* heading, is what
    # stops it being spent on the user's `## <date>` reply further down.
    if (-not $managed -and $isFirstHeading -and $turnEnd -lt 0 -and
        $agentMarker -eq $sentinelMarker -and $h.Index -gt $agentMarker) {
      $managed = $true
    }
    $isFirstHeading = $false
    if (-not $managed) { $boundary = $h.Index; break }
    $sawManaged = $true
  }

  if ($boundary -lt 0) {
    # Nothing human below: either the agent's newest managed turn runs to EOF, or the
    # written-down boundary is still the last word.
    if ($sawManaged) { return $content.Length }
    if ($turnEnd -ge 0) { return $turnEnd }
    return $content.Length
  }
  # A terminator with no newer managed turn under it stands: everything below it belongs to
  # whoever wrote it next. (When there IS a newer managed turn, that terminator is stale and
  # the heading boundary below wins instead.)
  if (-not $sawManaged -and $turnEnd -ge 0) { return $turnEnd }
  $end = $boundary

  # --- Unstamped run-log recovery -------------------------------------------------------
  # Most historical journals contain NO `<!-- from: overnight-agent -->` marker: the agent
  # answered the user by appending a `### Run log` under their `## <date>` entry. The
  # boundary above then lands on that user heading, so the agent's own reply sits in the
  # "trailing" region and is mistaken for unanswered user prose -- pinning the journal at
  # HasTrailingUser=true forever. It reads as quiet only while the file is byte-identical to
  # the last snapshot, so any in-place edit by a sibling sweep (a dead-link rewrite, an
  # apostrophe repair) flips `changed` and the task false-reopens with a message that was
  # answered weeks ago.
  #
  # So: if this agent's `### Run log` appears AFTER the boundary, its reply is the newest
  # turn and the boundary belongs after it. Guarded by Test-IsRunLogBodyOnly, which refuses
  # to advance over anything that is not run-log shaped -- so raw user text appended below a
  # run log still reopens the task.
  $runLog = Get-LastIndexOfPattern $scan $script:RunLogRe
  if ($runLog -ge $end) {
    $afterRunLog = $scan.IndexOf("`n## ", $runLog)
    $regionEnd = if ($afterRunLog -lt 0) { $content.Length } else { $afterRunLog + 1 }
    $region = $content.Substring($runLog, $regionEnd - $runLog)
    if (Test-IsRunLogBodyOnly $region) { return $regionEnd }
  }

  return $end
}

function Test-TrailingHasUser([string]$trailing) {
  # Is there HUMAN content below this agent's last turn? Only the human reopens a task.
  #
  # The trailing region is a chat thread and may mix authors, because sibling skills append
  # their own turns here too. Split it into `## ` entries and judge each one by its marker:
  #   - `<!-- from: me -->`  -> the human spoke. Reopen.
  #   - any other marker     -> a sibling skill's turn. NOT a reopen: there is no message for
  #                             this agent to answer, and that skill re-appends on its own
  #                             schedule, so treating it as user prose pins the task at
  #                             `reopened` forever.
  #   - no marker at all     -> genuinely ambiguous (older journals, hand edits). Treat as the
  #                             human, which is the conservative direction: a false reopen
  #                             costs a look, a missed one loses the user's message.
  if ($trailing.Trim().Length -eq 0) { return $false }

  # Entry boundaries are H2 headings; text before the first heading belongs to the region as-is.
  # Split and judge markers on the fence mask (#320) so a quoted example neither invents an
  # entry boundary nor supplies an attribution the human never wrote. Judging is all this
  # function does -- it returns a bool, not a substring -- so the mask can be used throughout.
  $scan = Get-FenceMaskedText $trailing
  $entries = [regex]::Split($scan, '(?m)(?=^## )') | Where-Object { $_.Trim().Length -gt 0 }
  foreach ($entry in $entries) {
    $marks = [regex]::Matches($entry, $script:ProvenanceRe)
    if ($marks.Count -eq 0) { return $true }
    foreach ($m in $marks) {
      if ($m.Groups[1].Value.Trim() -eq $script:HumanAuthor) { return $true }
    }
  }
  return $false
}

# --- Consent authorship (#227) ---------------------------------------------------------
# TWO DIFFERENT QUESTIONS, TWO OPPOSITE DEFAULTS. This is the whole point of #227.
#
#   "Did the user speak?"      -> Test-TrailingHasUser. Unmarked prose counts AS the human.
#                                 FAIL OPEN, because the cost of being wrong is an extra look,
#                                 and the cost of the other error is losing the user's message.
#
#   "Did the human authorize   -> Test-TrailingHasConsent (below). Unmarked prose counts as
#    this irreversible act?"      NOT the human. FAIL CLOSED, because the cost of being wrong
#                                 is an action nobody sanctioned.
#
# Re-using the reopen reader for consent is the P9 violation: `<!-- from: me -->` is written by
# software the agent runs (the Telegram bridge folds phone replies under that marker), and the
# `no marker -> human` default means ANY unmarked text below the turn-end stamp is attributed to
# the human. A crash mid-write, a new sibling skill, or a refactor of write-turn.ps1 that drops
# its stamp all produce text this reader would otherwise read as consent.
#
# The boundary is enforced HERE, in the reader, not by asking every writer to remember to stamp
# itself. A writer that forgets its marker fails closed (its text is `unknown`, which is not the
# human), which is the requirement a convention cannot give.

function Get-AuthorSegments([string]$region) {
  # Split a region into (author, text) segments by provenance marker.
  #
  # Attribution is POSITIONAL, not per-entry: a marker owns the text that FOLLOWS it, up to the
  # next marker OR the next `## ` heading, whichever comes first.
  #
  # Positional beats per-`## ` entry here because a single heading block can legitimately hold
  # two authors (the agent answering inline under a user's heading). Judging the whole block by
  # "does it contain a human marker anywhere" would let agent-authored text inherit the human's
  # provenance, which is precisely the hole being closed.
  #
  # A `## ` HEADING ALSO ENDS OWNERSHIP (#272, added 2026-08-30 after the gate failed OPEN live).
  # ------------------------------------------------------------------------------------------
  # Running a marker's ownership to the *next marker* alone is what broke the gate: an agent turn
  # appended WITHOUT its `<!-- from: overnight-agent -->` stamp inserts no new marker, so the
  # human's marker above kept owning it -- all the way to the end of the region. Measured on #442:
  # Shiv's entire contribution was "should watchdog agent be doing reaps?" (a question, no
  # affirmative) and the following 15,400 characters were an unmarked agent turn containing
  # `approve`, `approved` and `yes` x2. The verdict came back `human-authored-affirmative`: the
  # agent had authorised itself, which is the exact direction #227 exists to prevent.
  #
  # A `## ` heading starts a NEW entry. An entry that does not carry its own provenance marker is
  # therefore not attributable to anyone, so its text becomes 'unknown' -- and 'unknown' is not the
  # human, so it fails closed. This keeps the guarantee in the reader (where it is enforced) rather
  # than in a convention every writer must remember; 114 of 238 journals prove the convention does
  # not hold. G7 in write-turn.ps1 closes the authoring half.
  #
  # It is deliberately narrow: text under a marker with NO intervening heading is untouched, so a
  # genuine approval still reads as one. Verified against the true positive #443, where `approve`
  # sits between `<!-- from: me -->` and the next `## ` -- it must keep returning consent_ok, or
  # this "fix" has merely broken the gate in the other direction.
  if ($null -eq $region) { return @() }
  $segments = @()
  # (Each segment also carries `Index`, its offset within $region -- see below.)
  # Markers and headings are located on the fence mask (#320): a `<!-- from: me -->` that only
  # exists inside a quoted example must not open a human-attributed segment. Offsets are
  # mask-identical, so every Substring below still slices the ORIGINAL region -- the segment
  # TEXT keeps its fences, and only the attribution stops being forgeable.
  $scan = Get-FenceMaskedText $region
  $marks = [regex]::Matches($scan, $script:ProvenanceRe)
  $headings = [regex]::Matches($scan, '(?m)^[ \t]*##[ \t]+\S')
  if ($marks.Count -eq 0) {
    if ($region.Trim().Length -gt 0) {
      $segments += [pscustomobject]@{ Author = 'unknown'; Text = $region; Index = 0 }
    }
    return $segments
  }

  # `Index` is the offset of the segment's TEXT within $region. It exists so a caller can ask
  # where a segment sits relative to other structure -- specifically, whether one of this agent's
  # turns was opened below an affirmative, which is how #465 decides an approval has been spent.
  # Without it a segment is just floating text and "did anything happen after this?" is
  # unanswerable, which is exactly how a week-old approve stayed live.
  $preamble = $region.Substring(0, $marks[0].Index)
  if ($preamble.Trim().Length -gt 0) {
    $segments += [pscustomobject]@{ Author = 'unknown'; Text = $preamble; Index = 0 }
  }
  for ($i = 0; $i -lt $marks.Count; $i++) {
    $start = $marks[$i].Index + $marks[$i].Length
    $end = if ($i + 1 -lt $marks.Count) { $marks[$i + 1].Index } else { $region.Length }

    # Clamp this marker's ownership at the first `## ` heading inside its span (#272). Anything
    # from that heading to `$end` is a new, unmarked entry: it belongs to whoever wrote it, which
    # we cannot know, so it is emitted as 'unknown' rather than inherited by this author.
    $cut = $end
    foreach ($h in $headings) {
      if ($h.Index -ge $start -and $h.Index -lt $end) { $cut = $h.Index; break }
    }

    $text = $region.Substring($start, $cut - $start)
    $segments += [pscustomobject]@{ Author = $marks[$i].Groups[1].Value.Trim(); Text = $text; Index = $start }

    if ($cut -lt $end) {
      $orphan = $region.Substring($cut, $end - $cut)
      if ($orphan.Trim().Length -gt 0) {
        $segments += [pscustomobject]@{ Author = 'unknown'; Text = $orphan; Index = $cut }
      }
    }
  }
  return $segments
}

function Get-ConsentFacts([string]$trailing) {
  # Verdict on whether the trailing region carries HUMAN consent, plus the evidence for it.
  #
  # `consent_ok` is true only when an affirmative phrase sits inside a segment positively
  # attributed to the human. Everything else -- unmarked prose, a sibling skill's turn, the
  # agent's own text, an empty region -- is NOT consent.
  #
  # `affirmative_unattributed` is the smoking gun the issue is about: an approval word that
  # exists but cannot be attributed to the human. It is surfaced rather than silently dropped
  # so a run can tell "nobody approved" apart from "something approved and it wasn't provably
  # you" -- the second is worth reporting, the first is just a quiet task.
  # `affirmative_answered` is #465: the affirmative IS his, and this agent has already opened a
  # turn below it, so it has been served. Reported as its own fact rather than folded into a bare
  # `false`, because "he approved and I acted on it" and "he never approved" call for different
  # behaviour -- the first means stop and ask again, the second means the task is simply quiet.
  $result = [ordered]@{
    consent_ok               = $false
    human_segments           = 0
    affirmative_phrase       = $null
    affirmative_author       = $null
    affirmative_unattributed = $false
    affirmative_answered     = $false
    reason                   = 'no-trailing-content'
  }
  if ([string]::IsNullOrWhiteSpace($trailing)) { return [pscustomobject]$result }

  $segments = @(Get-AuthorSegments $trailing)
  $result.human_segments = @($segments | Where-Object { $_.Author -eq $script:HumanAuthor }).Count

  # --- Where THIS agent opened a turn (#465) ----------------------------------------------
  # An affirmative is spent once this agent has replied beneath it. The written-down mechanism
  # for that is the turn-end stamp, which moves the trailing boundary past the approval -- but
  # it is a marker the writer must remember, and a turn that forgets it leaves the approval live
  # FOREVER. Measured: two journals identical except for that one line returned
  # `human-authored-affirmative` and `no-trailing-content` respectively. A gate whose verdict
  # turns on the agent's own bookkeeping about itself fails OPEN when the bookkeeping is missed,
  # which is the direction #227 exists to prevent.
  #
  # So consumption is derived from STRUCTURE instead, and structure survives a forgotten stamp:
  # this agent's own provenance marker, or its managed `## ... Overnight Agent` turn heading.
  # The heading is what makes it robust -- it is present even on the unstamped turns that are the
  # whole problem (164 of 244 journals carry no provenance marker today).
  #
  # ONLY THIS AGENT'S TURNS COUNT, and the narrowness is load-bearing: a sibling skill appending
  # below Shiv's `approve` has not answered him, so treating it as consumption would silently
  # discard a live approval -- a false negative in the gate, which is the mirror of the bug.
  #
  # Located on the fence mask (#320) for the same reason attribution is: a turn heading quoted
  # inside a code fence is an example, and an example must not be able to spend an approval.
  $scan = Get-FenceMaskedText $trailing
  $agentTurnAt = @()
  foreach ($m in [regex]::Matches($scan, $script:ProvenanceRe)) {
    if ($m.Groups[1].Value.Trim() -eq $script:SelfAuthor) { $agentTurnAt += $m.Index }
  }
  foreach ($m in [regex]::Matches($scan, '(?m)^[ \t]*##[^\r\n]*Overnight Agent')) {
    $agentTurnAt += $m.Index
  }

  foreach ($seg in $segments) {
    $m = [regex]::Match($seg.Text, $script:ConsentAffirmRe)
    if (-not $m.Success) { continue }
    if ($seg.Author -eq $script:HumanAuthor) {
      # Absolute offset of the affirmative itself, not of its segment: an approval typed at the
      # END of a long message must still be compared against what came after the WORD.
      $at = [int]$seg.Index + $m.Index
      $served = @($agentTurnAt | Where-Object { $_ -gt $at }).Count -gt 0
      if ($served) {
        # Spent. Keep scanning rather than returning: he may have approved AGAIN further down,
        # and a later affirmative with nothing beneath it is live. Without this, re-approving
        # after the agent replied would be impossible and the gate would deadlock closed.
        if (-not $result.affirmative_answered) {
          $result.affirmative_answered = $true
          $result.affirmative_phrase = $m.Value
          $result.affirmative_author = $seg.Author
        }
        continue
      }
      $result.consent_ok = $true
      $result.affirmative_phrase = $m.Value
      $result.affirmative_author = $seg.Author
      $result.reason = 'human-authored-affirmative'
      return [pscustomobject]$result
    }
    # Remember the first non-human affirmative, but keep scanning: a later segment may be the
    # genuine human approval, and finding one must win over having seen a machine one first.
    if (-not $result.affirmative_unattributed) {
      $result.affirmative_unattributed = $true
      # Do not overwrite a spent HUMAN affirmative with a machine one. Which words the agent
      # used matters far less than the fact that Shiv's own approval was found and consumed.
      if (-not $result.affirmative_answered) {
        $result.affirmative_phrase = $m.Value
        $result.affirmative_author = $seg.Author
      }
    }
  }

  # `human-affirmative-already-answered` outranks `affirmative-not-attributable-to-human`: both
  # can be true at once, and knowing his approval was found and spent is strictly more actionable
  # than knowing some machine said `yes` somewhere.
  $result.reason = if ($result.affirmative_answered) {
    'human-affirmative-already-answered'
  }
  elseif ($result.affirmative_unattributed) {
    'affirmative-not-attributable-to-human'
  }
  elseif ($result.human_segments -gt 0) { 'human-spoke-but-no-affirmative' }
  else { 'no-human-authored-content' }
  return [pscustomobject]$result
}

function Test-TrailingHasConsent([string]$trailing) {
  return [bool](Get-ConsentFacts $trailing).consent_ok
}

function Parse-LegacyOaState([string]$content) {
  # Read the LAST in-journal oa-state JSON, if any, to bootstrap status on migration.
  $m = [regex]::Matches($content, 'oa-state\s*\r?\n\s*(\{.*?\})\s*\r?\n\s*-->', 'Singleline')
  if ($m.Count -eq 0) { return $null }
  try { return ($m[$m.Count - 1].Groups[1].Value | ConvertFrom-Json) } catch { return $null }
}

function Read-JournalText([string]$path) {
  # ALWAYS decode journals as UTF-8, explicitly. Never `Get-Content -Raw`.
  #
  # These journals are UTF-8 with NO BOM, and the default decoder is host-dependent: Windows
  # PowerShell 5.1 falls back to the ANSI codepage, PowerShell 7 defaults to UTF-8. So the
  # SAME journal read by `Get-Content -Raw` yields different strings depending on which host
  # is running -- an em-dash arrives as one character under pwsh and as three under
  # powershell.exe.
  #
  # Two concrete harms, both observed live:
  #   1. CORRUPTION. Add-TurnTerminator does a read-modify-write. Under 5.1 it read mojibake
  #      and wrote it back as UTF-8, making the damage permanent. task-448.md lost 593 lines
  #      of correct text this way (1,487 sequences, damaged twice) before this was found.
  #   2. PHANTOM CHANGES. The processed_file_hash is computed from this string, so a journal
  #      hashed under one host and re-hashed under the other looks edited when nothing
  #      touched it -- which reads as the user having replied.
  #
  # Encoding is part of the read, not an ambient setting to inherit.
  if (-not (Test-Path $path)) { return '' }
  return [IO.File]::ReadAllText($path, (New-Object Text.UTF8Encoding($false)))
}

function Get-JournalFacts([string]$path) {
  $content = Read-JournalText $path
  if ($null -eq $content) { $content = '' }
  $id = [System.IO.Path]::GetFileNameWithoutExtension($path) -replace '^task-', ''
  $agentEnd = Get-AgentEndIndex $content
  $hasAgentBlock = $agentEnd -ge 0
  if ($agentEnd -lt 0) { $agentEnd = 0 }
  $agentLeft = $content.Substring(0, [Math]::Min($agentEnd, $content.Length))
  $trailing = if ($agentEnd -lt $content.Length) { $content.Substring($agentEnd) } else { '' }
  [pscustomobject]@{
    Id              = $id
    Path            = $path
    HasAgentBlock   = $hasAgentBlock
    FullHash        = Get-Sha256 $content
    AgentLeftHash   = Get-Sha256 $agentLeft     # file as the agent last left it (no trailing user prose)
    HasTrailingUser = (Test-TrailingHasUser $trailing)
    HasOpenAsk      = (Test-HasOpenAsk $agentLeft)       # visibility: digest must show it
    HasBlockingAsk  = (Test-HasBlockingAsk $agentLeft)   # gate: does it stop the run proceeding?
    Consent         = (Get-ConsentFacts $trailing)   # #227: fail-CLOSED authorship verdict
    Trailing        = $trailing
    Legacy          = Parse-LegacyOaState $content
  }
}

function State-Path([string]$id) { Join-Path $StateDir "task-$id.json" }

function Read-State([string]$id) {
  $p = State-Path $id
  if (Test-Path $p) { return (Get-Content -Raw $p | ConvertFrom-Json) }
  return $null
}

function Write-State($obj) {
  Ensure-StateDir
  ($obj | ConvertTo-Json -Depth 6) | Set-Content -Path (State-Path $obj.id) -Encoding UTF8
}

function Now-Iso { (Get-Date).ToString('yyyy-MM-ddTHH:mm:ssK') }

function Set-Member($obj, [string]$name, $value) {
  # PSCustomObjects from ConvertFrom-Json can't take a new property via `$o.x = ...`; add it.
  if ($obj.PSObject.Properties[$name]) { $obj.$name = $value }
  else { $obj | Add-Member -NotePropertyName $name -NotePropertyValue $value }
}

function Parse-PollMinutes([string]$spec) {
  # Cadence -> interval in minutes. Accepts hourly|daily|weekly|<N>h|<N>d|<N>m (case-insensitive).
  switch -regex ($spec.Trim().ToLower()) {
    '^hourly$' { return 60 }
    '^daily$' { return 1440 }
    '^weekly$' { return 10080 }
    '^(\d+)\s*h$' { return [int]$Matches[1] * 60 }
    '^(\d+)\s*d$' { return [int]$Matches[1] * 1440 }
    '^(\d+)\s*m$' { return [int]$Matches[1] }
    default { throw "invalid cadence '$spec' (use hourly|daily|weekly|<N>h|<N>d|<N>m)" }
  }
}

function New-PollObject([string]$cadence, [int]$minutes, [string]$lastPolled, [datetime]$nextDue) {
  [pscustomobject]@{
    cadence          = $cadence
    interval_minutes = $minutes
    last_polled      = $lastPolled
    next_due         = $nextDue.ToString('yyyy-MM-ddTHH:mm:ssK')
  }
}

function New-RecheckObject([string]$cadence, [int]$minutes, [string]$kind, [string]$lastRechecked, [datetime]$nextDue) {
  # Same timer shape as a poll (so Test-PollDue serves both), plus `kind` so a run can select
  # only the rechecks it is actually able to perform this pass.
  [pscustomobject]@{
    cadence          = $cadence
    interval_minutes = $minutes
    kind             = $kind
    last_rechecked   = $lastRechecked
    next_due         = $nextDue.ToString('yyyy-MM-ddTHH:mm:ssK')
  }
}

function Test-PollDue($poll) {
  # A poll with no next_due (freshly armed / malformed) is treated as due now.
  if (-not $poll) { return $false }
  if (-not $poll.next_due) { return $true }
  try { return ([datetime]::Parse($poll.next_due) -le (Get-Date)) }
  catch { return $true }
}

function Cmd-Seed {
  Ensure-StateDir
  $journals = Get-ChildItem $JournalDir -Filter 'task-*.md' -File | Where-Object { $_.BaseName -match '^task-\d+$' }
  $n = 0
  foreach ($f in $journals) {
    $facts = Get-JournalFacts $f.FullName
    if ((Read-State $facts.Id) -and -not $Force) { continue }
    $legacy = $facts.Legacy
    # Snapshot the hash of the file AS THE AGENT LAST LEFT IT (excludes any trailing user
    # prose). For a reopened task like #293 this differs from the current full hash, so the
    # very next `scan` correctly reports it reopened. Settled tasks have no trailing prose,
    # so AgentLeftHash == FullHash and they read as quiet.
    $state = [pscustomobject]@{
      id                  = $facts.Id
      status              = if ($legacy) { "$($legacy.status)" } elseif ($facts.HasAgentBlock) { 'unknown' } else { 'none' }
      version             = if ($legacy -and $legacy.version) { [int]$legacy.version } else { 0 }
      plan_id             = if ($legacy) { "$($legacy.plan_id)" } else { '' }
      processed_file_hash = $facts.AgentLeftHash
      has_agent_block     = $facts.HasAgentBlock
      seeded              = $true
      updated             = Now-Iso
    }
    Write-State $state
    $n++
  }
  Write-Output "seeded $n task state file(s) into $StateDir"
}

function Test-SnoozeActive {
  # A task counts as snoozed while its date is today or later, so the agent holds off
  # *through* the snooze date and only re-engages the day after. Errs toward respecting
  # the user's snooze rather than acting a day early. Returns the date, or $null.
  param([string]$Raw)
  if (-not $Raw) { return $null }
  $d = [datetime]::MinValue
  $ok = [datetime]::TryParseExact(
    $Raw.Trim(), 'yyyy-MM-dd',
    [System.Globalization.CultureInfo]::InvariantCulture,
    [System.Globalization.DateTimeStyles]::None, [ref]$d)
  if ($ok -and $d.Date -ge (Get-Date).Date) { return $Raw.Trim() }
  return $null
}

function Get-SnoozeFromStore {
  # snooze.json — the structured store the Planner web app owns (#391). Agent is READ-ONLY.
  # Shape: a flat map of task id -> ISO date, optionally wrapped:
  #   { "270": "2026-08-15" }              or   { "tasks":  { "270": "2026-08-15" } }
  #   { "snoozed": { "270": "..." } }      or   { "270": { "until": "2026-08-15" } }
  # Preferred over the in-markdown markers because it is typed, tiny, and does not ride on
  # planner.md — the most sync-conflicted, human-edited file in the folder. Parsing prose is
  # also where the markers bite: a task whose *title* contains "snooze:" (e.g. #391 itself)
  # will fool any regex that isn't strict about the <!-- --> wrapper.
  $map = @{}
  if (-not (Test-Path $SnoozeStore)) { return $null }   # $null = "no store", so fall back
  try {
    # Decode explicitly as UTF-8, for the same reason journals are (see Read-JournalText):
    # `Get-Content -Raw` takes its decoder from the host, so a snooze store holding any
    # non-ASCII character reads differently under powershell 5.1 and pwsh 7. This also keeps
    # the `oa-state/no-bare-raw-journal-read` capability honest rather than merely quiet.
    $raw = [IO.File]::ReadAllText($SnoozeStore, (New-Object Text.UTF8Encoding($false)))
    if ([string]::IsNullOrWhiteSpace($raw)) { return $map }
    $json = $raw | ConvertFrom-Json -ErrorAction Stop
  } catch {
    # A malformed store must never take the whole scan down, and must never be read as
    # "nothing is snoozed" — that would silently un-snooze every task. Fall back instead.
    Write-Warning "oa-state: could not parse $SnoozeStore ($($_.Exception.Message)); falling back to planner.md markers"
    return $null
  }
  foreach ($wrapper in 'tasks', 'snoozed') {
    if ($json.PSObject.Properties.Name -contains $wrapper -and $json.$wrapper) { $json = $json.$wrapper; break }
  }
  foreach ($prop in $json.PSObject.Properties) {
    if ($prop.Name -notmatch '^\d+$') { continue }        # ignore metadata keys like "version"
    $val = $prop.Value
    if ($val -isnot [string]) { $val = $val.until }        # tolerate { "until": "..." } objects
    $active = Test-SnoozeActive ([string]$val)
    if ($active) { $map[$prop.Name] = $active }
  }
  return $map
}

function Get-BoardRowId {
  # The task id of a planner.md table row, or $null if the line is not a task row.
  #
  # The id CELL is not always a bare integer. The board's ID column carries the task id
  # optionally followed by external references, e.g.
  #
  #     | 448,[176](https://github.com/shivbijlani/focus-planner/issues/176) | 🔴 | ... |
  #
  # The original pattern (`^\s*\|\s*(\d+)\s*\|`) required the cell to be digits and NOTHING
  # else, so it silently skipped that row entirely -- the row vanished from the board map and
  # from the snooze map at once, with no error anywhere.
  #
  # That is not a cosmetic miss. It is the Today->Deferred gate's only input. Measured on the
  # live board 2026-08-31: the board's ONE Today row used this compound form, so `Get-BoardMap`
  # returned no `today` rows at all, `$todayWorkable` was 0, the gate stood permanently open,
  # and the single 🔴 Today task sorted to position 232 of 238 -- behind all 121 Deferred rows,
  # which is the exact inversion the ordering rule exists to prevent. The run reads perfectly
  # clean while doing so, because "no Today rows" and "Today is finished" are indistinguishable
  # downstream.
  #
  # Parse the first CELL and take its leading digits: a header (`| ID |`) and a separator
  # (`|---|`) still yield nothing, so non-rows are rejected exactly as before.
  param([string]$Line)
  if ($Line -notmatch '^\s*\|') { return $null }
  $first = (($Line.Trim().Trim('|') -split '\|') | Select-Object -First 1)
  if ($null -eq $first) { return $null }
  if ($first.Trim() -match '^(\d+)') { return $Matches[1] }
  return $null
}

# The board's `Linked ID` column can never be one of the first five cells. Today is
# `ID | urgency | Task | Work Priority | Added | Linked ID` and Deferred inserts a `Wake`
# column before it, so the link is at index 5 or 6. The floor is what stops a short/ragged
# row -- `| 123 | icon | 456 |` -- from having its TASK TITLE read as a linked id.
$script:BoardLinkedMinIndex = 5

function Get-BoardRowLinkedIds {
  # The `Linked ID` cell of a planner.md row, as a list of task ids. This is the BOARD half of
  # SKILL.md's "Resolve the chain" step -- the half `extract` used to drop on the floor (#408).
  #
  # Why this is not simply `$cells[5]`: the live board's Deferred rows are RAGGED. Some carry the
  # `Wake` column and some do not, so the same table has 6- and 7-cell rows and a fixed index
  # reads the wrong column on half of them. Measured on the live board 2026-09-02: row 467 has 6
  # cells, row 437 has 7.
  #
  # So: prefer the index the table's own HEADER declares (future-proof if a column is ever
  # appended after Linked ID), and fall back to the last non-empty cell, which is where the
  # column sits in both shapes.
  param([string]$Line, [int]$LinkedIndex = -1)
  # Trailing `<!-- snooze:YYYY-MM-DD -->` markers live AFTER the final pipe (#353), so a naive
  # last-cell read returns the COMMENT rather than the link. Strip comments before splitting.
  $clean = [regex]::Replace($Line, '<!--.*?-->', '')
  $cells = @(($clean.Trim().Trim('|') -split '\|') | ForEach-Object { $_.Trim() })
  $last = $cells.Count - 1
  while ($last -ge 0 -and [string]::IsNullOrWhiteSpace($cells[$last])) { $last-- }
  if ($last -lt $script:BoardLinkedMinIndex) { return @() }
  $idx = if ($LinkedIndex -ge $script:BoardLinkedMinIndex -and $LinkedIndex -le $last) { $LinkedIndex } else { $last }
  $cell = $cells[$idx]
  # A date is the `Added`/`Wake` column, never a link. Without this a Deferred row whose Linked ID
  # is empty but whose Wake date is set would report the wake date as a linked task id.
  if ($cell -match '^\d{4}-\d{2}-\d{2}') { return @() }
  $ids = @()
  foreach ($m in [regex]::Matches($cell, '(?<!\d)\d{1,6}(?!\d)')) {
    if ($ids -notcontains $m.Value) { $ids += $m.Value }
  }
  return $ids
}

function Get-SnoozeFromBoard {
  # Legacy path: `<!-- snooze:YYYY-MM-DD -->` HTML comments stamped onto planner.md rows by
  # the #353 feature. Kept as a migration fallback so nothing breaks the day snooze.json
  # lands and old markers keep working until the web app switches over.
  $map = @{}
  if (-not (Test-Path $PlannerBoard)) { return $map }
  foreach ($line in (Get-Content -Path $PlannerBoard)) {
    # Board rows look like: | 327 | 🟡 | Task… | P1 | 2026-07-20 | 353 | <!-- snooze:2026-08-18 -->
    $tid = Get-BoardRowId $line
    if (-not $tid) { continue }
    # The <!-- --> wrapper is REQUIRED. Without it a task titled "snooze: …" matches its own
    # title and hides itself from the board — the concrete failure mode behind #391.
    if ($line -match '<!--\s*snooze:(\d{4}-\d{2}-\d{2})\s*-->') {
      $active = Test-SnoozeActive $Matches[1]
      if ($active) { $map[$tid] = $active }
    }
  }
  return $map
}

function Get-SnoozeMap {
  # Build id -> snooze-until (yyyy-MM-dd) for tasks that are CURRENTLY snoozed.
  # Order: snooze.json (structured, web-app-owned) wins; planner.md markers fill the gaps.
  # The union is deliberate — during migration some tasks live in one store and some in the
  # other, and dropping either would silently un-snooze tasks the user asked to hide.
  $board = Get-SnoozeFromBoard
  $store = Get-SnoozeFromStore
  if ($null -eq $store) { return $board }   # no store yet, or unreadable → legacy behaviour
  $merged = @{}
  foreach ($k in $board.Keys) { $merged[$k] = $board[$k] }
  foreach ($k in $store.Keys) { $merged[$k] = $store[$k] }   # store wins on conflict
  return $merged
}

function Get-PrioritiesRank {
  # The `## Priorities` block at the bottom of planner.md is the user's own ordered list of task
  # IDs ("1. 285", "2. 191", ...). It is the third sort key in #223, below section and priority.
  param([string[]]$Lines)
  $rank = @{}
  $inSection = $false
  $n = 0
  foreach ($line in $Lines) {
    if ($line -match '^##\s') { $inSection = ($line -match '^##\s*Priorities\b'); continue }
    if (-not $inSection) { continue }
    if ($line -match '^\s*\d+\.\s+(\d+)\s*$') { $rank[$Matches[1]] = $n; $n++ }
  }
  return $rank
}

function Get-BoardMap {
  # id -> { section, urgency, work_priority, board_pos, linked } for every row on the board.
  #
  # Read with the explicit UTF-8 decoder, NOT Get-Content: the urgency cell is an emoji, and
  # under Windows PowerShell 5.1 a bare read decodes these BOM-less files as the ANSI codepage,
  # so every icon would arrive as mojibake and rank as "unknown" (HAZARD 4, user-settings.md).
  $map = @{}
  if (-not (Test-Path $PlannerBoard)) { return $map }
  $lines = (Read-JournalText $PlannerBoard) -split "`r?`n"
  $section = 'other'
  $pos = 0
  $linkedIdx = -1
  foreach ($line in $lines) {
    if ($line -match '^##\s*Today\b') { $section = 'today'; $linkedIdx = -1; continue }
    elseif ($line -match '^##\s*Deferred\b') { $section = 'deferred'; $linkedIdx = -1; continue }
    elseif ($line -match '^##\s') { $section = 'other'; $linkedIdx = -1; continue }
    # A table's own header names the Linked ID column, so the parse follows the board rather than
    # a hard-coded position. Learned per table because Today and Deferred put it at different
    # indices; reset on every section so one table's header can never speak for another's rows.
    if ($line -match '^\s*\|' -and $line -match '(?i)\bLinked\s*ID\b') {
      $hdr = @((($line.Trim().Trim('|') -split '\|') | ForEach-Object { $_.Trim() }))
      for ($i = 0; $i -lt $hdr.Count; $i++) { if ($hdr[$i] -match '(?i)^Linked\s*ID$') { $linkedIdx = $i; break } }
    }
    $id = Get-BoardRowId $line
    if (-not $id) { continue }
    $cells = ($line.Trim().Trim('|') -split '\|') | ForEach-Object { $_.Trim() }
    # Today is `ID | urgency | Task | Work Priority | Added | Linked ID` and Deferred inserts a
    # `Wake` column before Linked ID, so the first four cells line up in both tables.
    $wp = if ($cells.Count -ge 4 -and $cells[3] -match '^(P[0-9])$') { $Matches[1] } else { $null }
    $pos++
    $map[$id] = [pscustomobject]@{
      section       = $section
      urgency       = if ($cells.Count -ge 2) { $cells[1] } else { '' }
      work_priority = $wp
      board_pos     = $pos
      # #408: the upstream link, kept instead of discarded. It was parsed out of this very line
      # and then dropped, so `extract` reported `linked: (none)` for a task whose board row named
      # its parent -- and the mandated upstream walk never happened.
      linked        = @(Get-BoardRowLinkedIds -Line $line -LinkedIndex $linkedIdx)
    }
  }
  return $map
}

function Get-BoardLinkFacts {
  # The board half of the linked-task walk, with its OWN read state reported rather than folded
  # into an empty result (#408 acceptance criterion 3).
  #
  # `Get-BoardMap` returns an empty hashtable for a board that is missing, unreadable, or simply
  # has no rows -- three very different facts that all look identical downstream. Collapsing them
  # is exactly how `(none)` came to mean "I did not check": a pointer block that cannot report its
  # own gaps is worse than one that has them.
  param([string]$Id)
  $facts = [ordered]@{ Read = $false; RowFound = $false; Ids = @(); Note = ''; Path = "$PlannerBoard" }
  if ([string]::IsNullOrWhiteSpace($PlannerBoard)) {
    $facts.Note = 'no planner board path configured'
    return [pscustomobject]$facts
  }
  if (-not (Test-Path -LiteralPath $PlannerBoard)) {
    $facts.Note = "no board file at $PlannerBoard"
    return [pscustomobject]$facts
  }
  $map = $null
  try { $map = Get-BoardMap }
  catch {
    $facts.Note = "board unreadable: $($_.Exception.Message)"
    return [pscustomobject]$facts
  }
  $facts.Read = $true
  $row = $map["$Id"]
  if (-not $row) {
    # Read, but this task has no row -- e.g. it already moved to planner-completed.md. The board
    # genuinely contributes nothing, and saying WHY costs one clause.
    $facts.Note = "no board row for task $Id"
    return [pscustomobject]$facts
  }
  $facts.RowFound = $true
  $facts.Ids = @($row.linked)
  return [pscustomobject]$facts
}

# Urgency icons, built from codepoints on purpose: a literal emoji in a comparison line is the
# LOAD-BEARING class that ps1-encoding-sweep.mjs flags, because 5.1 would compare against
# mojibake. Codepoints keep this file's logic pure ASCII.
$script:UrgencyRank = @{
  ([char]::ConvertFromUtf32(0x1F534)) = 0   # red
  ([char]::ConvertFromUtf32(0x1F7E1)) = 1   # yellow
  ([char]::ConvertFromUtf32(0x1F4D6)) = 2   # book / reading
  ([char]::ConvertFromUtf32(0x26AA))  = 3   # white
}

function Get-UrgencyRank([string]$icon) {
  if ([string]::IsNullOrWhiteSpace($icon)) { return 4 }
  foreach ($k in $script:UrgencyRank.Keys) { if ($icon.Contains($k)) { return $script:UrgencyRank[$k] } }
  return 4
}

function Get-TodaySectionText {
  # The substantive rows of the board's `## Today` section, trimmed, one per line.
  #
  # This is the SUBJECT of an exhaustion declaration (#310). "I examined everything Today holds
  # and there is nothing workable left this run" is a claim ABOUT this text, so when the text
  # changes the claim is about a board that no longer exists and must be made again. That is the
  # part of the release signal the agent does NOT author: the human revokes it by editing Today.
  #
  # Blank lines are dropped and every line is trimmed, so whitespace churn from an editor or from
  # OneDrive cannot invalidate a live declaration -- only an actual add/remove/edit of a row can.
  if (-not (Test-Path $PlannerBoard)) { return '' }
  $lines = (Read-JournalText $PlannerBoard) -split "`r?`n"
  $out = New-Object Text.StringBuilder
  $inToday = $false
  foreach ($line in $lines) {
    if ($line -match '^##\s') { $inToday = [bool]($line -match '^##\s*Today\b'); continue }
    if (-not $inToday) { continue }
    $t = $line.Trim()
    if ($t.Length -gt 0) { [void]$out.AppendLine($t) }
  }
  return $out.ToString()
}

function Get-TodaySectionHash { return (Get-Sha256 (Get-TodaySectionText)) }

function Get-SectionRank([string]$section) {
  switch ($section) { 'today' { 0 } 'deferred' { 1 } default { 2 } }
}

function Get-PriorityRank($wp) {
  if ($wp -match '^P([0-9])$') { return [int]$Matches[1] }
  return 9   # unset sorts after every explicit priority
}

# A task is "workable" when the agent could actually do something with it this run. Terminal and
# waiting-on-the-user states are NOT workable -- that is what lets Today drain so Deferred can
# open up (#223 rule 1). Snoozed is handled by the caller, which outranks everything.
#
# `awaiting_reply` is the fourth waiting state, and it is a STATE, not a status: an `in-progress`
# task whose newest agent turn still asks the user something is waiting on them just as much as a
# `proposed` one, and the run is required to replace rather than append to that turn. Leaving it
# out of this list let a single unanswered Today row hold the whole Deferred backlog shut.
$script:NonWorkableStatus = @('done', 'skip', 'proposed', 'blocked')

# #170 cause 3: the CLOSED statuses. A reply arriving on one of these is a real message from a
# real person, and it must still be SEEN -- but seeing it and reanimating the task are different
# acts, and only the first one was ever asked for. Shiv, on task #400: "I don't think we need to
# handle the case where a reply on a closed task is considered [a reopen]".
#
# `proposed`/`blocked` are deliberately NOT here. Those are waiting-on-the-user states, so a reply
# is exactly the input they are waiting for and must reopen them normally. Only work the user has
# CLOSED is protected from being reanimated by a passing remark.
$script:ClosedStatus = @('done', 'skip')

function Test-ReopenedClosed($row) {
  # A reply landed on a task the user had closed. Reported, never worked.
  return [bool]($row.reopened -and ($script:ClosedStatus -contains "$($row.status)"))
}

function Test-Workable($row) {
  if ($row.snoozed) { return $false }
  # #170 cause 3, and this ORDER is the whole fix. `reopened` used to return $true here
  # unconditionally, one line earlier than the status gate below -- so a reply on a `done` task
  # jumped the gate that exists to keep finished work finished, and the run wrote a fresh turn
  # into it. Measured on the live board 2026-08-22: task #385 (Levolor shades) was cancelled on
  # 2026-07-28, sits on the completed board, and a JULY journal entry was re-posted into its
  # Telegram topic, floating the finished task back to the top of the group. 4 of 23 recently
  # re-posted tasks were completed-board tasks -- ~17% of mirror traffic going into closed work.
  #
  # The asymmetry is deliberate and is the reason this is safe: a missed nudge on a closed task
  # is cheap and STAYS VISIBLE (the run reports it, quoted, under "Replies on closed tasks", and
  # the row can be reopened by saying so or by moving it back onto the board). Silently
  # reanimating finished work is the actual complaint, and it is not visible at all.
  if (Test-ReopenedClosed $row) { return $false }
  if ($row.reopened) { return $true }   # a live reply is always workable (#223 rule 4)
  # A DUE timer outranks the awaiting-reply park. A poll/recheck is read-only agent work that
  # needs no reply, so parking it on "the user has not answered" would silently stop exactly the
  # recurring duty polling exists to protect -- SKILL.md's "a purely time-based job would be
  # invisible and silently stop the moment the user stops replying". Measured on the live board:
  # all 3 polled and both recheck tasks are awaiting_reply, so without this they would all stop.
  # It yields only the park, never the status gate below.
  if ($row.awaiting_reply -and -not $row.due_poll -and -not $row.due_recheck) { return $false }
  # A DUE RECHECK must also yield the `blocked` STATUS gate, not merely the awaiting-reply park
  # above. `-Recheck` is documented as, and exists only for, "a recurring recheck of a BLOCKED
  # task's blocker" -- so every task carrying one is `blocked` by construction. Leaving `blocked`
  # in the gate below therefore made the entire feature INERT: the timer computed `due_recheck`
  # correctly and the verdict was then discarded one line later, every time.
  #
  # This is the same silent-starvation shape as the awaiting_reply bug above, one layer down, and
  # it survived for the same reason that one did -- the guard asserted the SIGNAL (`due_recheck`)
  # and never the CONSEQUENCE (`eligible`), so a fired-and-ignored timer read as healthy.
  # Measured live 2026-08-31: all three armed rechecks (#236, #393, #416) reported
  # `due_recheck: true` with `eligible: false`. Not one had ever been able to run.
  #
  # `done`/`skip` are deliberately NOT yielded: re-surfacing a closed task is the #170
  # "agent executes in closed tasks" bug, and a recheck must never be able to reopen one.
  if ($row.due_recheck -and "$($row.status)".ToLowerInvariant() -eq 'blocked') { return $true }
  return ($script:NonWorkableStatus -notcontains "$($row.status)".ToLowerInvariant())
}

# Does this Today row still deserve the run's EXCLUSIVE attention -- i.e. does it hold the
# Today->Deferred gate shut? (#223 rule 1, corrected 2026-08-31, corrected again in #310.)
#
# THIS HAS BEEN WRONG TWICE, IN OPPOSITE DIRECTIONS. Both readings are recorded here because
# the fix is only defensible as the thing that satisfies BOTH at once.
#
# WRONG READING 1 -- "a Deferred row is ineligible while any Today row is WORKABLE".
# Workability is a property of the BOARD, not of the run, so the gate can only open if a Today
# row stops being workable. Measured live 2026-08-31: the entire `## Today` section was a SINGLE
# standing meta-task (#448, "triage fix and ship GitHub issues"), unbounded by construction, so
# `in-progress` and workable forever. It held 121 Deferred rows shut on every run; `scan`
# reported 1 eligible row out of 238, and three runs in one night each re-worked that one task
# and touched nothing else. A gate keyed to workability NEVER OPENS for an unbounded row.
#
# WRONG READING 2 -- "a Today row is SERVED for N minutes after the agent last wrote a turn".
# That is what replaced reading 1, and it made the release signal `last_turn_at`, which `mark`
# stamps to now on EVERY turn. So the agent opened its own gate BY TYPING: one `mark`, with any
# content, at any completion state, released the whole Deferred backlog for the rest of the run.
# Measured live 2026-08-31 22:20 PT: after one turn on #463 -- still `in-progress`, its queue
# nowhere near drained, four criticals unworked -- eligibility went 1 -> 13 and the run moved to
# a Deferred-adjacent task at order 181. Note the field is named `last_turn_at`, not
# `last_completed_at`: the data needed to answer "is this done" was never collected at all.
#
# That is the third instance of ONE failure class in this repo: THE AGENT AUTHORS THE SIGNAL
# THAT ITS OWN GATE READS. (#227/#272: the agent's unmarked prose read back as the human's
# consent. The `awaiting_reply` ratchet: the agent's closing courtesy line parked its own task,
# 186 of 238 rows parked, 0 eligible. This.) Each reader was correct in isolation and wrong
# because the thing it read was agent-authored.
#
# THE CORRECTION: release on EXHAUSTION, and make exhaustion a deliberate DECLARATION rather
# than a side effect of writing. A Today row stops being exclusive when, and only when:
#
#   not_workable         it is terminal (`done`/`skip`) or genuinely waiting on the user
#                        (`proposed`, `blocked`, `awaiting_reply`, snoozed). Unchanged.
#   declared_exhausted   the run has affirmatively declared -- in its own separate call, naming
#                        what it examined -- that this row has nothing workable left THIS RUN,
#                        and that declaration is still standing (see Test-ExhaustionClaim).
#   stale_turn_backstop  nobody has written a turn here for -TodayGateBackstopHours, so the run
#                        is wedged and the backlog is released rather than frozen behind it.
#
# Writing a turn is now NECESSARY-BUT-NOT-SUFFICIENT for the declaration and, on its own, moves
# the gate in the SAFE direction only: it resets the backstop, i.e. typing makes the gate hold
# LONGER, never shorter. That inversion is the whole of the #310 fix.
#
# Every branch that is unsure HOLDS, so an unknown or unparseable input preserves Today-first
# exclusivity rather than opening the backlog by accident.
function Get-TodayGateVerdict($row, [string]$todayHash) {
  if (-not (Test-Workable $row)) {
    return [pscustomobject]@{ holds = $false; reason = 'not_workable' }
  }
  # A live reply is the highest-value work there is, AND it invalidates any standing claim that
  # this row was examined -- the thing that was examined has just changed underneath the claim.
  if ($row.reopened) {
    return [pscustomobject]@{ holds = $true; reason = 'holding:reopened' }
  }
  if ($script:GateStrict) {
    return [pscustomobject]@{ holds = $true; reason = 'holding:strict' }
  }

  $claim = Test-ExhaustionClaim $row.exhaustion $row $todayHash
  if ($claim -eq 'declared_exhausted') {
    return [pscustomobject]@{ holds = $false; reason = 'declared_exhausted' }
  }

  # The wedged-run backstop. Deliberately keyed to STALENESS, never to recency: it fires because
  # the agent has NOT written here, and any turn written resets it. There is therefore no way to
  # reach this release by writing, which is precisely what #310 was.
  if ($script:BackstopHours -gt 0 -and $row.last_turn_at) {
    $t = [datetime]::MinValue
    if ([datetime]::TryParse(
        "$($row.last_turn_at)", [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::None, [ref]$t)) {
      if (((Get-Date) - $t).TotalHours -ge $script:BackstopHours) {
        return [pscustomobject]@{ holds = $false; reason = 'stale_turn_backstop' }
      }
    }
  }

  return [pscustomobject]@{ holds = $true; reason = $claim }
}

# Is a stored exhaustion declaration still standing? Returns `declared_exhausted` when it is,
# and otherwise a `holding:<why-not>` string that goes straight into `today_release_reason`, so
# a run's selection can be audited afterwards without re-deriving anything.
#
# The four ways a declaration stops standing are the reason this is a claim rather than a latch,
# and three of the four are invalidated by state the AGENT DOES NOT AUTHOR:
#
#   exhaustion_expired        older than -ExhaustionTtlMinutes. A declaration is scoped to the
#                             run that made it; the next run must look again.
#   exhaustion_stale_board    the `## Today` section of planner.md has changed since the claim
#                             was made. "I examined everything Today holds" is a statement ABOUT
#                             that text, so the HUMAN revokes it simply by editing the board.
#   exhaustion_superseded     a turn was written to this row AFTER the declaration. Writing more
#                             work on a row you just called exhausted refutes the claim, by the
#                             run's own record. This is what makes the declaration awkward to
#                             make falsely: claim it early and every later turn cancels it.
#   declaration_named_nothing the claim names no examined item, so it asserts nothing.
function Test-ExhaustionClaim($ex, $row, [string]$todayHash) {
  if ($ExhaustionTtlMinutes -le 0) { return 'holding:declaration_disabled' }
  if (-not $ex) { return 'holding:no_declaration' }
  $examined = @()
  if ($ex.PSObject.Properties['examined'] -and $ex.examined) { $examined = @($ex.examined) }
  if ($examined.Count -eq 0) { return 'holding:declaration_named_nothing' }

  $at = [datetime]::MinValue
  if (-not [datetime]::TryParse(
      "$($ex.at)", [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::None, [ref]$at)) { return 'holding:declaration_unparseable' }
  if (((Get-Date) - $at).TotalMinutes -ge $ExhaustionTtlMinutes) { return 'holding:exhaustion_expired' }

  if ("$($ex.today_hash)" -ne $todayHash) { return 'holding:exhaustion_stale_board' }

  if ($row.last_turn_at) {
    $lt = [datetime]::MinValue
    if ([datetime]::TryParse(
        "$($row.last_turn_at)", [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::None, [ref]$lt)) {
      # Strictly AFTER. Both stamps have one-second resolution, so the declaration made in the
      # same second as the turn that preceded it must not refute itself.
      if ($lt -gt $at) { return 'holding:exhaustion_superseded' }
    }
  }

  return 'declared_exhausted'
}

function Cmd-Scan {
  $snooze = Get-SnoozeMap
  $board = Get-BoardMap
  $boardLines = @()
  if (Test-Path $PlannerBoard) { $boardLines = (Read-JournalText $PlannerBoard) -split "`r?`n" }
  $prioRank = Get-PrioritiesRank $boardLines
  $journals = Get-ChildItem $JournalDir -Filter 'task-*.md' -File | Where-Object { $_.BaseName -match '^task-\d+$' } | Sort-Object Name
  $rows = foreach ($f in $journals) {
    $facts = Get-JournalFacts $f.FullName
    $st = Read-State $facts.Id
    $poll = $null
    $recheck = $null
    if ($st) {
      $changed = ($facts.FullHash -ne $st.processed_file_hash)
      $reopened = $changed -and $facts.HasTrailingUser
      $status = "$($st.status)"
      if ($st.PSObject.Properties['poll']) { $poll = $st.poll }
      if ($st.PSObject.Properties['recheck']) { $recheck = $st.recheck }
    }
    else {
      # No memory yet: a task is "reopened/active" only if the user has left prose below the
      # agent's last block; otherwise it's genuinely new (no agent block) -> propose.
      $changed = $true
      $reopened = $facts.HasTrailingUser
      $status = if ($facts.HasAgentBlock) { 'unknown' } else { 'none' }
    }
    $snoozeUntil = if ($snooze.ContainsKey($facts.Id)) { $snooze[$facts.Id] } else { $null }
    # Snooze is the user's explicit "not until <date>", so it outranks both timers. Suppress the
    # DUE verdict only -- the timer object itself is left armed, so it fires again on its own once
    # the snooze lapses rather than being silently disarmed by it.
    $isSnoozed = [bool]$snoozeUntil
    $b = $board[$facts.Id]
    $section = 'other'
    $urgency = ''
    $workPriority = $null
    $boardPos = 999999
    $boardLinked = @()
    if ($b) {
      $section = $b.section
      $urgency = $b.urgency
      $workPriority = $b.work_priority
      $boardPos = $b.board_pos
      $boardLinked = @($b.linked)
    }
    $pRank = 999999
    if ($prioRank.ContainsKey($facts.Id)) { $pRank = $prioRank[$facts.Id] }
    # #423: resolve the doc binding for this row (state first, journal stamp as fallback).
    $docFacts = Get-DocState $st $f.FullName
    # #404: the per-task session binding, read-only.
    $sessFacts = Get-SessionState $st
    [pscustomobject]@{
      id            = $facts.Id
      status        = $status
      changed       = $changed
      reopened      = $reopened
      has_agent_block = $facts.HasAgentBlock
      tracked       = [bool]$st
      snoozed       = $isSnoozed
      snooze_until  = $snoozeUntil
      # #223: the board joined onto each row, so selection order is DATA rather than the agent's
      # judgement. Before this, scan emitted rows in task-ID order with no notion of section or
      # priority at all, and "Today first" existed only as prose in SKILL.md.
      section       = $section
      urgency       = $urgency
      work_priority = $workPriority
      board_pos     = $boardPos
      # #408: the row's `Linked ID`, carried through instead of discarded. SKILL.md's "Resolve
      # the chain" step needs it before planning, and it was previously parsed and thrown away.
      linked        = @($boardLinked)
      priorities_rank = $pRank
      due_poll      = [bool]((Test-PollDue $poll) -and -not $isSnoozed)
      poll_cadence  = if ($poll) { "$($poll.cadence)" } else { $null }
      due_recheck   = [bool]((Test-PollDue $recheck) -and -not $isSnoozed)
      recheck_cadence = if ($recheck) { "$($recheck.cadence)" } else { $null }
      recheck_kind  = if ($recheck) { "$($recheck.kind)" } else { $null }
      # #227: does the trailing region carry consent the HUMAN provably authored? Distinct from
      # `reopened`, which counts unmarked prose as the user on purpose. Never infer approval for
      # an irreversible action from `reopened` -- read this instead.
      consent_ok    = [bool]$facts.Consent.consent_ok
      consent_reason = "$($facts.Consent.reason)"
      # The agent spoke last and its newest turn still carries an open ask, so this task is
      # waiting on the user -- the same state `proposed` encodes, reached from `in-progress`.
      # `reopened` outranks it (Test-Workable checks that first), so a reply un-parks it at once.
      has_open_ask   = [bool]$facts.HasOpenAsk
      # #170 cause 3: a reply that landed on a task the user had CLOSED. It is deliberately not
      # workable -- see Test-Workable -- but it is emitted so the run can SURFACE it (quoted, in
      # the wrap-up) rather than swallow it. Suppressing the work without reporting the message
      # would trade one silent failure for another.
      reopened_closed = [bool]($reopened -and ($script:ClosedStatus -contains "$status"))
      awaiting_reply = [bool]($facts.HasAgentBlock -and $facts.HasBlockingAsk -and -not $facts.HasTrailingUser)
      # When the agent last wrote a TURN here (`mark` stamps it; `seed` and `resnapshot`
      # deliberately do not). Since #310 this is NOT a release signal: it feeds the wedged-run
      # backstop, where a FRESH stamp holds the gate and only a STALE one can release it.
      last_turn_at   = if ($st -and $st.PSObject.Properties['last_turn_at']) { "$($st.last_turn_at)" } else { $null }
      # #423: the durable task->doc binding, surfaced on the ONE worklist rather than a second
      # one. Resolved state-first with the journal stamp as fallback, so a lost state store still
      # reports the right doc instead of reading as "unbound" (which is the value that would make
      # a caller create a duplicate). This is READ-ONLY here -- `scan` never heals, because a
      # read command that writes is a read command nobody can run twice safely; `doc -Id <id>`
      # performs the heal.
      doc_id        = if ($docFacts.doc) { "$($docFacts.doc.doc_id)" } else { $null }
      doc_bound     = [bool]($docFacts.doc -and "$($docFacts.doc.doc_id)")
      doc_source    = $docFacts.source
      # Comments reported new by the last `doc -Observe` and not yet `-Ack`ed. Non-zero means the
      # user has said something on the doc that this run has not answered -- the doc-surface
      # analogue of `reopened`.
      doc_new_comments = if ($docFacts.doc) { @($docFacts.doc.pending_ids).Count } else { 0 }
      # #404: the per-task session, on the SAME worklist as everything else, for the reason #423
      # gives -- a binding that lives on a second list the run has to remember to consult is a
      # binding the run will forget. READ-ONLY here: `scan` reports the verdict, and only the
      # `session` command writes. A run that sees `session_verdict: reuse` must wake THAT session
      # rather than create a second one.
      session_id      = if ($sessFacts) { "$($sessFacts.session_id)" } else { $null }
      session_state   = if ($sessFacts) { "$($sessFacts.state)" } else { $null }
      session_verdict = (Get-SessionVerdict $sessFacts)
      session_workspace = if ($sessFacts -and "$($sessFacts.workspace)") { "$($sessFacts.workspace)" } else { $null }
      # The standing exhaustion declaration for this row, verbatim (#310), so a human can audit
      # what the run claimed to have examined and against which board it claimed it.
      exhaustion     = if ($st -and $st.PSObject.Properties['today_exhausted']) { $st.today_exhausted } else { $null }
    }
  }

  # ---- #223: deterministic selection order -------------------------------------------------
  # Rule 1  Today before Deferred, and a Deferred row is not eligible while any Today row is
  #         still workable.
  # Rule 2  Within a section: Work Priority (P0>P1>P2>unset), then urgency icon, then the
  #         `## Priorities` list, then board row order, then task id.
  # Rule 4  `reopened` preempts everything -- a live reply is the highest-value work there is.
  #
  # Sorting here rather than in the agent's head is the whole point of the issue: two runs over
  # an unchanged board must produce the same order, and the order must be auditable afterwards.
  $rows = $rows | Sort-Object `
    @{ Expression = { if ($_.reopened) { 0 } else { 1 } } }, `
    @{ Expression = { Get-SectionRank $_.section } }, `
    @{ Expression = { Get-PriorityRank $_.work_priority } }, `
    @{ Expression = { Get-UrgencyRank $_.urgency } }, `
    @{ Expression = { $_.priorities_rank } }, `
    @{ Expression = { $_.board_pos } }, `
    @{ Expression = { [int]$_.id } }

  # The gate is computed from the WHOLE set, so it cannot be evaluated per-row in the loop above.
  # NOTE this counts rows that still hold the gate SHUT, which is narrower than "workable": a
  # Today row the run has DECLARED EXHAUSTED stays workable (and eligible, at its own board rank)
  # but stops blocking Deferred. See Get-TodayGateVerdict for why, and for the two ways this has
  # been got wrong already.
  $todayHash = Get-TodaySectionHash
  $verdicts = @{}
  foreach ($r in $rows) {
    if ($r.section -eq 'today') { $verdicts["$($r.id)"] = (Get-TodayGateVerdict $r $todayHash) }
  }
  $todayHolding = @($verdicts.Values | Where-Object { $_.holds }).Count
  $order = 0
  foreach ($r in $rows) {
    $order++
    $eligible = $false
    if (-not $r.snoozed) {
      # #170 cause 3: `reopened` beating the gate is rule 4, and it is right -- a live reply is
      # the highest-value work there is. But it must be a reply on work that is still OPEN.
      # This shortcut is the SECOND place the old "a reply always wins" rule lived, above the
      # `Test-Workable` calls below, so fixing only `Test-Workable` left the row ineligible by
      # one reader and force-eligible by this one. Measured while fixing it: the gate verdict
      # correctly read `not_workable` while `eligible` still came back `true`, so the run would
      # have been handed a closed task anyway.
      if (Test-ReopenedClosed $r) { $eligible = $false }
      elseif ($r.reopened) { $eligible = $true }                  # rule 4 beats the gate
      elseif ($r.section -eq 'today') { $eligible = (Test-Workable $r) }
      elseif ($todayHolding -eq 0) { $eligible = (Test-Workable $r) }
    }
    $v = $verdicts["$($r.id)"]
    Add-Member -InputObject $r -NotePropertyName 'order' -NotePropertyValue $order -Force
    Add-Member -InputObject $r -NotePropertyName 'eligible' -NotePropertyValue $eligible -Force
    # Auditable: which Today rows are actually holding the backlog shut this run (#223 is
    # explicit that selection must be data, not the agent's judgement).
    Add-Member -InputObject $r -NotePropertyName 'holds_today_gate' `
      -NotePropertyValue ([bool]($null -ne $v -and $v.holds)) -Force
    # ...and WHY, in one word, for every Today row (#310). A run that skipped to Deferred can be
    # audited afterwards without re-deriving anything: either it says `declared_exhausted` and
    # the declaration is right there in `exhaustion`, or it does not and the skip was a bug.
    Add-Member -InputObject $r -NotePropertyName 'today_release_reason' `
      -NotePropertyValue $(if ($null -ne $v) { "$($v.reason)" } else { $null }) -Force
    # The tunables AS RESOLVED for this run, on every Today row. Reporting the value that was
    # actually in force -- rather than the one someone believes they configured -- is what makes
    # a settings file auditable instead of merely present: a row that says `backstop_hours: 6`
    # when user-settings.md says 12 is a visible discrepancy, where silence is not.
    if ($r.section -eq 'today') {
      Add-Member -InputObject $r -NotePropertyName 'gate_backstop_hours' -NotePropertyValue ([int]$script:BackstopHours) -Force
      Add-Member -InputObject $r -NotePropertyName 'gate_strict' -NotePropertyValue ([bool]$script:GateStrict) -Force
    }
  }

  $rows | ConvertTo-Json -Depth 4
}

function Cmd-Get {
  if (-not $Id) { throw 'get requires -Id' }
  $st = Read-State $Id
  if (-not $st) { Write-Output "{}"; return }
  $st | ConvertTo-Json -Depth 6
}

# --- The bounded journal read (#291) ---------------------------------------------------
# See .BOUNDED READ in the header for why this is a READER and not a rewriter.
#
# Everything below is read-only by construction: it opens journals with Read-JournalText and
# never with a writer. The only state it touches is the string it returns.

function Get-Utf8ByteCount([string]$s) {
  if ([string]::IsNullOrEmpty($s)) { return 0 }
  return [Text.Encoding]::UTF8.GetByteCount($s)
}

function Get-Utf8Prefix([string]$s, [int]$maxBytes) {
  # Longest prefix of $s whose UTF-8 encoding fits in $maxBytes, cut at a line boundary.
  #
  # Budgeting in BYTES rather than characters is deliberate. The budget exists to bound what a
  # model call costs, and these journals carry em-dashes, curly quotes and emoji -- all of which
  # are one char and up to four bytes. A char-based cap would be honest on ASCII and quietly
  # wrong by up to 4x on exactly the files that matter most.
  #
  # MIDPOINTS ARE COMPUTED WITH [Math]::Floor/Ceiling, NEVER `[int](($lo+$hi)/2)`.
  # PowerShell's `/` on two ints yields a DOUBLE and `[int]` rounds it BANKER'S-STYLE (to even),
  # so `[int]((1+2)/2)` is 2, not 1. In the suffix search below that makes `mid` equal `hi`, `hi`
  # is reassigned to itself, and the loop never terminates. Measured: extract -Id 349 hung for
  # over 100s on a 104 KB journal with no error and no output. That is exactly the failure this
  # whole change exists to prevent -- a run that never finishes and freezes the */30 schedule --
  # so the arithmetic is written explicitly and the loops carry a hard iteration ceiling.
  if ($maxBytes -le 0 -or [string]::IsNullOrEmpty($s)) { return '' }
  if ((Get-Utf8ByteCount $s) -le $maxBytes) { return $s }
  $lo = 0; $hi = $s.Length; $guard = 0
  while ($lo -lt $hi) {
    if (++$guard -gt 64) { break }   # log2(2^64) can never be reached; a break here is a bug, not a hang
    $mid = [int][Math]::Ceiling(($lo + $hi) / 2.0)
    if ($mid -le $lo) { $mid = $lo + 1 }
    if ($mid -gt $hi) { $mid = $hi }
    if ((Get-Utf8ByteCount $s.Substring(0, $mid)) -le $maxBytes) { $lo = $mid } else { $hi = $mid - 1 }
  }
  $cut = [Math]::Min($lo, $s.Length)
  # Never split a surrogate pair: half of an astral character is not a substring of the source
  # in any useful sense, and -Verify would be right to reject it.
  if ($cut -gt 0 -and $cut -lt $s.Length -and [char]::IsHighSurrogate($s[$cut - 1])) { $cut-- }
  # Prefer a line boundary so the emitted fragment is readable markdown rather than a half line.
  # Only when one exists in the kept region -- otherwise keep the byte-exact cut.
  $nl = $s.LastIndexOf("`n", [Math]::Max(0, $cut - 1))
  if ($nl -gt 0) { $cut = $nl + 1 }
  return $s.Substring(0, $cut)
}

function Get-Utf8Suffix([string]$s, [int]$maxBytes) {
  # Longest SUFFIX of $s that fits in $maxBytes, cut at a line boundary. Mirror of the above,
  # including the explicit-midpoint rule -- this is the loop that actually hung.
  if ($maxBytes -le 0 -or [string]::IsNullOrEmpty($s)) { return '' }
  if ((Get-Utf8ByteCount $s) -le $maxBytes) { return $s }
  $lo = 0; $hi = $s.Length; $guard = 0
  while ($lo -lt $hi) {
    if (++$guard -gt 64) { break }
    $mid = [int][Math]::Floor(($lo + $hi) / 2.0)
    if ($mid -ge $hi) { $mid = $hi - 1 }
    if ($mid -lt $lo) { $mid = $lo }
    if ((Get-Utf8ByteCount $s.Substring($mid)) -le $maxBytes) { $hi = $mid } else { $lo = $mid + 1 }
  }
  $cut = [Math]::Min($lo, $s.Length)
  if ($cut -lt $s.Length -and $cut -gt 0 -and [char]::IsLowSurrogate($s[$cut])) { $cut++ }
  $nl = $s.IndexOf("`n", [Math]::Min($cut, [Math]::Max(0, $s.Length - 1)))
  if ($nl -ge 0 -and $nl -lt $s.Length - 1) { $cut = $nl + 1 }
  return $s.Substring([Math]::Min($cut, $s.Length))
}

function Get-BoundedSlice([string]$text, [int]$maxBytes) {
  # Cap a region at $maxBytes by keeping its HEAD and its TAIL and stating what was dropped.
  #
  # Head AND tail, not one or the other, because the two ends carry different things and a run
  # needs both: a region opens with its framing (a `**Status:**` line, the plan, the ask) and
  # closes with the most recent thing that happened. Keeping only the head loses the latest
  # state; keeping only the tail loses the decisions the user wrote down.
  #
  # Returns the two verbatim fragments SEPARATELY rather than pre-joined, so -Verify can assert
  # each one against the source. A pre-joined string with an elision marker in the middle is by
  # definition not a substring of anything.
  $full = Get-Utf8ByteCount $text
  if ($maxBytes -le 0) {
    return [pscustomobject]@{ Head = ''; Tail = ''; FullBytes = $full; ElidedBytes = $full; Truncated = ($full -gt 0) }
  }
  if ($full -le $maxBytes) {
    return [pscustomobject]@{ Head = $text; Tail = ''; FullBytes = $full; ElidedBytes = 0; Truncated = $false }
  }
  $headBudget = [int]([Math]::Floor($maxBytes * 0.6))
  $head = Get-Utf8Prefix $text $headBudget
  $rest = $text.Substring($head.Length)
  $tail = Get-Utf8Suffix $rest ($maxBytes - (Get-Utf8ByteCount $head))
  $elided = $full - (Get-Utf8ByteCount $head) - (Get-Utf8ByteCount $tail)
  return [pscustomobject]@{
    Head = $head; Tail = $tail; FullBytes = $full
    ElidedBytes = [Math]::Max(0, $elided); Truncated = $true
  }
}

function Get-JournalHeadIndex([string]$content) {
  # Where the USER'S framing ends and the first machine turn begins.
  #
  # Located on the fence mask (#320) for the same reason every other structural scan here is:
  # a `<!-- from: overnight-agent -->` quoted inside a fenced example must not be mistaken for
  # the start of a real turn and truncate the user's notes to nothing.
  #
  # A leading `<!-- from: me -->` is the USER'S OWN marker and must not end the head -- that is
  # the ordinary shape of a journal the Telegram bridge has folded a reply into, and treating it
  # as a machine turn would drop the user's framing entirely.
  if ([string]::IsNullOrEmpty($content)) { return 0 }
  $scan = Get-FenceMaskedText $content
  $idxs = @()
  $m = [regex]::Match($scan, '(?m)' + $script:ManagedHeadingRe)
  if ($m.Success) { $idxs += $m.Index }
  foreach ($p in [regex]::Matches($scan, $script:ProvenanceRe)) {
    if ($p.Groups[1].Value.Trim() -ne $script:HumanAuthor) { $idxs += $p.Index; break }
  }
  $m = [regex]::Match($scan, $script:LegacyStateRe)
  if ($m.Success) { $idxs += $m.Index }
  $sentinel = $scan.IndexOf('OVERNIGHT-AGENT do not edit')
  if ($sentinel -ge 0) {
    # The sentinel sits on its own line and the user's space is everything ABOVE it. Cut at the
    # start of that line, not at the phrase, so the extract never shows half a comment.
    $ls = $scan.LastIndexOf("`n", [Math]::Max(0, $sentinel - 1))
    $idxs += $(if ($ls -ge 0) { $ls + 1 } else { 0 })
  }
  if ($idxs.Count -eq 0) { return $content.Length }
  return [Math]::Max(0, ($idxs | Measure-Object -Minimum).Minimum)
}

function Get-JournalUserMessages([string]$content) {
  # Every segment positively attributed to the HUMAN, NEWEST FIRST.
  #
  # WHY THIS REGION EXISTS AND HEAD IS NOT ENOUGH. The first shape of this extract had only a
  # HEAD region -- "the user's notes at the top" -- because that is the phrase SKILL.md uses.
  # That is wrong on any journal older than a few days: a journal is a chat thread, so the user
  # keeps writing INTO it, and their later messages are the ones that supersede. On task-400,
  # HEAD ends at the first machine turn on 2026-07-30; every decision Shiv made in the five
  # weeks after that sits below it. A bounded read that dropped those would be worse than the
  # unbounded read it replaces -- it would silently lose exactly the material the issue says the
  # agent actually needs ("the user's decisions and the open items").
  #
  # Newest first because later decisions supersede earlier ones, so when the budget runs out the
  # thing to lose is the oldest.
  #
  # Attribution comes from Get-AuthorSegments, the SAME reader the consent gate uses -- so this
  # shows the user's words under exactly the rule that decides whether they authorised anything.
  # That reader fails CLOSED (unmarked prose is 'unknown', not the human), which is right for
  # consent and merely conservative here: an unmarked user note is not shown in THIS region, but
  # it is still inside HEAD or TRAILING, and the footer states how much was not shown.
  if ([string]::IsNullOrEmpty($content)) { return @() }
  $out = @()
  foreach ($s in (Get-AuthorSegments $content)) {
    if ($s.Author -eq $script:HumanAuthor -and $s.Text.Trim().Length -gt 0) { $out += $s.Text }
  }
  if ($out.Count -gt 1) { [array]::Reverse($out) }
  return $out
}

function Get-BoundedList($items, [int]$maxBytes) {
  # Keep whole items until the budget is spent, then a verbatim PREFIX of the next one.
  #
  # Item-at-a-time rather than joining and slicing, so every kept fragment stays a contiguous
  # substring of the source and -Verify can assert each one. Joining first would produce a
  # string that is a substring of nothing.
  $kept = @(); $used = 0; $dropped = 0; $elided = 0
  foreach ($it in @($items)) {
    $b = Get-Utf8ByteCount $it
    if ($used + $b -le $maxBytes) { $kept += $it; $used += $b; continue }
    $room = $maxBytes - $used
    if ($room -gt 256) {
      $p = Get-Utf8Prefix $it $room
      if ($p.Length -gt 0) { $kept += $p; $used += (Get-Utf8ByteCount $p); $elided += ($b - (Get-Utf8ByteCount $p)); continue }
    }
    $dropped++; $elided += $b
  }
  return [pscustomobject]@{ Kept = @($kept); Dropped = $dropped; ElidedBytes = $elided; UsedBytes = $used }
}

function Get-JournalOpenAsks([string]$agentLeft) {
  # The newest turn's asks, verbatim. Same regexes the digest and the gate read, so the extract
  # cannot show the user a different question from the one the board is parked on.
  $turn = Get-NewestAgentTurn $agentLeft
  $asks = @()
  if ([string]::IsNullOrEmpty($turn)) { return $asks }
  foreach ($m in [regex]::Matches($turn, $script:YourCallRe)) {
    $asks += [pscustomobject]@{ kind = 'Your call'; text = $m.Groups[1].Value.Trim(); blocking = $true }
  }
  foreach ($m in [regex]::Matches($turn, $script:NeedsFromYouRe)) {
    $v = $m.Groups[1].Value.Trim()
    if (Test-AskTextIsOpen $v) {
      $asks += [pscustomobject]@{ kind = 'Needs from you'; text = $v; blocking = (Test-AskTextIsBlocking $v) }
    }
  }
  return $asks
}

function Get-JournalPointers([string]$content, [string]$path) {
  # The cheap facts a run would otherwise read the whole file to recover: the status line, the
  # upstream link, and the deliverable files written NEXT TO the journal. Pointers, not content
  # -- naming a 40 KB deliverable costs 30 bytes and lets the run decide whether it needs it.
  $status = $null
  foreach ($m in [regex]::Matches($content, '(?im)^[ \t]*\*\*[ \t]*Status[ \t]*:?[ \t]*\*\*[ \t]*:?(.*)$')) {
    $status = $m.Groups[1].Value.Trim()
  }
  $linked = @()
  foreach ($m in [regex]::Matches($content, '(?im)^[ \t]*\*\*[ \t]*Linked[ \t]*:?[ \t]*\*\*[ \t]*:?(.*)$')) {
    foreach ($n in [regex]::Matches($m.Groups[1].Value, '#(\d+)')) {
      if ($linked -notcontains $n.Groups[1].Value) { $linked += $n.Groups[1].Value }
    }
  }
  $deliverables = @()
  $id = [System.IO.Path]::GetFileNameWithoutExtension($path) -replace '^task-', ''
  $dir = Split-Path -Parent $path
  if ($dir -and (Test-Path $dir)) {
    foreach ($f in (Get-ChildItem -LiteralPath $dir -Filter "task-$id-*.md" -File -ErrorAction SilentlyContinue)) {
      $deliverables += [pscustomobject]@{ name = $f.Name; kb = [math]::Round($f.Length / 1KB, 1) }
    }
  }
  return [pscustomobject]@{ Status = $status; Linked = $linked; Deliverables = $deliverables }
}

function Get-LinkedFacts {
  # The MERGED upstream link: board `Linked ID` + journal `**Linked:** #N`, de-duplicated, with
  # the provenance of each source kept so the pointer can state what it actually read (#408).
  #
  # Merged, not "one wins". The two sources disagree in both directions on the live folder: task
  # 468's link exists only on the board, while journals routinely add links the board never
  # carried. Letting either win would drop real parents; the union is the only answer that never
  # loses one.
  param([string]$Id, [string[]]$JournalIds)
  $board = Get-BoardLinkFacts -Id $Id
  $merged = @()
  foreach ($n in @($board.Ids)) { if ($n -and $merged -notcontains $n) { $merged += $n } }
  foreach ($n in @($JournalIds)) { if ($n -and $merged -notcontains $n) { $merged += $n } }
  # A task never links to itself; a self-link would send the depth-3 upstream walk in a circle.
  $merged = @($merged | Where-Object { $_ -ne "$Id" })
  return [pscustomobject]@{
    Ids       = $merged
    Board     = @($board.Ids)
    Journal   = @($JournalIds)
    BoardRead = [bool]$board.Read
    BoardRow  = [bool]$board.RowFound
    BoardNote = "$($board.Note)"
    BoardPath = "$($board.Path)"
  }
}

function Format-LinkedPointer {
  # The `- linked:` line. `(none)` is a POSITIVE claim -- "this task has no parent" -- so it is
  # emitted ONLY when the board and the journal were both consulted and both were empty. When the
  # board could not be read the line says so instead, naming the gap. #408: the previous version
  # printed `(none)` unconditionally, which is how an unreadable board and a genuinely unlinked
  # task became indistinguishable, and how the mandated upstream walk was skipped in silence.
  param($Facts)
  $journalNote = if (@($Facts.Journal).Count) { "journal: #$((@($Facts.Journal)) -join ', #')" } else { 'journal: no **Linked:** line' }
  if (@($Facts.Ids).Count) {
    $boardNote = if (@($Facts.Board).Count) { "board: #$((@($Facts.Board)) -join ', #')" }
                 elseif (-not $Facts.BoardRead) { "board: NOT READ ($($Facts.BoardNote))" }
                 elseif (-not $Facts.BoardRow) { "board: $($Facts.BoardNote)" }
                 else { 'board: no Linked ID' }
    return ('- linked: #' + ((@($Facts.Ids)) -join ', #') + "  ($boardNote; $journalNote)")
  }
  if (-not $Facts.BoardRead) {
    return "- linked: (board not read -- $($Facts.BoardNote); $journalNote). NOT a finding of 'no parent': re-run with -PlannerBoard pointing at planner.md before concluding this task has no upstream."
  }
  $boardNote = if (-not $Facts.BoardRow) { $Facts.BoardNote }
               elseif (@($Facts.Board).Count) {
                 # The row DID name a link and it was dropped as a self-reference. Saying "no
                 # Linked ID" here would be a second false negative of exactly the shape #408 is
                 # about, so the discarded value is named instead.
                 "board row read, Linked ID #$((@($Facts.Board)) -join ', #') is this task itself"
               }
               else { 'board row read, no Linked ID' }
  return "- linked: (none -- $boardNote; $journalNote)"
}

function Cmd-Extract {
  if (-not $Id) { throw 'extract requires -Id' }
  $path = Join-Path $JournalDir "task-$Id.md"
  if (-not (Test-Path -LiteralPath $path)) {
    # Loudly, and with the path tried. SKILL.md says a missing linked journal is a note-and-
    # proceed, not a stop -- but a reader that returns an empty extract for a path it never
    # found would let the run plan against silence and call it context.
    throw "extract: no journal at $path"
  }

  $content = Read-JournalText $path
  $sourceBytes = Get-Utf8ByteCount $content

  $agentEnd = Get-AgentEndIndex $content
  $hasAgentBlock = $agentEnd -ge 0
  if ($agentEnd -lt 0) { $agentEnd = 0 }
  $agentLeft = $content.Substring(0, [Math]::Min($agentEnd, $content.Length))
  $trailing = if ($agentEnd -lt $content.Length) { $content.Substring($agentEnd) } else { '' }

  $headEnd = [Math]::Min((Get-JournalHeadIndex $content), $content.Length)
  $head = $content.Substring(0, $headEnd)
  $turn = Get-NewestAgentTurn $agentLeft

  # Region budgets. They sum to the declared ceiling, so the TOTAL is bounded no matter how the
  # regions themselves are shaped -- a journal that is 100% head cannot borrow the turn's share.
  $ceiling = [Math]::Max(4, $BudgetKB) * 1024
  $slices = [ordered]@{
    head     = (Get-BoundedSlice $head     ([int]($ceiling * 0.22)))
    turn     = (Get-BoundedSlice $turn     ([int]($ceiling * 0.33)))
    trailing = (Get-BoundedSlice $trailing ([int]($ceiling * 0.15)))
  }
  # The user's own later messages get the remaining 30%. Sized close to the agent's newest turn
  # on purpose: this is the region the issue is actually about ("the user's decisions"), and
  # starving it to show more of the agent's own prose would be the wrong trade.
  $userMsgs = @(Get-JournalUserMessages $content)
  $userList = Get-BoundedList $userMsgs ([int]($ceiling * 0.30))

  $asks = @(Get-JournalOpenAsks $agentLeft)
  $ptr = Get-JournalPointers $content $path
  $links = Get-LinkedFacts -Id $Id -JournalIds @($ptr.Linked)

  $emitted = 0
  foreach ($s in $slices.Values) { $emitted += (Get-Utf8ByteCount $s.Head) + (Get-Utf8ByteCount $s.Tail) }
  $emitted += $userList.UsedBytes
  $elided = $sourceBytes - $emitted

  $kb = { param($b) [math]::Round($b / 1024, 1) }

  if ($Verify) {
    # The proof, run against the file it just read. Two claims, both mechanical.
    $problems = @()
    foreach ($k in $slices.Keys) {
      foreach ($frag in @($slices[$k].Head, $slices[$k].Tail)) {
        if ([string]::IsNullOrEmpty($frag)) { continue }
        if ($content.IndexOf($frag, [StringComparison]::Ordinal) -lt 0) {
          $problems += "region '$k' emitted $(Get-Utf8ByteCount $frag) bytes that are NOT a verbatim substring of the source"
        }
      }
    }
    if ($emitted -gt $ceiling) {
      $problems += "emitted $emitted bytes against a declared ceiling of $ceiling"
    }
    foreach ($frag in $userList.Kept) {
      if ($content.IndexOf($frag, [StringComparison]::Ordinal) -lt 0) {
        $problems += "a user message fragment of $(Get-Utf8ByteCount $frag) bytes is NOT a verbatim substring of the source"
      }
    }
    foreach ($a in $asks) {
      if ($a.text -and $content.IndexOf($a.text, [StringComparison]::Ordinal) -lt 0) {
        $problems += "ask text '$($a.text)' is not a verbatim substring of the source"
      }
    }
    $ok = ($problems.Count -eq 0)
    [pscustomobject]@{
      verify        = $(if ($ok) { 'pass' } else { 'fail' })
      id            = $Id
      path          = $path
      source_bytes  = $sourceBytes
      emitted_bytes = $emitted
      ceiling_bytes = $ceiling
      verbatim      = $ok
      problems      = @($problems)
    } | ConvertTo-Json -Depth 4
    if (-not $ok) { exit 1 }
    return
  }

  if ($Json) {
    [pscustomobject]@{
      id              = $Id
      path            = $path
      source_bytes    = $sourceBytes
      emitted_bytes   = $emitted
      elided_bytes    = [Math]::Max(0, $elided)
      ceiling_bytes   = $ceiling
      has_agent_block = $hasAgentBlock
      status          = $ptr.Status
      linked          = @($links.Ids)
      # Provenance, so a consumer can tell "no parent" from "never looked" without re-reading the
      # board itself. `board_read` false means the `linked` list is INCOMPLETE, not empty (#408).
      linked_board    = @($links.Board)
      linked_journal  = @($links.Journal)
      board_read      = [bool]$links.BoardRead
      board_row_found = [bool]$links.BoardRow
      board_path      = $links.BoardPath
      board_note      = $links.BoardNote
      deliverables    = @($ptr.Deliverables)
      open_asks       = @($asks)
      user_messages   = [pscustomobject]@{
        newest_first  = @($userList.Kept)
        shown         = $userList.Kept.Count
        total         = $userMsgs.Count
        dropped       = $userList.Dropped
        elided_bytes  = $userList.ElidedBytes
      }
      head            = [pscustomobject]@{ text = ($slices.head.Head + $slices.head.Tail); truncated = $slices.head.Truncated; elided_bytes = $slices.head.ElidedBytes }
      latest_turn     = [pscustomobject]@{ text = ($slices.turn.Head + $slices.turn.Tail); truncated = $slices.turn.Truncated; elided_bytes = $slices.turn.ElidedBytes }
      trailing_user   = [pscustomobject]@{ text = ($slices.trailing.Head + $slices.trailing.Tail); truncated = $slices.trailing.Truncated; elided_bytes = $slices.trailing.ElidedBytes }
    } | ConvertTo-Json -Depth 6
    return
  }

  $nl = [Environment]::NewLine
  $out = New-Object Text.StringBuilder
  $w = { param($s) [void]$out.Append($s); [void]$out.Append($nl) }

  & $w "# task-$Id -- BOUNDED EXTRACT (read-only)"
  & $w ''
  & $w "source: $path"
  & $w ("source $(& $kb $sourceBytes) KB / emitted $(& $kb $emitted) KB " +
        "(ceiling $(& $kb $ceiling) KB, ~$([math]::Round($emitted/4/1000,1))K tokens)")
  & $w ''
  & $w ('This is a BOUNDED extract, not the whole journal. Every line below is VERBATIM from the ' +
        'source; nothing is summarised. ' +
        $(if ($elided -gt 0) { "$(& $kb $elided) KB was NOT shown -- open the file directly if you need it." }
          else { 'Nothing was elided: this is the complete journal.' }))

  $section = {
    param($title, $slice, $note)
    & $w ''
    & $w "## $title"
    if ($note) { & $w "_${note}_" }
    $body = ($slice.Head + $slice.Tail).Trim()
    if ($body.Length -eq 0) { & $w '(empty)'; return }
    & $w ''
    if ($slice.Truncated) {
      & $w ($slice.Head.TrimEnd())
      & $w ''
      & $w "> [... $(& $kb $slice.ElidedBytes) KB elided from the middle of this section ...]"
      & $w ''
      & $w ($slice.Tail.TrimEnd())
    } else {
      & $w $body
    }
  }

  & $section 'HEAD -- the user''s framing' $slices.head 'Everything above the first machine turn: decisions, constraints, links.'

  & $w ''
  & $w '## OPEN ASKS (newest agent turn)'
  if ($asks.Count -eq 0) {
    & $w ''
    & $w '(none)'
  } else {
    & $w ''
    foreach ($a in $asks) {
      & $w ("- **$($a.kind):** $($a.text)" + $(if ($a.blocking) { '  `[blocking]`' } else { '  `[offer]`' }))
    }
  }

  & $w ''
  & $w '## USER MESSAGES (newest first)'
  & $w '_Attributed to the human. Later messages supersede earlier ones, so read top-down._'
  & $w ''
  if ($userList.Kept.Count -eq 0) {
    & $w $(if ($userMsgs.Count) { '(none fit in the budget)' } else { '(none positively attributed -- see HEAD and TRAILING)' })
  } else {
    $n = 0
    foreach ($m in $userList.Kept) {
      $n++
      & $w "### message $n of $($userMsgs.Count) (newest first)"
      & $w ''
      & $w $m.Trim()
      & $w ''
    }
    if ($userList.Dropped -gt 0 -or $userList.ElidedBytes -gt 0) {
      & $w "> [... $($userList.Dropped) older user message(s) not shown, $(& $kb $userList.ElidedBytes) KB ...]"
    }
  }

  & $section 'LATEST AGENT TURN' $slices.turn 'The newest turn only. Earlier turns are deliberately not read.'
  & $section 'TRAILING USER PROSE' $slices.trailing 'Below the turn-end stamp: the unanswered reply, if any.'

  & $w ''
  & $w '## POINTERS'
  & $w ''
  & $w ("- status: " + $(if ($ptr.Status) { $ptr.Status } else { '(none stated)' }))
  & $w (Format-LinkedPointer $links)
  if ($ptr.Deliverables.Count) {
    & $w "- deliverables next to this journal (not read here):"
    foreach ($d in $ptr.Deliverables) { & $w "    - $($d.name) ($($d.kb) KB)" }
  } else {
    & $w '- deliverables next to this journal: (none)'
  }
  & $w "- not shown: $(& $kb $elided) KB of $(& $kb $sourceBytes) KB"

  Write-Output $out.ToString()
}

function Cmd-Gate {
  # The gate as this script actually reads it — so a human can diff what they wrote against what
  # the agent parsed, rather than trusting that the two agree. Rule text is verbatim.
  $g = Read-AgentGate $GatePath
  [pscustomobject]@{
    path    = "$($g.path)"
    exists  = [bool]$g.exists
    state   = "$($g.state)"
    version = $g.version
    allow   = @($g.allow)
    ask     = @($g.ask)
    mtime   = $g.mtime
  } | ConvertTo-Json -Depth 4
}

function Cmd-Consent {
  # #227: the consent channel, read fail-CLOSED. Ask this BEFORE any irreversible action.
  #
  # Deliberately a separate command rather than a field on `get`: consent is a property of the
  # journal as it stands RIGHT NOW, not of the stored state. Reading it from state would let a
  # stale `status: approved` -- which the agent itself wrote -- stand in for the user's word,
  # which is the same self-authored-consent hole one level up.
  #
  # #297 adds the SECOND channel in front of it: the agent gate. It is consulted ONLY when the
  # caller names an `-Action`, and when it does not decide, control falls through to the journal
  # reader below completely untouched. With `-Action` omitted this function does not even open
  # the gate file, so the pre-#297 output is preserved byte for byte.
  if (-not $Id) { throw 'consent requires -Id' }
  $path = Join-Path $JournalDir "task-$Id.md"

  $gate = $null
  $verdict = $null
  if ($Action) {
    $gate = Read-AgentGate $GatePath
    $verdict = Get-GateVerdict $gate $Action $Repo
    if ($verdict.decision -ne 'none') {
      # A gate decision short-circuits the journal read, in BOTH directions and on purpose:
      #   floor -> deny, and it must outrank a human `approve` sitting in the journal;
      #   allow -> a STANDING permission, which by definition does not need re-granting per task
      #            (that is the whole reason the file exists).
      #
      # THE ALLOW DIRECTION HAS A CONSEQUENCE WORTH STATING, because it is surprising and it is
      # NOT a bug. Measured: with an allow rule covering merges in a repo, a journal carrying the
      # human's own `<!-- from: me -->` "do not merge that, hold off" still returns
      # `consent_ok: true, reason: gate-allowed` -- the journal is never opened. That is correct:
      # a standing permission any stray sentence could cancel would not be standing, and the
      # revocation channel is the file the user owns (move the rule to the floor, or delete it),
      # which is verified -- adding 'Merging any pull request' to the floor flips the same fixture
      # to `gate-floor-blocks`.
      #
      # What it means for the CALLER is that this command answers "am I authorised?", never
      # "should I?". SKILL.md carries that distinction: a fresh human "don't" in the journal stops
      # the run regardless of what this returns. Do not widen this function to also read refusals
      # -- a refusal vocabulary is the #301 problem (which affirmatives count), and it belongs in
      # its own change with its own mutation arms, not smuggled in here.
      # `trailing_has_user` is reported on this path too (#302), even though the verdict did not
      # consult it and MUST NOT. Surfacing it is the whole point: without it, a caller holding a
      # `gate-allowed` cannot tell "nobody has said anything" from "he replied 'don't' ninety
      # seconds ago", because the journal was never opened. Filing an issue saying a wrapper
      # should refuse, while the data the wrapper needs is absent from the output, is prose with
      # a tracking number.
      #
      # It deliberately uses HasTrailingUser -- the FAIL-OPEN reader -- not the fail-closed
      # consent reader, and the asymmetry is the same one documented at the top of this file
      # read in the other direction. Here a false "there is a human message" costs one pause; a
      # false "there is none" costs acting over a refusal. So unmarked prose counts.
      #
      # WHICH MEANS IT SAYS "SOMEONE MAY BE WAITING", NOT "HE REFUSED", and a consumer must not
      # collapse the two. Reading it as a refusal would let stray unattributed text silently
      # revoke a permission he actually granted -- the mirror image of the bug this file exists
      # to prevent. Measured bounds on how wrong that can go, pinned by arm H: the agent's own
      # unstamped turn and a sibling skill's turn both read FALSE (the managed-heading rule from
      # #272 and the sibling-reopen fix respectively), so machine text cannot impersonate him.
      # The residual true-but-not-him case is genuinely unattributed prose.
      #
      # Reporting only. Nothing in this function weighs it, and nothing should: deciding what a
      # human MEANT by the text below the turn is the vocabulary problem in #301, and it needs
      # its own reader with its own mutation arms rather than an `if` bolted on here.
      $trailingHasUser = $false
      if (Test-Path $path) { $trailingHasUser = [bool](Get-JournalFacts $path).HasTrailingUser }
      [pscustomobject]@{
        id                = $Id
        consent_ok        = ($verdict.decision -eq 'allow')
        reason            = $(if ($verdict.decision -eq 'floor') { 'gate-floor-blocks' } else { 'gate-allowed' })
        action            = "$Action"
        repo              = $(if ($Repo) { "$Repo" } else { $null })
        gate_state        = "$($gate.state)"
        gate_list         = "$($verdict.list)"
        gate_rule         = "$($verdict.rule)"
        gate_path         = "$($gate.path)"
        trailing_has_user = $trailingHasUser
        path              = $path
      } | ConvertTo-Json -Depth 4
      return
    }
  }

  if (-not (Test-Path $path)) {
    $out = [ordered]@{
      id = $Id; consent_ok = $false; reason = 'journal-not-found'; path = $path
    }
    if ($Action) { Add-GateFallthrough $out $gate }
    [pscustomobject]$out | ConvertTo-Json -Depth 4
    return
  }
  $facts = Get-JournalFacts $path
  $c = $facts.Consent
  $out = [ordered]@{
    id                       = $facts.Id
    consent_ok               = [bool]$c.consent_ok
    reason                   = "$($c.reason)"
    human_segments           = [int]$c.human_segments
    affirmative_phrase       = $c.affirmative_phrase
    affirmative_author       = $c.affirmative_author
    affirmative_unattributed = [bool]$c.affirmative_unattributed
    # #465: his approval was found and is provably his, and this agent has already replied
    # beneath it. Distinct from `consent_ok: false` with no phrase at all -- that is silence.
    affirmative_answered     = [bool]$c.affirmative_answered
    # `reopened` uses the opposite default on purpose; both are reported so the difference is
    # visible at the call site instead of being a footnote in a comment.
    trailing_has_user        = [bool]$facts.HasTrailingUser
    path                     = $facts.Path
  }
  if ($Action) { Add-GateFallthrough $out $gate }
  [pscustomobject]$out | ConvertTo-Json -Depth 4
}

function Add-GateFallthrough($out, $gate) {
  # The gate was consulted and declined to decide. Say so explicitly rather than staying silent:
  # `gate_rule: null` next to a real `gate_state` is the difference between "no rule covers this"
  # and "I never looked", and only the first is a verdict a human can audit.
  $out['action'] = "$Action"
  $out['repo'] = $(if ($Repo) { "$Repo" } else { $null })
  $out['gate_state'] = $(if ($gate) { "$($gate.state)" } else { 'not-consulted' })
  $out['gate_list'] = $null
  $out['gate_rule'] = $null
  $out['gate_path'] = $(if ($gate) { "$($gate.path)" } else { $null })
}

function Add-TurnTerminator([string]$path) {
  # Stamp the end of this agent's turn, so a reply typed below it can never be absorbed
  # into the turn (see $script:TurnEndMarker for why).
  #
  # APPEND-ONLY, deliberately. The terminator is written only when the agent's turn already
  # runs to EOF -- the exact shape that is blind today. When there IS trailing content below
  # the turn, the `## ` heading already provides a working boundary and we do not need a
  # marker, so we do not reach into the middle of the user's file to insert one. A journal in
  # that state heals itself the next time the agent appends a turn, because that turn lands
  # at EOF and this runs again.
  #
  # Returns $true if the file was modified.
  #
  # The read MUST be Read-JournalText, not `Get-Content -Raw`. This is a read-modify-write on
  # one of the user's files, so a wrong decode here does not merely misread -- it re-encodes
  # the misreading and writes it back, destroying the original characters. See the note on
  # Read-JournalText for the 593 lines this cost before it was pinned.
  $content = Read-JournalText $path
  if ($null -eq $content) { $content = '' }
  if ($content.Length -eq 0) { return $false }

  $agentEnd = Get-AgentEndIndex $content
  if ($agentEnd -lt 0) { return $false }          # no agent block yet -- nothing to terminate
  if ($agentEnd -lt $content.Length) { return $false }  # boundary already exists below the turn

  # Already terminated? Then Get-AgentEndIndex returned the marker's end, which is only equal
  # to the file length when the marker is the last thing in the file -- nothing to do.
  # Read the fence mask (#320) so a terminator shown inside a quoted example never counts as
  # this file's real terminator.
  $scan = Get-FenceMaskedText $content
  if ([regex]::IsMatch($scan, $script:TurnEndRe)) {
    $last = $null
    foreach ($m in [regex]::Matches($scan, $script:TurnEndRe)) { $last = $m }
    if ($null -ne $last -and $content.Substring($last.Index).Trim() -eq $script:TurnEndMarker) { return $false }
  }

  $nl = if ($content.Contains("`r`n")) { "`r`n" } else { "`n" }
  $out = $content.TrimEnd() + $nl + $nl + $script:TurnEndMarker + $nl
  [IO.File]::WriteAllText($path, $out, (New-Object Text.UTF8Encoding($false)))
  return $true
}

# --- Durable task -> catch-up-doc binding (#423) ------------------------------------------
#
# WHY THIS EXISTS
# ---------------
# The one catch-up doc that exists today (task #228) is found by TITLE SEARCH -- matching the
# string `(task 228)` in a `search_docs "catch-up"` result. That is not an identity, it is a
# guess that happens to work while exactly one such doc exists. Three ways it breaks, all silent:
#
#   * a RENAMED doc becomes invisible, so the next wake CREATES A SECOND ONE and every comment
#     the user has already written is stranded on the orphan;
#   * task ids are reusable after completion (#132), so `(task 392)` is not unique over time;
#   * a search returning 0 rows and a search returning the WRONG doc are indistinguishable to
#     the caller -- the same "a missing capability looks like an empty result" shape as #346.
#
# THE MODEL IS BORROWED, NOT INVENTED
# -----------------------------------
# Both halves are already solved in this repo, and #286 asked for exactly this reuse rather than
# "inventing a second one":
#
#   IDENTITY          the Telegram bridge stamps `<!-- tg-meta chatId=... threadId=... -->` into
#                     the journal on first post. The doc gets the direct analogue, `doc-meta`.
#   CHANGE DETECTION  `scan` already answers "has the user spoken since my last turn?" from a
#                     stored hash plus a boundary stamp. A comment watermark is the same
#                     question asked of a different surface.
#
# TWO STORES, AND WHY BOTH ARE LOAD-BEARING
# -----------------------------------------
# The state store is the source of truth per SKILL.md; the journal stamp is what makes the
# binding SELF-HEALING. `%LOCALAPPDATA%` is deliberately not synced, so it can be lost, and
# losing it must not manufacture a duplicate doc. State is read first, the stamp is the fallback
# that rebinds it. Neither alone is sufficient: state alone is not durable, and the stamp alone
# cannot carry a watermark without rewriting one of the user's files on every single run.
#
# BINDING IS EXACT, AND A CONFLICT IS AN ERROR RATHER THAN A CHOICE
# ----------------------------------------------------------------
# `-DocId` naming a DIFFERENT document than the one already bound THROWS. It does not rebind and
# it does not create. That refusal is the machine half of the issue's "find-or-create must be
# exact": the create path is reachable only when nothing is bound at all, so a doc id that 404s
# surfaces as an error for a human to look at -- never as a cue to quietly make a second one.
#
# THE WATERMARK IS TWO-PHASE ON PURPOSE
# -------------------------------------
# `-Observe` reports what is new and does NOT advance; `-Ack` advances. A crash between the two
# re-reports a comment, which is the fail-OPEN direction and matches readingView() in
# lib-doc-comments.mjs: dropping one of Shiv's instructions is the #170 defect, and re-reading
# one costs a duplicate answer. A single-phase "observing advances it" would lose an instruction
# on any failure between reading the comment and acting on it -- invisibly, which is the whole
# class of bug this file keeps having to close.
#
# WHAT THIS DOES NOT DO
# ---------------------
# It never talks to Google. Every command here is offline and deterministic, which is what lets
# `scan` report the binding without a network call and without being able to hang the run. The
# caller fetches comments through the MCP and hands the result to `-Observe`.

# Accepts the stamp with or without the optional docUrl, and tolerates arbitrary inner spacing.
$script:DocMetaRe = '<!--\s*doc-meta\s+docId=(?<id>[A-Za-z0-9_\-]+)(?:\s+docUrl=(?<url>\S+))?\s*-->'

function Get-DocMetaFromJournal([string]$path) {
  # Read the self-healing stamp out of the journal. Fence-masked (#320) so a `doc-meta` shown
  # inside a fenced example in a turn is never mistaken for this task's real binding -- the same
  # rule the turn-end reader already applies, for the same reason.
  $content = Read-JournalText $path
  if (-not $content) { return $null }
  $m = [regex]::Match((Get-FenceMaskedText $content), $script:DocMetaRe)
  if (-not $m.Success) { return $null }
  [pscustomobject]@{
    doc_id  = $m.Groups['id'].Value
    doc_url = if ($m.Groups['url'].Success) { $m.Groups['url'].Value } else { '' }
  }
}

function Add-DocMetaStamp([string]$path, [string]$docId, [string]$docUrl) {
  # Write the stamp into the journal, ONCE, near the top beside `tg-meta`.
  #
  # This is a read-modify-write on one of the user's files, so it uses Read-JournalText for the
  # reason documented there (a wrong decode does not merely misread, it re-encodes the misreading
  # and writes it back). It inserts a single line and never reorders or rewrites anything else.
  #
  # Returns $true if the file was modified.
  $content = Read-JournalText $path
  if ($null -eq $content) { $content = '' }
  $existing = Get-DocMetaFromJournal $path
  if ($existing) { return $false }   # already stamped; a conflicting id was refused upstream

  $stamp = if ($docUrl) { "<!-- doc-meta docId=$docId docUrl=$docUrl -->" } else { "<!-- doc-meta docId=$docId -->" }
  $nl = if ($content.Contains("`r`n")) { "`r`n" } else { "`n" }
  if ($content.Length -eq 0) { [IO.File]::WriteAllText($path, $stamp + $nl, (New-Object Text.UTF8Encoding($false))); return $true }

  $lines = $content -split "`r?`n"
  # Preferred anchor: immediately after an existing tg-meta line, so the two identity stamps sit
  # together. Otherwise immediately after the H1 title. Otherwise the very top.
  $at = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '<!--\s*tg-meta\b') { $at = $i + 1; break }
  }
  if ($at -lt 0) {
    for ($i = 0; $i -lt $lines.Count; $i++) {
      if ($lines[$i] -match '^#\s') { $at = $i + 1; break }
    }
  }
  if ($at -lt 0) { $at = 0 }

  $out = @()
  if ($at -gt 0) { $out += $lines[0..($at - 1)] }
  $out += $stamp
  if ($at -lt $lines.Count) { $out += $lines[$at..($lines.Count - 1)] }
  [IO.File]::WriteAllText($path, ($out -join $nl), (New-Object Text.UTF8Encoding($false)))
  return $true
}

function Read-ObservedComments([string]$path) {
  # Accept EITHER shape the caller might plausibly have, because a reader that only handles the
  # tidy one is a reader that gets bypassed:
  #   * a JSON array of { id, created } (what a caller with structured data has), or
  #   * the Google Workspace MCP's `list_document_comments` text dump (what the live surface
  #     actually hands back today).
  # Ids are matched the same way in both, so the two paths cannot disagree about identity.
  if (-not (Test-Path $path)) { throw "no such observation file: $path" }
  $text = [IO.File]::ReadAllText($path, (New-Object Text.UTF8Encoding($false)))
  $rows = @()
  $trimmed = $text.Trim()
  if ($trimmed.StartsWith('[') -or $trimmed.StartsWith('{')) {
    try {
      $parsed = $trimmed | ConvertFrom-Json
      foreach ($e in @($parsed)) {
        $eid = if ($e.PSObject.Properties['id']) { "$($e.id)" } else { '' }
        if (-not $eid) { continue }
        $rows += [pscustomobject]@{
          id      = $eid
          created = if ($e.PSObject.Properties['created']) { "$($e.created)" } else { '' }
        }
      }
      return , $rows
    }
    catch {
      # Fall through to the dump parser: a JSON-looking file that does not parse is far more
      # likely to be a dump that happens to start with a brace than a caller error worth throwing
      # over, and the dump parser simply finds nothing if it really was malformed JSON.
    }
  }
  $lines = $text -split "`r?`n"
  $cur = $null
  foreach ($ln in $lines) {
    $m = [regex]::Match($ln, '^\s*(?:Comment|Reply)\s+ID:\s*(\S+)\s*$')
    if ($m.Success) {
      if ($cur) { $rows += $cur }
      $cur = [pscustomobject]@{ id = $m.Groups[1].Value; created = '' }
      continue
    }
    if ($cur) {
      $c = [regex]::Match($ln, '^\s*Created:\s*(.+?)\s*$')
      if ($c.Success -and -not $cur.created) { $cur.created = $c.Groups[1].Value }
    }
  }
  if ($cur) { $rows += $cur }
  return , $rows
}

function New-DocObject([string]$docId, [string]$docUrl, [string]$boundAt, $seen, $pending, [string]$observedAt) {
  [pscustomobject]@{
    doc_id      = $docId
    doc_url     = $docUrl
    bound_at    = $boundAt
    # Every comment id the run has ACKNOWLEDGED. The watermark is a SET of ids, not a
    # timestamp: Google returns replies threaded under their parent, so "newest created" is not
    # a monotonic frontier -- a reply added today can carry an older position in the dump than a
    # comment already processed. An id set cannot be fooled by ordering.
    #
    # Empties are filtered HERE, at the one constructor every path goes through, rather than at
    # each call site. `@() + @() | Select-Object -Unique` emits NOTHING, so the caller's variable
    # is $null, and `@($null)` is an array of one null -- a phantom id. Measured 2026-09-03 the
    # first time the read loop was ever run (GH #421): an -Ack with nothing pending wrote
    # `seen_ids [null]`, so `seen_comments` reported 1 on a doc with zero comments. Harmless to
    # matching, because no real id equals null, but it is a false number on the exact surface
    # #423 added for auditing whether the agent has processed a comment -- and "1 seen" on a doc
    # you have never commented on is precisely the kind of quiet wrong answer this channel
    # cannot afford.
    seen_ids    = @(@($seen) | Where-Object { "$_" -ne '' })
    # Reported by the last -Observe and not yet acked. This is what `scan` counts.
    pending_ids = @(@($pending) | Where-Object { "$_" -ne '' })
    observed_at = $observedAt
  }
}

function Get-DocState($st, [string]$path) {
  # Resolve the binding, state first, journal stamp as the self-healing fallback.
  # Returns @{ doc = <object|null>; source = 'state'|'journal'|'none'; healed = $bool }
  $doc = if ($st -and $st.PSObject.Properties['doc']) { $st.doc } else { $null }
  if ($doc -and "$($doc.doc_id)") { return @{ doc = $doc; source = 'state'; healed = $false } }
  $stamp = Get-DocMetaFromJournal $path
  if ($stamp) {
    # State was lost or never written, but the journal remembers. Rebind rather than create --
    # this is the exact case the issue's third acceptance criterion names.
    return @{
      doc    = (New-DocObject $stamp.doc_id $stamp.doc_url (Now-Iso) @() @() '')
      source = 'journal'
      healed = $true
    }
  }
  return @{ doc = $null; source = 'none'; healed = $false }
}

function Cmd-Doc {
  if (-not $Id) { throw 'doc requires -Id' }
  $path = Join-Path $JournalDir "task-$Id.md"
  if (-not (Test-Path $path)) { throw "no journal at $path" }

  $st = Read-State $Id
  if (-not $st) {
    $st = [pscustomobject]@{ id = $Id; status = 'unknown'; version = 0; plan_id = ''; processed_file_hash = ''; has_agent_block = $false; seeded = $false; updated = $null }
  }
  $resolved = Get-DocState $st $path
  $doc = $resolved.doc

  if ($Unbind) {
    Set-Member $st 'doc' $null
    $st.updated = Now-Iso
    Write-State $st
    return ([pscustomobject]@{ id = $Id; bound = $false; unbound = $true } | ConvertTo-Json -Depth 5)
  }

  if ($DocId) {
    if ($doc -and "$($doc.doc_id)" -and "$($doc.doc_id)" -ne $DocId -and -not $Force) {
      # The refusal that makes "find-or-create must be exact" true rather than merely intended.
      #
      # The leading `doc_bind_conflict` token is load-bearing, not decoration. A caller (and the
      # guard) must recognise this refusal from captured output, and with `pwsh -File` the CHILD
      # formats the error at ITS OWN terminal width and writes the formatted text to stderr --
      # so the parent cannot unwrap it, and a phrase in the middle of the sentence may be split
      # across lines on one platform and not another. That is precisely what happened: matching
      # `refusing to rebind` passed on Windows and failed on the Linux runner with byte-identical
      # BEHAVIOUR. The token is first in the message and contains no spaces or hyphens, so no
      # word-boundary wrap can break it.
      throw ("doc_bind_conflict: task $Id is already bound to doc $($doc.doc_id) (source: $($resolved.source)); " +
        "refusing to rebind to $DocId. A doc id that 404s is an error to report, not a cue to create " +
        'a second doc. Use -Force only if the first doc is genuinely gone.')
    }
    if (-not $doc -or "$($doc.doc_id)" -ne $DocId) {
      $doc = New-DocObject $DocId $DocUrl (Now-Iso) @() @() ''
    }
    elseif ($DocUrl) {
      $doc = New-DocObject $doc.doc_id $DocUrl "$($doc.bound_at)" @($doc.seen_ids) @($doc.pending_ids) "$($doc.observed_at)"
    }
    # Called for its side effect only. Its return value answers "did THIS call write the stamp",
    # which is not what `journal_stamped` reports -- see the state read below.
    [void](Add-DocMetaStamp $path $doc.doc_id "$($doc.doc_url)")
  }

  if ($Observe) {
    if (-not $doc) { throw "task $Id has no bound doc; bind one with -DocId first" }
    $obs = Read-ObservedComments $Observe
    $seen = @($doc.seen_ids)
    $new = @()
    foreach ($c in $obs) { if ($seen -notcontains $c.id) { $new += $c.id } }
    $doc = New-DocObject $doc.doc_id "$($doc.doc_url)" "$($doc.bound_at)" $seen $new (Now-Iso)
  }

  if ($Ack) {
    if (-not $doc) { throw "task $Id has no bound doc; nothing to acknowledge" }
    # Union, never replace. An -Ack after an -Observe that returned fewer rows (a partial read,
    # a filtered dump) must not un-see anything already processed.
    $seen = @($doc.seen_ids) + @($doc.pending_ids) | Select-Object -Unique
    $doc = New-DocObject $doc.doc_id "$($doc.doc_url)" "$($doc.bound_at)" $seen @() "$($doc.observed_at)"
  }

  if ($doc -and ($DocId -or $Observe -or $Ack -or $resolved.healed)) {
    Set-Member $st 'doc' $doc
    $st.updated = Now-Iso
    Write-State $st
  }

  # `journal_stamped` reports the STATE of the journal, read back here, AFTER any write above.
  #
  # It used to report whether THIS invocation wrote the stamp, which is a different question and
  # false for almost every real call (#436). Two ways that lied, both in the fail-open direction:
  # a plain `doc -Id N` resolve never enters the -DocId branch at all, so it reported `false` on a
  # correctly-stamped journal; and `Add-DocMetaStamp` returns `$false` when the journal is ALREADY
  # stamped, so even a re-bind reported `false` on the healthiest possible input. A durable
  # binding and one that is about to strand the user's comments therefore printed identically --
  # and the only field that could tell them apart said "at risk" for both.
  #
  # The comparison is against the bound id, not merely "a stamp exists". A journal stamped with a
  # DIFFERENT doc than state holds is not durable: it is the case where losing %LOCALAPPDATA%
  # heals the binding to the WRONG document, silently. That reports `false` here and names the
  # offending id in `journal_stamp_id`, so "no stamp" and "wrong stamp" are distinguishable
  # rather than both being a bare false.
  $journalStamp = Get-DocMetaFromJournal $path
  $stampId = if ($journalStamp) { "$($journalStamp.doc_id)" } else { '' }
  $stamped = [bool]($stampId -and $doc -and "$($doc.doc_id)" -and $stampId -eq "$($doc.doc_id)")

  [pscustomobject]@{
    id             = $Id
    bound          = [bool]($doc -and "$($doc.doc_id)")
    doc_id         = if ($doc) { "$($doc.doc_id)" } else { $null }
    doc_url        = if ($doc -and "$($doc.doc_url)") { "$($doc.doc_url)" } else { $null }
    source         = $resolved.source
    # True when state had lost the binding and the journal stamp put it back. Reported rather
    # than silent, because "we rebound from the journal" and "we were already bound" are
    # different facts and a run that cannot tell them apart cannot notice state loss.
    healed         = [bool]$resolved.healed
    # True iff the journal currently carries a doc-meta stamp for THIS doc, i.e. the binding
    # survives the loss of %LOCALAPPDATA%. False means state is the only copy.
    journal_stamped = [bool]$stamped
    # The id the journal actually carries, when it disagrees with the binding. Null when the
    # journal is unstamped or agrees. A bare `journal_stamped: false` cannot distinguish "no
    # stamp" (heals to nothing) from "wrong stamp" (heals to the wrong document), and those need
    # different repairs.
    journal_stamp_id = if ($stampId -and -not $stamped) { $stampId } else { $null }
    new_comments   = if ($doc) { @($doc.pending_ids).Count } else { 0 }
    new_comment_ids = if ($doc) { @($doc.pending_ids) } else { @() }
    seen_comments  = if ($doc) { @($doc.seen_ids).Count } else { 0 }
    observed_at    = if ($doc -and "$($doc.observed_at)") { "$($doc.observed_at)" } else { $null }
  } | ConvertTo-Json -Depth 5
}

# --- The per-task session binding (#404) ----------------------------------------------
# See .SESSIONS in the header for why this exists. Everything below answers one question --
# create, reuse, or replace? -- from stored state rather than from the agent's recollection.

function ConvertTo-IsoText($value) {
  # PowerShell's ConvertFrom-Json re-types an ISO-8601 STRING as a [datetime], so a timestamp read
  # back out of the state file and re-stringified renders in the host's LOCAL format
  # ("09/03/2026 15:16:45") instead of the ISO text that was stored. Every re-write of the record
  # would then corrupt its own history -- silently, and worse each time.
  #
  # Normalising on the way OUT of state rather than on the way in is deliberate: it also repairs a
  # record already written in the mangled format, so no migration is needed.
  if ($null -eq $value) { return '' }
  if ($value -is [datetime]) { return $value.ToString('yyyy-MM-ddTHH:mm:ssK') }
  $s = "$value"
  if (-not $s) { return '' }
  if ($s -match '^\d{4}-\d{2}-\d{2}T') { return $s }
  # A previously-mangled local-format stamp: parse what we can and re-emit it as ISO.
  try { return ([datetime]::Parse($s)).ToString('yyyy-MM-ddTHH:mm:ssK') } catch { return $s }
}

function New-SessionObject {
  param(
    [string]$SessionIdValue, [string]$Kind, [string]$Project, [string]$Workspace,
    [string]$WsType, $CreatedAt, $LastWokenAt, [string]$SessionState,
    [string]$PriorSessionId, $ReplacedAt
  )
  [pscustomobject]@{
    session_id       = $SessionIdValue
    kind             = $Kind
    # The project the session was created in. Recorded because the failure this guards against is
    # INVISIBLE without it: a session that inherited the run session's project looks, from its id
    # alone, exactly like one created in the right place.
    project          = $Project
    workspace        = $Workspace
    workspace_type   = $WsType
    created_at       = (ConvertTo-IsoText $CreatedAt)
    last_woken_at    = (ConvertTo-IsoText $LastWokenAt)
    # 'live' | 'dead'. Only a caller that actually TRIED to wake it may write 'dead'; nothing
    # here infers death from age, because "we did not wake it tonight" and "it cannot be woken"
    # are different facts and guessing between them either leaks a session or abandons a live one.
    state            = $SessionState
    # Set when this session REPLACED one that could not be woken. It is the continuity record:
    # without it the replacement is indistinguishable from a first-ever session, which is the
    # cold start the whole binding exists to remove.
    prior_session_id = $PriorSessionId
    replaced_at      = (ConvertTo-IsoText $ReplacedAt)
  }
}

function Test-SamePath([string]$a, [string]$b) {
  # Two paths naming the same directory. Deliberately textual (normalise separators, trailing
  # slashes and case) rather than resolved against the filesystem: the guard has to work when the
  # workspace has not been created yet, which is exactly when a bind is being validated. It is
  # also the conservative direction -- an unresolvable path that LOOKS like the run session's is
  # refused, and a false refusal costs one explicit re-run while a false pass costs the isolation.
  if (-not $a -or -not $b) { return $false }
  $na = ($a -replace '/', '\').TrimEnd('\')
  $nb = ($b -replace '/', '\').TrimEnd('\')
  return [string]::Equals($na, $nb, [StringComparison]::OrdinalIgnoreCase)
}

function Get-SessionState($st) {
  if ($st -and $st.PSObject.Properties['session'] -and $st.session -and "$($st.session.session_id)") {
    return $st.session
  }
  return $null
}

function Test-WorkspaceUsable([string]$path, [string]$wsType) {
  # Does this workspace still CONTAIN a checkout? (GH #452)
  #
  # Measured 2026-09-03: task #466's binding reported `bound: true, verdict: reuse, state: live`
  # while its workspace was an EMPTY directory -- deregistered from `git worktree list`, no `.git`,
  # no package.json. The verdict directed the next run to reuse a workspace with no repository in
  # it. `remove-worktree.ps1` deletes the workspace and knows nothing about bindings; this command
  # releases bindings and knew nothing about workspaces, so teardown-without-release left the pair
  # inconsistent and NOTHING checked.
  #
  # That is the #261 / #346 shape: a status that reports healthy continuity while the thing it
  # points at is absent. The repair existed (`-SessionDead`) and worked -- but only because a human
  # noticed and ran it. This makes the verdict answer the question itself.
  #
  # ⛔ ABSENCE OF EVIDENCE IS NOT EVIDENCE OF ABSENCE. Every failure to inspect returns $true.
  # A path we cannot read -- a disconnected network drive, a permissions blip -- is not proof the
  # checkout is gone, and guessing "gone" would DISCARD a live session's continuity, which is the
  # expensive direction. Only a directory that is provably there and provably has no checkout is
  # reported unusable.
  if (-not $path) { return $true }
  # A non-worktree workspace (a plain folder session) has no checkout to look for, so there is
  # nothing here that could distinguish healthy from broken.
  if ($wsType -and $wsType -ne 'worktree') { return $true }
  try {
    # A path that does not exist is NOT judged. "Never created yet" and "torn down" are different
    # facts and only the second is a defect: a workspace is bound before the session materialises
    # it, which `Test-SamePath` below records as "the guard has to work when the workspace has not
    # been created yet, which is exactly when a bind is being validated". This is also what makes
    # the function safe on an unreachable volume, where `Test-Path` answers $false for a
    # disconnected drive exactly as it does for a deleted directory -- the two are indistinguishable
    # here, so neither is treated as evidence.
    if (-not (Test-Path -LiteralPath $path)) { return $true }
    # `.git` in a worktree is a FILE (`gitdir: ...`), not a directory, so this must not test for a
    # container. Its absence beside a directory that STILL EXISTS is the measured signature of a
    # torn-down worktree: #466's workspace was present, empty, and deregistered.
    if (Test-Path -LiteralPath (Join-Path $path '.git')) { return $true }
    return $false
  } catch {
    return $true
  }
}

function Get-SessionVerdict($sess) {
  # The whole decision, in one place. `create` and `replace` both mean "make a new session", but
  # they are NOT the same instruction: `replace` carries a continuation the new session must be
  # told about, and collapsing them is how continuity is lost while the code still looks correct.
  if (-not $sess) { return 'create' }
  if ("$($sess.state)" -eq 'dead') { return 'replace' }
  # A live binding whose workspace no longer holds a checkout is `replace`, never `create` (#452).
  # The distinction is the whole point: this task HAS prior work, and `create` would cold-start it
  # -- losing exactly the continuity the binding exists to provide. `replace` re-creates the
  # workspace and tells the new session it is continuing.
  if (-not (Test-WorkspaceUsable "$($sess.workspace)" "$($sess.workspace_type)")) { return 'replace' }
  return 'reuse'
}

function Get-LiveSessionCount {
  # In-flight = tasks holding a LIVE session. Counted from the state store rather than tracked in
  # a counter, because a counter drifts the first time a run dies mid-item -- and a run dying
  # mid-item is the case the count exists to survive.
  if (-not (Test-Path $StateDir)) { return 0 }
  $n = 0
  foreach ($f in (Get-ChildItem $StateDir -Filter 'task-*.json' -File -ErrorAction SilentlyContinue)) {
    try { $obj = Get-Content -Raw $f.FullName | ConvertFrom-Json } catch { continue }
    $s = Get-SessionState $obj
    if ($s -and "$($s.state)" -eq 'live') { $n++ }
  }
  return $n
}

function Get-KickoffContinuation([string]$taskId, [string]$priorId) {
  # Emitted VERBATIM so the caller cannot paraphrase the continuation away. The acceptance
  # criterion is that the replacement's kickoff names the task AND the prior session id; a
  # sentence the agent is merely asked to compose satisfies that only when it remembers to.
  "This session continues work on planner task #$taskId. The previous session for this task " +
  "($priorId) could not be woken, so this one replaces it -- you are not starting from scratch. " +
  "Read the task journal for what has already been done before doing anything new."
}

function Cmd-Session {
  # ---- workspace teardown: `session -WorkspaceGone <path>`, no -Id -----------------------
  #
  # The other half of #452, and it is NOT the half `Get-SessionVerdict` can cover. Measured
  # 2026-09-04 against a REAL worktree torn down with the sanctioned `remove-worktree.ps1`:
  #
  #   before teardown : exists=True  items=23  .git=True   -> verdict reuse   (correct)
  #   after teardown  : exists=FALSE                        -> verdict reuse   (WRONG)
  #
  # The verdict cannot fix that one. A path that is absent is either a torn-down workspace or a
  # session that has been bound but has not materialised its checkout yet, and nothing on the
  # filesystem separates them -- so judging absence would discard live young sessions, which is
  # worse than the bug. #466's directory happened to SURVIVE its teardown (a live session's cwd
  # blocked the final delete), leaving the empty-directory signature the verdict does catch; a
  # clean teardown leaves nothing to look at.
  #
  # So teardown has to SAY SO. This is the coupling #452 asks for, from the side that holds the
  # fact: `remove-worktree.ps1` knows the workspace is gone because it removed it.
  #
  # It marks the binding DEAD rather than releasing it, deliberately. Releasing leaves the task
  # unbound, so the next verdict is `create` -- a cold start that discards the continuity the
  # binding exists to provide. `dead` yields `replace`, which carries the continuation. That is
  # also exactly what the manual repair of #466 used.
  if ($WorkspaceGone) {
    $hits = @()
    if (Test-Path $StateDir) {
      foreach ($f in (Get-ChildItem $StateDir -Filter 'task-*.json' -File -ErrorAction SilentlyContinue)) {
        try { $obj = Get-Content -Raw $f.FullName | ConvertFrom-Json } catch { continue }
        $s = Get-SessionState $obj
        if (-not $s) { continue }
        # EXACT path match only, via the same textual comparison the bind guard uses. A prefix
        # match would let tearing down a parent directory silently kill every binding beneath it.
        if (-not (Test-SamePath "$($s.workspace)" $WorkspaceGone)) { continue }
        $hits += [pscustomobject]@{ id = "$($obj.id)"; was = "$($s.state)" }
        if ("$($s.state)" -eq 'dead') { continue }
        $newSess = New-SessionObject -SessionIdValue "$($s.session_id)" -Kind "$($s.kind)" `
          -Project "$($s.project)" -Workspace "$($s.workspace)" -WsType "$($s.workspace_type)" `
          -CreatedAt $s.created_at -LastWokenAt $s.last_woken_at -SessionState 'dead' `
          -PriorSessionId "$($s.prior_session_id)" -ReplacedAt $s.replaced_at
        Set-Member $obj 'session' $newSess
        # Set-Member, not a direct assignment: a state object written by an older version (or a
        # hand-built one) may not carry `updated` at all, and assigning to an absent property
        # throws -- which would abort the teardown release halfway through the state store,
        # leaving some bindings marked and others not. Found exactly that way.
        Set-Member $obj 'updated' (Now-Iso)
        Write-State $obj
      }
    }
    return ([pscustomobject]@{
        workspace = $WorkspaceGone
        # Zero is a perfectly ordinary answer -- most worktrees are not bound to a task -- so this
        # is reported rather than treated as an error. A caller that cannot tell "nothing was
        # bound here" from "the lookup failed" is back in the #346 shape.
        marked_dead = @($hits | Where-Object { $_.was -ne 'dead' }).Count
        already_dead = @($hits | Where-Object { $_.was -eq 'dead' }).Count
        tasks = @($hits | ForEach-Object { $_.id })
      } | ConvertTo-Json -Depth 4)
  }

  # ---- capacity view: `session -InFlight`, no -Id ----------------------------------------
  if (-not $Id) {
    if (-not $InFlight) { throw 'session requires -Id (or -InFlight for the capacity view, or -WorkspaceGone for teardown)' }
    $live = Get-LiveSessionCount
    return ([pscustomobject]@{
        concurrency = [int]$script:ConcurrencyLimit
        # `settings-malformed` here means the user WROTE a value and it did not parse, so the run
        # is at 1 by accident rather than by choice. Reporting it is what makes the anchored parse
        # safe to narrow on: a silent fallback is indistinguishable from agreement.
        concurrency_source = "$script:ConcurrencySource"
        in_flight   = [int]$live
        at_capacity = [bool]($live -ge $script:ConcurrencyLimit)
        # How many MORE items the priority wave may start. Never negative: a run that is already
        # over capacity (a -Force bind for a collect-wave wake) admits nothing further, and
        # reporting -1 would invite a caller to do arithmetic with it.
        admits      = [int][Math]::Max(0, $script:ConcurrencyLimit - $live)
      } | ConvertTo-Json -Depth 4)
  }

  $st = Read-State $Id
  if (-not $st) {
    $st = [pscustomobject]@{ id = $Id; status = 'unknown'; version = 0; plan_id = ''; processed_file_hash = ''; has_agent_block = $false; seeded = $false; updated = $null }
  }
  $sess = Get-SessionState $st
  $dirty = $false
  $released = $false

  if ($SessionRelease) {
    $sess = $null
    Set-Member $st 'session' $null
    $st.updated = Now-Iso
    Write-State $st
    $released = $true
  }
  elseif ($SessionDead) {
    if (-not $sess) { throw "session_not_bound: task $Id has no session to mark dead" }
    $sess = New-SessionObject -SessionIdValue "$($sess.session_id)" -Kind "$($sess.kind)" `
      -Project "$($sess.project)" -Workspace "$($sess.workspace)" -WsType "$($sess.workspace_type)" `
      -CreatedAt $sess.created_at -LastWokenAt $sess.last_woken_at -SessionState 'dead' `
      -PriorSessionId "$($sess.prior_session_id)" -ReplacedAt $sess.replaced_at
    $dirty = $true
  }
  elseif ($SessionId) {
    $prior = ''
    if ($sess -and "$($sess.session_id)" -ne $SessionId) {
      if ("$($sess.state)" -ne 'dead' -and -not $Force) {
        # The refusal that makes "reuse the persisted session" a rule rather than an intention.
        # Leading space-free token for the same reason `doc_bind_conflict` has one: with
        # `pwsh -File` the CHILD formats the error at its own width, so only a token that cannot
        # be wrapped is reliably matchable from captured output.
        throw ("session_bind_conflict: task $Id is already bound to LIVE session $($sess.session_id); " +
          "refusing to bind $SessionId over it. Wake the bound session instead. If it genuinely " +
          'cannot be woken, record that with -SessionDead first -- that is the replacement path, ' +
          'and it is what carries the continuation into the new session.')
      }
      # Replacing a dead one: the prior id is the continuity record.
      $prior = "$($sess.session_id)"
    }
    elseif ($sess) { $prior = "$($sess.prior_session_id)" }

    $kind = if ($SessionKind) { $SessionKind } elseif ($sess) { "$($sess.kind)" } else { 'folder' }
    $project = if ($SessionProject) { $SessionProject } elseif ($sess) { "$($sess.project)" } else { '' }
    $workspace = if ($SessionWorkspace) { $SessionWorkspace } elseif ($sess) { "$($sess.workspace)" } else { '' }
    $wsType = if ($WorkspaceType) { $WorkspaceType } elseif ($sess -and "$($sess.workspace_type)") { "$($sess.workspace_type)" }
    elseif ($kind -eq 'code') { 'worktree' } else { 'folder' }

    if ($kind -eq 'code') {
      # A code task without a named project is the inheritance trap: every session API defaults
      # the project to the CALLER's, so omitting it silently produces a session in the run
      # session's project. Demanding it converts a silent wrong answer into a loud refusal.
      if (-not $project) {
        throw ("session_project_required: a code task must name the repository project its session " +
          "belongs to (-SessionProject). Omitting it inherits the RUN session's project, which is " +
          'how a "per-task session" ends up sharing the run session workspace with no git repo in it.')
      }
      if (-not $workspace) {
        throw ('session_workspace_required: a code task must name its own workspace ' +
          '(-SessionWorkspace) -- a worktree or branch checkout, not a shared folder.')
      }
      if ($wsType -eq 'folder') {
        throw ("session_workspace_type: a code task cannot use a 'folder' workspace; " +
          'use worktree (preferred) or branch.')
      }
      $runWs = if ($RunWorkspace) { $RunWorkspace } else { (Get-Location).Path }
      if ($runWs -and (Test-SamePath $workspace $runWs)) {
        throw ("session_workspace_inherited: workspace '$workspace' is the RUN session's own " +
          'workspace. One task, one workspace -- sharing one deadlocks the sessions and reproduces ' +
          'the very isolation failure #404 exists to prevent.')
      }
    }

    # Capacity is checked only when this bind ADDS an item to the run. Re-binding the same id, or
    # replacing a dead session, does not increase what is in flight, so charging them against the
    # limit would make the run narrower than the user asked for.
    $adds = -not ($sess -and ("$($sess.session_id)" -eq $SessionId -or "$($sess.state)" -eq 'dead'))
    if ($adds -and -not $Force) {
      $live = Get-LiveSessionCount
      if ($live -ge $script:ConcurrencyLimit) {
        throw ("session_at_capacity: $live task(s) already hold a live session and the " +
          'Overnight Agent concurrency setting is ' + $script:ConcurrencyLimit + '. Finish or ' +
          'release one first. -Force is for the collect-wave exception only ' +
          '(Prioritisation.md 4.1): a wake that exists because the USER did something may widen ' +
          "the run; the agent's own judgement may not.")
      }
    }

    $created = if ($sess -and "$($sess.session_id)" -eq $SessionId -and $sess.created_at) { $sess.created_at } else { Now-Iso }
    $replacedAt = if ($prior -and "$($sess.session_id)" -ne $SessionId) { Now-Iso } elseif ($sess) { $sess.replaced_at } else { '' }
    $sess = New-SessionObject -SessionIdValue $SessionId -Kind $kind -Project $project `
      -Workspace $workspace -WsType $wsType -CreatedAt $created `
      -LastWokenAt $(if ($sess -and "$($sess.session_id)" -eq $SessionId) { $sess.last_woken_at } else { '' }) `
      -SessionState 'live' -PriorSessionId $prior -ReplacedAt $replacedAt
    $dirty = $true
  }

  if ($SessionWoken) {
    if (-not $sess) { throw "session_not_bound: task $Id has no session to wake" }
    $sess = New-SessionObject -SessionIdValue "$($sess.session_id)" -Kind "$($sess.kind)" `
      -Project "$($sess.project)" -Workspace "$($sess.workspace)" -WsType "$($sess.workspace_type)" `
      -CreatedAt $sess.created_at -LastWokenAt (Now-Iso) -SessionState 'live' `
      -PriorSessionId "$($sess.prior_session_id)" -ReplacedAt $sess.replaced_at
    $dirty = $true
  }

  if ($dirty) {
    Set-Member $st 'session' $sess
    $st.updated = Now-Iso
    Write-State $st
  }

  $verdict = Get-SessionVerdict $sess
  $live = Get-LiveSessionCount
  [pscustomobject]@{
    id             = $Id
    bound          = [bool]$sess
    session_id     = if ($sess) { "$($sess.session_id)" } else { $null }
    # create | reuse | replace. The run loop acts on THIS, not on `bound`.
    verdict        = $verdict
    state          = if ($sess) { "$($sess.state)" } else { $null }
    kind           = if ($sess) { "$($sess.kind)" } else { $null }
    project        = if ($sess -and "$($sess.project)") { "$($sess.project)" } else { $null }
    workspace      = if ($sess -and "$($sess.workspace)") { "$($sess.workspace)" } else { $null }
    workspace_type = if ($sess) { "$($sess.workspace_type)" } else { $null }
    prior_session_id = if ($sess -and "$($sess.prior_session_id)") { "$($sess.prior_session_id)" } else { $null }
    created_at     = if ($sess) { (ConvertTo-IsoText $sess.created_at) } else { $null }
    last_woken_at  = if ($sess -and $sess.last_woken_at) { (ConvertTo-IsoText $sess.last_woken_at) } else { $null }
    released       = [bool]$released
    # Present ONLY on a `replace` verdict, and emitted ready to paste. See Get-KickoffContinuation.
    kickoff_continuation = if ($verdict -eq 'replace') { (Get-KickoffContinuation $Id "$($sess.session_id)") } else { $null }
    # Emitted, never executed (#321): the raw `git worktree remove --force` deletes THROUGH a
    # node_modules junction, so the safe teardown is named here rather than performed here.
    teardown_command = if ($sess -and "$($sess.workspace_type)" -eq 'worktree' -and "$($sess.workspace)") {
      "pwsh -NoProfile -File scripts/remove-worktree.ps1 -Path `"$($sess.workspace)`""
    }
    else { $null }
    concurrency    = [int]$script:ConcurrencyLimit
    concurrency_source = "$script:ConcurrencySource"
    in_flight      = [int]$live
    at_capacity    = [bool]($live -ge $script:ConcurrencyLimit)
  } | ConvertTo-Json -Depth 5
}

function Cmd-Resnapshot {
  #
  # Why this is needed. The hash is computed from the decoded journal text, so any change to
  # HOW the journal is decoded changes every hash at once -- even though not one byte on disk
  # moved. Pinning the decoder to UTF-8 (see Read-JournalText) is exactly such a change: the
  # first scan afterwards reports every non-ASCII journal as `changed`, and each one that has
  # trailing prose then reports `reopened`. That is a queue flood of phantom replies.
  #
  # The guard is the whole point: a journal with trailing USER content is SKIPPED. Those are
  # the ones that might hold a real unanswered message, and re-snapshotting one would mark it
  # answered -- silently, with no trace. Quiet journals are safe to re-baseline because there
  # is nothing under the agent's turn to lose.
  #
  # Idempotent, and it never writes to a journal -- only to the state store.
  $journals = Get-ChildItem $JournalDir -Filter 'task-*.md' -File |
    Where-Object { $_.BaseName -match '^task-\d+$' } | Sort-Object Name
  $updated = 0; $skipped = 0; $untracked = 0
  foreach ($f in $journals) {
    $facts = Get-JournalFacts $f.FullName
    $st = Read-State $facts.Id
    if (-not $st) { $untracked++; continue }
    if ($facts.FullHash -eq $st.processed_file_hash) { continue }
    if ($facts.HasTrailingUser) {
      # Something is below the agent's turn. Leave it visible rather than baselining over it.
      $skipped++
      continue
    }
    $st.processed_file_hash = $facts.FullHash
    $st.has_agent_block = $facts.HasAgentBlock
    $st.updated = Now-Iso
    Write-State $st
    $updated++
  }
  [pscustomobject]@{
    rebaselined       = $updated
    left_for_review   = $skipped
    untracked         = $untracked
  } | ConvertTo-Json -Depth 4
}

function Set-ExhaustionDeclaration {
  # The exhaustion DECLARATION (#310) -- the affirmative statement that releases the
  # Today->Deferred gate. Everything about the shape of this call is chosen to make the
  # declaration cheap to make honestly and awkward to make falsely.
  #
  #   IT IS ITS OWN CALL. `-Exhausted` cannot be combined with `-Status`/`-Version`/`-PlanId` or
  #   with any timer flag. That is the structural half of the #310 fix: the act that RELEASES
  #   the gate can no longer ride along on the act that WRITES a turn, so writing can never
  #   release by accident. A caller that wants both must ask for both, in that order, on purpose.
  #
  #   IT MUST NAME WHAT IT EXAMINED. An empty declaration is rejected outright. "Exhausted" is a
  #   claim about a set; a claim that names no set asserts nothing and would be a shrug with the
  #   authority of a decision.
  #
  #   IT MUST FOLLOW REAL WORK. There must be a `last_turn_at` within -ExhaustionTtlMinutes: you
  #   may not declare a row exhausted that this run never opened. Note the direction -- writing a
  #   turn is now NECESSARY BUT NOT SUFFICIENT, which is the exact inversion of the #310 defect,
  #   where writing alone was sufficient.
  #
  #   IT DOES NOT TOUCH THE JOURNAL. No turn terminator, no re-snapshot, no `last_turn_at`. A
  #   declaration is a statement about work already recorded, so it must not be able to absorb a
  #   user reply that arrived in the meantime, and it must not refute itself (see
  #   Test-ExhaustionClaim's `exhaustion_superseded`).
  #
  # It records the hash of the `## Today` section it was made against, which is what lets the
  # HUMAN revoke it -- silently and without knowing this file exists -- just by editing the board.
  $st = Read-State $Id
  if ($ExhaustionClear) {
    if (-not $st) { throw "task $Id has no state to clear" }
    Set-Member $st 'today_exhausted' $null
    $st.updated = Now-Iso
    Write-State $st
    return ($st | ConvertTo-Json -Depth 6)
  }

  if ($Status -or $Version -gt 0 -or $PlanId -or $Poll -or $PollDone -or $PollClear -or
      $Recheck -or $RecheckKind -or $RecheckDone -or $RecheckClear) {
    throw "-Exhausted is a separate declaration and cannot be combined with -Status/-Version/-PlanId or any timer flag: write the turn first, then declare exhaustion in its own call"
  }
  if ($ExhaustionTtlMinutes -le 0) {
    throw "-Exhausted is disabled (-ExhaustionTtlMinutes is $ExhaustionTtlMinutes)"
  }

  $examined = @(($Exhausted -split '[,;\r\n\t ]+') | ForEach-Object { $_.Trim() } | Where-Object { $_.Length -gt 0 })
  if ($examined.Count -eq 0) {
    throw "-Exhausted must name what was examined (e.g. -Exhausted 'gh:197,gh:179,gh:139'); an unnamed declaration asserts nothing"
  }

  # ONE guard, deliberately: "there is no turn", "the turn is unreadable" and "the turn is too
  # old to be this run's" are the same refusal -- you may not declare a row this run has not
  # worked -- and splitting them into separate throws would leave a mutant that deletes only the
  # first one still failing on the second, i.e. a hole no test can see.
  $lt = [datetime]::MinValue
  $hasTurn = [bool]($st -and $st.PSObject.Properties['last_turn_at'] -and $st.last_turn_at -and
    [datetime]::TryParse(
      "$($st.last_turn_at)", [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::None, [ref]$lt))
  if (-not $hasTurn -or ((Get-Date) - $lt).TotalMinutes -ge $ExhaustionTtlMinutes) {
    throw "task $Id has no turn recorded in the last $ExhaustionTtlMinutes minute(s): work the row and mark it this run before declaring it exhausted"
  }

  Set-Member $st 'today_exhausted' ([pscustomobject]@{
      at         = Now-Iso
      examined   = $examined
      note       = "$ExhaustedNote"
      today_hash = Get-TodaySectionHash
    })
  $st.updated = Now-Iso
  Write-State $st
  return ($st | ConvertTo-Json -Depth 6)
}

function Cmd-Mark {
  if (-not $Id) { throw 'mark requires -Id' }
  $path = Join-Path $JournalDir "task-$Id.md"
  if (-not (Test-Path $path)) { throw "no journal at $path" }
  # The exhaustion declaration (#310) branches out BEFORE anything below touches the journal or
  # stamps a turn -- see Set-ExhaustionDeclaration for why it must be a separate act.
  if ($Exhausted -or $ExhaustionClear) { return (Set-ExhaustionDeclaration) }
  # Stamp the turn boundary BEFORE snapshotting, so the hash recorded below describes the
  # file as it now stands on disk. Doing it after would record a hash the file no longer has
  # and every subsequent scan would report a phantom change.
  [void](Add-TurnTerminator $path)
  $facts = Get-JournalFacts $path
  $st = Read-State $Id
  if (-not $st) {
    $st = [pscustomobject]@{ id = $Id; status = 'unknown'; version = 0; plan_id = ''; processed_file_hash = ''; has_agent_block = $true; seeded = $false; updated = $null }
  }
  if ($Status) { $st.status = $Status }
  if ($Version -gt 0) { $st.version = $Version }
  if ($PlanId) { $st.plan_id = $PlanId }

  # --- Polling -------------------------------------------------------------------
  $existingPoll = if ($st.PSObject.Properties['poll']) { $st.poll } else { $null }
  if ($PollClear) {
    Set-Member $st 'poll' $null
  }
  elseif ($Poll) {
    # (Re)arm: due immediately so the very next scan picks it up.
    $mins = Parse-PollMinutes $Poll
    Set-Member $st 'poll' (New-PollObject $Poll.Trim().ToLower() $mins '' (Get-Date))
  }
  elseif ($PollDone) {
    if (-not $existingPoll) { throw "task $Id has no poll to mark done (arm one with -Poll first)" }
    $mins = [int]$existingPoll.interval_minutes
    Set-Member $st 'poll' (New-PollObject "$($existingPoll.cadence)" $mins (Now-Iso) (Get-Date).AddMinutes($mins))
  }

  # --- Blocked-task rechecks (#395) ----------------------------------------------
  # Same timer machinery as a poll, aimed at the BLOCKER rather than at recurring work, so a
  # blocked task re-enters the worklist on a cadence instead of parking forever.
  $existingRecheck = if ($st.PSObject.Properties['recheck']) { $st.recheck } else { $null }
  if ($RecheckClear) {
    Set-Member $st 'recheck' $null
  }
  elseif ($Recheck) {
    # (Re)arm: due immediately so the very next scan picks it up.
    $rmins = Parse-PollMinutes $Recheck
    $kind = if ($RecheckKind) { $RecheckKind.Trim() } elseif ($existingRecheck) { "$($existingRecheck.kind)" } else { '' }
    Set-Member $st 'recheck' (New-RecheckObject $Recheck.Trim().ToLower() $rmins $kind '' (Get-Date))
  }
  elseif ($RecheckDone) {
    if (-not $existingRecheck) { throw "task $Id has no recheck to mark done (arm one with -Recheck first)" }
    $rmins = [int]$existingRecheck.interval_minutes
    $kind = if ($RecheckKind) { $RecheckKind.Trim() } else { "$($existingRecheck.kind)" }
    Set-Member $st 'recheck' (New-RecheckObject "$($existingRecheck.cadence)" $rmins $kind (Now-Iso) (Get-Date).AddMinutes($rmins))
  }
  elseif ($RecheckKind -and $existingRecheck) {
    # Retag an armed recheck without disturbing its timer.
    Set-Member $st 'recheck' (New-RecheckObject "$($existingRecheck.cadence)" ([int]$existingRecheck.interval_minutes) $RecheckKind.Trim() "$($existingRecheck.last_rechecked)" ([datetime]::Parse($existingRecheck.next_due)))
  }

  # Re-snapshot: the agent has now processed the journal as it currently stands.
  $st.processed_file_hash = $facts.FullHash
  $st.has_agent_block = $facts.HasAgentBlock
  $st.updated = Now-Iso
  # `last_turn_at` is DELIBERATELY not `updated`. `updated` means "this state record was
  # touched", and it is stamped by `seed` (a bootstrap over every journal on disk) and by
  # `resnapshot` (a rebaseline) as well as by a real turn. Feeding that into the Today gate
  # made every freshly-seeded task read as "the agent just worked this", which released the
  # Today->Deferred gate for the whole board after any seed or migration -- caught by
  # mutcheck-board-compound-id, whose fixture seeds before it scans.
  #
  # Pure timer bookkeeping (-PollDone/-RecheckDone and the clear/retag forms) is not a turn
  # either: nothing was written to the journal, so it must not buy the row a release. Anything
  # that carries -Status/-Version/-PlanId, or a bare `mark`, is the documented "I just wrote my
  # turn" call and does count.
  #
  # SINCE #310 THIS FIELD NO LONGER RELEASES THE GATE. It is a precondition for declaring
  # exhaustion (you may not declare a row you never opened), it refutes a declaration made
  # before it (`exhaustion_superseded`), and it resets the wedged-run backstop. All three
  # directions make a fresh stamp hold the gate LONGER, so writing can no longer open it.
  # Absent still means "never worked", which keeps the row gating.
  $timerOnly = ($PollDone -or $PollClear -or $RecheckDone -or $RecheckClear -or ($RecheckKind -and -not $Recheck))
  $isTurn = -not ($timerOnly -and -not $Status -and $Version -le 0 -and -not $PlanId)
  if ($isTurn) {
    Set-Member $st 'last_turn_at' (Now-Iso)
    # WHO wrote it (#477). `last_turn_at` alone made the wake token anonymous, so G12 could tell
    # that a turn existed but not whose it was -- and on the first wake after it shipped, the run
    # session wrote first and the guard then locked out the sub-session the contract names as sole
    # author. Recording the author is what lets the OWNER supersede a non-owner instead.
    #
    # Taken from the runtime rather than from a parameter, so it is DERIVED and cannot be
    # forgotten: `COPILOT_AGENT_SESSION_ID` is set by the harness for whichever session is
    # running, and it is the same value the session binding already stores as
    # `session.session_id`. Ownership is therefore checkable - the two are compared - rather than
    # asserted by whoever happens to be calling.
    #
    # UNSET RECORDS 'unknown', NEVER THE OWNER. An undefaulted value that fails toward the
    # outcome it is meant to prevent is #462, and here that failure would be silent and exactly
    # backwards: an unattributed turn would inherit the owner's authority and lock the real owner
    # out. 'unknown' is supersedable, which is the safe direction.
    $by = if ($TurnBy) { $TurnBy } elseif ($env:COPILOT_AGENT_SESSION_ID) { $env:COPILOT_AGENT_SESSION_ID } else { 'unknown' }
    Set-Member $st 'last_turn_by' $by
  }
  Write-State $st
  $st | ConvertTo-Json -Depth 6
}

# Resolve the gate tunables BEFORE dispatching, so every command sees the same values and no
# code path can read a half-resolved one. It is here rather than beside the parameter block
# because it calls Read-JournalText, which is defined further down the file.
Resolve-GateSettings
Resolve-PacingSettings

switch ($Command) {
  'seed' { Cmd-Seed }
  'scan' { Cmd-Scan }
  'get' { Cmd-Get }
  'mark' { Cmd-Mark }
  'resnapshot' { Cmd-Resnapshot }
  'consent' { Cmd-Consent }
  'gate' { Cmd-Gate }
  'extract' { Cmd-Extract }
  'doc' { Cmd-Doc }
  'session' { Cmd-Session }
}
