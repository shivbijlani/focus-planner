# mutcheck-managed-heading.ps1
#
# Proves that a SECOND `## <moon> Overnight Agent` turn -- the heading SKILL.md tells this
# agent to open every time it writes another turn to a journal -- is recognised as the
# agent's OWN turn and not as an unanswered message from the user.
#
# The defect it guards against: Get-AgentEndIndex ends the agent's turn at the next `## `
# heading. When the agent writes a second turn, that heading is the agent's own. The whole
# turn then lands in the "trailing" region, where Test-TrailingHasUser's no-marker branch
# reads it as user prose -- so the task reports `reopened` forever, with no message in it to
# answer. Measured on the live board: 7 journals, 35,148 characters of the agent's own prose
# misfiled as an unread reply, and #384 actually surfaced in a run's approval queue.
#
# The half that matters is the DEAFNESS TEST. Widening "this is my own turn" is exactly the
# direction that silently eats the user's messages, so a green fix is worthless without
# evidence of what it can still hear.
#
# Every case is BEHAVIOURAL -- it drives the real script against isolated -JournalDir and
# -StateDir, through the real seed -> mark -> append -> scan sequence, so it cannot be fooled
# by source text that merely mentions the fix.
#
# Both line endings are exercised on purpose. A CRLF-blind pattern is the specific way the
# earlier RunLogRe fix silently no-opped, and a green from a single fixture builder is not
# evidence.
#
# Usage:  pwsh mutcheck-managed-heading.ps1 [-Script <path to oa-state.ps1>]
# Exit:   0 all assertions pass - 1 one or more failed.

[CmdletBinding()]
param(
  [string]$Script
)

$ErrorActionPreference = 'Stop'

# Resolved in the body, not the param default: $PSScriptRoot is not populated while the
# param block is being bound under Windows PowerShell 5.1.
if (-not $Script) { $Script = Join-Path $PSScriptRoot 'oa-state.ps1' }

# Built from the codepoint, never typed literally. This file has no UTF-8 BOM, so a literal
# 4-byte emoji in the source would be decoded as Latin-1 mojibake and the fixture would stop
# describing the real journals.
$MOON = [char]::ConvertFromUtf32(0x1F319)

function New-Journal {
  <#
    The shape of a real journal: the user's notes, the sentinel, the agent's first turn
    (stamped with a provenance marker), and optionally a SECOND agent turn opened with the
    managed heading -- which is the shape under test.
  #>
  param([string]$Nl, [switch]$SecondTurn, [switch]$AsciiHeading)

  $lines = @(
    '# Task 9xx: synthetic',
    '',
    "The user's own notes.",
    '',
    '---',
    '<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->',
    '',
    "## $MOON Overnight Agent",
    '',
    '**Status:** Done - plan v1 - 2026-08-26',
    '',
    '<!-- from: overnight-agent -->',
    '',
    '### Run log',
    '',
    '**2026-08-26 (overnight):**',
    '- Did the first thing.',
    ''
  )
  if ($SecondTurn) {
    # A hard-wrapped bold line: the continuation below starts at column 0, which is what the
    # journals actually look like and what the run-log shape check chokes on.
    $heading = if ($AsciiHeading) { '## Overnight Agent' } else { "## $MOON Overnight Agent" }
    $lines += @(
      $heading,
      '',
      '**Status:** Done - plan v2 - 2026-08-27',
      '',
      '### Run log',
      '',
      '**2026-08-27 (overnight):**',
      '- Did the second thing.',
      '',
      '**Needs from you:** nothing. One optional check: is the account pre-tax or',
      'Roth? Reply and I will re-run it.',
      ''
    )
  }
  return ($lines -join $Nl)
}

function New-SecondTurn {
  # The text of a second agent turn, exactly as the agent appends it to a journal it has
  # already answered once. The bold line is hard-wrapped with the continuation starting at
  # column 0 -- the real journals look like this, and it is what the run-log shape check
  # chokes on.
  param([string]$Nl, [switch]$AsciiHeading)
  $heading = if ($AsciiHeading) { '## Overnight Agent' } else { "## $MOON Overnight Agent" }
  return ($Nl + ($(
    $heading,
    '',
    '**Status:** Done - plan v2 - 2026-08-27',
    '',
    '### Run log',
    '',
    '**2026-08-27 (overnight):**',
    '- Did the second thing.',
    '',
    '**Needs from you:** nothing. One optional check: is the account pre-tax or',
    'Roth? Reply and I will re-run it.',
    ''
  ) -join $Nl))
}

$failures = New-Object System.Collections.ArrayList
$passes = 0

