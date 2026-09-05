# Domain: config

## Responsibility

Every canonical, scaffolded document the app writes into a data folder so the folder is
self-documenting to any external reader — human or agent — and every structured, round-trip-safe view
the UI needs onto a config file it must never corrupt. This is the domain boundary between "the app's
own settings" and "files the overnight agent and other tools also depend on."

## Principal modules

| Module | Role |
| --- | --- |
| `src/config/branding.js` | Single source for user-visible app/file names (`APP_NAME`, `PLAN_FILE`, `COMPLETED_FILE`, `CLOUD_FOLDER_NAME`); internal storage-key prefixes (`fp-file:`, `fp-sources`) deliberately do **not** follow a rename, so existing user data keeps loading without a storage migration. |
| `src/config/agentsDoc.js` | The canonical `AGENTS.md` scaffolded into every connected folder — the folder's own documentation for any agent pointed at it, versioned so a stale copy is refreshed. |
| `src/config/agentGate.js` | The agent-gate file (see [Data-Formats](Data-Formats)): human-authored by construction, seeded only when absent/blank, saved by splicing only its two managed bullet lists and preserving everything else verbatim. |
| `src/config/aiSettings.js` | `AI_SETTINGS_FILE`/`AI_SETTINGS_TEMPLATE` for `user-settings.md`, the file the overnight-agent plugin resolves at the start of every run. |
| `src/config/userSettingsForm.js` | Round-trip-safe structured view of `user-settings.md`: parses it into ordered editable table rows and, on save, replaces only the value cell of a changed row — never regenerates the file. |
| `src/config/agentSettingsVisibility.js` | Classifies each parsed settings row as `user` (shown by default) or `advanced` (behind a disclosure) by label, defaulting anything unrecognized to advanced. |

## Public surface (representative exports)

`APP_NAME, APP_DESCRIPTION, PLAN_FILE, COMPLETED_FILE, CLOUD_FOLDER_NAME` (`branding.js`);
`AGENTS_DOC, AGENTS_DOC_VERSION, AGENTS_FILE, scaffoldAgentsDoc` (`agentsDoc.js`); `AGENT_GATE_DOC,
AGENT_GATE_FILE, AGENT_GATE_VERSION, DEFAULT_REVERSIBLE, DEFAULT_ALWAYS_ASK, parseAgentGate,
serializeAgentGate, scaffoldAgentGate, addGateLine, removeGateLine` (`agentGate.js`);
`AI_SETTINGS_FILE, AI_SETTINGS_TEMPLATE` (`aiSettings.js`); `parseSettingsForm, serializeSettingsForm,
hasSettingsForm, groupSettingsForm` (`userSettingsForm.js`); `classifyAgentSetting,
isUserFacingSetting, partitionAgentSettings` (`agentSettingsVisibility.js`).

## Behavioural requirements (from tests)

- **`scaffoldAgentGate` never overwrites an existing gate file** — the user owns it; it writes only
  when the file is missing, blank, or the provider throws on a missing read, and never throws itself
  when the write fails.
- **`serializeAgentGate` is a surgical splice, not a regeneration**: it round-trips the canonical doc
  and CRLF input unchanged, preserves the user's title/preamble/comments and any section the app didn't
  write, is stable across repeated saves (no blank-line drift), and still applies the requested edit.
- **`parseAgentGate` tolerates real-world variation**: `*`/`+`/`-` bullets, prose between them, CRLF,
  reworded headings matched by keyword, and a file with only one of the two sections.
- **`scaffoldAgentsDoc` refreshes an out-of-date doc but never churns an up-to-date one** — version
  comparison, not content diffing, decides whether to rewrite.
- **`userSettingsForm`'s round trip is exact**: `serializeSettingsForm(md, parseSettingsForm(md).map(r
  => r.value))` returns `md` unchanged for any input including CRLF and odd spacing; changing one
  field's value changes only that field's cell.
- **`partitionAgentSettings` loses no rows** — the union of its user/advanced partitions always equals
  the input rows — and keeps section headers attached to their rows.
- **Settings classification defaults to advanced**: an unrecognized label never leaks into the simple,
  user-facing view; classification is case-insensitive and whitespace-trimmed.

## Failure modes this domain guards against

- **The agent mistaking its own prose for user consent** (issue #250) — because the agent gate is only
  ever read, never written, by the agent, a standing permission recorded there needs no attribution
  marker; on 2026-08-31 the absence of exactly this separation cost a real, explicitly-granted
  permission, which is why `scaffoldAgentGate`'s never-overwrite rule is load-bearing rather than
  cautious.
- **Silent config corruption via full-file regeneration** — `userSettingsForm.js`'s byte-offset cell
  splicing exists because issue #288 explicitly ruled out whole-file regeneration for a file real
  paths, accounts and allow-lists live in; the same reasoning is why `agentGate.js`'s save path splices
  bullets rather than re-templating.
- **An unknown settings row silently becoming user-editable** — `agentSettingsVisibility.js`'s
  conservative default (unknown ⇒ advanced) exists specifically so a new or future settings row never
  appears in the simple view before someone has decided it belongs there.
- **A rename breaking existing user data** — `branding.js` isolates user-facing names from the
  internal storage-key prefixes precisely so a future rebrand is a one-file change that does not also
  require a storage migration.
