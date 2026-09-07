# Domain: app

The `app` domain is the planner’s React front end plus the pure text-transformation core that keeps `planner.md`, `planner-completed.md`, and `journal/task-XX.md` coherent. It carries nearly all user-facing behaviour: board rendering, journal rendering, task mutation, read/unread state, cross-source combined views, and the editors for agent-facing sidecar files. The design repeatedly chooses **pure functions over UI-local logic** so the single-source board and the Combined view use the same algorithms, not two similar ones. See [Architecture](Architecture), [Data-Formats](Data-Formats), and [Reliability](Reliability).

## Responsibility

`src/App.jsx` is the composition root. It imports storage, routing, board parsing, journal rendering, read-state, sync diagnostics, and the settings editors, then wires them into views such as `FocusPlanView`, `CombinedFocusPlanView`, `TaskSection`, and `JournalChatView`. The rationale prose lives mostly in the small modules it depends on. `src/focusPlanOps.js` explicitly says its operations stay pure so the same algorithms can be reused “from both the single-source FocusPlanView and the multi-source Combined view”. `src/boardRow.js` narrows the row/header alignment rule to a **single implementation** because “the reader agrees with the writer” only holds by construction. `src/readState/readStateService.js` similarly pushes all unread logic behind a swappable provider so UI code emits events rather than computing signatures itself.

## Principal modules

| Path | Role | Why it exists |
| --- | --- | --- |
| `src/App.jsx` | Main UI composition root. | Centralises view wiring for board, journals, combined routing, sync, diagnostics, settings, and mobile affordances. |
| `src/focusPlanOps.js` | Pure board mutations. | Keeps add/move/snooze/complete/link operations reusable across views and sources. |
| `src/boardRow.js` | Canonical row/header normalization. | Prevents reader/writer disagreement on ragged `Wake`/`Linked ID` tables. |
| `src/journalChat.js` | Journal chat parser/appender. | Implements the markdown-to-chat contract without React dependencies. |
| `src/journalLoadQueue.js` | Ordered, de-duplicated async queue. | Prevents 90+ rows from stampeding cloud storage with journal reads. |
| `src/readState/readStateService.js` | Read/unread controller. | Holds all signature, seeding, and “opened” event logic outside components. |
| `src/AgentGateEditor.jsx` | Editor for `agent-gate.md`. | Preserves the human-owned file shape while exposing two editable lists. |
| `src/AgentSettingsEditor.jsx` | Editor for `user-settings.md`. | Offers structured and raw editing for agent settings. |

## Public exports

| Path | Exports from `spec-facts.json` |
| --- | --- |
| `src/App.jsx` | `default` |
| `src/focusPlanOps.js` | `allocateNextId`, `buildCompletedRow`, `completedRowExistsForTask`, `findMalformedRows`, `nextWakeTimeoutMs`, `opAddAndPrioritize`, `opAddTask`, `opAppendToCompleted`, `opApplySnoozeTransitions`, `opBridgeLinks`, `opChangeLinkedId`, `opChangePriority`, `opDeleteTask`, `opLinkToAdoBugDb`, `opMoveBetweenSections`, `opMoveLinesBetweenSections`, `opPromoteToManagerPriority`, `opPromoteTodoToTask`, `opRemoveFromManagerPriority`, `opRemoveTaskFromFocusPlan`, `opRemoveTaskFromFocusPlanResult`, `opRenameTask`, `opSetTaskSnooze`, `opSnoozeTask`, `opUpdateManagerPriorities` |
| `src/boardRow.js` | `WAKE_COLUMN`, `alignRowToHeaders`, `cellByHeader`, `formatRow`, `isTableSeparatorCells`, `normalizeRowCells`, `recoverMisfiledLinkedId`, `rowCells`, `wakeSeamIndex` |
| `src/journalChat.js` | `AGENT_SENTINEL_RE`, `FROM_ME`, `appendJournalMessage`, `fencedLineMask`, `formatChatDay`, `formatCloseOutComment`, `localISODate`, `parseJournalChat`, `trimBlankEnds` |
| `src/journalLoadQueue.js` | `JOURNAL_LOAD_TIMEOUT_MS`, `createLoadQueue`, `enqueueJournalLoad`, `journalLoadQueue`, `waitForInitialJournalLoads` |
| `src/readState/readStateService.js` | `__resetForTests`, `completeInitialSeeding`, `emitJournalOpened`, `getReadStateProvider`, `isUnread`, `markSeen`, `migrateSeenState`, `registerInitialSeedCandidates`, `resolveInitialSeedCandidate`, `setReadStateProvider`, `subscribe`, `track` |
| `src/AgentGateEditor.jsx` | `GateList`, `default` |
| `src/AgentSettingsEditor.jsx` | `default` |

