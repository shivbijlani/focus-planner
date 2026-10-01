# Overnight Agent characterization (golden) harness

This folder pins the **current** behaviour of the Overnight Agent's two PowerShell tools,
`skills/overnight-agent/oa-state.ps1` and `skills/overnight-agent/write-turn.ps1`, as
implementation-agnostic golden tests. It exists so the Node ports (item 3: the write tool, item 4:
`oa-state`) can be *proven* equivalent before they replace the PowerShell: the same cases run
against either implementation and must produce the same observations.

It changes no agent behaviour. Nothing here is loaded by the plugin at runtime.

```
node plugins/overnight-agent/tests/characterization/run.mjs --impl ps            # must be 100% green
node plugins/overnight-agent/tests/characterization/run.mjs --impl node          # the port; unmapped = SKIP
node plugins/overnight-agent/tests/characterization/run.mjs --impl ps --update   # re-record goldens (ps only)
node plugins/overnight-agent/tests/characterization/run.mjs --impl ps --repeat 3 # determinism check
node plugins/overnight-agent/tests/characterization/run.mjs --list               # cases, per-command and per-mutcheck counts
node plugins/overnight-agent/tests/characterization/run.mjs --coverage           # the mutcheck mapping as markdown
```

Other flags: `--filter <regex>` (on case id), `--jobs N`, `--keep` (leave failing sandboxes on
disk and print their path), `--prune` (with `--update`, delete goldens whose case is gone).

CI runs `--impl ps` on `windows-latest` (job `agent-characterization`), because the
owner's agent runs on Windows and a few verdicts are OS-shaped (lock-path case folding, path
roots, `Test-Path` semantics). Determinism is proven locally with `--repeat 3`, and CI re-proves
it across machines and days every run, since the goldens were recorded elsewhere and earlier.

## What one case observes

A case copies a **fixture** into a fresh temp sandbox, runs one or more **steps**, and records:

1. per step: the exit code, stdout (parsed as JSON when it is JSON, otherwise as lines), any
   `WARNING:` lines, and the stderr *messages*;
2. the **file-tree diff** of the sandbox: every file created, modified or deleted, with its
   normalised content (JSON files parsed; `.jsonl` parsed per line; `bom: true` recorded when a
   file carries a UTF-8 BOM).

That observation is compared with `golden/<case id>.json`.

### Normalisation (and only this)

| What | Becomes | Why |
|---|---|---|
| the sandbox root, the skill folder, the repo root | `<ROOT>`, `<SKILL>`, `<REPO>`; separators after them folded to `/` | temp paths |
| an ISO timestamp within ±45 days of the case clock T0 | `<NOW+Nm>` -- minutes from T0, floored to 5-minute buckets | clock |
| PowerShell's invariant `MM/dd/yyyy HH:mm:ss` rendering within ±45 days | `<INVTIME+Nm>` (kept distinct from ISO: the format is observable) | clock |
| a `yyyy-MM-dd` date within ±45 days | `<DATE+Nd>` | clock |
| a `yyyyMMdd-HHmm` / `yyyyMMddHHmm` stamp within ±45 days | `<STAMP+Nm>` | clock (write-turn backups) |
| a GUID the case did not supply (fixture, overlay, arguments) | `<GUID>` | generated identifiers; supplied GUIDs stay verbatim |
| a number under a key ending `seconds` / `_ms` / `duration` / `elapsed` | `<DURATION>` | wall-clock timing |
| ANSI colour escapes | removed | presentation |
| JSON object key order | sorted | PowerShell hashtables serialise in per-process random order |
| PowerShell error decoration (`Exception: x.ps1:<line>` header, `Line |`, source excerpt, `~~~`, the `x.ps1: ` prefix, console-width wrapping) | removed; one string per error message | implementation detail; the message text is kept |
| an error raised by PowerShell's own parameter binder (bad `ValidateSet` value, unknown parameter, ...) | `<PS-PARAM-INVALID:Name>` etc. | the contract is "that argument is rejected", not the binder's English |

Nothing semantic is normalised. Because the clock window is ±45 days, **fixed dates in fixtures
must be far from any run date** -- the fixtures use 2020 for "long ago" and 2099 for "far
future". Anything that must be relative to now uses a clock token (below).

### No live data, no ambient identity

