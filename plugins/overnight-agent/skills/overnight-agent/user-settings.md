# Overnight Agent — user settings

This file is the **source of truth** for the Overnight Agent skill's user-configurable values:
paths, accounts, allow-lists, and preferences. The skill (`SKILL.md`) reads this file at the start of
every run and uses these values everywhere. If the user asks to change any of these (e.g. "use a
different drive", "stop opening draft PRs", "add someone to the email allow-list", "email me a nightly
summary"), update **this file** in place — not `SKILL.md`.

> ⚠️ **This is a shareable TEMPLATE.** It ships with placeholder values so the plugin stays public-safe.
> Personal data (real email addresses, local paths, allow-lists) lives here on purpose, so `SKILL.md`
> stays shareable. **After installing the plugin, replace every `<...>` placeholder with your own
> values.** Do not commit your filled-in copy back to a public repository — keep personal data local
> (see "Making your settings persist" at the bottom).

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

## Making your settings persist

Because plugins are installed into a cache, edits you make to this file inside the installed plugin can
be overwritten when the plugin updates. To keep a durable personal copy, either:

1. **Keep this skill outside the plugin** (e.g. a personal `~/.copilot/skills/overnight-agent/` copy with
   your real `user-settings.md`), and use the plugin only as the canonical, shareable source; or
2. **Point the agent at an external settings file** by editing the "User settings" reference near the top
   of `SKILL.md` to read from a stable path you control (e.g. `%LOCALAPPDATA%\overnight-agent\user-settings.md`).

Either way, keep your filled-in settings out of any public repository.
