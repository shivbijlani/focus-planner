# Data Formats

Every persisted format in this system is plain text or JSON that a human can open directly — there is
no binary or database format anywhere. This page is the format contract: what each file must contain,
in what shape, and what invariant a reader/writer pair must preserve.

## 1. The active board — `planner.md`

A single markdown file with `##` section headings, each containing a pipe table. Sections are found
by heading text (`## Today`, `## Deferred`); there is no other structural marker.

```markdown
# Focus Plan

## Today

| ID | 🎯 | Task | Mngr Priority | Added | Linked ID |
|----|---|------|---------------|-------|-----------|
| 70 | 🟡 | Ship the thing | Sydney rollout | 2026-01-27 | |

## Deferred

| ID | 🎯 | Task | Mngr Priority | Added | Wake | Linked ID |
|----|---|------|---------------|-------|------|-----------|
| 254 | ⚪ | Add dance church events to the calendar | - | 2026-06-13 | 2026-09-08 | 191 |

## Priorities

1. Sydney rollout
2. Vibe Agenda

## Skills

| Skill | Active tasks |
|-------|-------------|
```

**The one invariant that matters, and the one it took a real defect to name (issue #426):** `##
Deferred`'s header has **7** columns (it carries `Wake`); `## Today`'s has **6** (it does not). A row's
cells must be aligned to its **own section's header**, never assumed to match a fixed column count. A
6-cell row under a 7-column header has its `Linked ID` in the *last* cell of the row, not at index 6 of
the header — `src/boardRow.js`'s `alignRowToHeaders`/`wakeSeamIndex` is the one place this is computed,
shared by every reader and writer in the `app` domain (see [Domain-app](Domain-app)). Priority icons
are one of 🔴/🟡/🔵/⚪/✅/🐸/📖 (see [Home](Home) for their meanings). The `## Priorities` numbered list
is free text matched against each row's `Mngr Priority` cell to compute manager-priority rank (see
[Prioritisation](Prioritisation)).

