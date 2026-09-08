# Domain: config

The `config` domain owns the planner’s agent-facing sidecar files and the rules for editing them safely. These files live next to `planner.md` in whichever storage source is active, so they are part of the synced data model rather than bundled application assets. The domain matters because the overnight agent and any external agent pointed at the planner folder read the same files directly. The app therefore treats them as contracts, not casual templates. See [Architecture](Architecture), [Data-Formats](Data-Formats), and [Domain-app](Domain-app).

## Responsibility

The central distinction is between **machine-managed reference docs** and **human-authored authority files**. `src/config/agentsDoc.js` manages `AGENTS.md`, a versioned, refreshable explanation of the planner folder schema. `src/config/agentGate.js` manages `agent-gate.md`, but only enough to seed it once and splice list bullets back into place, because its trust model depends on the user owning the file. `src/config/userSettingsForm.js` exposes a structured form over `user-settings.md`, yet preserves the original bytes around edited value cells so the app never damages prose, comments, spacing, or unknown sections that the overnight agent may still rely on. `src/config/agentSettingsVisibility.js` reduces risk in the form UI by defaulting unknown settings to “advanced” rather than surfacing them casually.

## Principal modules

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Path | Role | Why it exists |
| --- | --- | --- |
| `src/config/agentGate.js` | Defines, parses, serializes, and scaffolds `agent-gate.md`. | Keeps standing permissions in a file the agent only reads, never rewrites. |
| `src/config/agentsDoc.js` | Canonical `AGENTS.md` scaffold. | Makes every synced folder self-documenting for outside agents. |
| `src/config/aiSettings.js` | File identity and starter template for `user-settings.md`. | Ensures the web app writes the same file the overnight agent resolves on startup. |
| `src/config/userSettingsForm.js` | Structured parse/save for settings tables. | Guarantees round-trip-safe, single-cell edits. |
| `src/config/agentSettingsVisibility.js` | User-facing vs advanced partition. | Prevents risky infrastructure settings from dominating the default UI. |
| `src/config/branding.js` | App and filename constants. | Separates user-visible naming from internal storage-key history. |

</details>

## Public exports

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Path | Exports from `spec-facts.json` |
| --- | --- |
| `src/config/agentGate.js` | `AGENT_GATE_DOC`, `AGENT_GATE_FILE`, `AGENT_GATE_VERSION`, `ALWAYS_ASK_HEADING`, `DEFAULT_ALWAYS_ASK`, `DEFAULT_REVERSIBLE`, `REVERSIBLE_HEADING`, `addGateLine`, `parseAgentGate`, `removeGateLine`, `scaffoldAgentGate`, `serializeAgentGate` |
| `src/config/agentsDoc.js` | `AGENTS_DOC`, `AGENTS_DOC_VERSION`, `AGENTS_FILE`, `scaffoldAgentsDoc` |
| `src/config/aiSettings.js` | `AI_SETTINGS_FILE`, `AI_SETTINGS_TEMPLATE` |
| `src/config/userSettingsForm.js` | `groupSettingsForm`, `hasSettingsForm`, `parseSettingsForm`, `serializeSettingsForm` |
| `src/config/agentSettingsVisibility.js` | `classifyAgentSetting`, `isUserFacingSetting`, `partitionAgentSettings` |
| `src/config/branding.js` | `APP_DESCRIPTION`, `APP_NAME`, `CLOUD_FOLDER_NAME`, `COMPLETED_FILE`, `PLAN_FILE` |

</details>

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```markdown
## Do not gate these (reversible)

- focus-planner-ado-codeapp is in YOLO mode, dont ask just do, Im the only user
- Emailing myself

## Always ask (safety floor)

- Send-to-many (group/channel, manager, mass email)
- Starting a fresh conversation with someone in chat/email
```


</details>
That excerpt is copied from `src/config/agentGate.js`’s `AGENT_GATE_DOC`. Its rationale is explicit in the file header: approval cannot rest on machine-written `<!-- from: me -->` markers, so standing permission must live in a user-owned file that the app does not regenerate.

## Behavioural requirements from tests

The contract is spelled out by `src/config/agentGate.test.js`, `src/config/agentsDoc.test.js`, `src/config/userSettingsForm.test.js`, `src/config/aiSettings.test.js`, and `src/config/agentSettingsVisibility.test.js`.

- `agent-gate.md` is **seed-once, preserve-forever**. Tests require `scaffoldAgentGate()` to write the file when missing, blank, or reported missing by a throwing provider, and to **never overwrite an existing gate**.
- `serializeAgentGate()` is a **section-body splice**, not regeneration. Tests require preservation of titles, comments, preamble prose, notes inside managed sections, unrelated sections, trailing prose, and repeated-save stability with no drift or blank-line growth.
- `AGENTS.md` is **version-refreshable but not churny**. `src/config/agentsDoc.test.js` requires writes when missing, no rewrite when already current, refresh when stale, and no throw on write failure.
- Settings form edits are **byte-stable outside the changed cell**. `src/config/userSettingsForm.test.js` requires identity round-trips for LF and CRLF inputs, preservation of odd padding, escaped pipes inside values, and exact isolation of edits to the addressed value cell.
- `user-settings.md` must remain the **agent’s real file**, not a UI-only surrogate. `src/config/aiSettings.test.js` requires the filename `user-settings.md`, the presence of the sections the agent parses, and placeholders that are still visibly unfilled.
- Visibility partitioning is **conservative by default**. `src/config/agentSettingsVisibility.test.js` requires only a small label set (`User`, `Timezone`, `Enabled`, `Tasks`) to be user-facing; unknown rows, paths, IDs, accounts, and allow-lists remain advanced.

## Failure modes

The principal failure mode is silent loss of human intent. If `agent-gate.md` were regenerated the way `AGENTS.md` is, the app would destroy the very evidence that a human wrote the standing instruction. If `serializeSettingsForm()` rewrote whole files, it could erase real paths, email allow-lists, or prose preferences the overnight agent reads on every run. If visibility classification leaked unknown rows into the simple form, the UI would invite casual edits to infrastructure settings. This domain therefore prefers preservation, loose parsing, and conservative default hiding over convenience.
