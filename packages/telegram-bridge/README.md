# @focus/telegram-bridge

A one-way-per-direction bridge between **Focus Planner task journals** and a **Telegram
forum group**, so the Overnight Agent's per-task chat can be read and answered from your
phone — without opening the planner.

> **Augment, not replace.** This mirrors the journal chat into Telegram and folds your
> Telegram replies back into the journals. The journal `.md` files remain the source of
> truth; the `oa-state.ps1` reopen loop still drives the agent. Telegram is just a nicer
> phone surface on top.

## How it maps

- **1 task = 1 forum topic.** Each `journal/task-<ID>.md` gets its own Telegram topic named
  `#<ID> · <task title>`. The topic's `message_thread_id` is stored in bridge state.
- **syncUp** (journals → Telegram): posts each task's *latest agent turn* (the newest
  `<!-- from: overnight-agent -->` chat entry, or the current plan block) into its topic.
  Deduplicated by a SHA-256 of the turn text, so re-runs never repost unchanged content.
- **syncDown** (Telegram → journals): reads `getUpdates`, and for every non-bot text reply in
  a mapped topic, appends a dated `<!-- from: me -->` entry to the bottom of that task's
  journal — exactly the shape the Focus Planner app appends. The agent's normal
  `oa-state.ps1 scan` then sees the task as `reopened` and picks it up next run.

## Configuration (environment)

The bot token is **never** read from a file in the repo. The launcher must export it from the
Windows Credential Manager before invoking the CLI.

| Env var | Required | Purpose |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | ✅ | Bot API token. Populate from the OS vault (see below) — never commit it. |
| `TELEGRAM_CHAT_ID` | ✅ | The forum supergroup chat id (e.g. `-1004310604015`). |
| `PLANNER_PATH` | — | Planner folder. Defaults to `planner-config.json`'s `plannerPath`, else `../planner`. |
| `TELEGRAM_BRIDGE_TASKS` | — | Comma-separated allowlist of task IDs to mirror. Empty = all tasks with an agent block. |
| `TELEGRAM_BRIDGE_STATE_DIR` | — | State dir. Defaults to `%LOCALAPPDATA%\overnight-agent\telegram-bridge`. |

### Supplying the token (Windows Credential Manager)

The token lives in the credential vault via
`C:\Users\shiv\AppData\Local\overnight-agent\secrets\telegram-secret.ps1` (`get`/`set`/`test`/`clear`).
The launcher does:

```powershell
$env:TELEGRAM_BOT_TOKEN = & "$env:LOCALAPPDATA\overnight-agent\secrets\telegram-secret.ps1" get
$env:TELEGRAM_CHAT_ID   = '-1004310604015'
node packages/telegram-bridge/bin/telegram-bridge.js once
```

## CLI

```bash
node bin/telegram-bridge.js whoami        # verify the token / print bot info
node bin/telegram-bridge.js baseline      # mark existing tasks already-seen (no posts) — run once
node bin/telegram-bridge.js sync-up       # post NEW agent turns -> topics
node bin/telegram-bridge.js sync-down     # fold replies -> journals
node bin/telegram-bridge.js once          # sync-up then sync-down (default)
node bin/telegram-bridge.js watch [secs]  # loop `once` every N seconds (min 10, default 60)
```

**Natural (incremental) mirroring — no backfill.** `sync-up` only mirrors a task when its *latest agent
turn changes*; unchanged tasks are skipped entirely, so no topic is created for them. Run `baseline` **once**
on first setup to record the current backlog as already-seen — after that, a task gets its topic the first
time the agent writes a new turn to it, not in a bulk dump. Messages are sent as **Telegram HTML** (bold,
italics, code, links), so journal markdown renders as formatting instead of raw `**stars**`.

State (topic map, last-posted hashes, update offset) is persisted after every run, so the CLI
is safe to run on a schedule.

## 🔗 Per-task deep links (`tg-meta` marker)

Once a task's forum topic exists, `syncUp` stamps a hidden marker into that task's
journal so the planner web app can link straight to the thread:

```markdown
<!-- tg-meta chatId=-1004310604015 threadId=17 -->
```

The topic's `message_thread_id` is assigned by Telegram at `createForumTopic` time —
it can't be derived from the task id — so persisting it in the journal is what lets
the mapping travel with the synced markdown (the CLI's `state.json` lives only on
this machine). The pure helpers in `src/deepLink.js` (`telegramDeepLink`,
`parseTgLink`, `upsertTgMetaMarker`) build the link:

- Private supergroup: strip the leading `-100` → `https://t.me/c/<internalId>/<threadId>`
- Public supergroup: `https://t.me/<username>/<threadId>`

The web app parses the marker from the same journal read it already does for todos
and shows an ✈️ "Open in Telegram" link on each task row — no extra config needed.

## ⚠️ Bot privacy mode

@shivb_nemo_bot currently has **privacy mode ON** in BotFather. In that mode a group bot only
receives messages that are commands or that @mention it. Replies *inside a forum topic* still
arrive as normal messages the bot can read, which is what `syncDown` relies on — but if you
find replies aren't being folded in, disable privacy mode in BotFather
(`/setprivacy` → Disable) so the bot sees all topic messages.

## Testing

Pure and offline. The Telegram client (`fetchImpl`), filesystem (`io`), and clock (`now`) are
all injectable, so the unit tests run without network or disk:

```bash
npx vitest run packages/telegram-bridge
```