Every path parameter defaults to the sandbox (see `lib/contract.mjs`: `-JournalDir`,
`-StateDir`, `-PlannerBoard`, `-PlannerCompleted`, `-SnoozeStore`, `-GatePath`, `-UserSettings`,
`-SessionStateDir`, `-CapabilitiesPath`, `-RunLedger`, `-McpConfig` for oa-state; `-JournalDir`
for write-turn). The child environment is built from an allow-list, with `LOCALAPPDATA`,
`USERPROFILE`, `HOME`, `TEMP` pointed into the sandbox, so `COPILOT_AGENT_SESSION_ID`,
`OVERNIGHT_AGENT_SETTINGS` and OneDrive paths from the developer's own session never leak in.
write-turn gets `WRITE_TURN_OA_HOME=<sandbox home>` and `WRITE_TURN_ISSUE_RESOLVER=stubs/issue-shipped.mjs`
(its G15 classifier, stubbed: `CHAR_SHIPPED="640,641"` marks issues shipped, `CHAR_SHIPPED="!fail"`
simulates a classifier that cannot measure). **No hook was added to the PowerShell scripts**: the
clock is pinned by tokens in the fixture rather than by overriding the scripts' clock.

## Fixtures

```
fixtures/<name>/data/     the planner data folder      -> <ROOT>/data
fixtures/<name>/home/     %LOCALAPPDATA%\overnight-agent -> <ROOT>/lad/overnight-agent
fixtures/<name>/state/    the host state dir           -> <ROOT>/lad/overnight-agent/state
fixtures/<name>/fixture.json   { "extends": "base", "mtimes": { "data/journal/task-108.md": "-3h" } }
```

`fixtures/base` is the shared synthetic planner folder (no personal data): a board with Today /
Deferred / Priorities, a compound-id row, ragged Deferred rows (with and without `Wake`), Linked
IDs, board snooze markers; a completed board; `snooze.json`; `agent-gate.md`; `user-settings.md`;
and journals covering a fresh user reply (101), a declared blocking ask (102), a declared offer
over blocking-looking prose (103), an inferred ask (104), an offer-only turn (105), a user-closed
task with a reply (106), an agent-declared `done` (107), a user pause (108), consent lines (109
valid `merge 12`; 110 a quoted marker; 111 an unstamped agent "approved" under the human's
question), a catch-up doc binding (112), a brand-new task (113), a sibling-skill-only turn (114),
an above-sentinel reply (115), snooze / poll / recheck (116-119), live and dead session bindings
(121, 122), a legacy unstamped block (123) and a CRLF journal with an unmarked reply (124).
Journals and state are generated by `tools/build-base-fixture.mjs` (it computes each state file's
`processed_file_hash`); edit the definitions there and re-run it rather than hand-editing hashes.
Changing `base` changes many goldens -- prefer a case-level `files` overlay or a new fixture that
`extends` base.

### Tokens

Expanded in every UTF-8 fixture file containing `{{`, in `files` overlays, step `files`/`append`,
bodies and `env` values: `{{NOW}}`, `{{NOW-30m}}`, `{{NOW+2d}}` (local ISO with offset; units
`s m h d`), `{{UTC-20m}}` (UTC `Z`), `{{DATE-1d}}` (local `yyyy-MM-dd`), `{{STAMP-5m}}`
(`yyyyMMdd-HHmm`), `{{ROOT}}` / `{{ROOT_JSON}}` (the sandbox root, native / JSON-escaped). Keep
tokens out of journals whose hash a state file records. Because relative times are compared in
5-minute buckets, use whole multiples of 5 minutes and stay at least 5 minutes clear of any
threshold a case is meant to sit on one side of.

## Case files

`cases/*.json`, each `{ "fixture": "base", "covers": ["mutcheck-..."], "cases": [ ... ] }`.

```jsonc
{
  "id": "mc/sibling-reopen/dance-only-quiet",  // unique; the golden file name is derived from it
  "fixture": "base",                            // optional, defaults to the file's
  "covers": ["mutcheck-sibling-reopen"],        // mutchecks whose pinned behaviour this case pins
  "note": "why this case exists",
  "files": { "data/journal/task-901.md": "...", "state/task-901.json": null },  // overlay; null deletes
  "mtimes": { "data/journal/task-901.md": "-3h" },
  "env": { "COPILOT_AGENT_SESSION_ID": "sess-a" },
  "steps": [
    { "tool": "oa-state", "command": "mark", "args": { "Id": "901", "Status": "in-progress" }, "record": false },
    { "append": { "data/journal/task-901.md": "\n## 2020-03-02\n\n<!-- from: me -->\nreply\n" } },
    { "tool": "oa-state", "command": "scan", "args": { "Compact": true } },
    { "tool": "write-turn", "args": { "Id": "901", "Ask": "offer" }, "body": "## \ud83c\udf19 ...turn..." }
  ]
}
```

