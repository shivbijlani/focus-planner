<#
.SYNOPSIS
  Skill-owned memory for the Overnight Agent. Tracks, per task, what the agent has
  already processed in each journal — so a user message appended at the BOTTOM of a
  journal (the natural way the Focus Planner app journals) reliably reopens the task.

.WHY
  The journal .md is the only thing the user touches; it stays pure prose. NO machine
  metadata lives in it. All structured state lives HERE, in the skill's own working dir
  ($env:LOCALAPPDATA\overnight-agent\state), which is local and never OneDrive-synced
  (so it can't hit the planner's sync-conflict bug). The user never sees or edits any of it.

.MODEL
  "Has the user changed this journal since I last wrote to it?"  ==  reopen.
  We answer it by hashing the journal and remembering the hash the agent left behind:
    - reopened = current-file-hash != processed_file_hash   (the user/app edited it)
    - on first sight of a journal (no state yet), reopened = there is user prose AFTER
      the agent's last block (catches already-reopened tasks like #293 on the first run).
  The agent calls `mark` after it writes its turn, which re-snapshots the hash.

.COMMANDS
  seed   [-Force]                Initialise state for every journal (one-time / migration).
  scan                          Emit the per-run worklist as JSON (what changed / reopened /
                                due_poll).
  get    -Id <id>               Print one task's state JSON.
  mark   -Id <id> [-Status s] [-Version n] [-PlanId p]
                                Record that the agent has processed the journal as it now
                                stands (re-snapshots processed_file_hash + updates fields).
         [-Poll <cadence>]      Register/update a recurring poll on the task so `scan` surfaces
                                it on a timer even when the journal is untouched. Cadence is one
                                of: hourly | daily | weekly | <N>h | <N>d | <N>m. A freshly
                                registered poll is due immediately (next scan reports due_poll).
         [-PollDone]            Record that the poll just ran: stamp last_polled = now and push
                                next_due forward by the cadence interval.
         [-PollClear]           Remove the poll from the task.

.POLLING (why this exists)
  `scan` only flags journals the USER has touched, so a purely time-triggered job (e.g. #400's
  daily "check the video-backup folder and upload any drops") is invisible to it — if the user
  never replies, the agent never gets reminded and the poll silently stops. A poll lives in the
  skill's own state (never in the journal), so the agent can register it once, then every run:
  read `scan`, act on any row with `due_poll: true`, and `mark -PollDone` to re-arm it. The user
  sees nothing about it.

.EXAMPLES
  pwsh oa-state.ps1 seed
  pwsh oa-state.ps1 scan
  pwsh oa-state.ps1 get  -Id 293
  pwsh oa-state.ps1 mark -Id 305 -Status proposed -Version 1 -PlanId t305-v1
  pwsh oa-state.ps1 mark -Id 400 -Poll daily          # arm a daily poll on #400
  pwsh oa-state.ps1 mark -Id 400 -PollDone            # after running it this run
  pwsh oa-state.ps1 mark -Id 400 -PollClear           # stop polling #400
#>

[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('seed', 'scan', 'get', 'mark')]
  [string]$Command = 'scan',

  [string]$Id,
  [string]$Status,
  [int]$Version,
  [string]$PlanId,
  [switch]$Force,

  # Polling (time-triggered worklist). See .POLLING in the header.
  [string]$Poll,
  [switch]$PollDone,
  [switch]$PollClear,

  # Overridable so the skill stays shareable; defaults match user-settings.md.
  [string]$JournalDir = "$env:USERPROFILE\OneDrive\Apps\Focus Planner\journal",
  [string]$StateDir = "$env:LOCALAPPDATA\overnight-agent\state"
)

$ErrorActionPreference = 'Stop'

function Ensure-StateDir {
  if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Path $StateDir -Force | Out-Null }
}

function Get-Sha256([string]$text) {
  # Normalise newlines so OneDrive CRLF/LF churn never looks like a user edit.
  $norm = ($text -replace "`r`n", "`n")
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($norm)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '' }
  finally { $sha.Dispose() }
}

function Get-AgentEndIndex([string]$content) {
  # End offset of the agent's LAST turn. The journal is a bottom-appended chat: agent turns
  # are marked by `<!-- from: overnight-agent -->`, the managed `<!-- oa-state ... -->` block,
  # or the OVERNIGHT-AGENT sentinel. The agent's last turn is whichever marker appears latest;
  # its turn runs until the next `## ` section heading (the following, user, entry) or EOF.
  # Anything after that end is USER content the agent hasn't answered yet -> reopen.
  $markers = @(
    $content.LastIndexOf('<!-- from: overnight-agent -->'),
    $content.LastIndexOf('<!-- oa-state'),
    $content.LastIndexOf('OVERNIGHT-AGENT do not edit')
  )
  $agentMarker = ($markers | Measure-Object -Maximum).Maximum
  if ($agentMarker -lt 0) { return -1 }
  $nextHeading = $content.IndexOf("`n## ", $agentMarker)
  if ($nextHeading -lt 0) { return $content.Length }
  return $nextHeading + 1
}

