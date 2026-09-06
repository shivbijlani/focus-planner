# Domain: config

`config` defines and safely edits the small set of sidecar files that the overnight agent and the
web app both depend on: `AGENTS.md`, `agent-gate.md`, `user-settings.md`, and the branding constants
that name the app's own primary files.

## Responsibility

Own the canonical **content** and **safe-edit** rules for files that are read by a process outside
this repository's control (the overnight agent, or any external agent pointed at the folder), so
that the web app can create and update them without ever corrupting a file the agent depends on for
its next run, and — for `agent-gate.md` specifically — without ever overwriting what a human wrote.

## Principal modules

| Path | Purpose |
| --- | --- |
| `src/config/agentGate.js` | The agent gate (issue #288): "Do not gate these (reversible)" / "Always ask (safety floor)" lists. Scaffolds only when absent/blank; never refreshes an existing file. |
| `src/config/agentsDoc.js` | The canonical `AGENTS.md` scaffolded into every connected folder; version-stamped so a stale copy scaffolded by an older build is refreshed. |
| `src/config/aiSettings.js` | `user-settings.md`'s file identity/template — the file the overnight agent's `SKILL.md` resolution chain reads at the start of every run. |
| `src/config/userSettingsForm.js` | A round-trip-safe structured view of `user-settings.md` for the Settings UI: replaces only the value cell of a changed row, never regenerates the file. |
| `src/config/agentSettingsVisibility.js` | Classifies each `user-settings.md` row as `user` (a knob a person should see by default) or `advanced` (infrastructure, hidden behind a disclosure); unknown labels default to `advanced`. |
| `src/config/branding.js` | Centralized app name/description and primary filenames, so a rename is a one-file change. Internal storage keys intentionally keep their historical prefix so existing user data loads without a migration. |

## Public exports

`AGENT_GATE_DOC`, `AGENT_GATE_FILE`, `AGENT_GATE_VERSION`, `ALWAYS_ASK_HEADING`,
`DEFAULT_ALWAYS_ASK`, `DEFAULT_REVERSIBLE`, `REVERSIBLE_HEADING`, `addGateLine`, `parseAgentGate`,
`removeGateLine`, `scaffoldAgentGate`, `serializeAgentGate`; `AGENTS_DOC`, `AGENTS_DOC_VERSION`,
`AGENTS_FILE`, `scaffoldAgentsDoc`; `AI_SETTINGS_FILE`, `AI_SETTINGS_TEMPLATE`; `groupSettingsForm`,
`hasSettingsForm`, `parseSettingsForm`, `serializeSettingsForm`; `classifyAgentSetting`,
`isUserFacingSetting`, `partitionAgentSettings`; `APP_DESCRIPTION`, `APP_NAME`, `CLOUD_FOLDER_NAME`,
`COMPLETED_FILE`, `PLAN_FILE`.

## Behavioural requirements (from the config test suite, 5 files / 71 tests)

- **`agent-gate.md` is never regenerated over an existing file** — `scaffoldAgentGate` writes only
  when the file is missing, blank, or the provider throws "not found"; an existing gate — even a
  whitespace-only one is the *only* thing scaffolded over — is left completely alone. This is
  asserted as its own test: "NEVER overwrites an existing gate — the user owns this file."
- **`serializeAgentGate` is a surgical splice, not a rewrite.** It round-trips the canonical doc and
  arbitrary markdown-special characters unchanged, normalizes CRLF to LF, preserves the user's title,
  comments and preamble, preserves prose written *inside* a managed section, preserves unrelated
  sections and trailing prose, never duplicates a section that already exists, and is **stable
  across repeated saves** — no drift, no blank-line growth on the second or third save of the same
  content.
- **`AGENTS.md` refreshes only when stale.** `scaffoldAgentsDoc` writes when missing, does **not**
  churn an up-to-date file (no-op if the version marker matches), and refreshes an older-version
  doc — the version line is the single signal deciding rewrite-or-leave-alone.
- **Settings-form editing is a single-cell surgical write.** `userSettingsForm`'s guarantee (asserted
  directly in its own tests): `serializeSettingsForm(md, parseSettingsForm(md).map(r => r.value))`
  returns `md` byte-identical for any input including CRLF and odd spacing, and changing one field's
  value changes only that one cell — intro prose, the `## Preferences` list, comments, blank lines,
  spacing, and unknown sections are untouched.
- **Setting visibility classification never leaks unknowns into the simple view.** A label not
  explicitly recognized as user-facing defaults to `advanced`, is case-insensitive and
  whitespace-trimmed, and the partition is lossless — every input row appears in exactly one output
  partition.

## Failure modes guarded against

Every guarantee above targets one failure shape: an automated rewrite silently destroying
human-authored trust. `agent-gate.md`'s entire value is that a user, not the agent, wrote it — the
same code path (whole-file regeneration) that safely refreshes `AGENTS.md` would, applied here,
destroy the property that makes the gate trustworthy at all. That is why `agent-gate.md` gets a
splice-and-preserve writer instead of `AGENTS.md`'s version-stamped regenerate-when-stale writer,
and why `user-settings.md` — a file the agent reads fresh every run — gets the strictest of the
three: a single-cell change with a proven identity round-trip.
