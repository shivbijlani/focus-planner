# Behaviour

This page states the system's required behaviour as testable statements, grouped by functional area
rather than by source domain. Each statement is drawn from a real test name in `testFiles` and is
phrased as a "must," because together they are the acceptance suite a rebuilt implementation has to
satisfy — a reimplementation that passes every statement below is behaviourally equivalent to this one,
regardless of internal structure.

## Board integrity and editing

- Adding, deleting, moving, renaming, snoozing, changing priority, and promoting a task to manager
  priority must all match their target row regardless of CRLF vs LF line endings or incidental cell
  padding (`focusPlanOps.test.js`).
- A future `Wake` date must defer a Today row to Deferred; an expired `Wake` date must auto-return a
  Deferred row to Today and clear the cell; a marker-less Deferred row must be left untouched
  (`focusPlanOps.test.js`, `snooze.test.js`, `boardWakeMigration.test.js`).
- Sorting must produce a strict, deterministic total order even with cyclic `Linked ID` chains: urgent
  rows must float above all non-urgent rows regardless of manager priority; a shorter dependency chain
  must sort before a longer one within the same priority tier (`taskSort.test.js`).
- A ragged or misaligned board row must still be read and written consistently by both the reader and
  the writer (`raggedRow.test.js`, `misfiledLinkedId.test.js`).
- An allocated task id must never collide with an id already in use on either board, and the allocator
  must handle a numbering gap correctly (`allocateId.test.js`, `autoNumber.test.js`).
- A deleted task's id must not be reusable until its tombstone TTL has elapsed, and the tombstone set
  must persist and prune correctly (`idTombstones.test.js`).
- A journal with no reachable row on either board must be flagged, but only if it is not already
  tombstoned or terminal; string and numeric ids must compare as equal (`unreachableJournals.test.js`).
- Board search must find a task by content match across sections (`boardSearch.test.js`).
- Moving a task between sources or sections, including dragging a manager-priority task's whole
  dependency subtree, must move exactly that subtree and nothing else (`moveTask.test.js`).
- A runaway task id that escaped into a foreign numeric range must be self-healed exactly once and the
  healing mechanism must be able to delete itself afterward (`selfHealIds.test.js`).
- The `## Skills` board section must be parsed read-only and never edited by planner operations
  (`skillsSection.test.js`, `SkillsSection.test.jsx`).
- The agent gate editor UI must round-trip `agent-gate.md`'s two managed lists without disturbing
  unrelated file content (`AgentGateEditor.test.jsx`).

## Journal chat parsing and lifecycle

- Journal chat parsing must be fence-aware: a `## `-looking line or a `<!-- from: -->` marker quoted
  inside a fenced code block must never be read as live structure (`journalChat.test.js`).
- Creating, refreshing, deleting, and hydrating a journal must each leave the board and the journal
  file in a consistent, mutually reachable state (`journalCreate.test.js`, `journalCreateRefresh.test.js`,
  `journalDelete.test.js`, `journalHydrationWiring.test.js`, `journalFocusRefresh.test.js`).
- The journal load queue and load-state tracking must serialize concurrent loads and reflect an
  accurate loading/loaded/error state per journal (`journalLoadQueue.test.js`, `journalLoadState.test.js`).
- Journal attachments must be tracked and associated with the correct message (`journalAttachments.test.js`).
- Read/unread state must be event-driven (the UI fires events; a provider, currently localStorage,
  persists it) and a signature-based mechanism must detect whether a journal has changed since last read
  (`readState/readStateService.test.js`, `readState/signature.test.js`).
- Navigating to a linked task, or scrolling to a specific task in a long board, must land on the
  correct element (`linkedNav.test.js`, `scrollToTask.test.js`).

## Cross-source and multi-provider correctness

- A merged "Combined" view row must carry its true owning source id so a destructive operation is never
  routed to the wrong source, even when two sources share identical row text or local ids
  (`combinedRouting.test.js`, `combinedViewPatch.test.js`, `sourcePath.test.js`).
- A file-tree comparison or filter must treat two directory listings as equal only when their actual
  contents match, and must correctly filter by path/type (`fileTreeEqual.test.js`, `fileTreeFilter.test.js`).

## Storage and sync providers

- Pagination must be followed to completion for `journalIds()`, `maxJournalId()`, `getFiles()`, and any
  flat listing — stopping at the first page must never be treated as a complete result.
- Diagnostics must never leak a secret value; only provider id, token expiry, and refresh-token presence
  may be recorded.
- Sync-status coalescing must apply the first status change immediately and collapse a rapid burst of
  identical states into one final state, without re-applying a no-op burst.
- An `AbortSignal` must be honored by every cloud read/existence check; only an explicit not-found
  response may be treated as absence — any other error must propagate rather than be swallowed.
- Task-settings writes must serialize concurrent toggles, coerce a malformed entry to defaults, and
  preserve unknown per-task keys across a round trip.

## Folder-sync merge core

- A delete must never be resurrected by a stale full-file replica (`merge.test.js`).
- An alive-but-recordless sidecar entry must be preserved alive (never crash as `undefined`, never be
  silently voided into a tombstone), with its clock raised to the highest known value and an anomaly
  logged.
- A zero clock must be treated as an implicit "unknown" for exactly one merge, never as a durable value
  that permanently freezes a remote record.
- An empty record set must be refused as "everything was deleted" unless the caller explicitly opts in,
  distinguishing a genuine full clear from a parse failure that happened to yield zero records.
- `isMassDeletion` must flag a full wipe but never an ordinary single deletion, and must never fire when
  there is no tracked baseline to compare against.
- `planMirrorSync` must rehydrate a file missing from the active store rather than deleting its mirror,
  and must never treat an empty mirror file the active store also lacks as a deletion to propagate.
