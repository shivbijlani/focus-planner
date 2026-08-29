# Domain: app

## Responsibility

`app` is the React single-page application: the two boards (Today/Deferred/Priorities on
`planner.md`, the archive on `planner-completed.md`), the per-task journal chat view, the
Combined (multi-source) view, and the search/sort/navigation behaviour around them. It
owns *no* transport or persistence logic itself — every mutating operation is a pure
function that a UI event calls and then hands to [Domain-storage](Domain-storage) to
persist.

## Principal modules

| Module | Role |
| --- | --- |
| `src/App.jsx` | The application shell: board rendering, the Combined view, context menus, dialogs, wiring every other `app` module together. |
| `src/focusPlanOps.js` | Pure content-transformation operations on `planner.md` (add/delete/move/rename/snooze/prioritize a task, append to the completed archive). Each op is `(content, ...args) -> newContent`, reused unchanged by both the single-source and Combined views. |
| `src/journalChat.js` | Parses and appends to the journal chat format (see [Data-Formats](Data-Formats)). |
| `src/taskSort.js` | Board sort order: urgent-red first, then manager-priority order, then dependency-chain depth, then the remaining priority icons. |
| `src/moveTask.js` | Computes which tasks travel together when one is moved between storage sources, and which cross-source links would break. |
| `src/readState/readStateService.js` | Event-driven read/unread tracking for journals, behind a swappable provider (`src/readState/localStorageReadStateProvider.js` is the only implementation today). |
| `src/journalLoadQueue.js` | Concurrency-limited, de-duplicated, board-ordered queue for the ~2 journal reads every board row needs, so 90+ rows mounting at once don't stampede the storage provider. |
| `src/selfHealIds.js` | Defensive repair of task IDs that were corrupted by a historical numbering bug, applied on load. |
| `src/idTombstones.js` | Records recently deleted task IDs so a freed ID cannot be reused before a sync-resurrected journal for that ID could plausibly still arrive. |
| `src/combinedRouting.js` / `src/combinedViewPatch.js` | Multi-source (Combined view) row-to-source routing and optimistic re-render after a write. |
| `src/skillsSection.js` / `src/SkillsSection.jsx` | Read-only rendering of a `## Skills` board section (the app never edits it; authoring happens elsewhere). |

## Public exports (selected)

- `focusPlanOps.js`: `opAddTask`, `opMoveBetweenSections`, `opDeleteTask`,
  `opRenameTask`, `opChangePriority`, `opSnoozeTask`, `opApplySnoozeTransitions`,
  `opAppendToCompleted`, `allocateNextId`, `buildCompletedRow`.
- `journalChat.js`: `parseJournalChat`, `appendJournalMessage`, `formatChatDay`,
  `formatCloseOutComment`, `AGENT_SENTINEL_RE`.
- `taskSort.js`: `sortTasksByPriority`, `resolveManagerPriority`,
  `getChainDepthToManagerPriority`, `parseManagerPriorities`.
- `moveTask.js`: `computeMoveSet`, `computeBrokenLinks`, `renumberMovedRows`,
  `retitleJournal`.
- `readState/readStateService.js`: `track`, `isUnread`, `emitJournalOpened`, `markSeen`,
  `completeInitialSeeding`, `setReadStateProvider`.

## Behavioural requirements (from tests)

- **ID allocation** (`src/allocateId.test.js`) must number a new task from the content's
  current maximum, ignoring a foreign high journal ID, and must skip any ID that already
  has a journal on disk to avoid collision.
- **Board sort** (`src/taskSort.test.js`) must order dependency chains
  prerequisite-first within the same manager priority, keep manager-priority order ahead
  of raw dependency depth, and still float 🔴-urgent items above non-urgent ones
  regardless of priority-chain membership.
- **Journal chat parsing** (`src/journalChat.test.js`) must extract the thread title
  without its leading `#`, keep undated content as pinned/earlier notes, and route
  `AUTO`-marked content into an agent-authored group distinct from the human's.
- **Journal load state** (`src/journalLoadState.test.js`) must never offer to create a
  journal when an existence check has failed (only after a *successful* absence check),
  and must retain previously known existence across a retry failure rather than
  flip-flopping the UI.
- **Journal load queue** (`src/journalLoadQueue.test.js`) must never exceed its
  concurrency limit and must drain queued work in ascending board-priority order.
- **Journal deletion** must resolve the journal path at delete time — falling back to
  asking storage directly — rather than trusting a possibly-stale, lazily-loaded row
  value, since a delete issued before a row's journal state has resolved must not
  silently orphan the journal file.
- **Combined-view row routing** (`src/combinedRouting.test.js`) must tag every merged row
  with the id of the source it actually came from, and must leave a row untagged (falling
  back to legacy text lookup) only when no source id is available — never guess.
- **Combined-view optimistic patch** (`src/combinedViewPatch.test.js`) must replace and
  re-parse only the matching source's content, and must return the same array reference
  when nothing changed, so React does not re-render needlessly.
- **File-tree filtering** (`src/fileTreeFilter.test.js`) must keep only the curated core
  files at each source's top level, hide every non-journal directory even if it contains
  copies of core files, and drop stray loose `.md` files not on the allow-list.
- **Move-between-sources** (`src/moveTask.test.js`) must pull every descendant of a
  manager-priority task into the move set, and must not pull in tasks whose chain
  resolves to a *different* manager priority.
- **Read-state seeding** (`src/readState/readStateService.test.js`) must mark every
  journal tracked before initial seeding completes as already-seen (no "wall of stars" on
  first load), and must treat a journal that first appears after seeding completes as
  unread until opened.
- **Journal signature** (`src/readState/signature.test.js`) must produce a stable
  placeholder for empty/invalid content and must change whenever new dated content is
  appended, even on the same day.
- **Self-healing IDs** (`src/selfHealIds.test.js`) must flag a high, gap-separated
  cluster of IDs as outliers, but must not flag a planner that legitimately uses
  high IDs throughout — the detector keys on the gap, not on absolute magnitude.
- **Tombstones** (`src/idTombstones.test.js`) must ignore invalid ids so a malformed row
  cannot poison the tombstone store, and must treat a recent tombstone as active while an
  expired one is treated as gone.
- **Snooze** (`src/snooze.test.js`) must set and parse a `Wake` column without altering
  any other table cell, and must fall back to parsing a legacy trailing HTML comment for
  rows written before the column existed.
- **Skills section** (`src/skillsSection.test.js`) must match only the exact `Skills`
  heading (case/whitespace-sensitive) and must be null-safe when no such section exists.

## Failure modes

- A row whose journal read is still in flight when the user issues a destructive action
  (delete, move) risks silently orphaning or double-deleting a journal if the read result
  is trusted instead of re-resolved at action time — mitigated by `src/journalDelete.js`
  re-querying storage rather than using cached row state.
- A sync replica that delivers a stale copy of `planner.md` containing a row another
  device already deleted can resurrect that row locally unless the sidecar tombstone (see
  [Data-Formats](Data-Formats)) is honored by the reading device — this is a
  [Domain-folder-sync](Domain-folder-sync) concern, not an `app` one, but `app` depends on
  it never regressing.
- A foreign/corrupted high-range task ID arriving via sync can permanently distort the
  board's own numbering sequence unless caught by `src/selfHealIds.js` on load; this
  module is explicitly documented as temporary, deletable once every device has healed.