A single-step case may put `tool` / `command` / `args` / `body` at the top level. Argument values
use the scripts' own parameter names: a string (placeholders `{root} {data} {journal} {home}
{state} {cwd} {input}` expanded), a number, `true` for a switch, `false`/`null` to drop a
harness default, or a one-element array for a `string[]`. `body` is written to a file and passed
as `-BodyFile`. `record: false` keeps only the exit code of a setup step. A step with no `tool`
mutates files between commands (`files` / `append`) -- the user or the app editing the folder.

## Plugging in the Node implementation (items 3 and 4)

`adapters/node.mjs` holds the mapping. Every `(tool, command)` pair starts as `null`, which the
runner reports as **SKIP** (never as a pass), so `--impl node` shows exactly how much of the
contract a port covers. To wire a port in, set its entry:

```js
export const IMPLEMENTATIONS = {
  'oa-state': {
    scan: { bin: 'plugins/overnight-agent/skills/overnight-agent/oa-state.mjs' },  // node <bin> scan --JournalDir ... --Compact
    // or a function for anything bespoke:
    gate: async (step, ctx) => ({ status: 'ran', exit: 0, stdout: JSON.stringify(await readGate(step.args.GatePath)), stderr: '' }),
  },
  'write-turn': { '': { bin: 'plugins/overnight-agent/skills/overnight-agent/write-turn.mjs' } },
};
```

With `{ bin }` the adapter runs `node <bin> <command> --Name value ...` using the PowerShell
parameter names verbatim (switches as `--Name`, arrays as repeated `--Name`), in the same
sandbox cwd and environment the PowerShell sees. Supply `argv: (step) => [...]` to rename
arguments instead. `step.args` is already fully resolved (sandbox paths included); `ctx` carries
`root`, `dirs`, `cwd`, `env`, `skillDir`, `repoDir`.

What equivalence means: identical exit codes, identical stdout **after normalisation** (JSON is
compared structurally, so formatting and key order are free), identical stderr message lines,
identical `WARNING:` lines, and an identical file-tree diff -- including a state file's BOM. If
a port deliberately changes an observable (say, dropping the state-file BOM), that is a
behaviour change: record it in a **separate, clearly labelled commit** that updates the affected
goldens and explains why (preamble rule 2), never by loosening the normaliser.

Goldens are only ever written from `--impl ps` (`--update` refuses other implementations).

### Shadow mode (local only, for cutover)

```
node run.mjs --shadow [--data <planner folder>] [--state <state dir>] [--sample 25] [--out <dir>]
```

Copies the owner's live planner folder (`planner.md`, `planner-completed.md`, `snooze.json`,
`agent-gate.md`, `user-settings.md`, `journal/`) and the host state dir into a temp sandbox, runs
the read-only commands (`scan`, `scan -Compact`, `gate`, `whoami`, and `get` / `consent` /
`extract -Json` / `session` for the newest `--sample` tasks) with **both** implementations, and
writes `shadow-<timestamp>.json` to `%LOCALAPPDATA%\overnight-agent\shadow\`. The live folders are
only read (copied from); every command runs against the copy. The data folder is located from
`--data`, else `PLANNER_PATH`, else the `Planner board` row of the user-settings.md the plugin
reads (`OVERNIGHT_AGENT_SETTINGS`, `%LOCALAPPDATA%\overnight-agent\user-settings.md`, the OneDrive
planner folder), else the documented OneDrive default. It refuses to run when `CI` is set and is
never part of CI; until the ports land every node observation is a SKIP.

## Mutcheck mapping

Every mutation check that drives `oa-state.ps1` or `write-turn.ps1` has at least one case that
pins the behaviour it protects (`covers` in the case files). Regenerate this table with
`node run.mjs --coverage`.

<!-- COVERAGE:BEGIN -->
<!-- COVERAGE:END -->
