# Overnight Agent — user settings

This file lists the Overnight Agent skill's user-configurable values: paths, accounts, allow-lists, and
preferences.

> ⚠️ **This is a shareable TEMPLATE that ships inside the plugin — every plugin update overwrites it.**
> Do **not** put your real values here. Your real settings live in an **external** `user-settings.md`
> that the skill resolves at the start of every run and auto-creates on first run (see "Where your real
> settings live" at the bottom). Edit that external copy — not this one — and keep personal data out of
> any public repository.

## Settings

| Setting | Value |
| --- | --- |
| User | `<your name>` (`<your-github-username>` on GitHub) |
| Timezone | `<IANA timezone, e.g. America/Los_Angeles>` |
| Planner board | `<path to>\planner.md` |
| Completed board | `<path to>\planner-completed.md` |
| Journals folder | `<path to>\journal\` |
| Agent state store | `%LOCALAPPDATA%\overnight-agent\state\` (per-task JSON; **local, not cloud-synced**). Skill-owned memory — the user never edits it. Managed via `oa-state.ps1`. |
| Dev drive (repos) | `<path to your repos, e.g. V:\repos\>` (worktrees in `<...>.worktrees\`, packages in `<...>\packages\`) |
| GitHub owner | `github.com/<your-github-username>` |
| Agent email account | `<agent-inbox@example.com>` (the name of this account as it appears in the email MCP) |
| Authorized sender addresses | `<addr1@example.com>`, `<addr2@example.com>` (only act on instruction emails **from** these) |
| Auto-send (email) allow-list | `<addr1@example.com>`, `<addr2@example.com>` — you may **send/reply** email to these without extra approval. Emailing anyone **not** on this list still needs explicit approval. |

## Preferences

- **Inbox check:** `on` — check the agent email inbox at the start of every run (PHASE 0). Set to `off`
  if you don't want the agent to read an inbox for instructions.
- **Code tasks open a draft PR:** `on` — prefer **draft** PRs for the reviewable deliverable.
- **Default planning scope:** every task in `## Today` (expand to `## Deferred` as capacity allows).
- **Email replies / sends:** `allowed` to anyone on the **Auto-send allow-list** above — keep replies
  short. Emailing anyone **not** on that list still needs explicit approval.
- **Email format:** `html` — send all emails (new sends, replies, forwards) as HTML with a plain-text
  fallback. Set to `plain` for plain-text only.
- **Browser automation:** use a **Playwright MCP browser slot** — never the agent's built-in browser.
- **Secrets:** never stored in this repo. Email credentials live in the email MCP's own store.

## Where your real settings live

This bundled file is a **template inside the installed plugin, so plugin updates overwrite it.** Your real,
filled-in settings must live **outside** the plugin. At the start of every run the skill looks for them, in
order, and uses the first that exists:

1. `$OVERNIGHT_AGENT_SETTINGS` — an explicit path you set (override); else
2. `<project folder>\user-settings.md` — the folder the agent runs in; else
3. **`%OneDrive%\Apps\Focus Planner\user-settings.md`** — the recommended home: cloud-synced, survives
   plugin updates, sits next to `planner.md`, and can be edited by the planner web app; else
4. `%LOCALAPPDATA%\overnight-agent\user-settings.md`.

On **first run**, if no external copy exists, the skill seeds location #3 from this template and asks you to
fill it in. From then on, edit that **external** copy — not this one. Keep your filled-in settings out of
any public repository.
