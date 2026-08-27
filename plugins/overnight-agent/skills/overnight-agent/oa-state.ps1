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
  "Has the USER changed this journal since I last wrote to it?"  ==  reopen.
  We answer it by hashing the journal and remembering the hash the agent left behind:
    - reopened = current-file-hash != processed_file_hash   (the user/app edited it)
    - on first sight of a journal (no state yet), reopened = there is user prose AFTER
      the agent's last block (catches already-reopened tasks like #293 on the first run).
  The agent calls `mark` after it writes its turn, which re-snapshots the hash.

  WHERE the agent's turn ends is answered two ways, and the ORDER matters:
    1. EXACTLY, from the snapshot. `mark`/`seed` record `processed_len` next to
       `processed_file_hash`, so if the file still begins with the bytes the agent
       processed, everything past `processed_len` is provably new. Journals are
       bottom-appended chat, so this covers the normal way they grow and needs no
       guess about what the text looks like.
    2. HEURISTICALLY, by locating the agent's last marker and reading to the next
       `## ` heading. Needed for untracked journals and in-place rewrites, but it is
       blind when the agent's turn is the last `## ` section in the file: there is no
       closing delimiter, so a raw append at EOF used to be absorbed into the agent's
       own turn and silently swallowed (SKILL.md promises the opposite). That shape is
       the majority of the corpus, so (1) is what makes the promise true.
  The two are OR'd, never AND'd: a false reopen costs one look, a missed one loses the
  user's message.

  "The user" means the human, `<!-- from: me -->`, and nothing else. These journals are
  shared: sibling skills (dance-church, instagram-publisher-monitor, kranbox-backup, ...)
  append their own turns with their own `<!-- from: ... -->` stamps. Those are machine
  turns. Counting one as user prose pins the task at `reopened` permanently -- there is no
  human message to answer, and the sibling skill re-appends on its own schedule.

.COMMANDS
  seed   [-Force]                Initialise state for every journal (one-time / migration).
  backfill                      Add `processed_len` to pre-existing state files that predate
                                it, so the exact append check above works without waiting for
                                each task's next `mark`. Idempotent; never changes status.
  scan                          Emit the per-run worklist as JSON (what changed / reopened).
  get    -Id <id>               Print one task's state JSON.
  mark   -Id <id> [-Status s] [-Version n] [-PlanId p]
                                Record that the agent has processed the journal as it now
                                stands (re-snapshots processed_file_hash + updates fields).

.EXAMPLES
  pwsh oa-state.ps1 seed
  pwsh oa-state.ps1 scan
  pwsh oa-state.ps1 get  -Id 293
  pwsh oa-state.ps1 mark -Id 305 -Status proposed -Version 1 -PlanId t305-v1
#>

[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('seed', 'backfill', 'scan', 'get', 'mark')]
  [string]$Command = 'scan',

  [string]$Id,
  [string]$Status,
  [int]$Version,
  [string]$PlanId,
  [switch]$Force,

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

# A journal turn is stamped with a provenance marker, `<!-- from: <author> -->`. Exactly ONE
# author is the human -- `me`. Every other author is a machine: this agent
# (`overnight-agent`) and the sibling skills that also append turns to these same journals
# (`dance-church`, `instagram-publisher-monitor`, `kranbox-backup`, ...).
#
# Markers are matched at the START OF A LINE, because journals legitimately *discuss* these
# markers in prose; a quoted marker must not be mistaken for a real turn boundary.
$script:HumanAuthor   = 'me'
$script:SelfAuthor    = 'overnight-agent'
$script:ProvenanceRe  = '(?m)^[ \t]*<!--[ \t]*from:[ \t]*([^>\r\n]*?)[ \t]*-->'
$script:LegacyStateRe = '(?m)^[ \t]*<!--[ \t]*oa-state'

# `### Run log` is SKILL.md's managed heading for this agent's execution record. Only this
# agent writes it, so it is a reliable machine-turn marker even in the many historical
# journals where the agent replied without stamping a `<!-- from: overnight-agent -->`
# provenance marker at all.
#
# The trailing `\r?` is load-bearing: these journals round-trip through OneDrive and the
# planner web app, so CRLF is common. `$` in .NET multiline mode matches before the `\n`,
# which leaves the `\r` unconsumed -- and `[ \t]` does not match `\r`. Without it the
# heading is simply never found on a CRLF file and the whole recovery silently no-ops.
$script:RunLogRe = '(?m)^[ \t]*###[ \t]+Run log[ \t]*\r?$'

