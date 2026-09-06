# Domain: mcp-cred-vault

## Responsibility

`packages/mcp-cred-vault` keeps MCP (Model Context Protocol) server secrets — bot tokens, API keys —
out of the repository and out of any synced planner folder, while still letting the overnight-agent
plugin discover which secret feeds which environment variable on a given machine. It is primarily a
**Windows PowerShell + .NET Framework toolchain** (`bin/secret-vault.ps1`, `bin/setup.ps1`,
`bin/build.ps1`, `src/mcp-cred-launch.cs`); the JavaScript surface exists only so the **pointer file**
schema can be validated and unit-tested alongside the repository's other packages.

## Principal modules

| Path | Exports | Role |
| --- | --- | --- |
| `packages/mcp-cred-vault/src/schema.js` | `parseMcpSecrets`, `isValidMcpSecrets`, `collectMcpSecretsErrors` | Validates the shape of the non-secret `mcp-secrets.json` pointer file. |
| `packages/mcp-cred-vault/src/index.js` | (re-exports `schema.js`) | Package entry point. |

## The pointer-file design

The real secret **values** live in Windows Credential Manager, never in a file. `mcp-secrets.json`
lives on each machine, in the web app's OneDrive working folder — **not** in the repo — and lists,
per machine, which secrets it needs: the credential-manager target name, the environment variable it
feeds, and which MCP server + real launch command consumes it. It never contains a secret value
itself.

```json
{
  "version": 1,
  "secrets": [
    {
      "server": "telegram",
      "target": "overnight-agent:telegram-bot-token",
      "envVar": "TELEGRAM_BOT_TOKEN",
      "command": "uvx",
      "args": ["better-telegram-mcp"]
    }
  ],
  "ids": {
    "telegramBotId": "0000000000",
    "telegramChatId": "0000000000"
  }
}
```

`server`/`target` pairs must be unique (two secrets cannot silently share one Credential Manager
entry), `envVar` must be a valid environment-variable name, and every secret entry must carry all of
`server`, `target`, `envVar` and `command`. `ids` is a free-form bag for genuinely non-secret public
identifiers (e.g. a Telegram bot/chat id) that are safe to keep alongside the pointer file.

## Behavioural requirements (from `packages/mcp-cred-vault/src/schema.test.js`)

- Accepts the committed example file (`mcp-secrets.example.json`) as valid.
- Rejects a missing `version`.
- Rejects a secret entry missing any required field.
- Rejects an invalid environment-variable name.
- Rejects duplicate `server`/`target` pairs.
- Throws on malformed JSON.
- Throws **with details** (not just a boolean) on an invalid shape, so a caller can report exactly
  which field is wrong.

## Failure modes

- A pointer file with a duplicate `target` would make two different secrets resolve to the same
  Credential Manager entry, silently handing one MCP server another's token; the duplicate check
  exists specifically to fail this loudly at load time rather than at connection time.
- Because the JS validator never touches Credential Manager, it cannot itself leak a secret — the
  worst it can do is accept/reject the pointer file incorrectly, which is exactly what the test suite
  pins.
