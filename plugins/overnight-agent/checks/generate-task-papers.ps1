<#
  generate-task-papers.ps1 — PHASE 2.5 of an Overnight Agent run (issue #286).

  WHY THIS EXISTS
  ---------------
  A journal is a chronological log, and a log is the wrong shape for understanding a
  complicated task: the current state is scattered across every turn that ever touched
  it, newest last, interleaved with corrections. Shiv, filing #286:

    "The journal file is hard to understand and read. Same with telegram... What helps
     is one doc that assumes I have little context and is easy to read and comment on...
     It should be a paper. No talk about corrections and mistakes you made. That could
     go into appendix."

  This wrapper generates that paper for every task the agent has worked, into
  `<planner>\journal\paper\task-<id>.html`.

  ADDITIVE BY CONSTRUCTION
  ------------------------
  It only ever WRITES into `journal\paper\`. It never reads, moves or edits a journal,
  and it never touches the board. Deleting the `paper\` folder reverts the feature
  completely. That is the staging #286 asks for: "a way to deliver without impacting
  old features, then later we can make this primary."

  SAFE ON A NIGHTLY CADENCE
  -------------------------
  Rendering is deterministic — there is deliberately no "generated at <now>" stamp — so
  an unchanged journal produces byte-identical HTML and nothing is rewritten. Without
  that property this would churn every file in OneDrive on every run and destroy the one
  signal that matters, which is whether the task actually moved.

  A failure here must never abort a run: the papers are a reading convenience, and the
  journal remains the source of truth either way.
#>
[CmdletBinding()]
param(
  [string]$PlannerPath,
  [string]$Repo,
  [string[]]$Task,
  [switch]$Json,
  [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'

if (-not $PlannerPath) {
  $PlannerPath = if ($env:PLANNER_PATH) { $env:PLANNER_PATH }
                 else { Join-Path $env:OneDrive 'Apps\Focus Planner' }
}
if (-not (Test-Path $PlannerPath)) { throw "Planner folder not found: $PlannerPath" }

# The CLI ships in the repo, not in the deployed plugin tree: it imports the app's
# journal reader and the bridge's status/ask parsers, so it has to run from a checkout
# where those exist. Resolving it here (rather than hard-coding) keeps a pinned or
# worktree checkout working, the same way the Telegram "Bridge CLI" row does.
if (-not $Repo) {
  $Repo = if ($env:FOCUS_PLANNER_REPO) { $env:FOCUS_PLANNER_REPO } else { 'V:\repos\focus-planner' }
}
$cli = Join-Path $Repo 'packages\task-paper\bin\task-paper.js'
if (-not (Test-Path $cli)) { throw "task-paper CLI not found at $cli (set -Repo or FOCUS_PLANNER_REPO)" }

$argv = @('generate', '--planner', $PlannerPath)
if ($Task) { $argv += @('--task', ($Task -join ',')) }
if ($Json) { $argv += '--json' }

if ($WhatIf) {
  Write-Host "[task-papers] would run: node `"$cli`" $($argv -join ' ')"
  exit 0
}

& node $cli @argv
exit $LASTEXITCODE
