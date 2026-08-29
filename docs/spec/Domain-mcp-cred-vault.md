# Domain: mcp-cred-vault

## Responsibility

Keeps secrets the Overnight Agent's MCP (Model Context Protocol) servers need — such as
the Telegram bot token — out of plaintext configuration files, by storing them in Windows
Credential Manager (DPAPI-protected) instead. The bulk of this package is a Windows
PowerShell + .NET Framework launcher (`bin/` and a `.cs` source, outside this JS
domain's scope); the JS surface exists purely so the **non-secret pointer file** that
tells the launcher which secrets to fetch can be validated and unit-tested like every
other format in the system.

## Principal modules

| Module | Role |
| --- | --- |
| `packages/mcp-cred-vault/src/schema.js` | Validation for the `mcp-secrets.json` pointer file: `collectMcpSecretsErrors`, `isValidMcpSecrets`, `parseMcpSecrets`. |
| `packages/mcp-cred-vault/src/index.js` | Re-exports the schema functions as the package's public entry point. |

## Public exports

`collectMcpSecretsErrors(obj)` — returns every validation problem found (not just the
first); `isValidMcpSecrets(obj)` — boolean shortcut; `parseMcpSecrets(text)` — parses JSON
text and throws a single error listing every violation if invalid.

## Design decision: a non-secret pointer file, validated but not secret-bearing

The pointer file (see [Data-Formats](Data-Formats) §7 for its shape) lives in the web
app's OneDrive working folder on each machine — deliberately **not** in the repo and
**not** in Credential Manager itself — and lists which Credential Manager target feeds
which environment variable into which real MCP command. It never contains a secret value.
This split means the JS surface of this package can be fully open-source and unit-tested
without ever touching real credentials: the schema only describes *pointers*, and the
actual secret material is fetched at launch time by the PowerShell/.NET half, which is out
of this domain's JS-testable scope.

## Behavioural requirements (from tests)

- The schema **must accept the committed example file** (`mcp-secrets.example.json`) as
  valid — the example is the canonical "this is what a correct file looks like"
  reference, and a schema that rejects its own example is untrustworthy by definition.
- **Must reject a missing `version`.**
- **Must reject a secret entry missing any required field** (`server`, `target`,
  `envVar`, `command`).
- **Must reject an invalid environment-variable name** — `envVar` must be a syntactically
  valid identifier, since it becomes a real process environment variable at launch.
- **Must reject duplicate `server` or `target` values** across the `secrets` array — two
  entries claiming the same Credential Manager target, or the same MCP server key, is a
  configuration error the launcher cannot resolve unambiguously.
- **Must throw on malformed JSON** (`parseMcpSecrets` wraps the underlying `JSON.parse`
  error with a clear message rather than letting a cryptic native error escape).
- **Must throw with details on an invalid shape** — the thrown error lists every
  collected violation, not just the first one found, so a user fixing the file does not
  have to re-run validation once per error.

## Failure modes

- A schema that only reported the *first* violation would force a user through a
  slow fix-one-error-at-a-time loop against a file that likely has several problems at
  once (e.g. copy-pasted from an example with placeholders never filled in) — this is why
  `collectMcpSecretsErrors` accumulates every problem before returning.
- Allowing a `target` value containing a tab or newline would corrupt it as a Windows
  Credential Manager target name; the schema's `CRED_TARGET_RE` check exists specifically
  to catch that before the launcher ever attempts the credential lookup.
