# Overnight Agent (Copilot CLI plugin)

Autonomously makes progress on your **Focus Planner** tasks overnight using a
per-task **plan → approve → execute** loop. The agent *proposes* a plan inside a
task's journal, you *approve* it (or ask for revisions), and only an **approved**
plan gets **executed**. Approval is the safety gate.

This plugin packages the `overnight-agent` skill (its `SKILL.md`, helper
PowerShell scripts, native task-dispatch extension, and a settings template) so it can be installed with one
command from the Focus Planner plugin marketplace.

## What's inside

```
overnight-agent/
├── plugin.json                 # Plugin manifest
└── skills/
    └── overnight-agent/
        ├── SKILL.md            # The skill instructions
        ├── user-settings.md    # Template — fill in your own values after install
        ├── oa-state.ps1        # Skill-owned per-task state (local, not synced)
        ├── check-google-token.ps1
        ├── ensure-mcp-browsers.ps1
        └── launch-signed-in-browser.ps1
```

## Install

From the marketplace (recommended):

```shell
copilot plugin marketplace add shivbijlani/focus-planner
copilot plugin install overnight-agent@focus-planner
```

Or install the plugin directly from the repo subdirectory:

```shell
copilot plugin install shivbijlani/focus-planner:plugins/overnight-agent
```

Verify it loaded:

```shell
copilot plugin list
```

```copilot
/skills list
```

## First-run setup

`skills/overnight-agent/user-settings.md` ships as a **placeholder template** so
the plugin is safe to publish. After installing, open it and replace every
`<...>` placeholder with your own values (planner paths, timezone, GitHub owner,
agent email account, and the email allow-lists). The skill reads this file at the
start of every run.

Keep your filled-in `user-settings.md` **out of any public repository** — see the
"Making your settings persist" section at the bottom of that file for durable
options.

## Usage

Ask Copilot to "run the overnight agent", "propose plans for my tasks", or
"execute approved plans". The skill's `SKILL.md` documents the full run flow
(inbox check → execute approved plans → propose new plans behind the approval
gate).

### Task capacity and dispatch

Use **`oa_scan` → `oa_capacity` → `oa_dispatch`** in the Copilot app. The extension is declared
in `plugin.json`; it invokes the app's native `get_sessions_status`, `get_session` and
`send_session_message` tools through the SDK. It needs those app tools, Node 22+ and Windows
PowerShell 5.1 (or `pwsh` elsewhere). Missing capabilities stop dispatch explicitly; a standalone
CLI without app activity cannot safely substitute task-state guesses.

Bindings preserve conversations; due timers select work. Neither occupies a worker. Capacity
counts app-busy **planner-bound executions** plus pending/uncertain deliveries, deduplicated when
several task bindings resolve to the same session. Other, unbound app sessions are outside this
planner admission scope. `actual_busy` distinguishes observed work from conservative charges.
New sessions must be created **idle, without a kickoff**, then bound and sent their brief through
`oa_dispatch`. Do not follow its success with a second raw message.

The wrapper queries fresh activity, atomically reserves a slot, fences the start, stamps the
wake, and performs the actual native send. OS-owned locking covers all state read/check/write
operations; a crash releases the lock. A preparation expires after two minutes and can no
longer send. A durable generation nonce fences snapshots when admission or receipt retirement
changes the evidence; stale observers must refresh even inside the 30-second freshness window.
Pass the task's `wake_key` from `oa_scan` to `oa_dispatch`. This identifies the worklist input,
not the transport: a fast-completing first wake cannot make a racing duplicate new work.
Changed task input requires a new brief, not an automatic retry of the old one.
A started send **never becomes free just because its deadline elapsed**: the
target must show that the unique dispatch interaction started or finished. A lost acceptance
response is therefore safe to inspect, but not safe to resend.

At that deadline, absent receipt evidence becomes **`dispatch_reconciliation_required`**, with
the token, target and recovery instruction in capacity output. Every `oa_capacity` / `oa_scan`
retries the read and retires resolved delivery records. A non-capacity acknowledgment receipt
remains for at most 15 minutes so reconciliation racing the sender's response cannot turn a
successful send into a failed one. After retention, acknowledgment trouble is still reported as
**accepted with a receipt warning**, never as permission to send again. Missing/stale app status, unreadable or
replaced logs, and logs exceeding the 16 MiB receipt-read budget stay visible and fail closed.
If evidence cannot be recovered, a human must resolve the uncertain app delivery; this plugin
does not cancel an app message, release a binding, reset a pause or restart a session to guess
its way out. This is an explicit blocked outcome, not an assertion that work is running.
If the app truncates its bulk status response, each bound identity is queried through
`get_session` instead and `activity_warnings` discloses that path; a failed individual lookup
still counts as unknown.

The configured limit bounds **scheduled admissions**, not all human activity. Direct human
wakes of bound tasks and explicit human collect-wave exceptions can create overlap; those
executions still occupy capacity for subsequent scheduled work. All coordinators must use the
new wrapper; mixed-version/raw callers are not protected by its atomic admission protocol.

`oa-state.ps1 session -InFlight -ActivitySnapshot <file>` remains the offline replay interface.
For a strictly read-only live audit, use `oa_capacity({ reconcile: false })`; it reports the
same evidence-based answer without retiring or garbage-collecting receipt files.
Without a fresh snapshot it reports unknown activity and zero admissions, not the former
readiness-based answer. `scan` emits per-task reasons and `capacity_units`; their sum matches
the deduplicated total, including explicitly ineligible state-only audit rows.

### Is this issue already shipped?

A shipped PR does not close its issue in this repo — it stays `OPEN` until the doc is
read — so `gh issue list` shows "nobody has done this" and "done, waiting on you"
identically. Measured 2026-09-08: 98 of 169 open issues were already shipped.

Before committing to an issue, ask:

```
node plugins/overnight-agent/checks/issue-shipped.mjs 588 620
```

`0` safe to pick up · `1` already shipped, pick something else · `2` could not classify
(**not** a pass) · `3` bad arguments.

It resolves each issue against implementation source on `origin/main` rather than the
commit log, because a commit subject names the PR, not the issue. `write-turn.ps1`'s G15
enforces the same answer on journal turns, so a run cannot recommend shipped work by
skipping the check (GH #635).
