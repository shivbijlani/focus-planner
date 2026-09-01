# Data Formats

Every persisted format in this system is plain markdown or small, human-readable JSON.
This page is the format contract a rebuild must reproduce exactly — the app's own
`src/config/agentsDoc.js` scaffolds a condensed version of the board/journal formats
(sections "Task tables" and "Journal chat schema" below) directly into every connected
data folder as `AGENTS.md`, so any external tool — this app, the Telegram bridge, the
Overnight Agent, or an unrelated agent — can read the contract without this repo's source.

## 1. The active board — `planner.md`

One markdown file per storage source, containing `##`-level sections (conventionally
`Today`, `Deferred`, `Priorities`) each holding a pipe-table of tasks. Row and section
order is significant — see [Domain-app](Domain-app) (`src/taskSort.js`) for how the
`Priorities` section's *ordered list* controls sort order for anything else on the board.

```markdown
## Today

| ID | 🎯 | Task | Mngr Priority | Added | Linked ID |
|----|----|------|----------------|-------|-----------|
| 70 | 🟡 | Write the design doc | Sydney rollout | 2026-01-27 | |
| 71 | 🔴 | Fix prod outage | | 2026-01-27 | 70 |

## Deferred

| ID | 🎯 | Task | Mngr Priority | Added | Linked ID |
|----|----|------|----------------|-------|-----------|

## Priorities

1. Sydney rollout
2. Vibe Agenda
```

**Invariants:**
- Column 0 is the row's stable numeric **id**; the sync codec
  (`packages/folder-sync/src/codecs/mdTable.js`) uses it as the record key, and IDs are
  never reused while a live tombstone protects them (`src/idTombstones.js`).
- The priority icon (`🎯` column) is one of 🔴 urgent+important, 🟡 important-not-urgent,
  🔵 urgent-not-important, ⚪ low, ✅ done, 🐸 "frog" (do first), 📖 learning.
- `Priorities` is an **ordered list**, not a table; `src/taskSort.js`'s
  `parseManagerPriorities` maps each list item's text to its 1-based position, and any
  task whose `Linked ID` chain resolves (transitively, via `src/taskSort.js`'s
  `resolveManagerPriority`) to a priority-list entry inherits that ordering rank.
- `Linked ID` records a dependency: "this row's priority is governed by that row's".
  `src/moveTask.js`'s `computeMoveSet` uses this chain to decide which *other* rows must
  travel together when a manager-priority task moves between storage sources.
- A "snooze" is encoded in-row (see `src/snooze.js`) rather than as a separate field —
  a task with an active `Wake` date in the future is filtered from the active view until
  that date passes.

## 2. The completed archive — `planner-completed.md`

Rows are grouped under weekly prose headings, not `##` sections keyed by name; each row
is still a pipe-table row whose first cell is the numeric task id:

```markdown
### Week of 2026-01-26

| 401 | ✅ | Draft house-sitter directions doc | - | 2026-08-02 |
```

`packages/telegram-bridge/src/completed.js`'s `parseCompletedTaskIds` treats **any** row
whose first cell is all-digits as a completed task id, and explicitly ignores header rows
(`| # | 🎯 | ... |`) and separator rows (`|---|---|`) by requiring the digit test — this
is why the archive's own header row must never contain a bare number in column 0.

## 3. Task journals — `journal/task-<id>.md`

A journal is a **bottom-appended chat thread** rendered by `src/journalChat.js`'s
`parseJournalChat`, consumed by both the web app and (independently) the Telegram bridge
and Overnight Agent. It degrades gracefully: plain markdown with no markers at all still
renders as one valid "me" message bubble.

```markdown
# Task 254: Add dance church events to the calendar

- TODO: pick a cleaner

## 2026-06-13

Booked the cleaner for Saturday.

<!-- from: research-agent -->
Found the cleaning code: **W-S**.
- [ ] Spot-test the back-left corner first

<!-- from: me -->
Looks right, go ahead.
```

