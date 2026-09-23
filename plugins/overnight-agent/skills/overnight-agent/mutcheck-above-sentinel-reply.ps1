<#
  mutcheck-above-sentinel-reply.ps1 -- proves the #569 reader is load-bearing AND bounded.

  THE DEFECT

  `reopened` and `unanswered_user` read the region BELOW the agent's turn-end stamp, because
  that is where the Telegram bridge appends. The planner app writes Shiv's edits into his own
  space at the TOP of the file, above the sentinel -- structurally invisible to both.

  Measured live 2026-09-06 on task #472: row 1 of `## Today`, urgency red, carrying his list
  for that day, reported `eligible: false` / `not_workable` to every run, while `extract`
  listed the same text as a user message. Two readers of one file, disagreeing.

  WHY THE ARMS ARE MOSTLY ABOUT NOT FIRING

  This flag WIDENS workability, so the risk is not missing his message -- it is marking the
  whole board unanswered and becoming noise, at which point it gets ignored and the surface is
  unguarded while appearing guarded. Three separate latching hazards were measured out of it
  while it was built, and each is pinned below as its own arm:

    scope       scanning "the file as the agent left it" instead of HIS space re-read the
                whole answered conversation -> 119 of 267 rows
    same-day    an inclusive date compare re-fired on messages already answered that day
    no turn     treating a missing `last_turn_at` as "unanswered" latched on every legacy
                state file that predates the field -> 18 rows, several with no message at all

  Each of those read as a plausible fix and was wrong, so each gets a fixture that would pass
  if the hazard came back.

  Criterion 4 of the issue is PAIRED-POSITION: two journals differing ONLY in whether his
  block sits above the sentinel or below the stamp must produce the SAME verdict. Today they
  produce opposite ones.

  HERMETIC. Synthetic journals, state and board under TEMP, driving the REAL oa-state.ps1.
  Exit 0 = every arm agreed.
#>
[CmdletBinding()]
param([string]$ScriptPath)

$ErrorActionPreference = 'Stop'
if (-not $ScriptPath) { $ScriptPath = Join-Path $PSScriptRoot 'oa-state.ps1' }
if (-not (Test-Path $ScriptPath)) { throw "oa-state.ps1 not found at $ScriptPath" }

$script:PsExe = if ($PSVersionTable.PSEdition -eq 'Core') { (Get-Process -Id $PID).Path } else { 'powershell' }
$utf8 = New-Object Text.UTF8Encoding($false)
$MOON = [char]::ConvertFromUtf32(0x1F319)

