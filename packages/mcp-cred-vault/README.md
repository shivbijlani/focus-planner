# @focus/mcp-cred-vault

Portable, user-agnostic Windows credential launcher for Copilot CLI stdio MCP
servers. Secrets (e.g. a Telegram bot token) live in **Windows Credential
Manager** (DPAPI-encrypted, per user) instead of plaintext in
`%USERPROFILE%\.copilot\mcp-config.json`. A tiny compiled native launcher reads
the secret at spawn time, injects it as an environment variable, and execs the
real MCP with **inherited stdio** so the JSON-RPC stream is untouched.

This package is **vendored** (private, not published to npm). It's checked in so
the whole setup is version-controlled and reproducible on a fresh machine with
one command.

## Why these design choices

**Why a compiled `.exe` and not a PowerShell wrapper.** MCP stdio servers speak
JSON-RPC over raw stdin/stdout. PowerShell cannot transparently forward raw
stdin to a child process — a `.ps1` shim silently corrupts the protocol and the
MCP handshake fails. The launcher is a native `.exe` that uses
`ProcessStartInfo` with `UseShellExecute=false` and **no** redirection of
stdin/stdout/stderr, so the child inherits the console handles directly. The
secret is set via `psi.EnvironmentVariables[...]` and is **never** placed on the
command line. All launcher diagnostics go to **stderr only**, keeping stdout a
clean JSON-RPC stream.

**Why the fixed `C:\ProgramData` path.** Copilot's `mcp-config.json` does **not**
expand `${env}` in `command`, so the launcher path must be a literal absolute
path that is identical on every machine — it can't reference `%USERPROFILE%`.
The launcher therefore installs to
`C:\ProgramData\mcp-cred-vault\mcp-cred-launch.exe`. Writing under `ProgramData`
needs elevation, so `build.ps1` self-elevates for that one step.

**Why re-store secrets per machine.** We deliberately do **not** roam secrets to
any cloud vault. Each machine stores its own copy in its own Credential Manager.
This is accepted and intentional.

## Contents

| File | What it is |
|---|---|
| `src/mcp-cred-launch.cs` | The native launcher source. Compiled in-box (no .NET SDK). |
| `bin/build.ps1` | Compiles the launcher to `C:\ProgramData\mcp-cred-vault\` (self-elevating). |
| `bin/secret-vault.ps1` | Store/read/test/clear/list secrets in Credential Manager. |
| `bin/setup.ps1` | Idempotent bootstrap: build → verify toolchain → patch config → store missing secrets. |
| `src/schema.js`, `src/index.js` | Validator for the pointer file (`mcp-secrets.json`). |
| `src/schema.test.js` | Vitest coverage for the pointer schema + the example file. |
| `mcp-secrets.example.json` | Committed example of the (non-secret) pointer file. |

## Launcher contract

```
mcp-cred-launch.exe <credentialTarget> <envVarName> <realCommand> [realArgs...]
```

The patched `telegram` entry in `mcp-config.json` looks like:

```json
"telegram": {
  "type": "stdio",
  "command": "C:\\ProgramData\\mcp-cred-vault\\mcp-cred-launch.exe",
  "args": ["overnight-agent:telegram-bot-token", "TELEGRAM_BOT_TOKEN", "uvx", "better-telegram-mcp"]
}
```

No `env` block, no secret anywhere in the file.

## The pointer file (`mcp-secrets.json`) — NON-secret

`setup.ps1` reads a small per-machine pointer file that says *which* credential
targets this machine needs and *which* MCP server + env var each one feeds. It
contains **no secret values** — only target names, env var names, the real
command to exec, and optional public identifiers. It lives in the web app's
OneDrive working folder (a sibling of `settings.json`), **not** in this repo:

```
C:\Users\<you>\OneDrive\Apps\Focus Planner\mcp-secrets.json
```

Schema (see `mcp-secrets.example.json`):

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
    "telegramBotId": "",
    "telegramChatId": ""
  }
}
```

- `secrets[]` — one entry per credential. `server` is the key in
  `mcp-config.json` to patch; `target` is the Credential Manager target name;
  `envVar` is the variable the launcher injects; `command`/`args` are the real
  MCP to exec.
- `ids` — non-secret public identifiers, for convenience only.

If the pointer file is absent, `setup.ps1` falls back to interactive prompts.

## Set up on a new machine

```powershell
cd packages/mcp-cred-vault
npm run setup
```

`setup.ps1` will:

1. Compile the launcher to `C:\ProgramData\mcp-cred-vault\mcp-cred-launch.exe`
   (self-elevates for the ProgramData write).
2. Verify `node`/`npx` and `uv`/`uvx` are on `PATH` and warn if either is missing.
3. Read `mcp-secrets.json` (or prompt interactively) to learn the required targets.
4. Back up and patch `%USERPROFILE%\.copilot\mcp-config.json` so each server's
   `command` points at the fixed launcher with the right args and **no**
   plaintext `env` secret. The result is re-validated as JSON.
5. For any target not already in Credential Manager, prompt you to paste the
   value and store it (DPAPI-encrypted).

Then restart Copilot CLI to pick up the patched config.

Useful flags:

```powershell
npm run setup -- -DryRun        # compile to a temp dir, patch a COPY of the config, never store secrets
npm run setup -- -SkipBuild     # don't recompile the launcher
npm run build                    # just (re)compile the launcher to ProgramData
```

## Managing secrets directly

```powershell
# Store / rotate a secret (prompts if -Token omitted).
powershell -File bin/secret-vault.ps1 set   -Target overnight-agent:telegram-bot-token -Token <value>

# Print the secret (stdout, by design — used by the launcher's read path).
powershell -File bin/secret-vault.ps1 get   -Target overnight-agent:telegram-bot-token

# Check presence without revealing the value.
powershell -File bin/secret-vault.ps1 test  -Target overnight-agent:telegram-bot-token

# List stored targets under a prefix (values never shown).
powershell -File bin/secret-vault.ps1 list  -Prefix overnight-agent:

# Remove a secret.
powershell -File bin/secret-vault.ps1 clear -Target overnight-agent:telegram-bot-token
```

Short target names are auto-prefixed with `overnight-agent:` (override with
`-Prefix`). Only `get` ever prints a secret value.

## Threat model

**Protects against:**

- **Plaintext at rest / accidental leak.** Secrets are DPAPI-encrypted in
  Credential Manager, not sitting in a world-readable config or dotfile. Copying
  `mcp-config.json` (or committing it) no longer leaks the token.
- **Command-line exposure.** The secret is never an argv element, so it can't be
  read from process listings, shell history, or logs. Only the *target name* and
  *env var name* are on the command line.
- **At-rest disk theft (powered-off).** DPAPI ties the blob to the Windows user
  account; the raw credential store isn't usable on another machine/user.

**Does NOT protect against:**

- **Same-user compromise.** Any code running as the same Windows user can call
  `CredRead` (or run `secret-vault.ps1 get`) and recover the secret — that's how
  the launcher itself reads it. This guards against leaks and exposure, not
  against an attacker already executing as you.

## Requirements

- Windows 10/11 (in-box .NET Framework 4.x supplies `csc.exe`; no .NET SDK
  needed).
- Windows PowerShell 5.1 is sufficient; PowerShell 7 (`pwsh`) is used
  automatically when present for more robust JSON handling.
