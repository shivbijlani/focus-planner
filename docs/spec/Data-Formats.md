# Data formats

This app persists almost everything as markdown or small JSON sidecars in the planner folder; the main exceptions are host-local operational files such as Telegram bridge state and the Overnight Agent state store. [Architecture](Architecture) explains why the repo chooses files over a database, and [Prioritisation](Prioritisation) explains how the Overnight Agent interprets those files.

One naming note matters up front: the checked-in app now scaffolds and filters for `planner.md` / `planner-completed.md` (`src/storage/fsa.js`, `src/storage/indexeddb-provider.js`, `src/config/agentsDoc.js`, `src/config/branding.js`), while `.github/copilot-instructions.md` still shows the older `focus-plan.md` / `focus-plan-completed.md` names. The **row grammar** is the same either way. The current forward design is `planner.md`; the older filenames are a legacy alias in docs and historical files, not a different schema.

## 1. Planner board — `planner.md` (legacy name: `focus-plan.md`)

The active board is a markdown document with `## Today`, `## Deferred`, and usually `## Priorities`. The parser cares about **headers and rows**, not the filename. The important design choice is that the board is hand-editable, so its tables are intentionally tolerant of ragged rows, old schemas, and reordered spacing.

A source-faithful sample, assembled from the scaffold in `src/storage/fsa.js` plus real rows used in `src/raggedRow.test.js` and `src/boardWakeMigration.test.js`:

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```markdown
## Today

| ID | 🎯 | Task | Work Priority | Added | Linked ID |
|---|---|------|---------------|-------|-----------|
| 463 | 🟡 | Ship issues | - | 2026-08-31 | 192 |
| 468 | 🟡 | work github issues | - | 2026-09-02 | 463 |

## Deferred

| ID | 🎯 | Task | Work Priority | Added | Wake | Linked ID |
| --- | --- | ------ | --------------- | ------- | ---- | ----------- |
| 446 | 🔴 | NVIDIA roles | - | 2026-08-24 |  | 295 |
| 327 | 🟡 | Black lodge has emerald city soul club | - |  | 2026-09-04 | |
| 254 | ⚪ | Add dance church events to the calendar | - | 2026-06-13 | 2026-09-08 | 191 |

## Priorities

1. 191
2. 200
3. 204
```


</details>
Cross-check: `.github/copilot-instructions.md` still documents the same row shape with a different priority-header spelling:

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```markdown
| ID | 🎯 | Task | Mngr Priority | Added | Linked ID |
| 70 | 🟡 | New task description | Sydney rollout | 2026-01-27 | |
```


</details>
The code makes that header drift explicit rather than pretending it does not exist. `src/focusPlanOps.js` looks for the live header whose text **includes `Priority`**, and `src/boardTable.js` collapses `Mngr Priority` and `Work Priority` to the display label `Priority`. That means the stable contract is “the priority column is the column whose header names priority”, not one exact literal heading.

| Invariant | Why it exists | Enforced / relied on by |
| --- | --- | --- |
| Address cells by header name **after** normalization, never by fixed index. | `Deferred` can have 7 columns while older rows still have 6. | `src/boardRow.js`, `src/boardTable.js`, `src/focusPlanOps.js`, `src/raggedRow.test.js` |
| Missing cells are inserted at the `Wake` seam, not appended at the end. | A short Deferred row’s trailing value is usually its `Linked ID`, not a wake date. | `alignRowToHeaders()` in `src/boardRow.js`; asserted in `src/raggedRow.test.js` |
| A non-date in `Wake` moves to `Linked ID` only when `Linked ID` is empty. | Recovers full-width rows corrupted by older writers without clobbering real snoozes. | `recoverMisfiledLinkedId()` in `src/boardRow.js`; `src/misfiledLinkedId.test.js` |
| `Wake` is a `YYYY-MM-DD` date and only belongs in Deferred rows. | Snooze logic depends on typed dates, not prose. | `src/snooze.js`, `src/focusPlanOps.js`, `src/boardWakeMigration.test.js` |
| Legacy `<!-- snooze:DATE -->` trailers migrate into the `Wake` column once a row is rewritten. | The app must not silently drop old snooze data during schema evolution. | `ensureWakeColumn()` and `transformRowForSection()` in `src/focusPlanOps.js` |
| The first cell is the stable task id, optionally followed by `,[ticket](url)`. | Board readers, completed-board readers, journal filenames, and Telegram all key off the same id grammar. | `src/boardTable.js`, `packages/telegram-bridge/src/board.js`, `packages/telegram-bridge/src/completed.js` |
| `## Priorities` is an ordered list, not a table. | It preserves user-owned ranking outside Today/Deferred row order. | `src/focusPlanOps.js`, `src/taskSort.js`, `packages/folder-sync/src/records.js` |
| Row order inside a section is meaningful. | The board itself is a priority signal. | `packages/telegram-bridge/src/board.js`, `src/taskSort.js`, [Prioritisation](Prioritisation) |

