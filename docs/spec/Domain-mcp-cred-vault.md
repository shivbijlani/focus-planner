# Domain: mcp-cred-vault

`mcp-cred-vault` is a tiny JavaScript surface over a larger Windows credential-launch toolchain. The JS code does one thing: validate the shape of the non-secret `mcp-secrets.json` pointer file so the rest of the system can reject bad configuration loudly before any launcher tries to resolve credentials. See [Data-Formats](Data-Formats) and [Architecture](Architecture).

## Responsibility

The leading comment in `packages/mcp-cred-vault/src/schema.js` is explicit about scope. The pointer file lives in the working folder, not in the repository and not in Credential Manager. It lists which secrets a machine needs—server key, Windows Credential Manager target, environment variable, command, and optional args—but it never carries the secret value. The value lives only in Windows Credential Manager. This package therefore validates *shape*, not secret contents and not credential retrieval.

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```js
export function parseMcpSecrets(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    throw new Error(`mcp-secrets.json is not valid JSON: ${err.message}`);
  }
  const errors = collectMcpSecretsErrors(obj);
  if (errors.length > 0) {
    throw new Error(`mcp-secrets.json is invalid:\n- ${errors.join('\n- ')}`);
  }
  return obj;
}
```


</details>
## Modules and exports

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Path | Exports from `spec-facts.json` | Role |
| --- | --- | --- |
| `packages/mcp-cred-vault/src/index.js` | `collectMcpSecretsErrors`, `isValidMcpSecrets`, `parseMcpSecrets` | Public package surface; notes that the broader toolchain is PowerShell + .NET. |
| `packages/mcp-cred-vault/src/schema.js` | `collectMcpSecretsErrors`, `isValidMcpSecrets`, `parseMcpSecrets` | Actual parser and validator for the pointer-file schema. |

</details>

## Format and invariants

`collectMcpSecretsErrors()` enforces three invariants that matter to rebuilders. First, the root must be an object with a positive integer `version`. Second, `secrets` must be an array of objects with non-empty `server`, `target`, `envVar`, and `command` strings; `args`, when present, must be an array of strings. Third, both `server` and `target` must be unique across the file. The validator also rejects invalid environment variable names and `target` values containing tabs or newlines.

That division of fields reflects the package's rationale. The pointer file must be safe to sync, inspect, and validate in source control-adjacent workflows, so it keeps public identifiers and routing information only. The launcher that actually reads secrets from the OS vault sits elsewhere. `packages/mcp-cred-vault/src/index.js` says this plainly: the JS surface exists so the pointer file schema can be validated and unit-tested alongside sibling packages.

## Behavioural requirements from tests

The behavioural spec is `packages/mcp-cred-vault/src/schema.test.js`.

- The committed example file must validate unchanged.
- Missing `version` is rejected.
- A secret entry missing any required field is rejected.
- `envVar` must match an environment-variable identifier, not arbitrary text.
- Duplicate `server` keys and duplicate `target` names are rejected because both would make downstream resolution ambiguous.
- Malformed JSON throws a JSON-specific error.
- Invalid object shape throws one aggregated error that includes human-readable detail lines.

## Failure modes

The key failure mode here is a pointer file that looks harmless but silently routes credentials nowhere useful: wrong field names, duplicate targets, or an impossible env-var name. By validating shape up front, the package prevents the harder-to-debug alternative where the launcher proceeds with `undefined` inputs and the user only sees a downstream connection failure. The package does not claim more than that. It cannot prove the target exists in Credential Manager, that the command is installed, or that the selected secret is semantically correct for a server. Those remain outside this domain.
