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
| Google account (Tasks) | `<your.name@example.com>` — the Google account whose **Tasks** the PHASE 2 collect step reads (must be consented in the Google Workspace MCP). Leave blank / omit to disable Google-Tasks collection. |
| Authorized sender addresses | `<addr1@example.com>`, `<addr2@example.com>` (only act on instruction emails **from** these) |
| Auto-send (email) allow-list | `<addr1@example.com>`, `<addr2@example.com>` — you may **send/reply** email to these without extra approval. Emailing anyone **not** on this list still needs explicit approval. |

## Telegram (optional — mirror journals to a Telegram forum group)

Enable this to have each task journal mirrored into its own **Telegram forum topic** (1 task = 1 topic) at
the end of every run (SKILL.md → "PHASE 3 — Mirror to Telegram"). Leave `Enabled = off` to skip it entirely.

| Setting | Value |
| --- | --- |
| Enabled | `off` (set to `on` to turn on the mirror) |
| Chat id | `<forum supergroup id, e.g. -1004310604015>` (the group must have **Topics** enabled) |
| Bot token | Stored in the OS credential vault, **never here** — read at run time via `%LOCALAPPDATA%\overnight-agent\secrets\telegram-secret.ps1 get`. |
| Bridge CLI | `<dev drive>\focus-planner\packages\telegram-bridge\bin\telegram-bridge.js` (dependency-free Node CLI). |
| Tasks | *(optional)* comma-separated task IDs to mirror; empty = every task that has an agent block. |
| Archive completed topics | `on` (default once Telegram is added) — close a task's topic when it reaches the completed board, reopen it if the task leaves. Set to `off` to disable. |

## Overnight Agent behaviour

How the agent decides when it may stop working `## Today` and start on `## Deferred`. Both rows are
optional — delete them and the built-in defaults apply. `oa-state.ps1` reads this table directly, so
a value here takes effect on the next run with nothing else to change.

| Setting | Value |
| --- | --- |
| Today gate backstop | `6h` — if **nothing** has been written to a Today task for this long, the agent stops waiting on it and works the backlog. Guards against a run that jams. Accepts `6`, `6h`, or `off` to disable. |
| Today gate strict | `off` — set to `on` to make a workable Today task block the backlog **always**, with no release at all. The one-switch rollback if the agent starts leaving Today too readily. |

**Raising the backstop makes the agent wait longer before giving up on a stuck Today task; lowering
it makes it give up sooner.** Writing to the task *resets* the timer, so the agent can only ever
delay this release, never trigger it.

> The third tunable — how long an "I'm out of work here" declaration stays valid — is deliberately
> **not** exposed. It currently controls two different things at once, and raising it would let one
> run declare itself finished on the strength of a previous run's work. It stays in code until that
> is split apart (tracked as GitHub issue 330).

## Preferences