- `isValidRemotePath` must reject a source-scoped key that leaked into the sync queue and every
  character a provider forbids in a path segment.
- A merge must never overwrite a structured or populated `## Priorities` frame with an empty one
  (`records.test.js`: "BLANK-PLANNER BUG", "PRIORITIES-WIPE BUG").

## Telegram bridge

- A turn exceeding Telegram's 4,096-character cap must be split into balanced parts with none exceeding
  the cap, and the ask must never be truncated away; a split turn must not be reposted on a later run.
- A superseded turn must be deleted and replaced, never stacked — unless the user has already replied to
  it, in which case it must never be deleted.
- A 429 rate-limit mid-sweep must resume and post each task exactly once across the crash/retry
  boundary, honoring the server's advised `retry_after`.
- The digest must read the newest turn only, never a whole-file grep for the last ask marker; a
  superseded ask restated in later prose without re-emitting the marker must not resurface.
- Status must be read from the newest turn, never from a frozen header line: a task whose newest turn
  says Done must drop out of the digest even if its header still says blocked, and vice versa for a
  reopened task; a fix in this area may only add information, never override a genuinely informative
  frozen header with nothing.
- The digest must order by the board's own priority signals, sink a malformed id or a task absent from
  the board, and exclude a P0 whose only "ask" is the agent's own next step.
- A task must be archived only when a sync record explicitly marks it `deleted: true`; a board that
  fails to parse must never be read as "everything on it was deleted."
- A General-thread reply must route by a known task id, never by a coincidental digit sequence in the
  prose, and an unroutable reply must be reported, never silently discarded.
- A catch-up-doc link must replace the per-turn post and stay quiet across repeated unchanged runs,
  updating in place rather than stacking a second notice when the ask changes.

## Task papers

- The embedded journal-chat writer script must be byte-identical to the app's own source, must refuse
  source that would break out of its `<script>` element, and must bake in only the one task's own
  journal filename.
- A comment must land in the journal after the turn-end stamp so it reopens the task through the
  agent's existing reopen detection, with no second detection mechanism.
- Rendering must be fully deterministic: byte-identical output for identical input, with no clock, nonce,
  or random id anywhere in the generated page.
- The newest agent turn must become the paper's body; every superseded turn and the run log must move to
  the appendix; a quoted turn heading or marker inside a fenced example must never fabricate a second
  turn or a new day.
- The renderer must escape all HTML appearing in journal prose and must refuse to make a
  `javascript:` URL clickable while still keeping its text.

## Config and settings round-trips

- `serializeAgentGate` must round-trip the canonical document and CRLF input unchanged, preserve any
  user-authored title/preamble/comment/section, remain stable across repeated saves, and never be
  triggered to overwrite an existing gate file by `scaffoldAgentGate`.
- `parseAgentGate` must tolerate `*`/`+`/`-` bullets, prose between them, CRLF input, reworded headings
  matched by keyword, and a file carrying only one of its two sections.
- `serializeSettingsForm(md, parseSettingsForm(md).map(r => r.value))` must return `md` unchanged for any
  input, including CRLF and odd spacing; changing one field's value must change only that field's cell.
- `partitionAgentSettings` must lose no rows — the union of its user-facing and advanced partitions must
  equal the input rows — and must keep section headers attached to their rows.
- Settings classification must default an unrecognized label to advanced, never to user-facing.
- `scaffoldAgentsDoc` must refresh an out-of-date `AGENTS.md` but must never rewrite an up-to-date one.

## MCP credential pointer file

- The committed example pointer file must validate as-is.
- A missing version, a secret entry missing a required field, an invalid environment-variable name, or
  a duplicate server/credential-target must each be rejected.
- Malformed JSON must throw; an invalid shape must throw with field-level detail.

## Diagnostics

- `diag(...)` must be a cheap no-op when diagnostics are disabled.
- An enabled event must fan out to every registered sink using one shared, per-context-correlated event
  schema, and must be recorded into a bounded ring buffer per context without emitting live console
  traffic on its own.
- A diagnostics request must select the correct worker (e.g. folder-sync, not the root app worker), must
  keep worker diagnostics enabled while any client still wants them, must prune a client once its tab
  closes, and must recover cleanly (re-request, re-advertise) after a worker restart.

## Repository tooling and the spec pipeline

- `classifyNodeModules` must distinguish empty, missing, and unreadable states, and the pretest guard
  must fail only for the empty (post-junction-deletion) state.
- The verified PR merge queue must contain no duplicates, must never queue an excluded PR, must respect
  every stacking dependency, and must have a non-decreasing expected test count across its steps;
  planning must halt at the first conflicting or unfindable PR rather than guess past it.
- The spec-conflict detector must require a shared, specific target before calling two issues a
  conflict, must not flag two issues that merely share a topic or restate the same setting/value, and
  must report one finding per pair per kind.
- The spec-verify-parity checker must read the workflow files themselves and cover every npm command CI
  uses to gate a pull request; its own mutation check must catch a verification step being silently
  dropped from the spec job.

## Overnight Agent (mutation-tested, not vitest)

The overnight-agent domain carries no meaningful vitest suite (`stuck-run-sweep.test.mjs` and
`workflow-health-sweep.test.mjs` both currently have empty test arrays); its behavioural specification
instead lives in the PowerShell/`.mjs` `mutcheck-*` harness described in [Domain:
overnight-agent](Domain-overnight-agent), [Prioritisation](Prioritisation), and [Reliability](Reliability).
A rebuilt implementation must satisfy those mutation-tested guarantees — for example, that a guard's
removal flips exactly the fixture it owns — with the same rigor this page states for the JS-tested
domains above, because a sweep that only ever passes is treated in this codebase as equivalent to no
sweep at all.
