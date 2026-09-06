# Domain: app

`app` (`src/`) is the React board and its pure content-transformation core: reading and writing
`planner.md`/`planner-completed.md` and journals, rendering the board and the journal chat thread,
and the id/link/priority bookkeeping the board depends on. It is the repository's largest domain by
module count (37) and by far its largest single file (`src/App.jsx`, 7,215 lines — the whole
component tree).

## Responsibility

Everything a user sees and clicks: the board table, search, snoozing, moving tasks between
sections/sources, the journal chat renderer, storage-source picking, and the agent-gate/settings
editors. Deliberately split so the algorithmic core is pure and framework-free — `focusPlanOps.js`,
`boardRow.js`, `journalChat.js`, `taskSort.js`, `snooze.js` and friends take/return plain strings and
objects, with no React and no I/O — so the exact same logic runs identically from the single-source
view and the multi-source Combined view, and can be unit-tested without mounting a component tree.

## Principal modules

| Path | Purpose |
| --- | --- |
| `src/App.jsx` | The component tree: board rendering, routing between views, wiring every operation below to storage. |
| `src/focusPlanOps.js` | Pure `content -> newContent` operations on `planner.md`: add/move/rename/snooze/delete a task, manage manager priorities, allocate new task ids (`allocateNextId`). |
| `src/boardRow.js` | The single row/header-alignment rule (issue #426) — resolves `Wake` vs `Linked ID` by header name on a ragged table, shared by the writer and the reader so they cannot disagree. |
| `src/boardTable.js` | The app-side markdown table reader; the reader half of the #426 contract whose writer half is `focusPlanOps.js`. |
| `src/journalChat.js` | Parses/renders journal markdown as a chat thread (`parseJournalChat`); dependency-free so `packages/task-paper` can embed it verbatim as an inline module script. |
| `src/taskSort.js` | `sortTasksByPriority`, manager-priority chain resolution, the `## Priorities` list parser. |
| `src/snooze.js` | Snooze-date parsing/formatting and the `<!-- snooze:YYYY-MM-DD -->` cell grammar. |
| `src/boardRepair.js` | A pure, `content -> { content, changes }` repair for the #307 board-rewrite defect; the only thing that may touch `planner.md` with it is the dry-run-by-default `scripts/repair-board-307.mjs`. |
| `src/selfHealIds.js` | Temporary defence-in-depth: renumbers stray high-outlier task ids (a legacy bug's polluted replicas) back into the planner's own contiguous range on load; deliberately isolated so it can be deleted once every device has healed. |
| `src/idTombstones.js` | Remembers a deleted task's id for a TTL window so a resurrected stale replica of its old journal cannot hijack a freshly-reused id. |
| `src/moveTask.js` | Computes which tasks travel together when moving across storage sources (a manager-priority task drags its whole dependency subtree), and which cross-source links would break. |
| `src/combinedRouting.js` / `combinedViewPatch.js` | Multi-source write routing and optimistic UI patching for the Combined view. |
| `src/readState/*` | Read/unread tracking: a swappable provider interface (`localStorageReadStateProvider.js`), a business-logic-only controller (`readStateService.js`), and a lightweight per-journal content signature (`signature.js`) so a UI component never computes or persists state itself. |
| `src/skillsSection.js` / `SkillsSection.jsx` | Read-only parsing/rendering of the board's `## Skills` section — the planner surfaces skills but never edits them. |
| `src/journalLoadQueue.js` | An ordered, concurrency-limited, de-duplicated async queue so 90+ board rows mounting at once do not fire ~180 concurrent journal reads against a cloud provider simultaneously. |

## Public exports (selected)

`allocateNextId`, `opAddTask`, `opSnoozeTask`, `opMoveBetweenSections`, `opChangePriority`,
`opRenameTask`, `opDeleteTask` (`focusPlanOps.js`); `parseJournalChat`, `appendJournalMessage`,
`AGENT_SENTINEL_RE` (`journalChat.js`); `sortTasksByPriority`, `parseManagerPriorities`
(`taskSort.js`); `rowCells`, `alignRowToHeaders`, `wakeSeamIndex`, `recoverMisfiledLinkedId`
(`boardRow.js`); `planBoardRepair`, `verifyBoardRepair` (`boardRepair.js`); `computeMoveSet`,
`renumberMovedRows` (`moveTask.js`).

## Behavioural requirements (from the app test suite, 35 files / 389 tests)

- **Id allocation never collides, even across a foreign journal counter.** `allocateNextId` numbers
  from the content max while ignoring a foreign high journal id, skips any id that already has a
  journal, and skips the union of live content ids and journal ids — the fix for a bug that let new
  ids inherit a distant journal counter (issue #528: `opAddTask` never reuses a live task id).
- **A ragged Deferred row keeps its `Linked ID`, never mistakes `Wake` for it.** The #426 reader
  suite asserts a 6-field row under a 7-column header binds its trailing field to `Linked ID` (not
  `Wake`), a 7-field row is read as before, an over-wide row does not shift columns, and the RIGHT-most
  tail of an over-wide row is kept — so `Linked ID` survives rather than a stray cell.
- **A misfiled `Linked ID` value never becomes a fabricated snooze (#446).** `recoverMisfiledLinkedId`
  moves a non-date value sitting in `Wake` into an empty `Linked ID`, leaves a real wake date alone,
  never clobbers an already-populated `Linked ID`, is a no-op on a header with no `Wake` column
  (Today), and — critically — snoozing a task afterward preserves the misfiled id rather than
  overwriting it, and clearing the snooze round-trips the link intact.
- **Deleted-id tombstones prevent reuse collisions.** A deleted id's tombstone blocks its reuse
  during allocation while active, expires and is prunable, and an invalid id is ignored rather than
  poisoning the store.
- **Read-state is event-driven and provider-swappable.** The service computes and persists nothing
  in the UI layer; components only hand it raw content, render a boolean, and fire an "opened" event.

## Failure modes guarded against

The dominant recurring shape across this domain's tests is **a reader and a writer of the same
ragged/ambiguous format disagreeing** — #426 (Wake/Linked ID column alignment), #446 (a misfiled
value read as the wrong field), #528 (id allocation reading a different "max" than reality). Every
fix responds the same way: one shared implementation (`boardRow.js`, `allocateNextId`) imported by
both sides, rather than two independent parsers kept in sync by discipline.
