# Domain: app

## Responsibility

The web application: a single-page React app (`src/App.jsx`, 7,215 lines) that renders the board(s),
journals, and settings editors, and orchestrates every pure transformation of board/journal content
before handing the result to the storage layer. Almost none of the actual logic lives in `App.jsx`
itself — it is deliberately a thin shell over dependency-free, unit-tested modules, because (per
`src/boardTable.js`'s doc comment) nothing in the test suite imports `App.jsx` at all: doing so would
pull in React and the whole component tree, so any logic left inside it is *by construction* untested.
That constraint is why the domain is organized as ~35 small modules each doing one transformation.

## Principal modules

| Module | Role |
| --- | --- |
| `src/focusPlanOps.js` | Every pure content-transformation on `planner.md`: add/delete/move/rename/snooze/link a task, promote to manager priority. |
| `src/boardTable.js` / `src/boardRow.js` | The reader and the shared header-alignment rule (issue #426 — see [Data-Formats](Data-Formats)). |
| `src/taskSort.js` | The app's own display sort (urgent-first, then manager-priority chain via `Linked ID`, then chain depth, then icon rank). |
| `src/snooze.js` | Wake-date parsing/writing on board rows; legacy `<!-- snooze:… -->` comment fallback. |
| `src/journalChat.js` | The shared chat-thread parser/writer for journals (also embedded verbatim by `packages/task-paper`). |
| `src/moveTask.js` | Cross-source task moves, including dragging a manager-priority task's whole dependency subtree. |
| `src/idTombstones.js` | Deleted-task id tombstones, so a freed id isn't reused before a delayed sync-resurrection of the old journal has passed. |
| `src/combinedRouting.js` / `combinedViewPatch.js` | Multi-source ("Combined") board: tags each merged row with its owning source and patches optimistic UI state. |
| `src/readState/*` | Event-driven read/unread tracking, provider-swappable (localStorage today; sync explicitly deferred, issue #79). |
| `src/skillsSection.js` | Read-only parser for the `## Skills` board section (the planner never edits skills, only surfaces them). |
| `src/unreachableJournals.js` | In-app detector for a live journal with no reachable board row (the inverse defect of a deleted row leaving an orphaned journal). |
| `src/selfHealIds.js` | Temporary, self-deleting repair for task ids that escaped into a foreign numeric range. |

## Public surface (representative exports)

`opAddTask, opDeleteTask, opChangePriority, opSetTaskSnooze, opMoveBetweenSections,
opPromoteToManagerPriority, allocateNextId` (`focusPlanOps.js`); `parseMarkdownTable, displayHeader`
(`boardTable.js`); `alignRowToHeaders, cellByHeader, recoverMisfiledLinkedId` (`boardRow.js`);
`sortTasksByPriority, resolveManagerPriority, isNeededForUrgentTask` (`taskSort.js`);
`parseJournalChat, appendJournalMessage` (`journalChat.js`); `computeMoveSet, retitleJournal`
(`moveTask.js`); `addTombstone, getActiveTombstoneIds` (`idTombstones.js`); `findUnreachableLiveJournals`
(`unreachableJournals.js`).

## Behavioural requirements (from tests)

- **Board writes are CRLF/whitespace tolerant.** `opChangeLinkedId`, `opRenameTask` and
  `opRemoveTaskFromFocusPlanResult` must match a target row whether the file uses CRLF or LF line
  endings, and regardless of incidental cell padding (`focusPlanOps.test.js`).
- **Sorting is a strict, deterministic total order** even with cyclic `Linked ID` chains — urgent
  (🔴) rows float above all non-urgent rows regardless of manager priority; within a manager-priority
  tier, shorter dependency chains sort first; ties resolve by icon rank (`taskSort.test.js`).
- **Snooze transitions are two-way and idempotent**: a future Wake date defers a Today row to
  Deferred; an expired Wake date auto-returns a Deferred row to Today and clears the Wake cell; a
  marker-less Deferred row is left untouched (`focusPlanOps.test.js`, `snooze.test.js`).
- **Id tombstones block reuse only for a bounded TTL**, then release it, and persist/prune correctly
  through localStorage (`idTombstones.test.js`).
- **`findUnreachableLiveJournals` is silent** for a journal that is reachable, tombstoned, or
  terminal, and flags only a non-terminal, untombstoned journal with no row on either board — string
  and numeric ids must compare equal (`unreachableJournals.test.js`).
- **Journal chat parsing is fence-aware**: a `## `-looking line or a `<!-- from: -->` marker quoted
  inside a fenced code block must never be read as live structure (`journalChat.test.js`).

## Failure modes this domain guards against

- **Reader/writer disagreement on ragged rows** (#426) — closed by making `boardRow.js` the one
  shared alignment rule for both sides.
- **Orphaned journals in both directions** — a deleted row whose journal survives (#185, fixed by
  resolving the journal path at delete time rather than trusting stale UI state, `journalDelete.js`),
  and a surviving journal whose row vanished (#190/#228, detected by `unreachableJournals.js`).
- **Combined-view cross-source ambiguity** (#39) — two folders can share identical row text or local
  ids; `combinedRouting.js` tags every merged row with its real source id so a destructive op can never
  be routed to the wrong folder.
- **Runaway task ids** (a numbering bug that let new ids inherit a foreign counter) — `selfHealIds.js`
  is an explicitly temporary, self-obsoleting patch, deletable once every device has loaded and healed.