The rationale in the comments is consistent: the board is manually edited and historically messy, so the parser/writer pair bias toward **data preservation**. That is why `src/boardRow.js` is a dedicated shared module: the repo already shipped bugs where the reader and writer each “knew” the table differently.

### Completed board — `planner-completed.md` (legacy: `focus-plan-completed.md`)

The completed archive uses the same task-id cell grammar but groups rows under week headings.

Real sample from `packages/telegram-bridge/src/completed.test.js`:

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```markdown
## Week of 7/27/2026

| # | 🎯 | Task | Work Priority | Completed Date |
|---|---|------|---------------|----------------|
| 401 | ✅ | Draft house-sitter directions doc | - | 2026-08-02 |
| 387 | ✅ | Rosemary — Marketplace giveaway | - | 2026-08-02 |
```


</details>
| Invariant | Why it exists | Enforced / relied on by |
| --- | --- | --- |
| Only rows whose first cell parses as a task id count as completed tasks. | Headers and separators live in the same markdown table syntax. | `packages/telegram-bridge/src/completed.js` |
| The first cell may use the same compound-id grammar as the live board. | A completed task can still carry its linked external ticket. | `packages/telegram-bridge/src/completed.js`, `packages/telegram-bridge/src/board.js` |
| Weekly headings are organizational only. | Readers scan rows across all sections. | `packages/telegram-bridge/src/completed.js` |

Known gap: issue #556 shows that a reused task id on both boards can make a live task look user-completed. Treat `planner-completed.md` as part of the closure signal, not the only proof.

## 2. Task journals — `journal/task-<id>.md`

Journals are append-only markdown chat threads. `src/journalChat.js` renders them in the app; `packages/telegram-bridge/src/journal.js` folds Telegram replies back in; the Overnight Agent reads the same bytes. `src/config/agentsDoc.js` is the human-readable contract that the app scaffolds into each folder.

Real sample, combining the fixture in `src/journalChat.test.js` with exact markers from `src/config/agentsDoc.js` and `packages/telegram-bridge/src/journal.js`:

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```markdown
# Task 254: Add dance church events to the calendar

- TODO:

---
<!-- DANCE-CHURCH-AUTO do not edit this line; everything below is regenerated each run -->

## 🕺 Dance Church — Seattle (updated Jun 13, 2026)

**Which classes should I add to your calendar?**
- [ ] **1.** Sat · Jun 13 · 10:30 AM · Reverie Ballroom · **TOMMY IS GAY // PRIDE 2026**
- [ ] **2.** Sun · Jun 14 · 10:00 AM · Reverie Ballroom · Carlin Kramer
**Picks:** <!-- dc-meta
[
  {"n":1,"id":"LndAQC3V","summary":"TOMMY IS GAY // PRIDE 2026"},
  {"n":2,"id":"abc","summary":"Dance Church"}
]
-->

## 2026-09-01

<!-- from: overnight-agent -->
A human reply carries its marker above it.

<!-- from: me -->
yes, go ahead
```