```js
export const FROM_ME = '<!-- from: me -->'

export function appendJournalMessage(content, text, today = localISODate()) {
  const body = (content || '').replace(/\s+$/, '')
  ...
  if (lastDate !== today) addition = `\n\n## ${today}\n\n${FROM_ME}\n${text}`
  else if (attributed) addition = `\n${text}`
  else addition = `\n\n${FROM_ME}\n${text}`
  return `${body}${addition}\n`
}
```

The snippet above from `src/journalChat.js` is the journal-writing contract: new user text is appended at the bottom, grouped under a `## YYYY-MM-DD` day heading, and stamped with `<!-- from: me -->` when attribution would otherwise be ambiguous.

## Behavioural requirements from tests

The strongest contracts come from `src/focusPlanOps.test.js`, `src/boardWakeMigration.test.js`, `src/raggedRow.test.js`, `src/misfiledLinkedId.test.js`, `src/journalChat.test.js`, `src/journalLoadQueue.test.js`, `src/journalHydrationWiring.test.js`, `src/unreachableJournals.test.js`, and `src/readState/readStateService.test.js`.

- Board rewrites **must migrate legacy snooze comments, never drop them**. `src/boardWakeMigration.test.js` requires preserved wake dates, header-width alignment, idempotent rewrites, safe section moves, and anomaly logging instead of silent loss.
- Reader and writer **must share one row-alignment rule**. `src/raggedRow.test.js` and `src/misfiledLinkedId.test.js` require a trailing field in a short Deferred row to bind to `Linked ID`, not `Wake`, and require a non-date wake value to be recovered into `Linked ID` without inventing a snooze.
- Journal parsing treats fenced code as **quoted text, not control markup**. `src/journalChat.test.js` requires quoted `<!-- from: me -->` and quoted `## 2026-12-25` examples to stay literal, preventing false authorship and fabricated day grouping.
- Journal hydration is **bounded and shareable**. `src/journalLoadQueue.test.js` requires concurrency limits, de-duplication by key/provider, cancellation, timeout, and that initial seeding stays open until queued work drains.
- Read/unread state is **event-driven and source-qualified**. `src/readState/readStateService.test.js` requires journals tracked before initial seeding to count as seen, later-appearing journals to count as unread, `emitJournalOpened()` to clear unread state, and source-qualified IDs to stay independent.
- Live journals with no board row and no tombstone are an error condition. `src/unreachableJournals.test.js` requires the detector to report reachable-vs-unreachable status without flagging completed or deliberately deleted journals.

## Failure modes

This domain’s recurring failure mode is **two readers of the same markdown disagreeing**: row writers versus row readers, journal appenders versus journal parsers, and UI-local state versus persisted read-state. The code comments name the concrete user-visible outcomes: linked IDs slide into `Wake`, snoozing destroys parent links, quoted examples fabricate approvals, and concurrent journal loads stall the whole board. The mitigation pattern is consistent: put the rule in one small module, make it pure, and import it everywhere that needs the rule.
