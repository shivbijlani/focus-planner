# Data Formats

Every format below is a plain text file inside the active storage source (a local folder via the
File System Access API, an IndexedDB-backed browser store, or an app-managed folder on OneDrive/Google
Drive). None of them require a schema migration tool: each reader is written to tolerate a file that
predates the field it's looking for, and each writer is written to touch only the bytes it means to
change.

## 1. The board (`planner.md`, `planner-completed.md`)

A board is one or more `##` sections, each containing a markdown pipe table. Row identity is the
first cell (the task id); everything else is display data plus a small number of machine-read fields.

```markdown
## Today

| ID | 🎯 | Task | Work Priority | Added | Linked ID |
|----|----|------|----------|-------|-----------|
| 70 | 🟡 | Write the design doc | Sydney rollout | 2026-01-27 | |

## Deferred

| ID | 🎯 | Task | Work Priority | Added | Wake | Linked ID |
|----|----|------|----------|-------|------|-----------|
| 254 | ⚪ | Add dance church events to the calendar | - | 2026-06-13 | 2026-09-08 | 191 |

## Priorities

1. Sydney rollout
2. Vibe Agenda
```

Priority icons (`src/config/agentsDoc.js`, mirrored in `src/taskSort.js`): 🔴 urgent+important,
🟡 important, 🔵 urgent/delegate, ⚪ low, ✅ done, 🐸 frog (do first), 📖 learning.

**Invariant — the ragged header (issue #426).** `## Deferred` has one more column than `## Today`
(`Wake`, inserted before `Linked ID`), and rows written before `Wake` existed carry only 6 fields under
a 7-column header. `src/boardRow.js` is the *one* place that resolves "given this row's cells and this
table's header, which cell is `Linked ID` and which is `Wake`" — it is imported by the writer
(`src/focusPlanOps.js`), the reader (`src/boardTable.js`), and the snooze accessor (`src/snooze.js`), so
"the reader agrees with the writer" holds by construction. A rebuild must **not** parse a row by
positional index against its *own* row length; it must align every row to its section's header first.

**Invariant — id extraction.** A cell may carry a linked external ticket, e.g. `448,[176](https://...)`.
Every reader (app, bridge, agent) treats the id as the **leading numeric token**, not "the whole cell
parsed as an integer" — a whole-cell-integer regex silently drops such rows (`oa-state.ps1`'s
`Get-BoardRowId`, guarded by `mutcheck-board-compound-id.ps1`).

**Sidecar (`planner.md.sync.json`).** Written only by the folder-sync layer for cloud-synced sources —
see §4. It never carries wake/date data and is not a source for board content recovery
(`src/boardRepair.js`).

## 2. Task journals (`journal/task-<id>.md`)

A journal is an append-only chat log. It **degrades gracefully**: plain markdown with nothing else
renders as one valid message bubble, so a naive writer that knows nothing about the schema still
produces a readable file. `src/config/agentsDoc.js`'s `AGENTS_DOC` (scaffolded into every connected
folder as `AGENTS.md`) is the canonical description a rebuilder should copy verbatim:

```markdown
# Task 254: Add dance church events to the calendar   <- thread title (first line)

- TODO: pick a cleaner                                <- undated "earlier notes"

## 2026-06-13                                         <- starts a day group (the user)

Booked the cleaner for Saturday.                      <- a "me" bubble

<!-- from: research-agent -->                         <- following content is from an agent
Found the cleaning code: **W-S**.                     <- agent bubble (shown under a 🤖 banner)
- [ ] Spot-test the back-left corner first
```

| Marker | Meaning |
| --- | --- |
| `# Task XX: Title` | Thread title; first line of the file. |
| `## YYYY-MM-DD` | Starts a new day group. Consecutive same-day "me" notes merge into one bubble. |
| `<!-- from: name -->` | Following content is attributed to agent `name` (rendered left, under a 🤖 banner). |
| `<!-- from: me -->` | Switches attribution back to the human. |
| `<!-- ...AUTO... -->` / `<!-- ...AGENT... -->` | A sentinel containing `AUTO` or `AGENT` flags an auto-generated / agent-managed block. |
| `<!-- ... -->` (may span lines) | Hidden from the rendered chat; used for machine metadata (e.g. the Telegram `tg-meta` marker, §3). |

