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
node plugins/overnight-agent/tests/characterization/run.mjs --impl node --tool write-turn  # one tool's cases only
node plugins/overnight-agent/tests/characterization/run.mjs --impl ps --update   # re-record goldens (ps only)
node plugins/overnight-agent/tests/characterization/run.mjs --impl ps --repeat 3 # determinism check
node plugins/overnight-agent/tests/characterization/run.mjs --list               # cases, per-command and per-mutcheck counts
node plugins/overnight-agent/tests/characterization/run.mjs --coverage           # the mutcheck mapping as markdown
```

Other flags: `--filter <regex>` (on case id), `--tool oa-state|write-turn` (every case with a step
driving that tool -- how a port proves itself tool by tool), `--jobs N`, `--keep` (leave failing sandboxes on
disk and print their path), `--prune` (with `--update`, delete goldens whose case is gone).

CI runs `--impl ps` on `windows-latest` (job `agent-characterization`, time zone pinned, see
below), because the
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

**pwsh runs with a console.** The ps adapter does not hide the child's window: without a console,
pwsh writes stdout in the OEM code page with best-fit, so every non-ASCII character (urgency
emoji, the moon, an em dash) used to reach the goldens as `?`. With one it writes UTF-8, which is
what the agent's own shell sees and what a Node port writes.

Nothing semantic is normalised. Because the clock window is ±45 days, **fixed dates in fixtures
must be far from any run date** -- the fixtures use 2020 for "long ago" and 2099 for "far
future". Anything that must be relative to now uses a clock token (below).

**Time zone is pinned, not normalised.** PowerShell renders some timestamps in local time (an ISO
string read back from JSON becomes a local `[datetime]`; fixed 2020 times print as `-08:00`), so the
goldens are tied to the zone they were recorded in, `America/Los_Angeles` (the owner's). `run.mjs`
refuses to compare in another zone (`--any-tz` overrides); CI runs `tzutil /s "Pacific Standard
Time"` first. On Linux/macOS export `TZ=America/Los_Angeles`.

**Opaque clock-derived fingerprints** are the one escape hatch, and it is per case and explicit: a
case may list keys in `"mask"` (today only `dispatch_input`, in `cmd/mark/101-arm-poll`, where the
hash covers a poll armed "now"). Each distinct value becomes `<MASKED:key#n>`, so the golden still
pins which rows/steps share a fingerprint and when it changes. Everywhere else `dispatch_input` is
compared exactly, so the port must reproduce the hash.

A child that does not exit (timeout, default 900 s) is an error, never a recorded result.

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
  "mask": ["dispatch_input"],                   // rare: opaque clock-derived fingerprints only
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