# An EXPLICIT end-of-turn boundary, written by `mark`. The heuristic below can find where a
# turn ENDS only when a later `## ` heading closes it; when the agent's turn is the last
# section in the file there is no such delimiter, and the boundary is genuinely undecidable
# from content (an agent turn can end in a plain prose paragraph that is indistinguishable
# from a short human reply). So the agent states it outright instead of guessing. It is an
# HTML comment, so it never renders in the journal the user reads.
$script:TurnEndMarker = '<!-- /overnight-agent turn-end -->'
$script:TurnEndRe = '(?m)^[ \t]*<!--[ \t]*/overnight-agent[ \t]+turn-end[ \t]*-->[ \t]*\r?$'

# The shape of a run-log body: the heading itself, blank lines, the bold date line
# (`**2026-08-26 (overnight):**`), list items, and indented wrapped continuations.
# Anything else in that region is prose this agent did not write.
$script:RunLogBodyLineRe = '^(?:[ \t\r]*$|[ \t]*###[ \t]+Run log[ \t\r]*$|[ \t]*\*\*.*$|[ \t]*[-*+][ \t].*$|[ \t]*\d+\.[ \t].*$|[ \t]+\S.*$)'

function Get-LastIndexOfPattern([string]$content, [string]$pattern) {
  $idx = -1
  foreach ($m in [regex]::Matches($content, $pattern)) { $idx = $m.Index }
  return $idx
}

function Test-IsRunLogBodyOnly([string]$region) {
  # Is this region nothing but the agent's own run-log entry? Used as a GUARD, so it must
  # answer "no" whenever it is unsure: a false "no" costs one needless look at a settled
  # task, a false "yes" silently swallows the user's message.
  foreach ($line in ($region -split "`r?`n")) {
    if ($line -notmatch $script:RunLogBodyLineRe) { return $false }
  }
  return $true
}

function Get-AgentEndIndex([string]$content) {
  # End offset of THIS agent's last turn: the latest of its own provenance marker, the legacy
  # managed `<!-- oa-state ... -->` block, or the OVERNIGHT-AGENT sentinel. The turn runs
  # until the next `## ` section heading (the following entry) or EOF.
  #
  # NOTE the boundary is deliberately *this agent's* turn, not the last machine turn of any
  # kind. If it were the latter, a sequence of [user reply] -> [sibling skill turn] would put
  # the user's unanswered message ABOVE the boundary and silently swallow it.
  $sentinelMarker = $content.LastIndexOf('OVERNIGHT-AGENT do not edit')
  $selfMarker = -1
  foreach ($m in [regex]::Matches($content, $script:ProvenanceRe)) {
    if ($m.Groups[1].Value.Trim() -eq $script:SelfAuthor) { $selfMarker = $m.Index }
  }

  $markers = @(
    $selfMarker,
    (Get-LastIndexOfPattern $content $script:LegacyStateRe),
    $sentinelMarker
  )
  $agentMarker = ($markers | Measure-Object -Maximum).Maximum
  if ($agentMarker -lt 0) { return -1 }

  # An explicit turn-end stamp at or after the agent's anchor outranks every heuristic below:
  # the agent recorded where its own turn stopped, so there is nothing left to infer. This is
  # what makes a raw append at EOF visible -- without it the turn has no closing delimiter and
  # the append is absorbed into the turn (SKILL.md promises it reopens the task).
  $stamp = $null
  foreach ($m in [regex]::Matches($content, $script:TurnEndRe)) {
    if ($m.Index -ge $agentMarker) { $stamp = $m }
  }
  if ($stamp) {
    $eol = $content.IndexOf("`n", $stamp.Index + $stamp.Length - 1)
    return $(if ($eol -lt 0) { $content.Length } else { $eol + 1 })
  }

  $nextHeading = $content.IndexOf("`n## ", $agentMarker)
  if ($agentMarker -eq $sentinelMarker -and $nextHeading -ge 0) {
    # The first H2 after the sentinel is the managed "Overnight Agent" heading, not a user
    # turn. Search for the next H2 after that heading instead.
    $headingEnd = $content.IndexOf("`n", $nextHeading + 1)
    if ($headingEnd -lt 0) { return $content.Length }
    $nextHeading = $content.IndexOf("`n## ", $headingEnd)
  }
  if ($nextHeading -lt 0) { return $content.Length }
  $end = $nextHeading + 1

  # --- Unstamped run-log recovery -------------------------------------------------------
  # Most historical journals contain NO `<!-- from: overnight-agent -->` marker: the agent
  # answered the user by appending a `### Run log` under their `## <date>` entry. The
  # boundary above then lands on that user heading, so the agent's own reply sits in the
  # "trailing" region and is mistaken for unanswered user prose -- pinning the journal at
  # HasTrailingUser=true forever. It reads as quiet only while the file is byte-identical to
  # the last snapshot, so any in-place edit by a sibling sweep (a dead-link rewrite, an
  # apostrophe repair) flips `changed` and the task false-reopens with a message that was
  # answered weeks ago.
  #
  # So: if this agent's `### Run log` appears AFTER the boundary, its reply is the newest
  # turn and the boundary belongs after it. Guarded by Test-IsRunLogBodyOnly, which refuses
  # to advance over anything that is not run-log shaped -- so raw user text appended below a
  # run log still reopens the task.
  $runLog = Get-LastIndexOfPattern $content $script:RunLogRe
  if ($runLog -ge $end) {
    $afterRunLog = $content.IndexOf("`n## ", $runLog)
    $regionEnd = if ($afterRunLog -lt 0) { $content.Length } else { $afterRunLog + 1 }
    $region = $content.Substring($runLog, $regionEnd - $runLog)
    if (Test-IsRunLogBodyOnly $region) { return $regionEnd }
  }

  return $end
}