**Markers and their meaning** (all recognized by `src/journalChat.js` and re-emitted by
`src/config/agentsDoc.js`'s scaffolded contract):

| Marker | Effect |
| --- | --- |
| `# Task XX: Title` | First line only; becomes the thread title. |
| `## YYYY-MM-DD` | Starts a new day group and resets the author to "me". Consecutive same-day, same-author lines merge into one chat bubble (`parseJournalChat`'s grouping key is `{day, author, agent}`). |
| `<!-- from: NAME -->` | Switches the following content's author. `NAME === "me"` (case-insensitive) switches back to the human; anything else is rendered as an agent message under a 🤖 banner, labeled `NAME`. |
| A comment containing `AUTO` or `AGENT` (case-insensitive, e.g. `<!-- DANCE-CHURCH-AUTO -->`, `<!-- OVERNIGHT-AGENT -->`) | Also flags the following content as agent-authored, even without an explicit `from:` marker (`AGENT_SENTINEL_RE` in `src/journalChat.js`). |
| Any other `<!-- ... -->` (may span multiple lines) | Hidden entirely from the rendered chat — the safe place for machine-readable metadata (e.g. the Telegram bridge's `tg-meta` marker below). |
| Content before the first day/agent marker | "Pinned" / undated earlier notes. |

`src/journalChat.js`'s `appendJournalMessage(content, text)` is the canonical writer, and it
**always stamps `<!-- from: me -->` on the text it appends** — the app is the true author of
journal-chat sends and close-out notes, so it identifies itself rather than leaving the entry
unattributed. It finds the last `## YYYY-MM-DD` heading, and either (a) opens a fresh
`## <today>` block followed by the marker if the last heading isn't today, (b) appends bare
under the current bubble if a `<!-- from: me -->` marker still owns the bottom of the file, or
(c) inserts the marker otherwise (after an agent block, or after a `## ` heading that ended a
previous marker's ownership). The emitted shape is byte-identical to the Telegram bridge's
`appendUserReply`, so a reply reads the same whichever channel it arrived through.

This matters beyond rendering: the overnight agent's consent reader attributes trailing text by
marker and **fails closed on unmarked text**, so an unstamped entry can never count as human
approval. The writer stamps; the reader is deliberately left strict.

**Rule for any external writer:** always append at the bottom, and stamp your own authorship;
never rewrite or reorder earlier entries — the format has no mechanism to express an edit
to history, only new content. Historical unmarked entries stay unmarked; nothing migrates them.

### Telegram deep-link marker

`packages/telegram-bridge/src/deepLink.js` stamps a hidden marker inside the journal so
the mapping between a task and its Telegram forum topic travels with the synced markdown
(the bridge's own state lives outside the sync folder — see §6):

```markdown
<!-- tg-meta chatId=-1001234567890 threadId=42 -->
```

## 4. Sync sidecar — `<file>.sync.json`

Every synced markdown file has a sidecar of the same name plus `.sync.json`
(`packages/folder-sync/src/records.js`'s `sidecarPath`), carrying a logical clock and
tombstone flag per record id — the mechanism that makes deletes survive a merge against a
stale replica instead of being silently resurrected.

```json
{
  "version": 1,
  "updatedAt": 1787621820553,
  "entries": {
    "70":  { "clock": 1787621820553, "deleted": false, "fp": 1234567890 },
    "434": { "clock": 1787621820553, "deleted": true,  "fp": -1454295489 }
  }
}
```

**Invariants (`packages/folder-sync/src/merge.js`):**
- `clock` is a logical mtime — `Date.now()` at the moment of the write/delete — used to
  decide which side wins a per-record merge (`mergeCollections`). It is *not* wall-clock
  truth across devices, only a tie-breaker within one merge.
- A record present in the parsed file but **absent** from `entries` is treated as an
  external/legacy write with clock `0`, which loses every tie — this is what lets an
  editor that doesn't understand the sidecar (a hand edit, an older app build) still
  merge safely, at the cost of always losing to any side that *does* stamp a clock.
- `deleted: true` is a **tombstone**: once one side has it, the row is dropped from every
  future merged output regardless of whether the other side still has a live copy of the
  row's text, until the tombstone is garbage-collected (`gcTombstones`, default TTL 90
  days).
- `fp` (a cheap djb2 fingerprint of the record's serialized content, via `fingerprint()`)
  lets a tombstoned-then-reappeared row be told apart from a genuine re-add: it is only
  revived if the reappeared content's fingerprint differs from the fingerprint recorded
  at delete time (a deliberate re-add), never merely because the row is present again (a
  stale-replica ghost).
- The markdown file's own non-row structure (headings, table headers, the `Priorities`
  ordered list, arbitrary prose) is folded into a single synthetic `FRAME` record inside
  the same `entries` map, so headings merge with the same last-write-wins + guard logic as
  any row (`packages/folder-sync/src/records.js`'s `frameHasStructure` /
  `preferStructuredFrame` guard specifically prevents a blank new local file's empty frame
  from beating a populated remote frame on first sync).

## 5. Deleted-task tombstones for cross-process consumers

The same `.sync.json` sidecar convention doubles as the deletion signal the Telegram
bridge reads (`packages/telegram-bridge/src/deleted.js`'s `parseDeletedTaskIds`), because
"absent from both boards" is ambiguous (a board that failed to parse would look identical
to a deleted task) but an explicit `deleted: true` tombstone is a recorded, deliberate
action:

```json
{
  "version": 1,
  "updatedAt": 1787621820553,
  "entries": {
    "434": { "clock": 1787621820553, "deleted": true,  "fp": -1454295489 },
    "462": { "clock": 1787000000000, "deleted": false, "fp": 1234567890 }
  }
}
```

## 6. Telegram bridge state — outside the synced folder

`packages/telegram-bridge/src/state.js` persists a separate JSON file (location:
`config.stateDir`, deliberately **outside** the repo and outside the OneDrive-synced
planner folder, so it never gets folded into board/journal sync):

```json
{
  "version": 1,
  "updateOffset": 918273,
  "tasks": {
    "254": {
      "topicId": 42,
      "name": "Task 254: Add dance church events to the calendar",
      "lastPostedHash": "a1b2c3...",
      "archived": false,
      "userEngaged": false
    }
  }
}
```

`updateOffset` is Telegram's own `getUpdates` cursor (so replies are never reprocessed);
`lastPostedHash` (from `hashTurn`/`hashDigest` in `packages/telegram-bridge/src/bridge.js`
and `packages/telegram-bridge/src/digest.js`) is a content hash of the last thing posted
for that task, so an unchanged turn or an unchanged digest is never reposted;
`userEngaged` is a one-shot flag that lets the bridge answer a user reply on an already
completed/archived task exactly once without reopening ordinary silent posting.

## 7. MCP secrets pointer file — `mcp-secrets.json`

Validated (not generated) by `packages/mcp-cred-vault/src/schema.js`. Lives on each
Windows machine inside the web app's OneDrive working folder — never in the repo, never
holding a secret value itself (values live in Windows Credential Manager; this file only
points at them):

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

**Invariants (`collectMcpSecretsErrors`):** `version` is a positive integer;
`secrets[].server`, `.target`, `.envVar`, `.command` are all non-empty strings;
`target` may not contain a tab or newline (it becomes a Windows Credential Manager
target name); `envVar` must be a valid environment-variable identifier; `server` and
`target` must each be unique across the array; `ids` values, if present, must all be
strings. A file that fails any of these throws with every violation listed, not just the
first — the launcher must refuse to start rather than run with a partially-valid pointer
file.

## 8. Overnight Agent settings — `user-settings.md`

Lives beside `planner.md` in the same synced folder (`src/config/aiSettings.js`'s
`AI_SETTINGS_FILE`), so both the web app and the agent read the identical file. It has
exactly two sections the app's structured editor understands: a `## Settings` table of
`| Setting | Value |` rows and a `## Preferences` bullet list.

```markdown
# Overnight Agent — user settings

## Settings

| Setting | Value |
| --- | --- |
| User | `Jane Doe` (`janedoe` on GitHub) |
| Timezone | `America/Los_Angeles` |
| Planner board | `C:\Users\jane\OneDrive\Apps\Planner\planner.md` |

## Preferences

- **Inbox check:** `on` — check the agent email inbox at the start of every run.
- **Secrets:** never stored here. Email credentials live in the email MCP's store.
```

**Round-trip invariant** (`src/config/userSettingsForm.js`, enforced by
`userSettingsForm.test.js`): `serializeSettingsForm(md, parseSettingsForm(md).map(r =>
r.value))` must return `md` byte-for-byte unchanged, and changing one field's value in
the UI must touch **only that row's value cell** in the file — intro prose, comments,
blank lines, spacing, and unrecognized sections are preserved verbatim. This is why the
parser tracks each cell's exact character offsets (`splitTableRow`) instead of
regenerating the table from parsed data: this file is the Overnight Agent's real,
security-relevant configuration (paths, accounts, email allow-lists), and a lossy
round-trip would corrupt it silently.

## 9. Small planner-owned JSON sidecars — `settings.json` and `task-settings.json`

Two small JSON files live next to `planner.md` in the active source for machine-owned
metadata that does not belong in journal prose. Both follow the same shape convention: a
`version` field plus one payload field, normalized leniently on read (malformed or
missing input never breaks the board) and written back as pretty-printed JSON with a
trailing newline.

`settings.json` (`src/storage/settings.js`, `SETTINGS_FILE`) holds the single
mission-statement string shown in the app:

```json
{
  "version": 1,
  "missionStatement": "Ship the Sydney rollout without dropping anything else."
}
```

`task-settings.json` (`src/storage/taskSettings.js`, `TASK_SETTINGS_FILE`) holds two
per-task AI-assistance opt-ins, keyed by the task's stable numeric id:

```json
{
  "version": 1,
  "tasks": {
    "70": { "aiAssisted": true, "persistentSession": false },
    "254": { "aiAssisted": false, "persistentSession": true }
  }
}
```

**Invariants:**
- A task absent from `tasks` is treated as both opt-ins being off
  (`DEFAULT_TASK_SETTINGS`), so every task that existed before this file was introduced
  keeps its old behavior with zero migration.
- Each task entry is an **open object**: `normalizeTaskEntry` coerces the two known keys
  to booleans but preserves any other keys already present, so a future third opt-in can
  be added to the schema without a file-format migration or data loss for entries
  written by a newer app build.
- `setTaskSetting` performs a read-modify-write of a single task's entry and serializes
  concurrent toggles so neither update is lost; a write refuses to overwrite a file that
  parses as JSON but fails the schema check (`strict` mode), protecting a malformed
  sidecar from being silently replaced by an empty settings map.
- When a task is renumbered (moved between sources, see `src/moveTask.js`), the matching
  entry in `task-settings.json` moves with it under the new id rather than being dropped.

## 10. Folder self-description — `AGENTS.md`

Scaffolded by `src/config/agentsDoc.js`'s `scaffoldAgentsDoc(read, write)` into every
connected folder (local FSA, OneDrive, Google Drive, or browser storage) the first time
the app writes to it, and refreshed whenever `AGENTS_DOC_VERSION` increases (parsed back
out of an existing file's `<!-- planner-agents-doc vN -->` marker). It restates the
`planner.md` table format and the journal chat schema above in prose, so an operator can
point *any* agent at the folder with no other documentation. `scaffoldAgentsDoc` never
throws and never overwrites a file at or above the current version — scaffolding must
never block ordinary folder setup, and a user's own edits to the current version are
never clobbered.