function Parse-LegacyOaState([string]$content) {
  # Read the LAST in-journal oa-state JSON, if any, to bootstrap status on migration.
  $m = [regex]::Matches($content, 'oa-state\s*\r?\n\s*(\{.*?\})\s*\r?\n\s*-->', 'Singleline')
  if ($m.Count -eq 0) { return $null }
  try { return ($m[$m.Count - 1].Groups[1].Value | ConvertFrom-Json) } catch { return $null }
}

function Get-JournalFacts([string]$path) {
  $content = Get-Content -Raw -Path $path
  if ($null -eq $content) { $content = '' }
  $id = [System.IO.Path]::GetFileNameWithoutExtension($path) -replace '^task-', ''
  $agentEnd = Get-AgentEndIndex $content
  $hasAgentBlock = $agentEnd -ge 0
  if ($agentEnd -lt 0) { $agentEnd = 0 }
  $agentLeft = $content.Substring(0, [Math]::Min($agentEnd, $content.Length))
  $trailing = if ($agentEnd -lt $content.Length) { $content.Substring($agentEnd) } else { '' }
  [pscustomobject]@{
    Id              = $id
    Path            = $path
    HasAgentBlock   = $hasAgentBlock
    FullHash        = Get-Sha256 $content
    AgentLeftHash   = Get-Sha256 $agentLeft     # file as the agent last left it (no trailing user prose)
    HasTrailingUser = ($trailing.Trim().Length -gt 0)
    Legacy          = Parse-LegacyOaState $content
  }
}

function State-Path([string]$id) { Join-Path $StateDir "task-$id.json" }

function Read-State([string]$id) {
  $p = State-Path $id
  if (Test-Path $p) { return (Get-Content -Raw $p | ConvertFrom-Json) }
  return $null
}

function Write-State($obj) {
  Ensure-StateDir
  ($obj | ConvertTo-Json -Depth 6) | Set-Content -Path (State-Path $obj.id) -Encoding UTF8
}

function Now-Iso { (Get-Date).ToString('yyyy-MM-ddTHH:mm:ssK') }

function Set-Member($obj, [string]$name, $value) {
  # PSCustomObjects from ConvertFrom-Json can't take a new property via `$o.x = ...`; add it.
  if ($obj.PSObject.Properties[$name]) { $obj.$name = $value }
  else { $obj | Add-Member -NotePropertyName $name -NotePropertyValue $value }
}

function Parse-PollMinutes([string]$spec) {
  # Cadence -> interval in minutes. Accepts hourly|daily|weekly|<N>h|<N>d|<N>m (case-insensitive).
  switch -regex ($spec.Trim().ToLower()) {
    '^hourly$' { return 60 }
    '^daily$' { return 1440 }
    '^weekly$' { return 10080 }
    '^(\d+)\s*h$' { return [int]$Matches[1] * 60 }
    '^(\d+)\s*d$' { return [int]$Matches[1] * 1440 }
    '^(\d+)\s*m$' { return [int]$Matches[1] }
    default { throw "invalid -Poll cadence '$spec' (use hourly|daily|weekly|<N>h|<N>d|<N>m)" }
  }
}

function New-PollObject([string]$cadence, [int]$minutes, [string]$lastPolled, [datetime]$nextDue) {
  [pscustomobject]@{
    cadence          = $cadence
    interval_minutes = $minutes
    last_polled      = $lastPolled
    next_due         = $nextDue.ToString('yyyy-MM-ddTHH:mm:ssK')
  }
}

function Test-PollDue($poll) {
  # A poll with no next_due (freshly armed / malformed) is treated as due now.
  if (-not $poll) { return $false }
  if (-not $poll.next_due) { return $true }
  try { return ([datetime]::Parse($poll.next_due) -le (Get-Date)) }
  catch { return $true }
}