- **Inbox check:** `on` — check the agent email inbox at the start of every run (PHASE 0). Set to `off`
  if you don't want the agent to read an inbox for instructions. While it is `on`, an inbox the agent
  **could not read** is reported as an ask, never as an empty inbox: `check-agent-inbox.ps1` probes the
  capability first and says `NOT CHECKED` rather than "no new instructions" (GH #346).
- **Code tasks open a draft PR:** `on` — prefer **draft** PRs for the reviewable deliverable.
- **Default planning scope:** every task in `## Today` (expand to `## Deferred` as capacity allows).
- **Email replies / sends:** `allowed` to anyone on the **Auto-send allow-list** above — keep replies
  short. Emailing anyone **not** on that list still needs explicit approval.
- **Email format:** `html` — send all emails (new sends, replies, forwards) as HTML with a plain-text
  fallback. Set to `plain` for plain-text only.
- **Browser automation:** use a **Playwright MCP browser slot** — never the agent's built-in browser.
- **Secrets:** never stored in this repo. Email credentials live in the email MCP's own store.

## Browser slots

**This section is the source of truth for the agent's browsers — the scripts read THIS table, and no
slot list is hard-coded in any of them.** Add a row to add a browser; delete a row to remove one. No
script needs editing either way.

**One row = one slot = one identity.** A slot is a browser the agent drives on your behalf, running its
own dedicated profile directory on its own CDP debug port. Two slots that share a profile are the same
identity twice over and are pure cost (~6 processes and ~400 MB each at startup, plus ~24 duplicate tool
schemas each in the agent's context), so only add a slot when it represents an account the others
cannot stand in for.

| Slot | Port | Profile dir (`%LOCALAPPDATA%\playwright-mcp\`) | Account | Desktop shortcut |
| --- | --- | --- | --- | --- |
| `edge-cdp-1` (regular) | 9225 | `edge1` | `<your main account>` | MCP Edge 1 (CDP 9225) |

**The columns**

| Column | Required | What it means |
| --- | --- | --- |
| **Slot** | **yes** | The MCP server name, so it must match the key in `~\.copilot\mcp-config.json`. A trailing `(alias)` is optional and gives you a friendly second name to select by. |
| **Port** | **yes** | The CDP debug port. Must be unique across rows and otherwise unused on your machine. |
| **Profile dir** | **yes** | **This is the identity.** A bare name (`edge1`) is resolved under the base folder named in this column's own header; a full path (`D:\browsers\work`) or one with `%VARS%` is used as-is. Must be unique across rows. |
| **Account** | no | A label for you and for the agent to select by (e.g. `work`, `personal`). Purely descriptive. |
| **Desktop shortcut** | no | The shortcut name to tell you to open if an automatic launch fails. Defaults to the slot name. |

Only **Slot**, **Port** and **Profile dir** are required, and the column **order does not matter** —
columns are found by name. The profile base folder is taken from the Profile column's header, so
changing `%LOCALAPPDATA%\playwright-mcp\` there moves every bare-name slot at once. A slot whose name or
profile contains `chrome` launches Chrome; anything else launches Edge.

**Adding more identities** — one row each. For example, a three-identity setup:

```
| Slot | Port | Profile dir (`%LOCALAPPDATA%\playwright-mcp\`) | Account | Desktop shortcut |
| --- | --- | --- | --- | --- |
| `edge-cdp-1` (regular) | 9225 | `edge1`      | personal | MCP Edge 1 (CDP 9225) |
| `edge-cdp-work`        | 9228 | `edge-work`  | work     | MCP Edge work (CDP 9228) |
| `edge-cdp-client`      | 9229 | `edge-client`| client   | MCP Edge client (CDP 9229) |
```

The table is **refused rather than guessed at** if it is missing, has no Slot/Port/Profile columns, has
no rows, or has two rows sharing a port or a profile dir. A silent fallback to a stale built-in list is
exactly how this drifts out of date without anyone noticing, so the scripts fail loudly instead.

**Rules for the agent:**

1. **Resolve the *profile*, not the slot name.** Pick the slot by which account the task needs. Never
   substitute a different account's profile for the requested one — that produces actions taken as the
   wrong identity, which is worse than failing.
2. **Launch on demand.** A closed slot answers `ECONNREFUSED`. That is **not** a task failure — run
   `ensure-mcp-browsers.ps1 -Slot <name|account|profile|port>`, wait for the port, then continue. Only if
   the launch fails, or the profile needs an interactive sign-in the agent cannot perform, set `blocked`
   with that one ask.
3. **Sign-in is one-time per profile, by you.** Chrome/Edge 127+ bind cookies to the profile directory
   (App-Bound Encryption), so a newly created or copied profile carries the password vault but starts
   **logged out**. The agent must never type a master password.
4. **Preflight before browser work:** `check-browser-slots.ps1` (`-Json`; exit 0 = ok, 2 = attention). It
   derives its slot list from **this table** and is strictly **read-only** — it never launches or kills
   one of your windows, because they may hold in-flight state.
5. **Zombie slot after a browser auto-update:** port open and `/json/version` answering, but every *new*
   tab dies with `Target crashed`, because the running process is pinned to the pre-update version
   directory. Detected by comparing the build at `/json/version` with the installed browser's version.
   Fix: close that window and reopen its shortcut — sign-ins persist, since the cookies live with the
   profile directory, not the process.

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
