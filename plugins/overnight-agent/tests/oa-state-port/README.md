# oa-state.mjs -- proving the Node port of the state engine

`skills/overnight-agent/oa-state.mjs` (+ `oa-state-lib/`) is the Node port of `oa-state.ps1` (item 4 of
the "one product, two deployments" plan; Refs #124). Until the cut-over it is called by nothing; this
folder, the characterization goldens and the mutation checks are what earn it the right to be.

| Proof | Command | CI job |
|---|---|---|
| Every oa-state golden, zero SKIP | `node tests/characterization/run.mjs --impl node --tool oa-state` | `oa-state-node` |
| Readers, function by function vs PowerShell | `node journal-diff.mjs --n 300`, `board-diff.mjs --n 200`, `session-diff.mjs --n 200` | `oa-state-node` |
| Whole commands, twin sandboxes vs PowerShell | `consent-diff.mjs --n 200`, `extract-diff.mjs --n 200`, `scan-diff.mjs --n 60`, `session-cmd-diff.mjs --n 60`, `mutate-diff.mjs --n 60 --steps 6` | `oa-state-node` |
| Mutation checks against both engines | `pwsh -File run-mutchecks.ps1 [-Target node|ps] [-Filter <regex>]` | `oa-state-node-mutchecks` |
| Live data, read-only (local only) | `node tests/characterization/run.mjs --shadow --sample 100000` | never |

- `ps-fn-host.ps1` loads oa-state.ps1's functions without running a command and answers JSON calls on
  stdin; `fn-diff.mjs` drives it (`createPsHost`, `asJson`, `diff`). Any internal function can be
  compared against its port this way.
- Every diff script is seeded (`--seed`), keeps its scratch under the OS temp folder, and exits non-zero
  on the first difference, printing it.
- `run-mutchecks.ps1` is the one list of mutation checks that drive the engine and the parameter each
  takes. A check reaches either engine through `skills/overnight-agent/oa-state-target.ps1`
  (`Get-OaStateCommand`, `New-OaStateMutant`): a Node mutant copies the whole bundle and edits the one
  file that holds the anchor, and an absent or ambiguous anchor is an error.