</details>
| Invariant | Why it exists | Enforced / relied on by |
| --- | --- | --- |
| The first H1 is the thread title, ideally `# Task <id>: <title>`. | Title extraction, topic naming, and journal identity all rely on it. | `src/journalChat.js`, `packages/telegram-bridge/src/journal.js` |
| Content before the first day/agent marker is “pinned” undated content. | Old notes and TODOs remain visible without forcing date headers. | `parseJournalChat()` in `src/journalChat.js`; `AGENTS_DOC` in `src/config/agentsDoc.js` |
| `## YYYY-MM-DD` starts a day group and resets authorship to `me`. | Same-day user notes merge into one bubble unless an agent marker intervenes. | `src/journalChat.js` |
| `<!-- from: name -->` switches attribution; `<!-- from: me -->` is byte-sensitive. | Consent logic and cross-channel parity depend on exact attribution bytes. | `FROM_ME` in `src/journalChat.js`; `packages/telegram-bridge/src/journal.js`; `src/journalChat.test.js` |
| Any comment containing `AUTO` or `AGENT` starts an agent-managed block. | Skills use sentinels like `DANCE-CHURCH-AUTO` and `OVERNIGHT-AGENT`. | `AGENT_SENTINEL_RE` in `src/journalChat.js`; `src/config/agentsDoc.js` |
| Multi-line HTML comments are hidden from the chat. | Machine metadata must travel with the file without rendering as prose. | `src/journalChat.js`; `src/journalChat.test.js` |
| Fenced code is quoted text, not markup. | A fenced `## 2026-12-25` or `<!-- from: me -->` must not fabricate a new day or fake human approval. | `fencedLineMask()` in `src/journalChat.js`; `src/journalChat.test.js`; PowerShell mirror in `oa-state.ps1` |
| Appends happen at the bottom only. | Re-scan logic and user-visible history depend on stable earlier content. | `appendJournalMessage()` in `src/journalChat.js`; `packages/telegram-bridge/src/journal.js` |
| Checkbox items and `TODO:` / `DONE:` prefixes are first-class task markers. | The UI and `server.js` extract todos from those exact shapes. | `server.js`, `src/config/agentsDoc.js` |

The design rationale is explicit in comments and tests: plain markdown always degrades to a valid bubble, but the format adds enough structure for provenance, date grouping, and machine metadata. That is why the parser strips metadata comments yet preserves markdown emphasis, lists, and tables unchanged.

Known gap: issue #569 reports that one Overnight Agent reopen reader still misses user text edited **above** the sentinel. The journal format itself is stable; one consumer still under-reads it.

## 3. Agent permissions, settings, and per-task state

### `agent-gate.md`

This file is unusual because the user, not the app, is supposed to author it. The app seeds it once and then preserves all non-list text verbatim.

Real seeded sample from `src/config/agentGate.js`:

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```markdown
# Agent gate

<!-- planner-agent-gate v1 — you own this file. The overnight agent reads it and never writes it, so anything here counts as your instruction without needing an attribution marker. -->

Two lists that tell the overnight agent when to act on its own and when to stop
and ask. Edit them in the app (**Agent gate** in the sidebar) or in this file
directly — both are the same file.

## Do not gate these (reversible)

- focus-planner-ado-codeapp is in YOLO mode, dont ask just do, Im the only user
- Emailing myself
- Responding to an interaction in a 1-1 chat or email with valuable info (not just shiv is oof). If doing so, append message signature indicating that this was sent by bot and that shiv will review when he gets back.
- Creating and publishing a pull request in any repository, then continuing to work on it until all checks pass, is easily reversible and has no consequence; do not gate it.

## Always ask (safety floor)

- Send-to-many (group/channel, manager, mass email)
- Starting a fresh conversation with someone in chat/email
```


