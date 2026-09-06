# Domain: mcp-cred-vault

`mcp-cred-vault` (`packages/mcp-cred-vault/`) is primarily a Windows PowerShell + .NET Framework
toolchain; its JS surface is deliberately thin — just enough to validate and unit-test the shape of
one non-secret pointer file.

## Responsibility

Let a machine declare, in a file that is safe to sync or commit, which credentials it needs (which
MCP server, which environment variable, which real command consumes it) **without ever holding a
secret value**. The values themselves live only in the Windows Credential Manager; this package's
job is to validate the pointer file's shape, not to touch a credential.

## Principal modules

| Path | Purpose |
| --- | --- |
| `packages/mcp-cred-vault/src/index.js` | Re-exports the schema validators; documents that the real implementation is the PowerShell/.NET toolchain in `bin/` and `src/mcp-cred-launch.cs`. |
| `packages/mcp-cred-vault/src/schema.js` | The actual validation logic: `isValidMcpSecrets`, `parseMcpSecrets`, `collectMcpSecretsErrors`. |

## Public exports

`collectMcpSecretsErrors`, `isValidMcpSecrets`, `parseMcpSecrets` (identical set from both
`index.js` and `schema.js`).

## The format it validates

See [Data-Formats](Data-Formats) §8 for the full `mcp-secrets.json` sample. In brief: `version`, a
`secrets[]` array of `{ server, target, envVar, command, args }` — the credential's Windows
Credential Manager target name, the environment variable it feeds, and the MCP server + real
command that consumes it — and an `ids` object for non-secret public identifiers (e.g. a Telegram
bot/chat id, which is not itself a secret but is useful to keep alongside the pointer). Per
`mcp-secrets.example.json`, the file lives on each machine in the web app's OneDrive working folder,
never in the repository and never alongside the actual secret value.

## Behavioural requirements (from `mcp-cred-vault` test coverage)

The test suite (7 tests, `mcp-cred-vault` domain) exercises `parseMcpSecrets` and
`collectMcpSecretsErrors` against malformed and well-formed pointer files, asserting the schema
rejects a file that is missing required fields, is not valid JSON-shaped data, or declares a secret
entry without every field a launcher needs to resolve it — because a malformed pointer file, unlike
a malformed secret, fails silently: the credential manager lookup simply returns nothing, and a
launcher with no shape validation would proceed with an undefined environment variable rather than
failing loudly at the point where the mistake actually is.

## Failure modes

A pointer file that validates but names the wrong `envVar` or `target` is outside this package's
reach — schema validation only proves the file is *well-shaped*, not that it is *correct* for the
machine it lives on. Getting the values right is the PowerShell/.NET launcher's job, which this
package's `doc` comment explicitly defers to.