function Invoke-Oa {
  param([string]$Cmd, [string]$JDir, [string]$SDir, [string]$TaskId)
  $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Script, $Cmd,
         '-JournalDir', $JDir, '-StateDir', $SDir)
  if ($TaskId) { $a += @('-Id', $TaskId) }
  & powershell @a 2>&1
}

function Assert-Reopened {
  <#
    Drives the real production sequence:
      write journal -> seed -> mark -> (the user appends $Append) -> scan
    and asserts the verdict, for one line-ending flavour.
  #>
  param(
    [string]$Name, [string]$Append, [bool]$Expected, [string]$Why,
    [string]$Nl, [switch]$SecondTurn, [switch]$AsciiHeading
  )

  $root = Join-Path ([IO.Path]::GetTempPath()) ("oa-mh-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
  $jdir = Join-Path $root 'journal'
  $sdir = Join-Path $root 'state'
  New-Item -ItemType Directory -Path $jdir -Force | Out-Null
  New-Item -ItemType Directory -Path $sdir -Force | Out-Null
  try {
    $journal = Join-Path $jdir 'task-901.md'
    $body = New-Journal -Nl $Nl -SecondTurn:$SecondTurn -AsciiHeading:$AsciiHeading
    [IO.File]::WriteAllText($journal, $body, (New-Object Text.UTF8Encoding($false)))

    [void](Invoke-Oa -Cmd 'seed' -JDir $jdir -SDir $sdir)
    [void](Invoke-Oa -Cmd 'mark' -JDir $jdir -SDir $sdir -TaskId '901')

    if ($Append) {
      $cur = [IO.File]::ReadAllText($journal)
      [IO.File]::WriteAllText($journal, $cur.TrimEnd() + $Append, (New-Object Text.UTF8Encoding($false)))
    }

    $rows = (Invoke-Oa -Cmd 'scan' -JDir $jdir -SDir $sdir) -join "`n" | ConvertFrom-Json
    $row = @($rows) | Where-Object { "$($_.id)" -eq '901' } | Select-Object -First 1
    $actual = [bool]$row.reopened

    $label = "{0} [{1}]" -f $Name, $(if ($Nl -eq "`r`n") { 'CRLF' } else { 'LF' })
    if ($actual -eq $Expected) {
      $script:passes++
      Write-Host ("  PASS  {0}" -f $label) -ForegroundColor Green
    } else {
      [void]$script:failures.Add(("{0}: expected reopened={1}, got {2} -- {3}" -f $label, $Expected, $actual, $Why))
      Write-Host ("  FAIL  {0}: expected {1}, got {2}" -f $label, $Expected, $actual) -ForegroundColor Red
    }
  } finally {
    Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Assert-True {
  param([string]$Name, [bool]$Condition, [string]$Why)
  if ($Condition) {
    $script:passes++
    Write-Host ("  PASS  {0}" -f $Name) -ForegroundColor Green
  } else {
    [void]$script:failures.Add(("{0} -- {1}" -f $Name, $Why))
    Write-Host ("  FAIL  {0}" -f $Name) -ForegroundColor Red
  }
}

Write-Host "mutcheck-managed-heading -- script under test: $Script"

foreach ($nl in @("`r`n", "`n")) {

  $APP_SHAPED   = "$nl## 2026-08-28$nl$nl<!-- from: me -->${nl}approve$nl"
  $HEADING_ONLY = "$nl## 2026-08-28$nl${nl}approve$nl"
  $RAW_APPEND   = "$nl${nl}approve - go ahead please$nl"
  $SIBLING_TURN = "$nl## 2026-08-28$nl$nl<!-- from: dance-church -->${nl}posted 3 classes$nl"

  Write-Host ''
  Write-Host 'THE FIX: the agent opening a second turn is not a message from the user'
  # The live sequence: the journal was answered and marked, then the agent appended ANOTHER
  # turn. The next run must not read that turn as an unanswered reply. Appending after the
  # mark is what makes `changed` true, which is the state a pinned journal reaches the moment
  # anything edits it.
  Assert-Reopened -Nl $nl -Name 'agent appends a second managed turn' `
    -Append (New-SecondTurn -Nl $nl) -Expected $false `
    -Why 'this is the defect: the agent read its OWN second turn as an unanswered reply'
  Assert-Reopened -Nl $nl -Name 'second managed turn, heading without the glyph' `
    -Append (New-SecondTurn -Nl $nl -AsciiHeading) -Expected $false `
    -Why 'the phrase is the anchor, so an older glyph-free heading must behave identically'
  Assert-Reopened -Nl $nl -SecondTurn -Name 'a settled two-turn journal stays quiet' `
    -Append '' -Expected $false `
    -Why 'crying wolf on a settled task is how a detector becomes decorative'

  Write-Host ''
  Write-Host 'THE DEAFNESS TEST: every real reply must still be heard, below a second turn'
  Assert-Reopened -Nl $nl -Name 'reply arriving after the agent appended a second turn' `
    -Append ((New-SecondTurn -Nl $nl) + $APP_SHAPED) -Expected $true `
    -Why 'the exact shape the fix must not swallow: a real reply below the agent second turn'
  Assert-Reopened -Nl $nl -SecondTurn -Name 'app-written reply below the second turn' `
    -Append $APP_SHAPED -Expected $true `
    -Why 'the path the Focus Planner app writes -- breaking it loses every reply'
  Assert-Reopened -Nl $nl -SecondTurn -Name 'dated reply with no marker below the second turn' `
    -Append $HEADING_ONLY -Expected $true `
    -Why 'hand-written and older app entries take this shape'
  Assert-Reopened -Nl $nl -SecondTurn -Name 'raw text at EOF below the second turn' `
    -Append $RAW_APPEND -Expected $true `
    -Why 'the turn-terminator property must survive: raw text at the bottom still reopens'
  Assert-Reopened -Nl $nl -SecondTurn -Name "a sibling skill's turn is still not a user reply" `
    -Append $SIBLING_TURN -Expected $false `
    -Why 'sibling skills append here too; counting one as the user pins the task forever'

  Write-Host ''
  Write-Host 'THE BASELINE: a single-turn journal is unaffected by this change'
  Assert-Reopened -Nl $nl -Name 'single turn, nothing appended' `
    -Append '' -Expected $false `
    -Why 'crying wolf on a settled task is how a detector becomes decorative'
  Assert-Reopened -Nl $nl -Name 'single turn, app-written reply' `
    -Append $APP_SHAPED -Expected $true `
    -Why 'the pre-existing behaviour must not regress'
}

Write-Host ''
Write-Host 'THE UNPINNING: a second turn can now be terminated, which is what frees the journal'
$root = Join-Path ([IO.Path]::GetTempPath()) ("oa-mh-s-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
$jdir = Join-Path $root 'journal'; $sdir = Join-Path $root 'state'
New-Item -ItemType Directory -Path $jdir -Force | Out-Null
New-Item -ItemType Directory -Path $sdir -Force | Out-Null
try {
  $j = Join-Path $jdir 'task-902.md'
  $body = New-Journal -Nl "`r`n" -SecondTurn
  [IO.File]::WriteAllText($j, $body, (New-Object Text.UTF8Encoding($false)))
  [void](Invoke-Oa -Cmd 'seed' -JDir $jdir -SDir $sdir)
  [void](Invoke-Oa -Cmd 'mark' -JDir $jdir -SDir $sdir -TaskId '902')
  $after = [IO.File]::ReadAllText($j)

  Assert-True -Name 'mark stamps a terminator on a second-turn journal' `
    -Condition ($after -match '/overnight-agent turn-end') `
    -Why 'without this the journal stays pinned: the stamp is only written when the turn reaches EOF, and the defect stopped it reaching EOF'
  Assert-True -Name 'the stamp is still append-only' `
    -Condition ($after.StartsWith($body.TrimEnd())) `
    -Why 'a rewrite could eat existing content; this must only ever add to the end'

  # The read-modify-write above is the exact shape that destroyed 593 lines of task-448.md:
  # read with the host's default decoder, write back as UTF-8. This mutcheck runs under
  # Windows PowerShell 5.1 (Invoke-Oa shells out to `powershell`), which is the host that
  # decodes a BOM-less UTF-8 file as ANSI -- so this assertion genuinely exercises the bug
  # rather than describing it.
  $moonSurvived = ([Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($j))).Contains($MOON)
  Assert-True -Name 'non-ASCII survives mark byte-for-byte' `
    -Condition $moonSurvived `
    -Why 'mark re-encodes what it read; a wrong decode makes the corruption permanent on disk'

  $mojibake = ([Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($j))).Contains([char]0x00F0)
  Assert-True -Name 'mark introduces no mojibake' `
    -Condition (-not $mojibake) `
    -Why 'a double-encoded emoji leaves an eth character behind; its presence is the fingerprint'
} finally {
  Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
if ($failures.Count -eq 0) {
  Write-Host ("ALL GREEN - {0} assertions passed." -f $passes) -ForegroundColor Green
  exit 0
}
Write-Host ("FAILURES: {0} of {1} assertions" -f $failures.Count, ($passes + $failures.Count)) -ForegroundColor Red
foreach ($f in $failures) { Write-Host "  - $f" -ForegroundColor Red }
exit 1