$root = Join-Path ([IO.Path]::GetTempPath()) ("oa-569-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$J = Join-Path $root 'journal'; New-Item -ItemType Directory -Path $J -Force | Out-Null
$S = Join-Path $root 'state';   New-Item -ItemType Directory -Path $S -Force | Out-Null
$board = Join-Path $root 'planner.md'
[IO.File]::WriteAllText($board, "# Planner`n`n## Today`n`n| ID | Urgency | Task |`n| 999 | Red | fixture row |`n", $utf8)

$script:pass = 0
$script:fail = 0
function Assert([bool]$ok, [string]$name, [string]$why, [string]$detail = '') {
  if ($ok) { Write-Host "  PASS  $name  -- $why"; $script:pass++ }
  else {
    Write-Host "  FAIL  $name  -- $why" -ForegroundColor Red
    if ($detail) { Write-Host ("        got: " + $detail) -ForegroundColor DarkGray }
    $script:fail++
  }
}

$TURN = @"
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## $MOON Overnight Agent -- 2026-09-10 10:00 PT

<!-- from: overnight-agent -->
<!-- oa-ask: offer -->

**Status:** done.

<!-- /overnight-agent turn-end -->
"@

# His message ABOVE the sentinel, under a date heading -- the shape the planner app writes.
function JournalAbove([string]$date) {
  return "# Task 999: fixture`n`n## $date`n`n<!-- from: me -->`nhere is my request`n`n$TURN"
}
# The same message BELOW the turn-end stamp -- the shape the Telegram bridge writes.
function JournalBelow([string]$date) {
  return "# Task 999: fixture`n`n$TURN`n`n## $date`n`n<!-- from: me -->`nhere is my request`n"
}

function Scan([string]$journal, [string]$lastTurnAt = '2026-09-10T10:00:00-07:00', [string]$status = 'done') {
  [IO.File]::WriteAllText((Join-Path $J 'task-999.md'), $journal, $utf8)
  $st = [ordered]@{ id = '999'; status = $status; status_by = 'agent'; processed_file_hash = 'stale' }
  if ($lastTurnAt) { $st['last_turn_at'] = $lastTurnAt }
  [IO.File]::WriteAllText((Join-Path $S 'task-999.json'), ([pscustomobject]$st | ConvertTo-Json), $utf8)
  $argv = @($ScriptPath, 'scan', '-JournalDir', $J, '-StateDir', $S, '-PlannerBoard', $board)
  $out = (& $script:PsExe -NoProfile -ExecutionPolicy Bypass -File @argv 2>&1 | Out-String)
  try { return (($out | ConvertFrom-Json) | Where-Object { $_.id -eq '999' }) } catch { return $null }
}
function D($r) { if ($r) { "reopened=$($r.reopened) unanswered=$($r.unanswered_user) where=$($r.unanswered_user_where) eligible=$($r.eligible)" } else { 'scan produced no row' } }

Write-Host ''
Write-Host 'THE DEFECT -- a message in his own space must be seen'

$a = Scan (JournalAbove '2026-09-20')
Assert ($a -and $a.unanswered_user) 'SEEN' 'a dated message above the sentinel, newer than the turn, reads as unanswered' (D $a)
Assert ($a -and $a.unanswered_user_where -eq 'above-sentinel') 'WHERE' 'and the verdict names WHERE it was found, so a reader can audit it' (D $a)
Assert ($a -and $a.eligible) 'ELIGIBLE' 'which is enough to override an agent-declared done (#501)' (D $a)

# Criterion 4: position must not change the verdict.
$b = Scan (JournalBelow '2026-09-20')
Assert ($b -and $b.unanswered_user) 'PAIRED' 'the SAME message below the turn-end stamp still reads unanswered' (D $b)
Assert ($a.unanswered_user -eq $b.unanswered_user) 'POSITION' 'above and below agree -- position no longer decides visibility' ("above: $(D $a)  below: $(D $b)")

Write-Host ''
Write-Host 'QUIET -- the three latching hazards this was measured out of'

# 1. OLDER. `mark` must still make an answered task go silent.
$old = Scan (JournalAbove '2026-09-01')
Assert ($old -and -not $old.unanswered_user) 'OLDER' 'a message older than the turn stays quiet, so mark still silences a task' (D $old)

# 2. SAME DAY. A date heading carries no time, so it cannot be shown to postdate the turn.
#    An inclusive compare re-fired on every already-answered message: 119 of 267 rows.
$same = Scan (JournalAbove '2026-09-10')
Assert ($same -and -not $same.unanswered_user) 'SAMEDAY' 'a same-day message does not re-fire (the turn may have answered it)' (D $same)

# 3. NO TURN TIMESTAMP. Legacy state files predate `last_turn_at`; treating absence as
#    "unanswered" latched on 18 rows, several with no dated message at all.
$noTurn = Scan (JournalAbove '2026-09-20') ''
Assert ($noTurn -and -not $noTurn.unanswered_user) 'NOTURN' 'a missing last_turn_at grants nothing -- the flag is a recency claim' (D $noTurn)

# 4. THE OPENING FRAMING. Every journal starts with his undated description of the task.
#    Counting it would mark the whole board unanswered forever.
$undated = Scan "# Task 999: fixture`n`n<!-- from: me -->`nthe original task description`n`n$TURN"
Assert ($undated -and -not $undated.unanswered_user) 'UNDATED' 'the undated opening framing is not a fresh message' (D $undated)

# 5. FENCED. A quoted example of the marker must not impersonate him (#320).
$fenced = Scan "# Task 999: fixture`n`n## 2026-09-20`n`n``````n<!-- from: me -->`n``````n`n$TURN"
Assert ($fenced -and -not $fenced.unanswered_user) 'FENCED' 'a marker inside a fenced quotation is inert' (D $fenced)

# 6. AGENT TEXT. A dated heading with only the AGENT speaking is not him.
$agentOnly = Scan "# Task 999: fixture`n`n## 2026-09-20`n`n<!-- from: overnight-agent -->`nmy own note`n`n$TURN"
Assert ($agentOnly -and -not $agentOnly.unanswered_user) 'NOTHIM' 'a dated block attributed to the agent is not a message from him' (D $agentOnly)

Write-Host ''
Write-Host 'SCOPE -- his space only, not the whole answered conversation'

# The hazard that measured worst. A dated message from him INSIDE the managed region is part
# of the conversation the agent has already answered; reading it here re-opened 119 rows.
$inside = Scan "# Task 999: fixture`n`n$TURN`n`n## 2026-09-20`n`n<!-- from: me -->`nreply`n`n## $MOON Overnight Agent -- 2026-09-21 10:00 PT`n`n<!-- from: overnight-agent -->`n`n**Status:** answered.`n`n<!-- /overnight-agent turn-end -->"
Assert ($inside -and $inside.unanswered_user_where -ne 'above-sentinel') 'SCOPE' 'a dated message inside the managed region is not read as his untouched space' (D $inside)

Write-Host ''
if ($script:fail -gt 0) {
  Write-Host ("FAILED: {0} arm(s) disagreed, {1} passed." -f $script:fail, $script:pass) -ForegroundColor Red
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  exit 1
}
Write-Host ("OK: {0} arms agreed. His space is read, and nothing else latches." -f $script:pass) -ForegroundColor Green
Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
exit 0
