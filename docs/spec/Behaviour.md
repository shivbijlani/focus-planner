# Behaviour

This page is the acceptance suite: testable statements a rebuilt implementation must satisfy, grouped
by area and traced to the test suite (`testFiles`) that specifies them. Each domain page carries its
own selected requirements in depth; this page is the cross-cutting index — 83 suites, 1,194 tests in
total.

## Board reading and writing

| Suite | Requirement |
| --- | --- |
| `src/focusPlanOps.test.js` | Every board mutation is a pure `(content, args) -> newContent` transform; `opMoveLinesBetweenSections` preserves order and is a no-op on an empty input; `buildCompletedRow` sanitizes pipes in free-text so a row can never break the table. |
| `src/boardWakeMigration.test.js` (#307) | A board rewrite migrates every legacy snooze comment to the `Wake` column, never drops one, never emits a row whose cell count disagrees with its header, and is idempotent across repeated rewrites. |
| `src/raggedRow.test.js` (#426) | A row is aligned to its **own section's** header; a short row's trailing cell binds to `Linked ID`, not `Wake`; an over-wide row keeps its right-most tail rather than shifting columns left. |
| `src/misfiledLinkedId.test.js` (#446) | A non-date value in `Wake` is recovered into an empty `Linked ID`; a real wake date is never touched, even when `Linked ID` is empty. |
| `src/snooze.test.js` | A `Wake` value round-trips without disturbing other cells; a legacy trailing HTML comment is still read; a future snooze is active, an expired one is not. |
| `src/taskSort.test.js` | Manager-priority chains sort prerequisite-first; manager priority outranks dependency depth; red-urgent rows float above non-red; cycles never crash the sort and produce a stable order. |
| `src/allocateId.test.js` (#528) | A new task id is allocated past every id live in either the board or the journal set — never colliding with a live row, even when a stale or foreign-numbered journal exists. |
| `src/selfHealIds.test.js` | An id cluster separated from the rest by a large gap is flagged as an outlier; a legitimately high-numbered planner is not; renumbering an outlier remaps every `Linked ID` and `## Priorities` reference to it. |
| `src/autoNumber.test.js`, `src/boardSearch.test.js`, `src/combinedRouting.test.js` (#39), `src/combinedViewPatch.test.js`, `src/moveTask.test.js`, `src/linkedNav.test.js`, `src/scrollToTask.test.js`, `src/sourcePath.test.js` | Board search, multi-source row tagging/routing, cross-folder task moves and dependency-subtree computation, and in-app navigation to a linked/rendered row all behave correctly under the multi-source ("Combined") view. |

## Journals and chat rendering

| Suite | Requirement |
| --- | --- |
| `src/journalChat.test.js` | A journal parses into dated bubbles; same-day "me" notes merge; `<!-- from: agent -->`/`<!-- from: me -->` correctly attribute a message; multi-line HTML comments never render. |
| `src/journalCreate.test.js`, `src/journalCreateRefresh.test.js` | Creating a journal for a task id that has none yields a minimal valid thread; the UI refreshes to reflect it without a full reload. |
| `src/journalDelete.test.js` (#185) | Deleting a journal resolves its path at delete time, not from stale, lazily-loaded UI state. |
| `src/journalLoadQueue.test.js`, `src/journalLoadState.test.js`, `src/journalHydrationWiring.test.js`, `src/journalFocusRefresh.test.js` | Journal reads on board mount are ordered, concurrency-limited and de-duplicated; hydration state and focus-triggered refresh are wired correctly. |
| `src/journalAttachments.test.js` | Attachments referenced from journal content resolve and render. |
| `src/readState/readStateService.test.js`, `src/readState/signature.test.js` | A journal tracked before initial seeding completes reads as already-seen; one that first appears after seeding is unread; opening a journal (via its fired event) marks it seen — the UI computes nothing itself. |
| `src/unreachableJournals.test.js` (#190/#228) | A live, non-terminal journal with no board row and no tombstone is flagged; a terminal or tombstoned journal is silently ignored. |
| `src/idTombstones.test.js` | A deleted task's id is tombstoned and excluded from future allocation; tombstones expire/prune correctly. |
| `src/missionStatement.test.js` | The mission-statement sidecar round-trips and defaults safely when absent or malformed. |

## Settings and the agent gate

| Suite | Requirement |
| --- | --- |
| `src/config/agentGate.test.js` | `agent-gate.md` parses by heading keyword regardless of exact wording; `*`/`+`/`-` bullets all parse; serialization splices only the two bullet lists back in, preserving everything else verbatim. |
| `src/config/userSettingsForm.test.js` | Re-serializing the file with every row's own unchanged value returns the original bytes exactly (the round-trip identity contract). |
| `src/config/agentSettingsVisibility.test.js`, `src/config/aiSettings.test.js`, `src/config/agentsDoc.test.js` | Settings-section visibility rules, AI-assist toggles, and `AGENTS.md` generation each behave deterministically from their inputs. |
| `src/AgentGateEditor.test.jsx`, `src/SkillsSection.test.jsx`, `src/skillsSection.test.js` (#188) | The gate editor round-trips through keyboard interaction; the read-only `## Skills` parser never treats it as writable. |

## Storage

| Suite | Requirement |
| --- | --- |
| `src/storage/fsa.test.js`, `src/storage/indexeddb-provider.test.js`, `src/storage/onedrive-provider.pagination.test.js`, `src/storage/cloud-provider.abort.test.js` | Every storage backend implements the same read/write/list contract; paginated listing and abort/cancellation behave uniformly across providers. |
| `src/storage/syncStatus.test.js`, `src/storage/syncStatusCoalesce.test.js` (#133) | Rapid successive sync events coalesce into one UI status update rather than flickering. |
| `src/storage/settings.test.js`, `src/storage/taskSettings.test.js` | The mission-statement and per-task settings sidecars default safely and round-trip correctly. |
| `src/storage/diagnostics.test.js`, `packages/diagnostics/src/index.test.js` | Diagnostic events cross the tab/service-worker boundary and are observable on both sides. |

## Folder sync

| Suite | Requirement |
| --- | --- |
| `packages/folder-sync/src/merge.test.js` | Merge is last-write-wins by logical clock, per record, with tombstones taking precedence over a stale full-file copy from another device. |
| `packages/folder-sync/src/records.test.js`, `packages/folder-sync/src/codecs/mdTable.test.js` | Markdown tables round-trip into id-keyed records and a row-marker frame without losing non-row content (headings, prose). |
| `packages/folder-sync/src/reconcile.test.js`, `packages/folder-sync/src/diagnosticVolume.test.js`, `packages/folder-sync/src/providers/oneDrive.pagination.test.js` | Reconciliation converges after a conflicting offline edit on two devices; diagnostic volume stays bounded; provider pagination is handled correctly. |

## Telegram bridge

| Suite | Requirement |
| --- | --- |
| `packages/telegram-bridge/src/board.test.js`, `digest.test.js` | The daily digest sorts by board order, not by task id or recency. |
| `packages/telegram-bridge/src/liveStatus.test.js` (#202) | Live/away status is arbitrated by date, resolving conflicting signals deterministically. |
| `packages/telegram-bridge/src/deleted.test.js`, `completed.test.js` | A tombstoned task's forum topic is archived; a completed-board row is recognized only by its numeric id cell, never by header/separator text. |
| `packages/telegram-bridge/src/routeReply.test.js`, `deepLink.test.js`, `docLink.test.js` | A reply typed in the task's own topic or in the General thread routes to the correct journal; deep links and doc links resolve to the right task. |
| `packages/telegram-bridge/src/journal.test.js`, `pointerTurn.test.js` | Folding a reply respects the `turn-end` boundary; a pointer-scoped turn is recognized only when opted in via its doc-meta stamp. |
| `packages/telegram-bridge/src/telegramFormat.test.js`, `telegramClient.test.js`, `config.test.js`, `state.test.js` | Telegram markdown escaping, HTTP client retry/backoff, and bridge state persistence all behave correctly in isolation. |

## Task paper

| Suite | Requirement |
| --- | --- |
| `packages/task-paper/src/generate.test.js`, `paper.test.js`, `render.test.js` | Regenerating from an unchanged journal produces byte-identical HTML; the current turn's sections render as collapsible details with stable anchors. |
| `packages/task-paper/src/markdown.test.js`, `comment.test.js` | Markdown-to-HTML conversion is deterministic; the comment channel appends to the journal rather than mutating existing content. |

## MCP credential vault

| Suite | Requirement |
| --- | --- |
| `packages/mcp-cred-vault/src/schema.test.js` | The manifest schema never accepts a literal secret value in a pointer field; validation rejects a malformed entry rather than silently dropping it. |

## Scripts and the spec pipeline

| Suite | Requirement |
| --- | --- |
| `scripts/check-node-modules.test.js` (#321) | Detects a `node_modules` tree that disagrees with the lockfile before it causes a confusing downstream failure. |
| `scripts/merge-queue.test.js` | PRs are merged in the empirically-verified safe order, not an arbitrary one. |
| `scripts/spec/conflicts.test.js`, `verifyParity.test.js` | Contradictory open issues are flagged; `verify.mjs`'s findings match what `verifyParity` independently recomputes. |

## Overnight agent

| Suite | Requirement |
| --- | --- |
| `plugins/overnight-agent/checks/stuck-run-sweep.test.mjs`, `workflow-health-sweep.test.mjs` | A run past its expected duration with no liveness signal is detected as stuck; a CI workflow that stops succeeding is detected as unhealthy. |

The behavioural contract for `oa-state.ps1`, `write-turn.ps1` and the rest of the PowerShell skill
layer is not expressed as vitest suites (they are not JavaScript); it is enforced instead by the
`mutcheck-*.ps1` mutation-check harness described in [Prioritisation](Prioritisation) and
[Domain-overnight-agent](Domain-overnight-agent), and should be read directly for that domain's
precise requirements.