</details>
| Invariant | Why it exists | Enforced / relied on by |
| --- | --- | --- |
| The file has two semantic lists: reversible allows and safety-floor asks. | The gate engine decides whether the agent may proceed. | `src/config/agentGate.js`, `oa-state.ps1` |
| Heading matching is keyword-based, not exact-text only. | Users can reword headings without breaking the parser. | `sectionKeyFor()` in `src/config/agentGate.js`; `Parse-AgentGateText` in `oa-state.ps1` |
| Only bullet lines count as rules. | Prose and notes stay user-owned and non-operative. | `parseAgentGate()` in `src/config/agentGate.js`; `Read-AgentGate()` in `oa-state.ps1` |
| Saving replaces only bullet blocks inside managed sections. | Title, comments, prose, and extra sections must survive app edits. | `serializeAgentGate()` in `src/config/agentGate.js`; `src/config/agentGate.test.js` |
| The app seeds the file only when absent or blank. | Rewriting an existing gate would destroy the trust channel it is meant to provide. | `scaffoldAgentGate()` in `src/config/agentGate.js` |

The comments tie the design directly to consent: this file exists because a journal marker such as `<!-- from: me -->` is still written by software, so standing permissions need a human-authored surface instead.

### `user-settings.md`

This markdown file is the live configuration source the app edits and the Overnight Agent reads at run time. The bundled plugin copy is only a template.

Real sample excerpt from `plugins/overnight-agent/skills/overnight-agent/user-settings.md`:

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```markdown
## Settings

| Setting | Value |
| --- | --- |
| User | `<your name>` (`<your-github-username>` on GitHub) |
| Timezone | `<IANA timezone, e.g. America/Los_Angeles>` |
| Planner board | `<path to>\planner.md` |
| Completed board | `<path to>\planner-completed.md` |
| Journals folder | `<path to>\journal\` |
| Agent state store | `%LOCALAPPDATA%\overnight-agent\state\` (per-task JSON; **local, not cloud-synced**). Skill-owned memory — the user never edits it. Managed via `oa-state.ps1`. |
| Google Tasks lists | *(optional)* `default only` — set this if `@default` **is** your whole Google Tasks backlog. |

## Overnight Agent behaviour

| Setting | Value |
| --- | --- |
| Today gate backstop | `6h` |
| Today gate strict | `off` |
| Overnight Agent concurrency | `1` |

## Browser slots

| Slot | Port | Profile dir (`%LOCALAPPDATA%\playwright-mcp\`) | Account | Desktop shortcut |
| --- | --- | --- | --- | --- |
| `edge-cdp-1` (regular) | 9225 | `edge1` | `<your main account>` | MCP Edge 1 (CDP 9225) |
```


</details>
| Invariant | Why it exists | Enforced / relied on by |
| --- | --- | --- |
| Structured settings live in `| Setting | Value |` tables. | The app edits settings surgically by cell, not by regenerating the file. | `src/config/userSettingsForm.js`, `src/config/userSettingsForm.test.js` |
| Non-table prose, blockquotes, comments, and preference bullets are preserved byte-for-byte. | This is the agent’s source of truth; the app must not erase surrounding guidance. | `serializeSettingsForm()` in `src/config/userSettingsForm.js` |
| `Today gate backstop` accepts `6`, `6h`, `6 hours`, or `off`. | The gate reader wants a human-friendly but bounded grammar. | `Resolve-GateSettings` in `oa-state.ps1` |
| `Today gate strict` is truthy only for `on`, `yes`, or `true`. | Fail-safe default is non-strict unless the file explicitly enables strict gating. | `Resolve-GateSettings` in `oa-state.ps1` |
| `Overnight Agent concurrency` must be a **bare whole number**. | Anchored parsing prevents dated prose like `2026-09-02: set to 1` from becoming concurrency `2026`. | `Resolve-PacingSettings` in `oa-state.ps1` |
| Browser-slot column order does not matter; Slot/Port/Profile are required. | Scripts resolve columns by name and must fail loudly on ambiguous slot definitions. | `user-settings.md` guidance; CI browser-slot mutation check in `.github/workflows/ci.yml` |

