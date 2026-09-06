# Domain: app

## Responsibility

The React frontend: the board (`## Today` / `## Deferred` sections of `planner.md`), the completed
board, per-task journals rendered as chat threads, multi-source ("Combined") routing, and the
settings surfaces for the agent gate and `user-settings.md`. This is the largest domain by far
(37 modules; `src/App.jsx` alone is 7,215 lines) because it is where every other domain's data model
becomes something a user directly edits.

## Principal modules

| Path | Exports | Role |
| --- | --- | --- |
| `src/App.jsx` | `default` | The root component: board rendering, context menus, journal panes, storage wiring. Imports from nearly every other domain. |
| `src/boardRow.js` | `alignRowToHeaders`, `cellByHeader`, `rowCells`, `wakeSeamIndex`, `recoverMisfiledLinkedId`, `WAKE_COLUMN` | The board's **one** canonical row/header alignment rule (issue #426) — see below. |
| `src/boardTable.js` | `parseMarkdownTable`, `displayHeader`, `daysSince` | The app-side board reader; aligns every row through `boardRow.js` before indexing it. |
| `src/focusPlanOps.js` | `opAddTask`, `opMoveBetweenSections`, `opChangePriority`, `opSetTaskSnooze`, `opDeleteTask`, `allocateNextId`, `buildCompletedRow`, ... | Pure content-transformation operations on `planner.md`: `(content, ...args) -> newContent`, reused identically by both the single-source and Combined views. |
| `src/snooze.js` | `parseSnoozeUntil`, `setSnoozeUntilOnLine`, `isSnoozeActive`, `getNextSaturdayDateString` | Reads/writes the `Wake` column and its legacy trailing-HTML-comment predecessor. |
| `src/taskSort.js` | `sortTasksByPriority`, `resolveManagerPriority`, `getChainDepthToManagerPriority`, `isNeededForUrgentTask` | The full board sort key (see [Prioritisation](Prioritisation)). |
| `src/journalChat.js` | `parseJournalChat`, `appendJournalMessage`, `formatChatDay`, `fencedLineMask` | Renders journal markdown as a chat thread; shared by the app, `telegram-bridge`, and `task-paper`. |
| `src/idTombstones.js` | `addTombstone`, `getActiveTombstoneIds`, `pruneTombstones` | Deleted-task ID tombstones, closing the ID-reuse/sync-resurrection race (issues #314/#305). |
| `src/selfHealIds.js` | `detectOutlierIds`, `selfHealOutlierIds` | Temporary defence-in-depth: renumbers task IDs that jumped into a foreign high range. |
| `src/moveTask.js` | `computeMoveSet`, `computeBrokenLinks`, `renumberMovedRows`, `rewriteRowId` | Moving a task (and its manager-priority dependency subtree) between multi-source folders. |
| `src/combinedRouting.js` | `tagMergedRows`, `resolveRowSourceId` | Tags every merged row with its true source id (issue #39) so a destructive op never routes to the wrong folder. |
| `src/unreachableJournals.js` | `findUnreachableLiveJournals` | Detects a live, non-terminal journal with no board row and no tombstone (issue #190/#228). |
| `src/journalDelete.js` | `deleteJournalForTask`, `resolveJournalPathForDelete` | Resolves the journal path **at delete time** rather than trusting lazily-loaded UI state (issue #185). |
| `src/journalLoadQueue.js` | `createLoadQueue`, `enqueueJournalLoad`, `JOURNAL_LOAD_TIMEOUT_MS` | Ordered, concurrency-limited, de-duplicated journal read queue — avoids ~180 concurrent reads on board mount. |
| `src/readState/readStateService.js` | `track`, `markSeen`, `isUnread`, `completeInitialSeeding`, `emitJournalOpened` | Event-driven read/unread controller; the UI contains no business logic (issue #79/#311). |
| `src/skillsSection.js` | `parseSkillsSection`, `extractTaskRefs`, `SKILLS_SECTION_TITLE` | Read-only parser for the board's `## Skills` section (issue #188). |
| `src/boardSearch.js` | `filterRowsAndRawLines`, `taskRowMatchesSearch` | Board search/filter. |
| `src/linkedNav.js` | `shouldNavigateToCompleted`, `linkedNavFallbackFile` | Decides where a "linked task" chip navigates when the target row isn't currently rendered. |
| `src/AgentGateEditor.jsx` / `src/agentGateEditor.js` | `GateList` / `handleGateKeyDown` | UI for `agent-gate.md` (component and pure logic split for the `react-refresh` lint rule). |
| `src/AgentSettingsEditor.jsx` | `default` | UI for `user-settings.md`, built on `userSettingsForm.js` and `agentSettingsVisibility.js` (`config` domain). |

## `boardRow.js` — the one alignment rule (issue #426)

`planner.md` is hand-edited, so its tables are **ragged**: `## Deferred` has a 7-column header
(`... | Added | Wake | Linked ID |`), `## Today` has 6 (no `Wake`), and rows written before `Wake`
existed carry only 6 fields under a 7-column header. Every reader and writer must answer the same
question — given this row's cells and this table's header, which cell is `Linked ID` and which is
`Wake`? Answering it in more than one place is what issue #426 actually was: the writer (`opAddTask`)
and the reader (`parseMarkdownTable`) disagreed, so a row the writer emitted correctly was read back
wrong. `boardRow.js` is now the **only** implementation, imported by the writer (`focusPlanOps.js`),
the reader (`boardTable.js`), and the snooze accessors (`snooze.js`) — "the reader agrees with the
writer" holds by construction rather than by keeping two edits in sync. `recoverMisfiledLinkedId`
(issue #446) additionally repairs a non-date value that landed in `Wake` by moving it into an empty
`Linked ID`, without ever touching a genuine wake date.

## `focusPlanOps.js` — pure ops, reused across views

Every board mutation is `(content, ...args) -> newContent` (or a small side-effect descriptor for
cross-file moves like completion). Purity is what lets the single-source `FocusPlanView` and the
multi-source Combined view share one algorithm instead of two: in Combined, each operation is simply
routed to whichever source the clicked row's `rawLine` belongs to, via `combinedRouting.js`'s
`__sourceId` tag.

## `combinedRouting.js` — routing by tag, not by text (issue #39)

Two folders can legitimately contain rows with identical text or the same local task id (a shared
umbrella row, or a genuine duplicate). The pre-fix Combined view routed a destructive op by looking
the clicked row up in a map keyed by trimmed text or local id — neither key is unique across sources, so
the last source iterated wins the map, and a *work* task could be archived into the *personal*
folder's completed board. The fix tags every merged row with the id of the source it actually came
from, carried through parse → sort → filter → context menu → handler, resolving the owning source
from that tag first and falling back to the legacy text lookup only for untagged (single-source) rows.

## Behavioural requirements (selected, from the domain's test suites)

- `focusPlanOps`: `opMoveLinesBetweenSections` preserves row order and silently skips lines not
  present in the source section; `buildCompletedRow` sanitizes pipes in a free-text outcome so the row
  cannot break the table.
- `boardWakeMigration.test.js` (#307): a board rewrite must migrate every legacy snooze comment,
  never drop one, never slide a trailing `Linked ID` into `Wake`, never emit a row whose cell count
  disagrees with its section header, and must be **idempotent** — a second rewrite pass produces no
  further drift.
- `raggedRow.test.js` (#426): a ragged Deferred row binds its trailing field to `Linked ID`, not
  `Wake`; an over-wide row keeps its right-most tail rather than shifting columns; the alignment rule
  inserts a missing cell at the `Wake` seam specifically, never at the row's end.
- `misfiledLinkedId.test.js` (#446): `recoverMisfiledLinkedId` moves a non-date `Wake` value into an
  empty `Linked ID`, but leaves a real wake date alone even when `Linked ID` is empty, and never
  clobbers a `Linked ID` that is already populated.
- `taskSort.test.js`: orders dependency chains prerequisite-first within the same manager priority;
  keeps manager priority ahead of dependency depth; still floats red-urgent items above non-red ones;
  handles cyclic links without crashing.
- `allocateId.test.js` / GH #528: `allocateNextId` numbers from the content max, ignoring a foreign
  high journal id, and skips the union of content ids and journal ids so a freshly added task can never
  collide with — and silently destroy — a live row.
- `selfHealIds.test.js`: `detectOutlierIds` flags a high cluster separated by a large gap but returns
  empty for a planner that legitimately uses high ids; `selfHealOutlierIds` remaps a linked-id and a
  `## Priorities` list entry that pointed at a renumbered task.
- `unreachableJournals.test.js` (#190/#228): a non-terminal journal with no board row and no tombstone
  is flagged; a terminal (finished) or tombstoned journal is silently ignored.
- `combinedRouting.test.js`: `resolveRowSourceId` prefers the row's own source tag over a colliding
  text lookup, and falls back to the text lookup only for an untagged (single-source) row.
- `readStateService.test.js`: journals tracked before initial seeding completes are marked already-
  seen (no "wall of stars" on first load); a journal that first appears **after** seeding is unread;
  opening a journal (via a fired event) marks it seen — the UI never computes or persists anything
  itself.

## Failure modes

- A destructive op (delete/complete/move) that resolves its target by text or lazily-loaded state
  rather than a stable id or tag reproduces the class of bug closed by #39/#185/#528: it can silently
  act on the wrong row or the wrong source.
- A board writer and a board reader that each reimplement the ragged-table alignment rule instead of
  sharing `boardRow.js` will drift the moment one of them changes — this is exactly how #426 happened
  the first time.
