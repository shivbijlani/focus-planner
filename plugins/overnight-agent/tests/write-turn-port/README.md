# write-turn Node port -- differential tests

`skills/overnight-agent/write-turn.mjs` is the Node port of `write-turn.ps1` (item 3: the sanctioned
planner write tool). Its contract is the characterization goldens
(`../characterization`, `run.mjs --impl node --tool write-turn`). These two tests aim at what no
golden thought of, by running the PowerShell and the port side by side. Both need `pwsh`.

| Test | What it compares | Run |
|---|---|---|
| `regex-diff.mjs` | every regex the guards use, translated from .NET semantics by the port's `netRe`, against .NET `[regex]` -- each match's index, length and groups, with PowerShell's `-match` options (case-insensitive) or `[regex]::Matches`' (none) as each guard applies them. Inputs are seeded positive examples, randomly mutated (CR/LF, Unicode word / space / digit characters, astral characters, case). | `node regex-diff.mjs --n 400 [--seed N]` |
| `body-diff.mjs` | the whole tool: random turn bodies x random destinations (no sentinel, prior turns, doc bindings real and fenced, human replies, state fresh / stale / owned / paused / corrupt, backups) x random flags, run through BOTH implementations in twin sandboxes. Compares exit code, stdout (JSON structurally), stderr messages and every file effect. | `node body-diff.mjs --n 80 [--seed N] [--jobs 4]` |

Exit 0 means identical. Two tolerances, both stated in the code: PowerShell's own error decoration
(`Write-Error: <script>:<line>`) is stripped from stderr, and a displayed `<n> min` age may differ by
one because pwsh starts seconds later than node.

Known, deliberate differences from `write-turn.ps1` (none is reachable by a goldened case):

- **Output encoding.** The port always writes UTF-8. pwsh writes the console code page, which loses
  every non-ASCII character when no console is attached (see the characterization README).
- **`-DisableGuard a,b`** disables both guards, as PowerShell does when called in-process; under
  `pwsh -File` the comma is not split and the literal `a,b` disables nothing.
- **Timestamps in state.** `last_turn_at` / `last_woken_at` are parsed as written (an offset or `Z`
  is honoured). pwsh 7's ConvertFrom-Json would turn an ISO string into a local DateTime and
  re-render it, dropping sub-second precision and misreading `Z`; Windows PowerShell 5.1 (what the
  agent runs) does not. oa-state writes local offsets with whole seconds, where all three agree.
- **Error text.** Exit codes are identical; stderr carries the message without PowerShell's
  decoration, and failures PowerShell reports in its own words (an unreadable file, a missing `node`)
  carry Node's.