The reasoning is visible both in the markdown template and the parser comments: this file is for values that the user **does** want editable and syncable, unlike `agent-gate.md`, so the app may rewrite cells — but only cells.

### Overnight Agent per-task state — `%LOCALAPPDATA%\overnight-agent\state\task-<id>.json`

`oa-state.ps1` stores one JSON document per task under the path named by the `Agent state store` setting. `State-Path` hardcodes the filename shape as `task-$id.json`.

Source-faithful sample built from `Cmd-Seed`, `Cmd-Mark`, `New-PollObject`, `New-RecheckObject`, `New-SessionObject`, and `Set-ExhaustionDeclaration` in `oa-state.ps1`:

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```json
{
  "id": "468",
  "status": "blocked",
  "version": 3,
  "plan_id": "plan-2026-09-07",
  "processed_file_hash": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "has_agent_block": true,
  "seeded": true,
  "updated": "2026-09-07T02:39:54+00:00",
  "status_by": "user",
  "paused_at": "2026-09-07T02:39:54+00:00",
  "poll": {
    "cadence": "daily",
    "interval_minutes": 1440,
    "last_polled": "2026-09-06T09:00:00+00:00",
    "next_due": "2026-09-07T09:00:00+00:00"
  },
  "recheck": {
    "cadence": "6h",
    "interval_minutes": 360,
    "kind": "oauth",
    "last_rechecked": "2026-09-06T18:00:00+00:00",
    "next_due": "2026-09-07T00:00:00+00:00"
  },
  "session": {
    "session_id": "abc123",
    "kind": "code",
    "project": "focus-planner",
    "workspace": "V:\\repos\\focus-planner.worktrees\\task-468",
    "workspace_type": "worktree",
    "created_at": "2026-09-06T18:00:00+00:00",
    "last_woken_at": "2026-09-07T01:30:00+00:00",
    "state": "live",
    "prior_session_id": "old456",
    "replaced_at": "2026-09-06T18:05:00+00:00"
  },
  "today_exhausted": {
    "at": "2026-09-07T02:00:00+00:00",
    "examined": ["gh:197", "gh:179"],
    "note": "waiting on reviewer",
    "today_hash": "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
  },
  "unanswered_user_message_at": "2026-09-07T02:10:00+00:00",
  "last_turn_at": "2026-09-07T02:15:00+00:00",
  "last_turn_by": "abc123"
}
```


</details>
| Invariant | Why it exists | Enforced / relied on by |
| --- | --- | --- |
| Filename is exactly `task-<id>.json`. | Session, poll, and scan logic all address state by task id. | `State-Path()` in `oa-state.ps1` |
| Seeded state starts with `id`, `status`, `version`, `plan_id`, `processed_file_hash`, `has_agent_block`, `seeded`, `updated`. | Scan needs a baseline even before later features add fields. | `Cmd-Seed` and `Cmd-Mark` in `oa-state.ps1` |
| `poll` and `recheck` objects use fixed keys: cadence, interval minutes, last stamp, next due. | Due-timer logic reads these structures directly. | `New-PollObject()`, `New-RecheckObject()`, `Test-PollDue()` in `oa-state.ps1` |
| `session.state` is `live` or `dead`; code sessions also require project/workspace/workspace_type. | Session reuse and replacement must be auditable, not inferred from the filesystem alone. | `New-SessionObject()` and `Cmd-Session` in `oa-state.ps1` |
| `today_exhausted` is written only by a separate exhaustion call and must include a non-empty `examined` list plus `today_hash`. | The declaration that opens the Today→Deferred gate must be explicit and tied to the board snapshot it was made against. | `Set-ExhaustionDeclaration()` in `oa-state.ps1` |
| Timestamps are stored as ISO text. | Cross-run comparisons and JSON output need a stable textual form. | `Now-Iso()`, `ConvertTo-IsoText()` in `oa-state.ps1` |
| `status_by` defaults to `agent` when absent on read. | Old state files must not silently acquire “user said so” authority. | `Cmd-Scan` and `Cmd-Mark` in `oa-state.ps1` |