Content before the first `##`/agent marker is undated "earlier notes." Supported inline markdown:
bold/italic/code, links, headings, bullet/numbered lists, tables, blockquotes, horizontal rules, and
task items (`- [ ]`, `- [x]`, plus `TODO:`/`DONE:` prefixes as chips). The parser
(`src/journalChat.js`, zero imports, shared verbatim by the app, the Telegram bridge and the task-paper
generator) is fence-masked (issue #320): a marker that appears *inside* a fenced code block (a quoted
example) must never be interpreted as live structure.

**Rules for any writer appending to a journal** (from `AGENTS.md`, load-bearing, not a suggestion):

1. Always append at the bottom. Never rewrite or reorder earlier entries.
2. Stamp who is speaking: a line `<!-- from: me -->` directly above human-authored text. Unmarked
   text is unattributed; never retroactively mark existing unmarked history.
3. If today has no header yet, add `\n\n## YYYY-MM-DD\n\n<!-- from: me -->\n`.
4. If today's header exists **and** a `<!-- from: me -->` marker still owns the bottom of the file,
   new lines merge into the same bubble; any `##` heading ends a marker's ownership.
5. An automation/agent block is preceded by `<!-- from: your-name -->` so it renders distinctly.
6. Machine-readable metadata goes inside an HTML comment so it stays hidden from the chat.

**Invariant — encoding.** Journals are UTF-8, no BOM. `oa-state.ps1`'s content hash (used to detect "has
the user replied?") must depend **only on the journal's bytes**, never on which PowerShell host decoded
them — Windows PowerShell 5.1 decodes a BOM-less non-ASCII file as the machine's ANSI codepage, `pwsh`
7 decodes the same bytes as UTF-8, and a read-under-one/write-under-the-other pair is destructive (593
lines of one real journal were destroyed this way; see [Reliability](Reliability) §5). A rebuild must
read and write journals with an explicit, fixed encoding and never let the host's default decide it.

**Invariant — the turn-end stamp is a boundary, not content.** The Telegram bridge and the agent both
need to find "everything after my last turn." A stamp marks that boundary; text after it belongs to
whoever wrote it next, and the stamp itself must never render into anything a human reads
(`packages/telegram-bridge/src/journal.js`).

## 3. Per-task metadata sidecars

**`task-settings.json`** (`src/storage/taskSettings.js`) — one JSON file per source, keyed by stable
task id, holding per-task AI-assistance opt-ins:

```json
{
  "version": 1,
  "tasks": {
    "254": { "aiAssisted": true, "persistentSession": false }
  }
}
```
A task absent from the file is treated as both opt-ins off — the file only ever grows by explicit
user action, and a task moved to a new id (`moveTaskSettingsEntries`) carries its entry with it.

**`user-settings.md`** (`src/config/aiSettings.js` / `userSettingsForm.js`) — the overnight agent's
run configuration, written by the app but *read authoritatively* by the plugin. It is a markdown file
of `| Setting | Value |` tables plus prose. The web form is **round-trip-safe by construction**: saving
one field rewrites only that value cell — intro prose, the `## Preferences` bullet list, comments,
blank lines, and unknown sections are preserved byte-for-byte (`userSettingsForm.test.js`'s "identity"
guarantee: `serializeSettingsForm(md, parseSettingsForm(md).map(r => r.value))` returns `md`
unchanged). This matters because the same file carries real paths, account ids and allow-lists that a
half-regenerated file would corrupt. See [Prioritisation](Prioritisation) for the specific tunables it
carries (concurrency, Today-gate backstop) and [Reliability](Reliability) for the browser-slots table.

**`agent-gate.md`** (`src/config/agentGate.js`) — two bullet lists, "Do not gate these (reversible)"
and "Always ask (safety floor)," that tell the agent when it may act unattended. It is **seeded once**
(only when absent or blank) and never refreshed like `AGENTS.md` is, because the file's entire value is
"the user wrote this" — see [Architecture](Architecture) for why this file carries no attribution
marker. Saving from the app still only splices the two known sections' bullet lines, preserving title,
preamble, comments, and any extra section verbatim.

