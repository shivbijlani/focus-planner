<#
  mutcheck-user-pause-write.ps1 -- G17, the user pause on the WRITE side (GH #627)

  #627's thesis is that `eligible` binds SELECTION but not WORK: dispatch refuses to wake a
  paused task, and nothing re-checks that for a session that is already alive. G17 closes the
  half that happens at the moment a turn is written.

  MOST OF THESE ARMS PROVE THE GUARD STAYS QUIET, and that is deliberate. Measured on the live
  board (270 rows, 2026-09-25) the candidate conditions were: eligible 2, awaiting_reply 182,
  done 137, off-board 123, USER-PAUSED 1. Every condition except the pause would refuse most
  turns written, so the arms below pin the boundary at the pause and nowhere near `done`,
  `blocked`-by-the-agent, or an ordinary row.

  THE RESUME ARM IS THE LOAD-BEARING ONE. `oa-state.ps1` treats a human message below the
  newest turn as the resume, before any `mark` records it. A guard keyed on the stored
  `paused_at` alone would latch and refuse the very turn that answers him.

  Hermetic: synthetic journal + state under TEMP, driving the REAL write-turn.ps1 with
  WRITE_TURN_OA_HOME and -JournalDir pointed inside the sandbox. No live store, no network.
#>

[CmdletBinding()]
param([string]$WriteTurnPath, [string]$OaStatePath)

$ErrorActionPreference = 'Stop'
# Resolved in the BODY, not as a param default: $PSScriptRoot is not yet bound when parameter
# defaults are evaluated, so a default of `Join-Path $PSScriptRoot ...` throws on an empty path.
if (-not $WriteTurnPath) { $WriteTurnPath = Join-Path $PSScriptRoot 'write-turn.ps1' }
if (-not $OaStatePath)   { $OaStatePath   = Join-Path $PSScriptRoot 'oa-state.ps1' }
if (-not (Test-Path $WriteTurnPath)) { throw "write-turn.ps1 not found at $WriteTurnPath" }

$script:PsExe = if ($PSVersionTable.PSEdition -eq 'Core') { (Get-Process -Id $PID).Path } else { 'powershell' }
$utf8 = New-Object Text.UTF8Encoding($true)
$MOON = [char]::ConvertFromUtf32(0x1F319)

$root = Join-Path ([IO.Path]::GetTempPath()) ("oa-627-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $root -Force | Out-Null

# The lesson from the G16 harness, applied before it bites: leaving this unset does not fail
# the same way on both hosts. On Windows write-turn resolves %LOCALAPPDATA% and the arms pass
# while touching the REAL overnight-agent home; on Linux $env:LOCALAPPDATA is null and every
# arm dies on a null Join-Path for a reason unrelated to the guard.
$env:WRITE_TURN_OA_HOME = Join-Path $root 'oa-home'
$journalDir = Join-Path $root 'journal'
$stateDir = Join-Path $env:WRITE_TURN_OA_HOME 'state'
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
New-Item -ItemType Directory -Path $journalDir -Force | Out-Null

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

$script:nextId = 900
function New-Task([string]$status, [string]$statusBy, [switch]$Resumed, [switch]$NoState, [switch]$CorruptState) {
  $id = ($script:nextId++).ToString()
  $j = "# Task ${id}: Sandbox`n`n<!-- OVERNIGHT-AGENT do not edit below this line -->`n`n" +
       "## $MOON Overnight Agent -- 2026-09-20 01:00 PT`n`n<!-- from: overnight-agent -->`n`n**Status:** $status.`n"
  if ($Resumed) { $j += "`n<!-- from: me -->`n`nhold off on this for now.`n" }
  [IO.File]::WriteAllText((Join-Path $journalDir "task-$id.md"), $j, $utf8)
  $sp = Join-Path $stateDir "task-$id.json"
  if ($CorruptState) { [IO.File]::WriteAllText($sp, "{ this is not json", $utf8) }
  elseif (-not $NoState) {
    $st = @{ id = $id; status = $status; status_by = $statusBy; paused_at = '2026-09-14T16:14:56-07:00' }
    [IO.File]::WriteAllText($sp, ($st | ConvertTo-Json), $utf8)
  }
  return $id
}

function Check([string]$id, [string[]]$extra = @()) {
  $p = Join-Path $root ("body-" + [guid]::NewGuid().ToString('N').Substring(0, 6) + '.md')
  $body = "## $MOON Overnight Agent -- 2026-09-25 07:00 PT`n`n<!-- from: overnight-agent -->`n`n" +
          "**Status:** working.`n`n**Needs from you:** nothing.`n"
  [IO.File]::WriteAllText($p, $body, $utf8)
  $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $WriteTurnPath,
            '-BodyFile', $p, '-Ask', 'none', '-Validate', '-JournalDir', $journalDir)
  if ($id) { $argv += @('-Id', $id) }
  $argv += $extra
  $so = "$p.out"; $se = "$p.err"
  $proc = Start-Process -FilePath $script:PsExe -ArgumentList $argv -NoNewWindow -Wait -PassThru `
                        -RedirectStandardOutput $so -RedirectStandardError $se
  $out = ''
  foreach ($f in @($so, $se)) { if (Test-Path $f) { $out += (Get-Content $f -Raw -ErrorAction SilentlyContinue) } }
  return [pscustomobject]@{ out = "$out"; code = $proc.ExitCode }
}
function D($r) {
  $o = ($r.out -replace '\s+', ' ')
  if ($o.Length -gt 240) { $o = $o.Substring(0, 240) + '...' }
  return "exit=$($r.code) :: $o"
}

Write-Host ''
Write-Host 'REFUSES -- a turn into work the user stopped'

$blocked = New-Task 'blocked' 'user'
$r = Check $blocked
Assert ($r.code -eq 2 -and $r.out -match 'G17') 'PAUSED' 'a user-paused task refuses the turn' (D $r)
# PINNED TO THE EXACT RECORDED STRING, not merely to the date. ConvertFrom-Json turns an
# ISO-8601 stamp into a [datetime], and stringifying that renders in the host's culture and
# zone: this arm caught the same state file printing "2026-09-14T16:14:56-07:00" on Windows
# and "09/14/2026 23:14:56" on Linux -- seven hours off, with nothing to show it had moved.
Assert ($r.out -match '2026-09-14T16:14:56-07:00') 'NAMES-WHEN' `
  'and quotes the recorded stamp verbatim, in every host''s culture and zone' (D $r)

$proposed = New-Task 'proposed' 'user'
$r = Check $proposed
Assert ($r.code -eq 2 -and $r.out -match 'G17') 'PAUSED-PROPOSED' 'the other paused status refuses too' (D $r)

Write-Host ''
Write-Host 'QUIET -- everything the guard must NOT refuse'

# THE LOAD-BEARING ARM. A reply below the newest turn is the resume, and oa-state honours it
# before any `mark` clears `paused_at`. If this arm fails the guard latches, and the turn it
# refuses is the one answering him.
$resumed = New-Task 'blocked' 'user' -Resumed
$r = Check $resumed
Assert ($r.out -notmatch 'G17') 'RESUMED' 'a reply below the newest turn is the resume, so the turn is allowed' (D $r)

$agentBlocked = New-Task 'blocked' 'agent'
$r = Check $agentBlocked
Assert ($r.out -notmatch 'G17') 'AGENT-BLOCKED' 'the agent blocking its own work is not a user pause' (D $r)

foreach ($s in @('done', 'skip')) {
  $closed = New-Task $s 'user'
  $r = Check $closed
  Assert ($r.out -notmatch 'G17') 'CLOSED' "``$s`` is closed, not paused -- the turn reporting it must still write" (D $r)
}

$ordinary = New-Task 'in-progress' 'user'
$r = Check $ordinary
Assert ($r.out -notmatch 'G17') 'ORDINARY' 'an ordinary live row is untouched' (D $r)

$nostate = New-Task 'blocked' 'user' -NoState
$r = Check $nostate
Assert ($r.out -notmatch 'G17') 'NO-STATE' 'no state file means no claim, so the turn is allowed' (D $r)

$r = Check ''
Assert ($r.out -notmatch 'G17') 'NO-ID' 'linting a fragment with no -Id is inert' (D $r)

# A guard that COULD NOT LOOK must not read the same as one that looked and found nothing
# (#520/#632). Unreadable state allows the turn AND says so.
$corrupt = New-Task 'blocked' 'user' -CorruptState
$r = Check $corrupt
Assert ($r.out -notmatch 'G17 line') 'UNREADABLE' 'unreadable state allows the turn rather than refusing on a guess' (D $r)
Assert ($r.out -match 'could not check whether the user paused') 'SAYS-SO' 'and it is reported, not swallowed' (D $r)

Write-Host ''
Write-Host 'ESCAPE -- the documented hatch works'
$r = Check $blocked @('-DisableGuard', 'G17')
Assert ($r.out -notmatch 'G17 line') 'HATCH' '-DisableGuard G17 clears the refusal (so the refusal was G17)' (D $r)

Write-Host ''
Write-Host 'DRIFT -- the paused status set must match oa-state''s'

# write-turn cannot import oa-state's sets, so it carries a literal copy. This pins that copy
# against the DERIVATION rather than against another literal: oa-state builds PausedStatus as
# NonWorkableStatus minus ClosedStatus, so a status added to either set there shows up here.
if (Test-Path $OaStatePath) {
  $src = [IO.File]::ReadAllText($OaStatePath)
  $setOf = {
    param([string]$name)
    $m = [regex]::Match($src, '(?m)^\s*\$script:' + $name + '\s*=\s*@\(([^\)]*)\)')
    if (-not $m.Success) { return $null }
    return @($m.Groups[1].Value -split ',' | ForEach-Object { $_.Trim().Trim("'").Trim('"') } | Where-Object { $_ })
  }
  $nonWorkable = & $setOf 'NonWorkableStatus'
  $closed = & $setOf 'ClosedStatus'
  Assert ($null -ne $nonWorkable -and $null -ne $closed) 'SETS-FOUND' 'oa-state still declares both status sets' ''
  if ($nonWorkable -and $closed) {
    $expected = @($nonWorkable | Where-Object { $closed -notcontains $_ }) | Sort-Object
    $wtSrc = [IO.File]::ReadAllText($WriteTurnPath)
    $m = [regex]::Match($wtSrc, '(?m)^\s*\$script:PausedStatusWT\s*=\s*@\(([^\)]*)\)')
    $actual = if ($m.Success) { @($m.Groups[1].Value -split ',' | ForEach-Object { $_.Trim().Trim("'").Trim('"') } | Where-Object { $_ }) | Sort-Object } else { @() }
    Assert (($expected -join ',') -eq ($actual -join ',')) 'IN-STEP' `
      'write-turn''s paused set equals NonWorkableStatus minus ClosedStatus' `
      "oa-state=$($expected -join ',') write-turn=$($actual -join ',')"
  }
}
else {
  Write-Host '  SKIP  IN-STEP  -- oa-state.ps1 not beside this script; drift unverified'
}

Write-Host ''
Write-Host 'HERMETIC -- the arms above ran against the sandbox, not a real home'
$homeLine = [regex]::Match([IO.File]::ReadAllText($WriteTurnPath), '(?m)^\s*\$OA_HOME\s*=.*$').Value
Assert ($homeLine -match 'WRITE_TURN_OA_HOME') 'OVERRIDE-HONOURED' `
  'write-turn still resolves its home from WRITE_TURN_OA_HOME' "OA_HOME line: $homeLine"
Assert ($env:WRITE_TURN_OA_HOME -and $env:WRITE_TURN_OA_HOME.StartsWith($root)) 'SANDBOXED' `
  'and this run pointed that home inside its own TEMP root' "home=$env:WRITE_TURN_OA_HOME root=$root"

Write-Host ''
if ($script:fail -gt 0) {
  Write-Host ("FAILED: {0} arm(s) disagreed, {1} passed." -f $script:fail, $script:pass) -ForegroundColor Red
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  exit 1
}
Write-Host ("OK: {0} arms agreed. A paused task refuses; a resumed one does not." -f $script:pass) -ForegroundColor Green
Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
exit 0