function Cmd-Seed {
  Ensure-StateDir
  $journals = Get-ChildItem $JournalDir -Filter 'task-*.md' -File | Where-Object { $_.BaseName -match '^task-\d+$' }
  $n = 0
  foreach ($f in $journals) {
    $facts = Get-JournalFacts $f.FullName
    if ((Read-State $facts.Id) -and -not $Force) { continue }
    $legacy = $facts.Legacy
    # Snapshot the hash of the file AS THE AGENT LAST LEFT IT (excludes any trailing user
    # prose). For a reopened task like #293 this differs from the current full hash, so the
    # very next `scan` correctly reports it reopened. Settled tasks have no trailing prose,
    # so AgentLeftHash == FullHash and they read as quiet.
    $state = [pscustomobject]@{
      id                  = $facts.Id
      status              = if ($legacy) { "$($legacy.status)" } elseif ($facts.HasAgentBlock) { 'unknown' } else { 'none' }
      version             = if ($legacy -and $legacy.version) { [int]$legacy.version } else { 0 }
      plan_id             = if ($legacy) { "$($legacy.plan_id)" } else { '' }
      processed_file_hash = $facts.AgentLeftHash
      has_agent_block     = $facts.HasAgentBlock
      seeded              = $true
      updated             = Now-Iso
    }
    Write-State $state
    $n++
  }
  Write-Output "seeded $n task state file(s) into $StateDir"
}

function Cmd-Scan {
  $journals = Get-ChildItem $JournalDir -Filter 'task-*.md' -File | Where-Object { $_.BaseName -match '^task-\d+$' } | Sort-Object Name
  $rows = foreach ($f in $journals) {
    $facts = Get-JournalFacts $f.FullName
    $st = Read-State $facts.Id
    $poll = $null
    if ($st) {
      $changed = ($facts.FullHash -ne $st.processed_file_hash)
      $reopened = $changed -and $facts.HasTrailingUser
      $status = "$($st.status)"
      if ($st.PSObject.Properties['poll']) { $poll = $st.poll }
    }
    else {
      # No memory yet: a task is "reopened/active" only if the user has left prose below the
      # agent's last block; otherwise it's genuinely new (no agent block) -> propose.
      $changed = $true
      $reopened = $facts.HasTrailingUser
      $status = if ($facts.HasAgentBlock) { 'unknown' } else { 'none' }
    }
    [pscustomobject]@{
      id            = $facts.Id
      status        = $status
      changed       = $changed
      reopened      = $reopened
      has_agent_block = $facts.HasAgentBlock
      tracked       = [bool]$st
      due_poll      = [bool](Test-PollDue $poll)
      poll_cadence  = if ($poll) { "$($poll.cadence)" } else { $null }
    }
  }
  $rows | ConvertTo-Json -Depth 4
}

function Cmd-Get {
  if (-not $Id) { throw 'get requires -Id' }
  $st = Read-State $Id
  if (-not $st) { Write-Output "{}"; return }
  $st | ConvertTo-Json -Depth 6
}

function Cmd-Mark {
  if (-not $Id) { throw 'mark requires -Id' }
  $path = Join-Path $JournalDir "task-$Id.md"
  if (-not (Test-Path $path)) { throw "no journal at $path" }
  $facts = Get-JournalFacts $path
  $st = Read-State $Id
  if (-not $st) {
    $st = [pscustomobject]@{ id = $Id; status = 'unknown'; version = 0; plan_id = ''; processed_file_hash = ''; has_agent_block = $true; seeded = $false; updated = $null }
  }
  if ($Status) { $st.status = $Status }
  if ($Version -gt 0) { $st.version = $Version }
  if ($PlanId) { $st.plan_id = $PlanId }

  # --- Polling -------------------------------------------------------------------
  $existingPoll = if ($st.PSObject.Properties['poll']) { $st.poll } else { $null }
  if ($PollClear) {
    Set-Member $st 'poll' $null
  }
  elseif ($Poll) {
    # (Re)arm: due immediately so the very next scan picks it up.
    $mins = Parse-PollMinutes $Poll
    Set-Member $st 'poll' (New-PollObject $Poll.Trim().ToLower() $mins '' (Get-Date))
  }
  elseif ($PollDone) {
    if (-not $existingPoll) { throw "task $Id has no poll to mark done (arm one with -Poll first)" }
    $mins = [int]$existingPoll.interval_minutes
    Set-Member $st 'poll' (New-PollObject "$($existingPoll.cadence)" $mins (Now-Iso) (Get-Date).AddMinutes($mins))
  }

  # Re-snapshot: the agent has now processed the journal as it currently stands.
  $st.processed_file_hash = $facts.FullHash
  $st.has_agent_block = $facts.HasAgentBlock
  $st.updated = Now-Iso
  Write-State $st
  $st | ConvertTo-Json -Depth 6
}

switch ($Command) {
  'seed' { Cmd-Seed }
  'scan' { Cmd-Scan }
  'get' { Cmd-Get }
  'mark' { Cmd-Mark }
}