**`<!-- tg-meta chatId=... threadId=... -->`** (`packages/telegram-bridge/src/deepLink.js`) — a hidden
marker inserted near the top of a journal (right after the H1) recording the Telegram forum topic that
journal maps to, so the mapping travels with the synced markdown rather than living only in the
bridge's local state file.

## 4. Sync sidecars (record-level merge state)

For cloud-synced sources, each markdown file has a paired sidecar (e.g. `planner.md.sync.json`)
carrying, per record id, a logical clock and a tombstone flag:

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
`clock` is a logical mtime (`Date.now()` at the time of the local write or delete). A record present in
the file's content but **absent from `entries`** is a legacy/external write and is treated as clock 0
during that merge only — it must never be *frozen* into the sidecar as the record's durable clock
(issue #280's "zero-clock freeze" — an *implicit* sentinel meaning "we don't know" must not become a
value future merges trust). An *explicit* `{clock: 0}` is a different, legitimate thing: a deliberate
"this side is weak" stamp. `fp` is a content fingerprint used to detect a genuine re-edit versus a
stale replica reappearing.

**The merge unit is the record, not the file** (`packages/folder-sync/src/merge.js`). Deletes are
tombstones, so a stale replica can never resurrect a row another device deleted — this is the fix for
the historical "deleted rows reappear" defect. A record whose sidecar entry is alive but whose content
is missing on *both* sides must be preserved as alive (never silently voided into a tombstone) and
logged as an anomaly — collapsing it silently is exactly how a live, unreachable journal (issue #190,
task #228) escaped every board and every sweep. See [Domain-folder-sync](Domain-folder-sync) for the
full merge algebra and its "collapse guard" (issue #371: an accidentally-empty record set must never be
read as "everything was deleted").

**Deletion is recorded as `deleted: true` explicitly**, never inferred from "absent from the board" —
`packages/telegram-bridge/src/deleted.js` needed exactly this distinction to decide whether to archive a
Telegram topic, because "absent" is ambiguous (a board that failed to parse also reads as absent) while
a tombstone is a deliberate, recorded action.

## 5. Bridge state (`packages/telegram-bridge/src/state.js`)

Persistent JSON, stored outside the repo and outside OneDrive (per `config.stateDir`), mapping each
task id to its forum topic, the hash of the last-posted turn (so a run doesn't repost unchanged
content), and the Telegram `getUpdates` offset (so replies aren't reprocessed):

```json
{
  "version": 1,
  "tasks": {
    "254": { "topicId": 981, "lastPostedHash": "…", "archived": false }
  },
  "offset": 445210
}
```

## 6. MCP credential pointer file (`mcp-secrets.json`)

Lives on each machine in the agent's OneDrive working folder — **never** in the repo, **never** the
secret value itself. It only lists which secrets a machine needs:

```json
{
  "version": 1,
  "secrets": [
    { "server": "telegram", "target": "overnight-agent:telegram-bot-token",
      "envVar": "TELEGRAM_BOT_TOKEN", "command": "uvx", "args": ["better-telegram-mcp"] }
  ],
  "ids": { "telegramBotId": "0000000000", "telegramChatId": "0000000000" }
}
```
The real secret values live in the OS credential vault (Windows Credential Manager); `packages/mcp-cred-vault`
validates only this pointer file's shape (`isValidMcpSecrets`/`parseMcpSecrets`, `packages/mcp-cred-vault/src/schema.js`).

## 7. Agent state (`%LOCALAPPDATA%\overnight-agent\state\task-<id>.json`)

Per-task JSON, local to the machine, never cloud-synced, owned exclusively by `oa-state.ps1` — the user
never edits it. Carries `id, status, status_by, version, plan_id, processed_file_hash, has_agent_block,
seeded, updated, poll, recheck, unanswered_user_message_at, today_exhausted, session, doc`. See
[Prioritisation](Prioritisation) for the fields that drive scheduling (`poll`/`recheck` timers,
`today_exhausted`) and [Domain-overnight-agent](Domain-overnight-agent) for the full state machine.