function Test-TrailingHasUser([string]$trailing) {
  # Is there HUMAN content below this agent's last turn? Only the human reopens a task.
  #
  # The trailing region is a chat thread and may mix authors, because sibling skills append
  # their own turns here too. Split it into `## ` entries and judge each one by its marker:
  #   - `<!-- from: me -->`  -> the human spoke. Reopen.
  #   - any other marker     -> a sibling skill's turn. NOT a reopen: there is no message for
  #                             this agent to answer, and that skill re-appends on its own
  #                             schedule, so treating it as user prose pins the task at
  #                             `reopened` forever.
  #   - no marker at all     -> genuinely ambiguous (older journals, hand edits). Treat as the
  #                             human, which is the conservative direction: a false reopen
  #                             costs a look, a missed one loses the user's message.
  if ($trailing.Trim().Length -eq 0) { return $false }

  # Entry boundaries are H2 headings; text before the first heading belongs to the region as-is.
  $entries = [regex]::Split($trailing, '(?m)(?=^## )') | Where-Object { $_.Trim().Length -gt 0 }
  foreach ($entry in $entries) {
    $marks = [regex]::Matches($entry, $script:ProvenanceRe)
    if ($marks.Count -eq 0) { return $true }
    foreach ($m in $marks) {
      if ($m.Groups[1].Value.Trim() -eq $script:HumanAuthor) { return $true }
    }
  }
  return $false
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
    Content         = $content
    AgentEnd        = [Math]::Min($agentEnd, $content.Length)
    HasAgentBlock   = $hasAgentBlock
    FullHash        = Get-Sha256 $content
    AgentLeftHash   = Get-Sha256 $agentLeft     # file as the agent last left it (no trailing user prose)
    HasTrailingUser = (Test-TrailingHasUser $trailing)
    Legacy          = Parse-LegacyOaState $content
  }
}

