# Data formats

The system has no database. Every durable fact lives in a plain-text or JSON file inside one
**storage source** — a folder reachable through `src/storage/fsa-provider.js` (local File System
Access), `src/storage/onedrive-provider.js`, `src/storage/google-drive-provider.js`, or
`src/storage/indexeddb-provider.js` (the browser-only default). All four expose the same read/write
contract (`src/storage/storage.js`), so every format below is provider-agnostic: it is defined by
its bytes, not by where those bytes are stored.

This page is the format contract. A rebuilder needs it to write a compatible reader/writer without
seeing the source; [Architecture](Architecture) explains why the system is shaped this way, and
[Prioritisation](Prioritisation) and [Reliability](Reliability) explain the runtime rules that
consume these formats.

## 1. The active board — `planner.md`

A markdown file with two ranked sections, each a pipe table. Real shape (`src/focusPlanOps.test.js`):

```markdown
# Focus Plan

## Today

| ID | 🎯 | Task |
|---|---|------|
| 1 | 🟡 | A |
| 2 | 🟡 | B |

## Deferred

| ID | 🎯 | Task | Mngr Priority | Added | Wake | Linked ID |
|---|---|---|---|---|---|---|
| 9 | ⚪ | X | - | 2026-06-13 | | 191 |
```

**Invariant: the file is ragged by construction.** `## Today` and `## Deferred` do not share one
header — Deferred carries a `Wake` column (the snooze date) that Today does not, because the file
is hand-edited and pre-existing rows are never forced to add a column they never had (issue #426).
Every reader and writer must therefore resolve a cell by **header name**, never by fixed index, and
must learn each table's own header before indexing its rows. `src/boardRow.js` is the single
implementation of that rule (`rowCells`, `alignRowToHeaders`, `wakeSeamIndex`); the writer
(`src/focusPlanOps.js`) and the reader (`src/boardTable.js`) both import it so they cannot disagree
about which cell is `Linked ID` and which is `Wake` — the defect class that already shipped once
when the two were separate implementations.

Column meanings, in order: `ID` (stable numeric task id, the same id namespace the journal
filenames use), urgency icon (🔴 urgent+important, 🟡 important not urgent, 🔵 urgent not important,
⚪ neither, 🐸 frog/eat-first, 📖 learning), task text, `Mngr Priority` (a free-text label, e.g. a
named manager priority like "Sydney rollout"), `Added` (date), `Wake` (Deferred only — an HTML
comment `<!-- snooze:YYYY-MM-DD -->` embedded in the cell, parsed by `src/snooze.js`), `Linked ID`
(a parent/child task id, optionally carrying an external ticket link as
`191,[170](https://…)` — the compound-id grammar shared with the Telegram bridge's board reader).
A `## Priorities` ordered list (`1. 285`, `2. 140`, …) may appear anywhere in the file; it is a
user-maintained override of intra-section ordering, read by `src/taskSort.js` and by the overnight
agent's `Get-PrioritiesRank`.

**Invariant: row order inside a section is significant** — it is one term of the priority sort key
(see [Prioritisation](Prioritisation)) and must be preserved exactly by every writer that is not
deliberately reordering.

## 2. The completed board — `planner-completed.md`

Same row grammar as `planner.md`, grouped under weekly headings instead of Today/Deferred:

```markdown
## Week of 2026-08-25

| 401 | ✅ | Draft house-sitter directions doc | - | 2026-08-02 |
```

Parsed by `packages/telegram-bridge/src/completed.js`; only rows whose first cell parses as a
numeric id are treated as tasks, so header and separator rows are ignored. **Invariant: a task ID
appearing here is not, by itself, proof the corresponding live task is closed** — issue #556
documents a live task and a stale placeholder sharing one reused id across the two boards, which
defeats an ID-only join. A correct reader must corroborate a completed-board match against the live
row's title or the journal's own `H1` before treating a task as closed.

## 3. Task journals — `journal/task-<id>.md`

A bottom-appended chat transcript, one file per task, rendered by `src/journalChat.js`
(`parseJournalChat`) and shared by the app UI, the Telegram bridge (`packages/telegram-bridge/src/journal.js`),
and the overnight agent (`oa-state.ps1`, `write-turn.ps1`). All three **must** use the same
grammar — the repo has already shipped bugs from a second, drifted implementation of this parser
(closed issues #320, #325).

```markdown
# Task 70: New task description

Some undated notes at the top (the "pinned"/earlier-notes region).

## 2026-08-31

<!-- from: me -->
Go ahead and ship it.

<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## Overnight Agent

**Status:** In progress

Needs from you: confirm the rollout window.
```

Grammar:

| Element | Meaning |
| --- | --- |
| `# Task <id>: <title>` | First line; thread title. |
| `## YYYY-MM-DD [label]` | Starts a new day group; resets the author to `me`. Consecutive same-day `me` notes merge into one bubble. |
| `<!-- from: NAME -->` | Switches the following content's author. `me` switches back to the human; anything else (e.g. `overnight-agent`) renders as an agent bubble. |
| A sentinel comment containing `AUTO` or `AGENT` (case-insensitive), e.g. `<!-- OVERNIGHT-AGENT ... -->` | Marks the start of an agent-managed block, matched by the shared `AGENT_SENTINEL_RE` so the parser and the agent's own writer can never disagree about where it begins. |
| Fenced code blocks (```` ``` ```` / `~~~`) | **Quoted text, not markup.** A `## `, `<!-- from: -->` or sentinel line *inside* a fence must not be interpreted — otherwise an illustrative example in a message can fabricate a bubble, misattribute authorship, or split a turn (measured live, documented in `src/journalChat.js`). |
| A multi-line HTML comment (e.g. `<!-- dc-meta ... -->`) | Hidden from the rendered chat; used for machine metadata that must not appear as a message. |

**Invariant: append-only.** The sanctioned agent writer (`write-turn.ps1`) has no code path that can
edit or delete an existing line — this is what makes "did the user reply?" a safe question to
answer by re-scanning the tail of the file, and it is why a comment typed into a generated
task-paper HTML document (`packages/task-paper/src/comment.js`) is durable: it is appended to the
journal by the same shared writer, not stored in a regeneratable artifact.

**Invariant: authorship is byte-identical across every writer.** The app, the Telegram bridge, and
the overnight agent all emit `<!-- from: me -->` / plain agent prose using the same bytes, because a
consent reader (the "did the user approve this?" gate) that recognizes one writer's marker but not
another's would silently misclassify approvals — the repeated failure class named explicitly in
`oa-state.ps1`: *the agent authoring the signal its own gate reads*.

## 4. Deep-link marker — `<!-- tg-meta ... -->`

A hidden HTML comment stamped into a journal by the Telegram bridge (`packages/telegram-bridge/src/deepLink.js`)
carrying the forum topic's `chatId`/`threadId`, because Telegram assigns `message_thread_id` only at
topic-creation time and it cannot be recomputed from the task id. Read/written by
`parseTgMeta`/`upsertTgMetaMarker`; travels with the journal through sync so any device can compute
the deep link.

## 5. Bridge state — `state.json` (outside the repo, outside the synced folder)

Persistent Telegram bridge state, one JSON object (`packages/telegram-bridge/src/state.js`,
`STATE_VERSION`). Tracks task↔topic mapping, last-posted-turn hashes (so a turn already mirrored is
never reposted), and the `getUpdates` offset (so a reply already folded is never reprocessed).
Stored under `TELEGRAM_BRIDGE_STATE_DIR`, deliberately outside OneDrive: it is host-local
operational state, not planner content.

## 6. Sync sidecar — `<file>.sync.json`

Per-file CRDT metadata written by the folder-sync engine (`packages/folder-sync/src/merge.js`,
`packages/folder-sync/src/records.js`) alongside `planner.md` / `planner-completed.md`:

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

`clock` is a logical mtime (`Date.now()` at write/delete time) used for last-write-wins conflict
resolution **per record** (a table row), not per file — the merge unit is the row, keyed by its
leading numeric id, so a device that deletes a row writes a **tombstone** (`deleted: true`) rather
than merely omitting the row, which is what stops a stale replica from resurrecting a row another
device deleted. `fp` is a content fingerprint used to detect a record that changed without its
clock being bumped (an external/legacy write). A `clock` of `0` in `meta` with no corresponding
entry in `records` is an *implicit* sentinel ("we don't know when this was written") that must lose
any tie during a single merge and must never be frozen into the sidecar as a real timestamp; an
*explicit* `{clock: 0}` is a different, deliberate "this side is weak" stamp and is preserved as-is.
The bridge's own deletion detector (`packages/telegram-bridge/src/deleted.js`) reads this same file
to know which tasks the user tombstoned, so a deleted task's Telegram topic can be closed even
though the task appears on neither board.

## 7. Config sidecars in the storage source

| File | Constant | Purpose |
| --- | --- | --- |
| `AGENTS.md` | `src/config/agentsDoc.js` (`AGENTS_FILE`, `AGENTS_DOC_VERSION`) | Self-documentation scaffolded into every connected folder so any external agent can operate on it without this app's source. Version-stamped so a stale copy is refreshed on load. |
| `agent-gate.md` | `src/config/agentGate.js` (`AGENT_GATE_FILE`) | The two lists that decide when the overnight agent may act unasked ("Do not gate these (reversible)") versus must always stop and ask ("Always ask (safety floor)"). **Human-authored by construction**: scaffolded only when absent/blank, never refreshed or version-bumped over an existing file, because the file's entire value is that the user — not the agent — wrote it (closed issue #250: an agent-written marker cannot distinguish the user's real consent from the agent's own prose). |
| `user-settings.md` | `src/config/aiSettings.js` (`AI_SETTINGS_FILE`) | The overnight agent's resolved-fresh-every-run configuration: paths, allow-lists, Telegram identifiers, and the `## Overnight Agent behaviour` table (gate backstop, gate strict, concurrency). See [Prioritisation](Prioritisation) for the tunables' runtime meaning. |
| `task-settings.json` | `src/storage/taskSettings.js` (`TASK_SETTINGS_FILE`) | Per-task opt-ins (AI-assisted, persistent session), keyed by stable task id; a task with no entry is treated as both opt-ins off. |
| mission-statement sidecar | `src/missionStatement.js` | Small planner-owned text sidecar, same pattern as `src/storage/settings.js`. |

Sample `agent-gate.md` body (from the module's seeded template):

```markdown
# Agent gate

<!-- planner-agent-gate v1 -- you own this file. The overnight agent reads it and never writes it. -->

## Do not gate these (reversible)

- Emailing myself
- Creating and publishing a pull request in any repository, then continuing to work on it until all checks pass, is easily reversible and has no consequence; do not gate it.

## Always ask (safety floor)

- Send-to-many (group/channel, mass email)
- Outcome can result in permanent data loss
```

`serializeAgentGate` never regenerates this file from the template — it splices only the bullet
lines of the two known sections by string matching (case-insensitive, reworded-heading tolerant)
and preserves every other byte (title, preamble, comments, extra sections) verbatim, so a hand edit
is never silently discarded.

Sample `user-settings.md` behaviour table:

```markdown
## Overnight Agent behaviour

| Setting | Value |
| --- | --- |
| Today gate backstop | `6h` |
| Today gate strict | `off` |
| Overnight Agent concurrency | `1` |
```

`src/config/userSettingsForm.js` gives the UI a round-trip-safe structured view of this file: it
changes only the value cell of a row a user edits, and leaves prose, comments, blank lines and
unknown sections untouched — this file is the overnight agent's live source of truth, so the app
must never regenerate it wholesale.

## 8. `mcp-secrets.json` (machine-local, never in the repo or the synced folder)

A non-secret pointer file (`packages/mcp-cred-vault/src/schema.js`) naming which secrets a machine
needs — never the values, which live in the OS credential vault:

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
  "ids": { "telegramBotId": "0000000000", "telegramChatId": "0000000000" }
}
```

## 9. Overnight agent scan output (in-memory / stdout JSON, not persisted)

The worklist `oa-state.ps1 scan` produces per Today/Deferred row is the binding input to dispatch.
See [Prioritisation](Prioritisation) for every field's meaning; shape:

```json
{
  "id": "451", "status": "in-progress", "section": "today", "urgency": "🔴",
  "work_priority": "P0", "board_pos": 3, "reopened": false,
  "awaiting_reply": true, "eligible": true, "order": 1,
  "holds_today_gate": true, "today_release_reason": "holding:reopened",
  "gate_backstop_hours": 6, "gate_strict": false
}
```

and the exhaustion-declaration object that releases the Today→Deferred gate:

```json
{
  "today_exhausted": {
    "at": "2026-08-31T22:40:00-07:00",
    "examined": ["gh:197", "gh:179", "gh:139"],
    "note": "all three blocked on review",
    "today_hash": "<sha256 of the ## Today section text>"
  }
}
```
