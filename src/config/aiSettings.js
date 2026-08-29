/**
 * AI agent settings — the `user-settings.md` file that lives in the active
 * storage source (e.g. your OneDrive `Apps/Planner` folder) alongside
 * `planner.md`.
 *
 * The overnight-agent Copilot CLI plugin resolves this same file at the start
 * of every run (see the plugin's SKILL.md resolution chain). Because the web
 * app writes it into the synced planner folder, the agent reads exactly what
 * you save here — no more per-update resets, and no need to hand-edit files.
 */

// Stored in the active source root, next to planner.md. This is the canonical
// external home the agent looks for (`%OneDrive%\Apps\Focus Planner\user-settings.md`).
export const AI_SETTINGS_FILE = 'user-settings.md'

// Starter template seeded when no settings file exists yet. Mirrors the shape
// the overnight-agent skill parses (Settings + Preferences). Fill in the
// `<...>` placeholders. Keep this out of any public repo — it holds real paths
// and email addresses.
export const AI_SETTINGS_TEMPLATE = `# Overnight Agent — user settings

Real, filled-in settings for the overnight agent. This file lives in your synced
planner folder (next to \`planner.md\`) and is read by the agent at the start of
every run. Edit it here in the app or directly on disk — both point at the same
file.

## Settings

| Setting | Value |
| --- | --- |
| User | \`<your name>\` (\`<your-github-username>\` on GitHub) |
| Timezone | \`<IANA timezone, e.g. America/Los_Angeles>\` |
| Planner board | \`<path to>\\planner.md\` |
| Completed board | \`<path to>\\planner-completed.md\` |
| Journals folder | \`<path to>\\journal\\\` |
| Dev drive (repos) | \`<path to your repos, e.g. V:\\repos\\>\` |
| GitHub owner | \`github.com/<your-github-username>\` |
| Agent email account | \`<agent-inbox@example.com>\` (as it appears in the email MCP) |
| Authorized sender addresses | \`<addr1@example.com>\`, \`<addr2@example.com>\` (only act on instruction emails **from** these) |
| Auto-send (email) allow-list | \`<addr1@example.com>\` — may **send/reply** without extra approval |

## Preferences

- **Inbox check:** \`on\` — check the agent email inbox at the start of every run.
- **Code tasks open a draft PR:** \`on\` — prefer **draft** PRs for the deliverable.
- **Default planning scope:** every task in \`## Today\`.
- **Email format:** \`html\` — send emails as HTML with a plain-text fallback.
- **Browser automation:** use a **Playwright MCP browser slot**.
- **Secrets:** never stored here. Email credentials live in the email MCP's store.
`