Known gap: issue #571 says `status_by` still lacks enough close provenance to prove the “only the user closes a task” invariant by itself.

## 4. Telegram bridge state — `state.json`

The Telegram bridge keeps operational JSON in a separate state directory, outside the repo and outside OneDrive. Unlike journals and boards, this is **host-local machinery**, not planner content.

Source-faithful sample built from `emptyState()` plus the reducers in `packages/telegram-bridge/src/state.js`:

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```json
{
  "version": 1,
  "updateOffset": 101,
  "lastDigestHash": "digest-hash",
  "digestTopicId": 77,
  "digestTopicName": "Waiting on you",
  "tasks": {
    "352": {
      "topicId": 5,
      "name": "#352 · Telegram",
      "lastPostedHash": "abc",
      "suppressedHash": "suppressed-1",
      "archived": false,
      "userEngaged": true,
      "lastPostedMessageIds": [9001, 9002],
      "replyCount": 4,
      "lastPostedReplyCount": 3,
      "lastPostedLinks": ["https://example.com/doc"],
      "docLinkDocId": "doc-352",
      "docLinkMessageId": 444,
      "docLinkVerifiedAt": 1732500000000,
      "docLinkNoticeHash": "notice-1",
      "docLinkNoticeMessageId": 445,
      "docLinkNoticeAsk": "Needs from you: confirm the rollout window."
    }
  }
}
```


</details>
| Invariant | Why it exists | Enforced / relied on by |
| --- | --- | --- |
| Root shape is `{ version, updateOffset, tasks }`, with optional digest fields. | `loadState()` overlays parsed JSON onto `emptyState()`. | `packages/telegram-bridge/src/state.js` |
| Task entries are keyed by task id string. | Reverse lookups and per-task dedupe use the task id as the primary key. | `getTask()`, `findTaskByTopic()` in `packages/telegram-bridge/src/state.js` |
| `lastPostedHash` and `suppressedHash` are separate fields. | A suppressed turn is paused, not considered already posted. | `setSuppressedHash()` in `packages/telegram-bridge/src/state.js` |
| `lastPostedMessageIds` is a list of integers, not one id. | A long Telegram post may be split into several messages and must collapse as a unit. | `setLastPostedMessageIds()` in `packages/telegram-bridge/src/state.js` |
| `replyCount` is monotonic. | Collapse decisions compare “reply count when posted” to “reply count now”. | `bumpReplyCount()`, `setLastPostedContext()` in `packages/telegram-bridge/src/state.js` |
| `docLinkVerifiedAt` is set only from a genuine observation (a confirmed probe or a successful send), never an assumption. | An unverified probe must not look like evidence, or the least-known link would be probed least often. | `setDocLinkVerified()`, `verifyLinkMessage()` in `packages/telegram-bridge/src/bridge.js` |
| Doc-link notice fields clear together when the ask is cleared. | A stale message id must not survive after the notice it referred to is gone. | `setDocLinkNoticeHash()` in `packages/telegram-bridge/src/state.js` |

## 5. Folder-sync sidecars — `<file>.sync.json`

Folder sync does not treat `planner.md` as one opaque blob. It splits the file into record rows plus a structural `__frame__` record and writes per-record metadata to a neighboring JSON sidecar.

Source-faithful sample from `packages/folder-sync/src/merge.js`, `packages/folder-sync/src/codecs/mdTable.js`, and `packages/folder-sync/src/records.test.js`:

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```json
{
  "version": 1,
  "updatedAt": 2000,
  "entries": {
    "1": { "clock": 1000, "deleted": false, "fp": 123456789 },
    "2": { "clock": 2000, "deleted": true, "fp": 987654321 },
    "__frame__": { "clock": 1000, "deleted": false, "fp": 555555555 }
  }
}
```


