# Domain: config

## Responsibility

Defines the small set of planner-owned markdown/text files that live in the user's data folder next
to `planner.md`, and the round-trip-safe parsers/serializers the web app uses to edit them without
corrupting hand-written content. Every file here is designed to be read by both this app and the
overnight-agent plugin (a separate, PowerShell-based consumer) — so the parsers must be forgiving and
the serializers must be surgical.

## Principal modules

| Path | Exports | Purpose |
| --- | --- | --- |
| `src/config/branding.js` | `APP_NAME`, `APP_DESCRIPTION`, `CLOUD_FOLDER_NAME`, `PLAN_FILE`, `COMPLETED_FILE` | Single source for user-visible names and the canonical plan/completed filenames. |
| `src/config/agentsDoc.js` | `AGENTS_DOC`, `AGENTS_DOC_VERSION`, `AGENTS_FILE`, `scaffoldAgentsDoc` | The canonical `AGENTS.md` scaffolded into every connected data folder so any external agent understands the file conventions without reading this app's source. |
| `src/config/agentGate.js` | `AGENT_GATE_FILE`, `AGENT_GATE_VERSION`, `AGENT_GATE_DOC`, `DEFAULT_REVERSIBLE`, `DEFAULT_ALWAYS_ASK`, `REVERSIBLE_HEADING`, `ALWAYS_ASK_HEADING`, `parseAgentGate`, `serializeAgentGate`, `scaffoldAgentGate`, `addGateLine`, `removeGateLine` | The **agent gate** (`agent-gate.md`) — the one file that decides when the overnight agent may act on its own vs. must ask first. |
| `src/config/aiSettings.js` | `AI_SETTINGS_FILE`, `AI_SETTINGS_TEMPLATE` | The `user-settings.md` file resolved by both this app's settings UI and the overnight-agent plugin's `SKILL.md`. |
| `src/config/userSettingsForm.js` | `parseSettingsForm`, `serializeSettingsForm`, `groupSettingsForm`, `hasSettingsForm` | Structured, round-trip-safe view of `user-settings.md`'s `Setting | Value` tables, for the settings UI. |
| `src/config/agentSettingsVisibility.js` | `classifyAgentSetting`, `isUserFacingSetting`, `partitionAgentSettings` | Splits parsed settings rows into `user` (shown by default) vs. `advanced` (behind a disclosure). |

## The agent gate — why it is different from every other file the app writes

`agent-gate.md` holds two bullet lists: *"Do not gate these (reversible)"* and *"Always ask (safety
floor)"*. It is **human-authored by construction**: the app only ever reads standing permission from
it, so a permission recorded there needs no `<!-- from: me -->` attribution marker the way journal
prose does. Two consequences follow directly from that design choice, both deliberate:

1. `scaffoldAgentGate` seeds the file **only when it is absent or blank** — it never refreshes an
   existing file the way `scaffoldAgentsDoc` version-bumps `AGENTS.md`, because rewriting a file whose
   entire value is "the user wrote this" would destroy the property that makes it trustworthy.
2. `serializeAgentGate` splices **only** the bullet lines of the two known sections and preserves
   everything else verbatim: title, preamble, comments, and any extra section the user added. This is
   a plain whole-file write, not a byte-offset cell edit — issue #288 (the gate's origin) explicitly
   rules out `userSettingsForm.js`'s cell-splicing approach here, because the gate's two lists are the
   entire content that matters, not one cell among many.

The alternative rejected here was treating the gate like `user-settings.md` (round-trip cell edits):
that would make the file editable by software in the same way its permissions are meant not to be —
see [Prioritisation](Prioritisation) for how `oa-state.ps1` enforces the read-only-by-the-agent half
of this contract, and issue #326, which tracks that the write-side is currently unguarded.

## `user-settings.md` — one file, two writers

`aiSettings.js` and `userSettingsForm.js` exist because **two different programs** edit the same file:
this web app (through a structured settings form) and the overnight-agent plugin (by reading it
directly at the start of every run, per its own `SKILL.md`). `userSettingsForm.js`'s guarantee, backed
by `userSettingsForm.test.js`, is that `serializeSettingsForm(md, parseSettingsForm(md).map(r =>
r.value))` returns `md` **unchanged** for any input (including CRLF and odd spacing) — i.e. editing one
field's value in the UI changes only that field's table cell, and prose, comments, and unknown rows are
never touched. `agentSettingsVisibility.js` layers a UX partition on top: most rows are paths, account
IDs and allow-lists a user should almost never touch, so they classify as `advanced` and stay behind a
disclosure; an unrecognized label defaults to `advanced` rather than leaking into the simple view.

## Behavioural requirements (selected, from the test suites)

- `parseAgentGate` accepts `*`, `+` and `-` bullets, matches reworded headings by keyword, and returns
  empty lists for missing/blank/garbage input rather than throwing.
- `serializeAgentGate` round-trips the canonical doc unchanged, normalises CRLF to LF, appends a
  missing section, and preserves user title/comments/preamble and prose inside a managed section.
- `scaffoldAgentsDoc` writes `AGENTS.md` when missing (including when the provider throws on a missing
  file), does not overwrite an up-to-date doc, refreshes an older-version doc, and never throws when
  the write itself fails.
- `parseSettingsForm` surfaces every `Setting | Value` row across all tables in order, captures each
  row's section, and ignores prose/blockquotes/`## Preferences` bullets — only tables are structured.
- `serializeSettingsForm` changes only the edited cell (even in a second table), collapses newlines in
  a new value so it cannot break the table, and round-trips a value containing an escaped pipe.
- `classifyAgentSetting` is case-insensitive/whitespace-trimmed and defaults unknown labels to
  `advanced`; `partitionAgentSettings` loses no rows (the union of its two partitions equals the input).

## Failure modes

- A gate parser that fails open (defaults to "allow" on malformed input) would let a corrupted file
  license unattended irreversible actions; `parseAgentGate` instead defaults to empty lists, which the
  agent-side reader treats as "nothing standing" rather than "everything standing."
- A settings serializer that rewrites the whole file on save would silently drop any row, comment, or
  section the parser does not recognize — exactly the corruption `userSettingsForm.test.js`'s identity
  test exists to catch.
