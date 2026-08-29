# Domain: config

## Responsibility

Centralises everything that names the app, defines its scaffolded documents, and defines
the structured (round-trip-safe) view of the two external configuration files
(`user-settings.md`, the Overnight Agent's settings; `AGENTS.md`, the folder's
self-description). Nothing in this domain performs I/O itself — callers in
[Domain-storage](Domain-storage) and [Domain-app](Domain-app) supply `read`/`write`.

## Principal modules

| Module | Role |
| --- | --- |
| `src/config/agentsDoc.js` | The canonical `AGENTS.md` text (versioned) and `scaffoldAgentsDoc(read, write)`, which writes it into a folder the first time and refreshes it when the version marker is stale. |
| `src/config/userSettingsForm.js` | Parses `user-settings.md`'s `| Setting | Value |` tables into an ordered, editable row list, and serializes edits back with a byte-for-byte round-trip guarantee for anything not explicitly changed. |
| `src/config/aiSettings.js` | The `user-settings.md` filename constant and its starter template (seeded when no settings file exists yet). |
| `src/config/branding.js` | The single source for user-visible app name/description and the two board filenames (`planner.md`, `planner-completed.md`), so a rename is a one-file change; internal storage-key prefixes deliberately keep their historical names independent of this. |

## Public exports

- `agentsDoc.js`: `AGENTS_DOC`, `AGENTS_DOC_VERSION`, `AGENTS_FILE`, `scaffoldAgentsDoc`.
- `userSettingsForm.js`: `parseSettingsForm`, `serializeSettingsForm`,
  `groupSettingsForm`, `hasSettingsForm`.
- `aiSettings.js`: `AI_SETTINGS_FILE`, `AI_SETTINGS_TEMPLATE`.
- `branding.js`: `APP_NAME`, `APP_DESCRIPTION`, `PLAN_FILE`, `COMPLETED_FILE`,
  `CLOUD_FOLDER_NAME`.

## Behavioural requirements (from tests)

- **`AGENTS_DOC` content** must embed the current version marker and must document the
  core journal markers, so the scaffolded copy is a complete, self-sufficient contract —
  not a pointer back into this app's source (`src/config/agentsDoc.test.js`).
- **`scaffoldAgentsDoc`** must write `AGENTS.md` when the file is missing, must also write
  it when the provider *throws* on a missing-file read (some providers signal absence via
  exception rather than an empty string), must not touch an already-up-to-date doc (no
  needless churn/diff noise), must refresh a doc whose embedded version is older than the
  current one, and must never throw even if the write itself fails — scaffolding must
  never block ordinary folder setup.
- **`aiSettings`** must write to `user-settings.md` (the exact filename the Overnight
  Agent resolves), and its seed template must both carry every section the agent's parser
  expects and still contain unfilled `<...>` placeholders — the template is deliberately
  not usable as-is, so it can never be accidentally treated as a real, secret-bearing
  config on first run.
- **`parseSettingsForm`** must surface every `Setting|Value` data row across *all* tables
  in the file, in document order, capturing which section each row belongs to; it must
  trim each value cell and must never surface a header or separator row as data; it must
  ignore prose, blockquotes, and `## Preferences` bullets — only genuine `Setting|Value`
  tables are structured; and it must return `[]` for non-string or empty input rather than
  throwing.
- **`serializeSettingsForm`** round-trip identity: re-writing every row with its own
  unchanged value must return the file byte-for-byte identical, passing no updates at all
  must return the file unchanged, CRLF line endings must be preserved exactly, and
  unrelated rows' unusual value-cell padding must survive untouched.
- **`serializeSettingsForm`** surgical edits: changing one row's value must touch *only*
  that cell's bytes, editing a row in a second table must not touch the first table at
  all, a newline embedded in a new value must be collapsed so it cannot break the table
  structure, and a value that itself contains an escaped pipe (`\|`) must round-trip
  correctly (the row scanner must not mistake it for a cell delimiter).
- **`groupSettingsForm`** must group rows by section while preserving both document order
  and a flat index into the original row list (so the UI can write back to the right
  offset). **`hasSettingsForm`** must be true exactly when structured rows exist.

## Failure modes

- If `AGENTS_DOC_VERSION` is bumped without keeping `AGENTS_DOC`'s prose in sync with the
  actual renderer (`src/journalChat.js`), scaffolded copies will describe a contract the
  app no longer implements — this file's own doc comment calls out that the two must be
  kept in sync by convention, since nothing currently enforces it automatically.
- A settings-form serializer that regenerated the file from parsed data (instead of
  splicing only the changed cell) would silently destroy the Overnight Agent's real paths,
  accounts, and email allow-lists on the first UI-driven save — this is why the round-trip
  identity guarantee is treated as a hard invariant with dedicated tests rather than an
  implementation detail.
