# Domain: mcp-cred-vault

## Responsibility

Secret handling for the overnight agent's MCP (Model Context Protocol) server connections, split
deliberately across two toolchains by trust boundary: the actual secret storage and retrieval is a
Windows PowerShell + .NET Framework toolchain (`bin/`, `src/mcp-cred-launch.cs`) that reads from
Windows Credential Manager, outside this repo's JS test surface entirely; the JS surface that *is*
tested here validates the shape of a companion **pointer file** that names which secrets exist without
ever containing a secret value.

## Principal modules

| Module | Role |
| --- | --- |
| `packages/mcp-cred-vault/src/schema.js` | Validates `mcp-secrets.json`: the non-secret pointer file listing, per machine, which credential target feeds which environment variable into which MCP server/command. |
| `packages/mcp-cred-vault/src/index.js` | Re-exports the schema validators as the package's public JS surface. |

## Public surface

`parseMcpSecrets, isValidMcpSecrets, collectMcpSecretsErrors` (both `schema.js` and `index.js`).

## The pointer-file contract

`mcp-secrets.json` lives on each machine in the web app's synced working folder (OneDrive), **not** in
the repo and **not** in Credential Manager itself. It records, per secret entry: which credential
target Windows Credential Manager holds it under, which environment variable it must be materialized
into, and which MCP server and real command consume it, plus non-secret public identifiers. Actual
secret values live exclusively in Windows Credential Manager; the pointer file's entire job is to make
that indirection discoverable and schema-checked without ever putting a value in a synced, multi-device
file.

## Behavioural requirements (from tests)

- **The committed example file (`mcp-secrets.example.json`) must validate as-is** — it is the living
  contract sample, not aspirational documentation.
- **A missing version is rejected.**
- **A secret entry missing any required field is rejected** — partial entries fail closed rather than
  degrading to a best-effort read.
- **An invalid environment-variable name is rejected** — the file drives real process environment
  injection, so a malformed name must be caught at validation time, not at launch time.
- **Duplicate servers or duplicate credential targets are rejected** — two entries claiming the same
  target or server is treated as a shape error, not resolved by "last one wins".
- **Malformed JSON throws**, and an invalid shape throws **with details** — a caller needs to know
  which field failed, not just that validation failed.

## Failure modes this domain guards against

- **A secret value leaking into a synced, multi-device file** — the entire pointer-file design exists
  to keep credential values inside Windows Credential Manager (single-machine, OS-protected storage)
  while still letting the synced planner folder carry the *metadata* needed to wire an MCP server up on
  any machine that folder reaches.
- **A partially-valid pointer file silently launching a broken agent process** — because a malformed
  entry throws with details at validation time rather than surfacing as a runtime failure deep inside
  an MCP server launch, the failure is attributable to the pointer file immediately.
- **Two entries silently colliding on the same credential target or server** — rejected outright rather
  than picking a winner, since either interpretation could route a real secret to the wrong command.