**write-turn is mapped** (item 3): `skills/overnight-agent/write-turn.mjs` passes all 84 write-turn
cases with no SKIP (`--impl node --tool write-turn`, CI job `write-turn-node`). oa-state is item 4.

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
| Mutcheck | Cases | Case ids |
|---|---|---|
| `mutcheck-above-sentinel-reply` | 4 | `mc/above-sentinel-reply/newer-human-message-seen`<br>`mc/above-sentinel-reply/older-and-same-day-quiet`<br>`mc/above-sentinel-reply/fenced-and-agent-text-quiet`<br>`mc/above-sentinel-reply/agent-only-quiet` |
| `mutcheck-advertised-reply-word` | 14 | `mc/advertised-reply-word-write/prune-refused`<br>`mc/advertised-reply-word-write/approve-clean`<br>`mc/advertised-reply-word-write/merge-number-clean`<br>`mc/advertised-reply-word-write/emphasis-clean`<br>`mc/advertised-reply-word-write/fenced-prune-clean`<br>`mc/advertised-reply-word-write/disable-g16-clears`<br>`mc/advertised-reply-word/prune-refused`<br>`mc/advertised-reply-word/confirm-refused`<br>`mc/advertised-reply-word/accepted-word-allowed`<br>`mc/advertised-reply-word/merge-number-allowed`<br>`mc/advertised-reply-word/yes-please-substring-allowed`<br>`mc/advertised-reply-word/bold-emphasis-allowed`<br>`mc/advertised-reply-word/fenced-offer-allowed`<br>`mc/advertised-reply-word/disable-guard-allows` |
| `mutcheck-agent-declared-done` | 4 | `mc/agent-declared-done/agent-done-with-absorbed-user-messages`<br>`mc/agent-declared-done/user-completed-control`<br>`mc/agent-declared-done/sibling-turn-control`<br>`mc/agent-declared-done/unmarked-prose-control` |
| `mutcheck-agent-gate` | 10 | `mc/agent-gate/allow-email-self`<br>`mc/agent-gate/floor-overrides-allow`<br>`mc/agent-gate/floor-overrides-human-approval`<br>`mc/agent-gate/repo-scope-allowed`<br>`mc/agent-gate/repo-scope-no-prefix`<br>`mc/agent-gate/open-pr-is-not-merge`<br>`mc/agent-gate/human-spoke-pauses-allow`<br>`mc/agent-gate/absent-gate-fail-closed`<br>`mc/agent-gate/malformed-gate-fail-closed`<br>`mc/agent-gate/no-action-shape-unchanged` |
| `mutcheck-awaiting-reply` | 4 | `mc/awaiting-reply/matrix`<br>`mc/awaiting-reply/parked-today-opens-deferred`<br>`mc/awaiting-reply/reply-unparks`<br>`mc/awaiting-reply/due-poll-beats-park` |
| `mutcheck-blocked-recheck` | 5 | `mc/blocked-recheck/lifecycle`<br>`mc/blocked-recheck/snooze-suppresses-timers`<br>`mc/blocked-recheck/lapsed-snooze-refires`<br>`mc/blocked-recheck/blocked-due-eligible`<br>`mc/blocked-recheck/done-due-ineligible` |
| `mutcheck-board-compound-id` | 2 | `mc/board-compound-id/compound-today-gates-deferred`<br>`mc/board-compound-id/plain-control-gates-deferred` |
| `mutcheck-board-linked` | 3 | `mc/board-linked/scan-merged-board-links`<br>`mc/board-linked/unreadable-board-not-none`<br>`mc/board-linked/extract-merged-board-and-journal` |
| `mutcheck-board-row-no-journal` | 1 | `mc/board-row-no-journal/visible-honest-row` |
| `mutcheck-busy-bound-session` | 5 | `mc/busy-bound-session/scan-skips-busy-selects-idle`<br>`mc/busy-bound-session/for-dispatch-busy-refused`<br>`mc/busy-bound-session/idle-authorised-stamps`<br>`mc/busy-bound-session/status-required-and-unknown`<br>`mc/busy-bound-session/decisions-record-busy` |
| `mutcheck-cadence-rearm` | 4 | `mc/cadence-rearm/new-poll-due-now`<br>`mc/cadence-rearm/lengthen-poll-later`<br>`mc/cadence-rearm/shorten-poll-soon`<br>`mc/cadence-rearm/lengthen-recheck-later` |
| `mutcheck-consent-authorship` | 8 | `mc/consent-authorship/unmarked-reopens-but-not-consent`<br>`mc/consent-authorship/human-approval-consents`<br>`mc/consent-authorship/sibling-approval-not-consent`<br>`mc/consent-authorship/agent-unstamped-heading-not-consent`<br>`mc/consent-authorship/spent-approval-reported`<br>`mc/consent-authorship/sibling-does-not-spend`<br>`mc/consent-authorship/reapproval-after-spent`<br>`mc/consent-authorship/fenced-marker-inert` |
| `mutcheck-consent-vocab` | 5 | `mc/consent-vocab/merge-number-accepted`<br>`mc/consent-vocab/bare-merge-rejected`<br>`mc/consent-vocab/agent-merge-narrative-rejected`<br>`mc/consent-vocab/yes-still-accepted`<br>`mc/consent-vocab/approve-still-accepted` |
| `mutcheck-consent-vocab-drift` | 6 | `mc/consent-vocab-drift/send-it-accepted`<br>`mc/consent-vocab-drift/make-it-so-accepted`<br>`mc/consent-vocab-drift/proceed-accepted`<br>`mc/consent-vocab-drift/vibe-it-accepted`<br>`mc/consent-vocab-drift/merge-number-accepted`<br>`mc/consent-vocab-drift/merge-it-later-rejected` |
| `mutcheck-critical-tools` | 4 | `mc/critical-tools/configured-tools`<br>`mc/critical-tools/default-tools-with-no-row`<br>`mc/critical-tools/unknown-tool-refused`<br>`mc/critical-tools/duplicates-are-unique` |
| `mutcheck-dead-session-verdict` | 5 | `mc/dead-session-verdict/dead-stale-replace`<br>`mc/dead-session-verdict/recent-events-reuse`<br>`mc/dead-session-verdict/missing-events-reuse`<br>`mc/dead-session-verdict/routine-shutdown-reuse`<br>`mc/dead-session-verdict/replacement-counts` |
| `mutcheck-decision-record` | 4 | `mc/decision-record/appends-ordered-reasons`<br>`mc/decision-record/rejects-free-text-outcome`<br>`mc/decision-record/rejects-full-scan-array`<br>`mc/decision-record/retention-drops-stale-lines` |
| `mutcheck-declared-ask` | 9 | `mc/declared-ask-write/missing-ask-refused`<br>`mc/declared-ask-write/bad-value-refused`<br>`mc/declared-ask-write/handwritten-stamp-refused`<br>`mc/declared-ask-write/stamps-blocking`<br>`mc/declared-ask-write/stamps-offer`<br>`mc/declared-ask-write/stamps-none`<br>`mc/declared-ask/reader-matrix`<br>`mc/declared-ask/blocking-opens-deferred`<br>`mc/declared-ask/offer-holds-deferred` |
| `mutcheck-direct-dispatch-drain` | 2 | `mc/direct-dispatch-drain/refill-rescan-after-mark`<br>`mc/direct-dispatch-drain/refill-rescan-after-user-pause` |
| `mutcheck-dispatch-stamp` | 6 | `mc/dispatch-stamp/inspection-does-not-authorise-or-stamp`<br>`mc/dispatch-stamp/check-readonly-and-stale-refused`<br>`mc/dispatch-stamp/for-dispatch-authorises-and-stamps`<br>`mc/dispatch-stamp/bind-does-not-stamp`<br>`mc/dispatch-stamp/dispatch-input-required`<br>`mc/dispatch-stamp/paused-refused-before-stamp` |
| `mutcheck-doc-binding` | 7 | `mc/doc-binding/bind-docid-url-stamps-journal`<br>`mc/doc-binding/rebind-conflict-and-force`<br>`mc/doc-binding/observe-text-dump-two-phase-ack`<br>`mc/doc-binding/observe-json-array-accepted`<br>`mc/doc-binding/unbind-reheals-from-journal-stamp`<br>`mc/doc-binding/journal-doc-meta-self-heals`<br>`mc/doc-binding/scan-reports-doc-fields` |
| `mutcheck-doc-channel-provenance` | 3 | `mc/doc-channel-provenance/scan-distinguishes-unread-fresh-stale`<br>`mc/doc-channel-provenance/freshness-threshold-env-overrides`<br>`mc/doc-channel-provenance/unparseable-observed-at-is-unread` |
| `mutcheck-doc-consent` | 7 | `mc/doc-consent/inert-without-doccomments`<br>`mc/doc-consent/doc-comment-affirmative-grants`<br>`mc/doc-consent/floor-outranks-doc-comment`<br>`mc/doc-consent/agent-comment-revokes-doc-channel`<br>`mc/doc-consent/missing-dump-refuses`<br>`mc/doc-consent/silent-comment-refuses`<br>`mc/doc-consent/journal-approval-keeps-provenance` |
| `mutcheck-gate-edit-ask` | 12 | `mc/gate-edit-ask-write/live-gate-edit-refused`<br>`mc/gate-edit-ask-write/verified-gatepath-clean`<br>`mc/gate-edit-ask-write/discussion-clean`<br>`mc/gate-edit-ask-write/fenced-example-clean`<br>`mc/gate-edit-ask-write/disable-g18-clears`<br>`mc/gate-edit-ask/live-gate-edit-refused`<br>`mc/gate-edit-ask/add-line-refused`<br>`mc/gate-edit-ask/ordinary-ask-allowed`<br>`mc/gate-edit-ask/discussion-allowed`<br>`mc/gate-edit-ask/verified-edit-allowed`<br>`mc/gate-edit-ask/fenced-example-allowed`<br>`mc/gate-edit-ask/disable-guard-allows` |
| `mutcheck-gate-settings-source` | 6 | `mc/gate-settings-source/default-sources-with-no-settings`<br>`mc/gate-settings-source/planner-folder-settings-source`<br>`mc/gate-settings-source/cwd-settings-precede-planner-folder`<br>`mc/gate-settings-source/off-is-configured`<br>`mc/gate-settings-source/malformed-settings-source`<br>`mc/gate-settings-source/argument-source-wins` |
| `mutcheck-issue-shipped` | 3 | `mc/issue-shipped/json-shipped-result-refuses`<br>`mc/issue-shipped/classifier-fail-advisory`<br>`mc/issue-shipped/disable-g15-clears-refusal` |
| `mutcheck-journal-decode` | 1 | `mc/journal-decode/nonascii-seed-stability` |
| `mutcheck-journal-encoding` | 1 | `mc/journal-encoding/mark-preserves-nonascii` |
| `mutcheck-journal-extract` | 3 | `mc/journal-extract/markdown-budget`<br>`mc/journal-extract/json-budget`<br>`mc/journal-extract/verify-budget` |
| `mutcheck-live-ask-unstamped` | 1 | `mc/live-ask-unstamped/scan-unstamped-recovered` |
| `mutcheck-managed-heading` | 5 | `mc/managed-heading/second-turn-quiet`<br>`mc/managed-heading/ascii-second-turn-quiet`<br>`mc/managed-heading/reply-after-second-turn`<br>`mc/managed-heading/sibling-after-second-turn`<br>`mc/managed-heading/mark-stamps-second-turn` |
| `mutcheck-observe-bound-docs` | 2 | `mc/observe-bound-docs/observe-refreshes-stale-channel`<br>`mc/observe-bound-docs/unreadable-observe-does-not-refresh` |
| `mutcheck-optional-offer-park` | 1 | `mc/optional-offer-park/matrix` |
| `mutcheck-pacing-concurrency` | 7 | `mc/pacing-concurrency/default-no-row`<br>`mc/pacing-concurrency/settings-row`<br>`mc/pacing-concurrency/backticked-value`<br>`mc/pacing-concurrency/zero-visible`<br>`mc/pacing-concurrency/word-visible`<br>`mc/pacing-concurrency/prose-no-widen`<br>`mc/pacing-concurrency/empty-cell-default` |
| `mutcheck-per-task-session` | 8 | `mc/per-task-session/unbound-create`<br>`mc/per-task-session/bind-reuse-persist`<br>`mc/per-task-session/conflict-and-force`<br>`mc/per-task-session/dead-replace-continuation`<br>`mc/per-task-session/code-bind-refusals`<br>`mc/per-task-session/chat-bind-settings`<br>`mc/per-task-session/release-safe-teardown`<br>`mc/per-task-session/workspace-gone` |
| `mutcheck-phase0-lock-scope` | 2 | `mc/phase0-lock-scope/critical-tools-read-only-policy`<br>`mc/phase0-lock-scope/decisions-ledger-independent` |
| `mutcheck-phase07-ownership` | 3 | `mc/phase07-ownership/unbound-resolve-is-readonly`<br>`mc/phase07-ownership/scan-keeps-unbound-live-task`<br>`mc/phase07-ownership/explicit-bind-is-separate-owner` |
| `mutcheck-plan-dispatch` | 10 | `mc/plan-dispatch/scan-plan-review`<br>`mc/plan-dispatch/plan-dispatch-refusals`<br>`mc/plan-dispatch/authorised-plan-dispatch`<br>`mc/plan-dispatch/human-reply-suppresses-review`<br>`mc/plan-dispatch/deferred-today-gate`<br>`mc/plan-dispatch/g19-all-reversible-refused`<br>`mc/plan-dispatch/g19-gate-allowed-first-refused`<br>`mc/plan-dispatch/g19-unclassified-refused`<br>`mc/plan-dispatch/g19-gated-first-accepted`<br>`mc/plan-dispatch/g19-in-progress-reversible-accepted` |
| `mutcheck-pointer-turn` | 6 | `mc/pointer-turn/short-pointer-passes`<br>`mc/pointer-turn/narrative-refused-g9`<br>`mc/pointer-turn/docless-long-accepted`<br>`mc/pointer-turn/no-doc-link-refused-g10`<br>`mc/pointer-turn/no-ask-refused-g11`<br>`mc/pointer-turn/fenced-doc-meta-real-binding-wins` |
| `mutcheck-priority-order` | 5 | `mc/priority-order/board-order-and-gate`<br>`mc/priority-order/terminal-today-opens-gate`<br>`mc/priority-order/writing-does-not-release`<br>`mc/priority-order/declared-exhausted-releases-but-stays-first`<br>`mc/priority-order/reply-reclaims-exclusivity` |
| `mutcheck-reopened-closed` | 6 | `mc/reopened-closed/user-completed-done-reported-not-worked`<br>`mc/reopened-closed/user-completed-skip-reported-not-worked`<br>`mc/reopened-closed/active-and-proposed-reopen`<br>`mc/reopened-closed/agent-done-on-board-reopens`<br>`mc/reopened-closed/user-skip-on-board-stays-closed`<br>`mc/reopened-closed/remark-does-not-erase-agent-done-reply` |
| `mutcheck-scan-perf` | 2 | `mc/scan-perf/compact-shape`<br>`mc/scan-perf/scanoutfile-equivalence-shape` |
| `mutcheck-session-bind-backwards` | 5 | `mc/session-bind-backwards/forward-lineage`<br>`mc/session-bind-backwards/immediate-ancestor-refused`<br>`mc/session-bind-backwards/grand-ancestor-and-force-refused`<br>`mc/session-bind-backwards/new-session-after-chain`<br>`mc/session-bind-backwards/legacy-prior-refused` |
| `mutcheck-session-pause` | 6 | `mc/session-pause/paused-verdicts`<br>`mc/session-pause/not-paused-controls`<br>`mc/session-pause/resume-ordering`<br>`mc/session-pause/mark-preserves-and-clears-stamp`<br>`mc/session-pause/agent-cannot-unpause`<br>`mc/session-pause/for-dispatch-refuses-pause` |
| `mutcheck-shipped-pick` | 4 | `mc/shipped-pick/proposed-shipped-refused`<br>`mc/shipped-pick/unshipped-pick-clean`<br>`mc/shipped-pick/report-shipped-clean`<br>`mc/shipped-pick/pr-number-clean` |
| `mutcheck-sibling-reopen` | 1 | `mc/sibling-reopen/matrix` |
| `mutcheck-task-session-role` | 5 | `mc/task-session-role/role-line-and-coordinator`<br>`mc/task-session-role/whoami-bound-explicit`<br>`mc/task-session-role/whoami-env-default`<br>`mc/task-session-role/whoami-replaced-ids`<br>`mc/task-session-role/whoami-no-id-unknown` |
| `mutcheck-today-served` | 10 | `mc/today-served/writing-does-not-release`<br>`mc/today-served/named-declaration-releases`<br>`mc/today-served/empty-declaration-refused`<br>`mc/today-served/declaration-cannot-ride-status`<br>`mc/today-served/unworked-row-refuses-exhaustion`<br>`mc/today-served/strict-rollback-holds`<br>`mc/today-served/backstop-releases-stale-turn`<br>`mc/today-served/settings-backstop-holds`<br>`mc/today-served/explicit-backstop-outranks-file`<br>`mc/today-served/reply-beats-declaration` |
| `mutcheck-turn-ask` | 7 | `mc/turn-ask/colon-reply-not-ask`<br>`mc/turn-ask/needs-from-you-is-ask`<br>`mc/turn-ask/imperative-reply-is-ask`<br>`mc/turn-ask/info-no-ask-clean`<br>`mc/turn-ask/g14-question-offer-refused`<br>`mc/turn-ask/g14-none-opener-offer-clean`<br>`mc/turn-ask/g14-question-blocking-clean` |
| `mutcheck-turn-terminator` | 3 | `mc/turn-terminator/reopen-shapes`<br>`mc/turn-terminator/mark-stamps-terminator`<br>`mc/turn-terminator/no-stamp-over-reply` |
| `mutcheck-unstamped-runlog` | 1 | `mc/unstamped-runlog/matrix` |
| `mutcheck-user-pause-write` | 6 | `mc/user-pause-write/user-blocked-refused`<br>`mc/user-pause-write/user-proposed-refused`<br>`mc/user-pause-write/resumed-human-reply-allows`<br>`mc/user-pause-write/agent-blocked-allows`<br>`mc/user-pause-write/closed-done-allows`<br>`mc/user-pause-write/corrupt-state-advisory` |
| `mutcheck-workspace-verdict` | 5 | `mc/workspace-verdict/empty-worktree-replace`<br>`mc/workspace-verdict/healthy-worktree-reuse`<br>`mc/workspace-verdict/folder-not-judged`<br>`mc/workspace-verdict/deleted-worktree-replace`<br>`mc/workspace-verdict/uninspectable-reuse` |
| `mutcheck-write-turn` | 16 | `mc/write-turn/validate-no-id-text`<br>`mc/write-turn/validate-with-id-json`<br>`mc/write-turn/append-default-output-backup`<br>`mc/write-turn/append-json-output`<br>`mc/write-turn/refusal-text-g1`<br>`mc/write-turn/refusal-json-g7`<br>`mc/write-turn/bad-args-missing-body`<br>`mc/write-turn/bad-args-empty-body`<br>`mc/write-turn/bad-args-no-id-without-validate`<br>`mc/write-turn/bad-args-journal-not-found`<br>`mc/write-turn/sentinel-added`<br>`mc/write-turn/crlf-preserved`<br>`mc/write-turn/disable-guard-allows-g7`<br>`mc/write-turn/author-owner-supersedes-non-owner`<br>`mc/write-turn/g12-recent-state-refuses`<br>`mc/write-turn/g12-old-state-allows` |
| `mutcheck-write-turn-sentinel` | 4 | `mc/write-turn-sentinel/lf-adds-one`<br>`mc/write-turn-sentinel/crlf-adds-one-preserves`<br>`mc/write-turn-sentinel/idempotent-second-turn`<br>`mc/write-turn-sentinel/existing-sentinel-not-duplicated` |
<!-- COVERAGE:END -->