Legacy rows may carry a wake date as a trailing `<!-- snooze:YYYY-MM-DD -->` HTML comment instead of a
`Wake` cell; `src/snooze.js` reads both forms, and a board rewrite must migrate every legacy comment to
the `Wake` column rather than dropping it (pinned by `src/boardWakeMigration.test.js`, issue #307).

## 2. The completed board — `planner-completed.md`

Rows identical in shape to the active board, but grouped under **weekly** headings rather than
section headings, e.g.:

```markdown
### Week of 2026-08-02

| 401 | ✅ | Draft house-sitter directions doc | - | 2026-08-02 |
```

`packages/telegram-bridge/src/completed.js` treats only rows whose first cell parses as a numeric task
id as data — the header row and the `|---|---|` separator are ignored by construction, not by an
explicit skip rule.

## 3. Task journals — `journal/task-<id>.md`

A bottom-appended **chat thread** in plain markdown, read by five independent consumers: the app
(`src/journalChat.js`), the Telegram bridge (`packages/telegram-bridge/src/journal.js`), the task-paper
generator, the overnight-agent skill (`oa-state.ps1`), and a human editing the file directly.

```markdown
# Task 352: Ship the thing

- First note
- TODO: Something to do
- DONE: Completed item

## 2026-08-27

<!-- OVERNIGHT-AGENT do not edit this line -->
## 🌙 Overnight Agent

<!-- from: overnight-agent -->
**Status:** in-progress · 2026-08-27
Did the work described in the plan.

**Needs from you:** approve the PR linked above.
<!-- /overnight-agent turn-end -->

<!-- from: me -->
approved, go ahead
```

Invariants a rebuild must hold:

- `# Task <id>: <title>` (or the first `#` heading) is the thread title; content before the first `##`
  heading or agent marker is "earlier notes," rendered as one undated bubble.
- `## YYYY-MM-DD` starts a new day group; consecutive same-day **user** ("me") notes merge into one
  bubble; content is otherwise ordered top-to-bottom, oldest first — new entries are always appended
  at the bottom.
- `<!-- from: agent-name -->` marks the following content as an agent message (rendered left, under a
  🤖 banner) until the next `<!-- from: ... -->` marker or `<!-- from: me -->`. `<!-- from: me -->`
  attributes text to the human — it is the **only** channel the consent/gate readers trust as a human
  affirmation (see [Prioritisation](Prioritisation)), and it must never be written by the agent's own
  software describing its own output, only by the bridge folding a real reply or by the human typing
  directly.
- `<!-- /overnight-agent turn-end -->` is a boundary stamp, not content — `oa-state.ps1 mark` writes it
  to record where the agent's own turn ends, so text appended below it can never be mis-absorbed into
  that turn, and a reply typed there is unambiguously the human's.
- `- [ ]` / `- [x]` are todo checkboxes; `TODO:`/`DONE:` line prefixes are an equivalent plain-text
  form both the UI and `oa-state.ps1` parse.
- Multi-line HTML comments (e.g. `<!-- doc-meta ... -->`, `<!-- tg-meta ... -->`) are machine metadata,
  hidden from the rendered chat.
- **Append-only by construction.** The only sanctioned writer (`write-turn.ps1`) never rewrites or
  deletes existing bytes — see [Reliability](Reliability) for why, and for the specific corruption
  classes (G1–G12) this format has been broken by and is now guarded against.

Full schema authority for this format lives in `AGENTS.md`, scaffolded into every connected data
folder by `src/config/agentsDoc.js` so an external agent can understand the folder without reading this
app's source. It is generated from `agentsDoc.js`, which mirrors `src/journalChat.js` — the two must
never drift, and the version marker in `AGENTS_DOC` is how a stale scaffolded copy is detected and
refreshed.

## 4. The agent gate — `agent-gate.md`

Two bullet lists under fixed headings, human-authored, read but never written by the agent:

```markdown
# Agent gate

## Do not gate these (reversible)

- Reading any file
- Committing to a branch that is not `main`

## Always ask (safety floor)

- Merging any pull request
- Deleting data
```

`src/config/agentGate.js`'s `parseAgentGate` matches headings by keyword (so a reworded heading still
resolves) and accepts `*`, `+` or `-` bullets. `serializeAgentGate` splices only the two lists' bullet
lines back in, preserving title, preamble, comments and any extra section verbatim — this file is
never regenerated wholesale, unlike `AGENTS.md`. See [Domain-config](Domain-config) and
[Prioritisation](Prioritisation) for why the write-side of "the agent never writes this file" is
currently enforced only by convention (issue #326).

## 5. Agent settings — `user-settings.md`

A markdown file with `##` sections, each containing a `| Setting | Value |` table, plus free-form
`## Preferences` bullets and a `## Browser slots` table. Both the app's settings UI
(`src/config/userSettingsForm.js`) and the overnight-agent plugin (`oa-state.ps1`) read the same file;
see the full sample and resolution order in [Prioritisation](Prioritisation) and
[Reliability](Reliability). The load-bearing invariant, proven by an identity test
(`src/config/userSettingsForm.test.js`): re-serializing the file with every row's own unchanged value
must return the original bytes exactly — CRLF, odd spacing and all — because this file is hand-edited
and any structural rewrite would be silent data loss to the user.

## 6. Per-task settings sidecar — `task-settings.json`

Machine-owned, planner-adjacent JSON, keyed by stable task id:

```json
{
  "version": 1,
  "tasks": {
    "352": { "aiAssisted": true, "persistentSession": false }
  }
}
```

A task with no entry is treated as both opt-ins being off — pre-existing tasks are unaffected until a
user explicitly opts in — and each entry is an open object so a future per-task toggle needs no format
migration (`src/storage/taskSettings.js`).

## 7. Mission-statement sidecar — `settings.json`

The precedent `task-settings.json` mirrors: `src/storage/settings.js` reads/writes `{ "version": 1,
"missionStatement": "" }`, normalizing a missing or malformed file back to that shape rather than
throwing, since this file is optional and its absence must never block loading the board.

## 8. Folder-sync record/frame model (planner-agnostic)

`packages/folder-sync/src/codecs/mdTable.js` turns any `##`-sectioned markdown-table file into
id-keyed **records** (`{ section, raw }`, keyed by the numeric/leading token of column 0) plus a
**frame**: the original file text with each data row replaced by a `\u0000ROW:<id>\u0000` marker, so
non-row content (headings, prose, the `## Priorities` list) survives untouched and a row added on
another device can be reinserted under the right heading.

## 9. Folder-sync sidecar — `<file>.sync.json`

One JSON sidecar per synced markdown file, carrying per-record logical clocks and tombstones — the
mechanism that makes "deleted rows reappear" impossible:

```json
{
  "version": 1,
  "updatedAt": 1787621820553,
  "entries": {
    "434": { "clock": 1787621820553, "deleted": true,  "fp": -1454295489 },
    "462": { "clock": 1787000000000, "deleted": false, "fp":  1234567890 }
  }
}
```

`clock` is a logical mtime (`Date.now()` at the write/delete). `deleted: true` is a tombstone: a
stale replica's full-file copy can never resurrect that row, because the tombstone's clock is compared,
not the row's presence or absence. `fp` is a content fingerprint used to detect a no-op sync
(`packages/folder-sync/src/merge.js`). The `telegram-bridge` domain's `deleted.js` reads exactly this
file to decide which forum topics to archive — see [Domain-telegram-bridge](Domain-telegram-bridge).

## 10. MCP secrets pointer — `mcp-secrets.json`

Documented in full in [Domain-mcp-cred-vault](Domain-mcp-cred-vault): a non-secret manifest of which
credential-vault target feeds which environment variable for which MCP server command. Never contains
a secret value.

## 11. Rendered task paper — `journal/paper/task-<id>.html`

A deterministic, self-contained HTML document (no external CSS/JS/fonts/network) generated from a
journal by the `task-paper` domain: title from the journal's H1, a status badge, the open ask above the
fold, and the current turn's sections rendered as collapsible `<details>` (first two open, rest
collapsed) with a stable per-section anchor. It carries no generation timestamp — "last updated" is
derived from the journal's own newest `## YYYY-MM-DD` heading, so an unchanged journal regenerates
byte-identical output. See [Domain-task-paper](Domain-task-paper).