function Get-AppendedSince($facts, $st) {
  # The EXACT half of the boundary question (see .MODEL): what, if anything, has been added
  # to this journal since the agent last processed it?
  #
  # `mark`/`seed` record the length of the content they hashed. If the file is longer now and
  # still *starts with* exactly those bytes -- proven by re-hashing the prefix, not by trusting
  # the length alone -- then the remainder is provably new text that arrived afterwards. No
  # lexical guess is involved, so it works for the 217-of-239 journals whose agent turn is the
  # last `## ` section and therefore has no closing delimiter for the heuristic to find.
  #
  # Returns $null when the question cannot be answered exactly (no recorded length, file
  # shorter, or an in-place rewrite so the prefix no longer matches). Callers then fall back
  # to the heuristic rather than assuming "nothing was appended".
  if (-not $st) { return $null }
  $len = $st.PSObject.Properties['processed_len']
  if (-not $len -or $null -eq $len.Value) { return $null }
  $len = [int]$len.Value
  if ($len -lt 0 -or $len -gt $facts.Content.Length) { return $null }
  if ((Get-Sha256 $facts.Content.Substring(0, $len)) -ne "$($st.processed_file_hash)") { return $null }
  return $facts.Content.Substring($len)
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
      processed_len       = $facts.AgentEnd     # length of the content that hash covers
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
    if ($st) {
      $changed = ($facts.FullHash -ne $st.processed_file_hash)
      # Two independent readings of "did the user speak below my last turn?", OR'd. See
      # .MODEL: the appended-text check is exact but needs a recorded length; the trailing
      # check is always available but cannot see a raw append at EOF. Either one is enough.
      $appended = Get-AppendedSince $facts $st
      $appendedHasUser = ($null -ne $appended) -and (Test-TrailingHasUser $appended)
      $reopened = $changed -and ($facts.HasTrailingUser -or $appendedHasUser)
      $status = "$($st.status)"
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

function Add-TurnEndStamp($facts) {
  # Record where this turn ended, so the next scan does not have to guess. Deliberately
  # conservative:
  #   - SKIPPED when the journal still shows unanswered user prose. `mark` would otherwise
  #     stamp *over* the user's message and permanently swallow it -- the exact failure this
  #     whole mechanism exists to prevent.
  #   - APPEND-ONLY and idempotent, so it can never disturb a byte the user wrote.
  # Returns the new content, or $null when nothing was written.
  if ($facts.HasTrailingUser) { return $null }
  $content = $facts.Content
  $trimmed = $content.TrimEnd()
  if ($trimmed.Length -eq 0) { return $null }
  $lastLine = ($trimmed -split "`r?`n")[-1]
  if ($lastLine -match $script:TurnEndRe) { return $null }   # already stamped
  $nl = if ($content -match "`r`n") { "`r`n" } else { "`n" }
  $new = $trimmed + $nl + $nl + $script:TurnEndMarker + $nl
  [System.IO.File]::WriteAllText($facts.Path, $new, [System.Text.UTF8Encoding]::new($false))
  return $new
}

function Set-StateProp($st, [string]$name, $value) {
  # State files written before a property existed simply lack it, so assigning would throw.
  if ($st.PSObject.Properties[$name]) { $st.$name = $value }
  else { $st | Add-Member -NotePropertyName $name -NotePropertyValue $value }
}

function Cmd-Mark {
  if (-not $Id) { throw 'mark requires -Id' }
  $path = Join-Path $JournalDir "task-$Id.md"
  if (-not (Test-Path $path)) { throw "no journal at $path" }
  $facts = Get-JournalFacts $path
  $st = Read-State $Id
  if (-not $st) {
    $st = [pscustomobject]@{ id = $Id; status = 'unknown'; version = 0; plan_id = ''; processed_file_hash = ''; processed_len = $null; has_agent_block = $true; seeded = $false; updated = $null }
  }
  if ($Status) { $st.status = $Status }
  if ($Version -gt 0) { $st.version = $Version }
  if ($PlanId) { $st.plan_id = $PlanId }
  # Stamp the end of the turn FIRST, then snapshot -- the hash has to describe the file as it
  # now stands on disk, stamp included, or the very next scan reports a phantom change.
  if ($facts.HasAgentBlock -and (Add-TurnEndStamp $facts)) { $facts = Get-JournalFacts $path }
  # Re-snapshot: the agent has now processed the journal as it currently stands. The length
  # must be recorded with the hash -- it is what lets the next `scan` prove that any extra
  # bytes are new (see Get-AppendedSince).
  Set-StateProp $st 'processed_file_hash' $facts.FullHash
  Set-StateProp $st 'processed_len' $facts.Content.Length
  Set-StateProp $st 'has_agent_block' $facts.HasAgentBlock
  Set-StateProp $st 'updated' (Now-Iso)
  Write-State $st
  $st | ConvertTo-Json -Depth 6
}

function Cmd-Backfill {
  # State written before `processed_len` existed cannot use the exact append check, which
  # would leave those tasks on the blind heuristic until each one happened to be marked
  # again. Derive the missing length from the hash already stored -- only ever accepting a
  # candidate whose prefix re-hashes to that exact value, so a wrong length is impossible.
  $journals = Get-ChildItem $JournalDir -Filter 'task-*.md' -File | Where-Object { $_.BaseName -match '^task-\d+$' } | Sort-Object Name
  $filled = 0; $already = 0; $undecidable = 0; $untracked = 0
  foreach ($f in $journals) {
    $facts = Get-JournalFacts $f.FullName
    $st = Read-State $facts.Id
    if (-not $st) { $untracked++; continue }
    $p = $st.PSObject.Properties['processed_len']
    if ($p -and $null -ne $p.Value) { $already++; continue }

    # The two bases a hash could have been taken on: the whole file (`mark`) or the file as
    # the agent left it (`seed`). Verify, never assume.
    $len = $null
    foreach ($cand in @($facts.Content.Length, $facts.AgentEnd)) {
      if ($cand -lt 0 -or $cand -gt $facts.Content.Length) { continue }
      if ((Get-Sha256 $facts.Content.Substring(0, $cand)) -eq "$($st.processed_file_hash)") { $len = $cand; break }
    }
    if ($null -eq $len) { $undecidable++; continue }
    Set-StateProp $st 'processed_len' $len
    Write-State $st
    $filled++
  }
  Write-Output "backfill: filled $filled, already had it $already, undecidable $undecidable, untracked $untracked"
}

switch ($Command) {
  'seed' { Cmd-Seed }
  'backfill' { Cmd-Backfill }
  'scan' { Cmd-Scan }
  'get' { Cmd-Get }
  'mark' { Cmd-Mark }
}