</details>
| Invariant | Why it exists | Enforced / relied on by |
| --- | --- | --- |
| Sidecar filename is `<path>.sync.json`. | Transports need a deterministic neighbor path and must skip sidecars when listing data files. | `sidecarPath()` and `isSidecarPath()` in `packages/folder-sync/src/records.js` |
| Root object is `{ version, updatedAt, entries }`. | `serializeSidecar()` and `parseSidecar()` only understand that wrapper. | `packages/folder-sync/src/merge.js` |
| Each entry stores `clock`, `deleted`, and optionally `fp`. | Merge is per-record LWW with tombstones and change fingerprints. | `packages/folder-sync/src/merge.js` |
| Deleted rows stay as tombstones instead of vanishing. | Without a tombstone, a stale replica can resurrect a deleted row. | `packages/folder-sync/src/records.js`, `packages/folder-sync/src/merge.js` |
| `__frame__` is the reserved structural record id. | Section headings, separators, blank lines, and the Priorities list must merge too. | `FRAME_ID` in `packages/folder-sync/src/codecs/mdTable.js`; `packages/folder-sync/src/records.js` |
| An implicit clock `0` is only a merge-time sentinel, not durable truth. | Persisting an unknown-time record at clock 0 makes it lose every later merge. | `mergeCollections()` in `packages/folder-sync/src/merge.js` |
| A structureless or empty-priorities frame must not beat a populated one just because it is newer. | Otherwise first sync or scaffolded templates can erase headings or the priorities list. | `preferStructuredFrame()` and `preferPopulatedPriorityFrame()` in `packages/folder-sync/src/records.js` |

The comments explain the design plainly: the unit of sync is the **row**, because that is the only way to keep deletes durable and make concurrent edits to different tasks commute.

## 6. MCP credential pointer file — `mcp-secrets.json`

This file never stores secret values. It is a non-secret pointer that tells the local launcher which credential-vault entries and public ids exist.

Real committed sample from `packages/mcp-cred-vault/mcp-secrets.example.json`:

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```json
{
  "version": 1,
  "secrets": [
    {
      "server": "telegram",
      "target": "overnight-agent:telegram-bot-token",
      "envVar": "TELEGRAM_BOT_TOKEN",
      "command": "uvx",
      "args": ["better-telegram-mcp"]
    }
  ],
  "ids": {
    "telegramBotId": "0000000000",
    "telegramChatId": "0000000000"
  }
}
```


</details>
| Invariant | Why it exists | Enforced / relied on by |
| --- | --- | --- |
| Root value must be an object. | The validator rejects arrays, strings, and null immediately. | `collectMcpSecretsErrors()` in `packages/mcp-cred-vault/src/schema.js` |
| `version` must be a positive integer. | Schema upgrades need an explicit version. | `packages/mcp-cred-vault/src/schema.js` |
| `secrets` must be an array of objects with `server`, `target`, `envVar`, and `command`. | Launchers need each mapping to be complete. | `packages/mcp-cred-vault/src/schema.js`; `packages/mcp-cred-vault/src/schema.test.js` |
| `envVar` must match shell-variable syntax; `target` cannot contain tabs/newlines. | The pointer file is later used to construct process environments and vault lookups. | `packages/mcp-cred-vault/src/schema.js` |
| `server` and `target` values must be unique across entries. | Duplicate mappings make injection ambiguous. | `packages/mcp-cred-vault/src/schema.js` |
| `ids`, when present, is a string map of non-secret public identifiers. | Public ids travel with the pointer file; secrets do not. | `packages/mcp-cred-vault/src/schema.js` |

See also [Domain-app](Domain-app), [Domain-config](Domain-config), [Domain-folder-sync](Domain-folder-sync), [Domain-telegram-bridge](Domain-telegram-bridge), [Domain-mcp-cred-vault](Domain-mcp-cred-vault), and [Domain-overnight-agent](Domain-overnight-agent).
