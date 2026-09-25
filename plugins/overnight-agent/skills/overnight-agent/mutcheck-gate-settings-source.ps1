<#
  mutcheck-gate-settings-source.ps1 -- the gate value WITH its provenance (GH #579)

  THE DEFECT. `oa-state.ps1`'s own .SETTINGS block promised that "`scan` reports the resolved
  values per Today row (`gate_backstop_hours`, `gate_strict`), so a configured value that is not
  applying is visible." It reported the VALUE and not its SOURCE, which does not deliver that. A
  row reading `gate_backstop_hours: 6` means either "you configured 6" or "nothing is configured
  and 6 is the built-in default", and separating those two is the entire purpose of the sentence.

  Measured live 2026-09-25: `Today gate backstop`, `Today gate strict` and `Overnight Agent
  concurrency` are ALL absent from user-settings.md. Three user-owned controls on built-in
  defaults, and only concurrency said so -- through `concurrency_source`, which is exactly the
  field the gate settings lacked.

  THE VOCABULARY IS DELIBERATELY THE ONE ALREADY IN USE, and an arm pins it: `default`,
  `settings`, `settings-malformed`, `argument` mean the same thing here as for concurrency. A
  second private vocabulary would make two settings on the same row unreadable together.

  TWO ARMS ARE ABOUT A DEFECT FOUND WHILE WRITING THIS, not about the reported one. `off` was
  previously read only through the on-spellings, so a user who deliberately turned strict OFF
  resolved through the default path and was reported identically to one who had never heard of
  the setting. Same for a typo: it fell through silently. Both now report.

  Hermetic: synthetic journals, state, board, snooze store and settings file under TEMP, driving
  the REAL oa-state.ps1. No live store, no network; runs under pwsh on Linux.

  Exit 0 = every arm agreed.
#>

[CmdletBinding()]
param([string]$ScriptPath)

$ErrorActionPreference = 'Stop'
# Resolved in the BODY: $PSScriptRoot is not bound while parameter defaults are evaluated.
if (-not $ScriptPath) { $ScriptPath = Join-Path $PSScriptRoot 'oa-state.ps1' }
if (-not (Test-Path $ScriptPath)) { throw "oa-state.ps1 not found at $ScriptPath" }

$script:PsExe = if ($PSVersionTable.PSEdition -eq 'Core') { (Get-Process -Id $PID).Path } else { 'powershell' }
$utf8 = New-Object Text.UTF8Encoding($false)
$MOON = [char]::ConvertFromUtf32(0x1F319)

$root = Join-Path ([IO.Path]::GetTempPath()) ("oa-579-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $root -Force | Out-Null

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

function New-Sandbox {
  param([string]$SettingsBody)
  $sx = Join-Path $root ([guid]::NewGuid().ToString('N').Substring(0, 6))
  $jdir = Join-Path $sx 'journal'; $sdir = Join-Path $sx 'state'
  New-Item -ItemType Directory -Path $jdir -Force | Out-Null
  New-Item -ItemType Directory -Path $sdir -Force | Out-Null
  $board = Join-Path $sx 'planner.md'; $store = Join-Path $sx 'snooze.json'
  $settings = Join-Path $sx 'user-settings.md'

  $j = "# Task 950: synthetic`n`nnotes`n`n---`n" +
       "<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->`n`n" +
       "## $MOON Overnight Agent`n`n**Status:** In progress`n`n<!-- oa-ask: none -->`n"
  [IO.File]::WriteAllText((Join-Path $jdir 'task-950.md'), $j, $utf8)

  $sb = New-Object Text.StringBuilder
  [void]$sb.AppendLine('## Today')
  [void]$sb.AppendLine('')
  [void]$sb.AppendLine('| ID | U | Task | Work Priority | Added | Linked ID |')
  [void]$sb.AppendLine('|---|---|------|---------------|-------|-----------|')
  [void]$sb.AppendLine('| 950 |  | today 950 | - | 2026-09-25 |  |')
  [IO.File]::WriteAllText($board, $sb.ToString(), $utf8)
  [IO.File]::WriteAllText($store, '{}', $utf8)
  [IO.File]::WriteAllText($settings, $SettingsBody, $utf8)
  return [pscustomobject]@{ JDir = $jdir; SDir = $sdir; Board = $board; Store = $store; Settings = $settings }
}

function Get-GateRow {
  param($Sx, [string[]]$Extra = @())
  $argv = @('scan', '-JournalDir', $Sx.JDir, '-StateDir', $Sx.SDir, '-PlannerBoard', $Sx.Board,
            '-SnoozeStore', $Sx.Store, '-UserSettings', $Sx.Settings) + $Extra
  $text = (& $script:PsExe -NoProfile -ExecutionPolicy Bypass -File $ScriptPath @argv 2>&1 | Out-String)
  try { $rows = @($text | ConvertFrom-Json) } catch { return $null }
  return ($rows | Where-Object { "$($_.id)" -eq '950' } | Select-Object -First 1)
}

# The file shape this actually has to cope with: settings rows live in a table with no dedicated
# section, which is the correction this change also makes to the docs.
$NO_ROWS = "# Settings`n`n## Settings`n`n| Setting | Value |`n|---|---|`n| Some other thing | yes |`n"
function With-Rows([string]$backstop, [string]$strict) {
  $s = "# Settings`n`n## Settings`n`n| Setting | Value |`n|---|---|`n"
  if ($backstop) { $s += "| Today gate backstop | $backstop |`n" }
  if ($strict) { $s += "| Today gate strict | $strict |`n" }
  return $s
}

Write-Host ''
Write-Host 'UNCONFIGURED -- the state all three live controls are actually in'

$row = Get-GateRow (New-Sandbox $NO_ROWS)
Assert ($null -ne $row) 'FIXTURE' 'the sandbox produced the Today row under test' ''
Assert ("$($row.gate_backstop_source)" -eq 'default') 'BACKSTOP-DEFAULT' `
  'an absent backstop row reports default, not a bare 6' "got $($row.gate_backstop_source)"
Assert ("$($row.gate_strict_source)" -eq 'default') 'STRICT-DEFAULT' `
  'an absent strict row reports default' "got $($row.gate_strict_source)"
# The VALUE is identical in every case below. That is the defect restated as a control: if the
# value alone could answer the question, none of the arms after this would be needed.
Assert ("$($row.gate_backstop_hours)" -eq '6') 'CONTROL' `
  'and the value is the same 6 a configured 6 would produce, which is why the source is needed' `
  "got $($row.gate_backstop_hours)"

Write-Host ''
Write-Host 'CONFIGURED -- a value read from the file says so'

$row = Get-GateRow (New-Sandbox (With-Rows '9' 'on'))
Assert ("$($row.gate_backstop_source)" -eq 'settings' -and "$($row.gate_backstop_hours)" -eq '9') `
  'BACKSTOP-SETTINGS' 'a configured backstop applies and is attributed to the file' `
  "src=$($row.gate_backstop_source) val=$($row.gate_backstop_hours)"
Assert ("$($row.gate_strict_source)" -eq 'settings' -and $row.gate_strict -eq $true) 'STRICT-SETTINGS' `
  'a configured strict applies and is attributed to the file' `
  "src=$($row.gate_strict_source) val=$($row.gate_strict)"

# `off` is a CONFIGURED value, not an absence. Reading only the on-spellings meant a user who
# deliberately disabled strict was reported identically to one who had never set it -- the same
# defect this issue reports, reached from the other side.
$row = Get-GateRow (New-Sandbox (With-Rows 'off' 'off'))
Assert ("$($row.gate_backstop_source)" -eq 'settings' -and "$($row.gate_backstop_hours)" -eq '0') `
  'BACKSTOP-OFF' '`off` is a decision, and reads as one' `
  "src=$($row.gate_backstop_source) val=$($row.gate_backstop_hours)"
Assert ("$($row.gate_strict_source)" -eq 'settings' -and $row.gate_strict -eq $false) 'STRICT-OFF' `
  'deliberately turning strict off is distinguishable from never setting it' `
  "src=$($row.gate_strict_source) val=$($row.gate_strict)"

Write-Host ''
Write-Host 'MALFORMED -- a typo is reported rather than silently ignored'

$row = Get-GateRow (New-Sandbox (With-Rows 'sometimes' 'maybe'))
Assert ("$($row.gate_backstop_source)" -eq 'settings-malformed') 'BACKSTOP-MALFORMED' `
  'an unparseable backstop row is visible instead of falling through as unset' `
  "got $($row.gate_backstop_source)"
Assert ("$($row.gate_strict_source)" -eq 'settings-malformed') 'STRICT-MALFORMED' `
  'an unparseable strict row is visible too' "got $($row.gate_strict_source)"
# A typo must never disable a safety backstop: it reports, and the VALUE stays the safe default.
Assert ("$($row.gate_backstop_hours)" -eq '6' -and $row.gate_strict -eq $false) 'MALFORMED-SAFE' `
  'and the value in force stays the built-in default rather than being guessed at' `
  "backstop=$($row.gate_backstop_hours) strict=$($row.gate_strict)"

Write-Host ''
Write-Host 'ARGUMENT -- an explicit flag outranks the file and says so'

$row = Get-GateRow (New-Sandbox (With-Rows '9' 'on')) @('-TodayGateBackstopHours', '3')
Assert ("$($row.gate_backstop_source)" -eq 'argument' -and "$($row.gate_backstop_hours)" -eq '3') `
  'BACKSTOP-ARGUMENT' 'a command-line value wins over the file, and is attributed to the flag' `
  "src=$($row.gate_backstop_source) val=$($row.gate_backstop_hours)"

Write-Host ''
Write-Host 'VOCABULARY -- one word means one thing across every setting'

# A second private vocabulary would make two settings on the same row unreadable together.
$src = [IO.File]::ReadAllText($ScriptPath)
foreach ($w in @('default', 'settings', 'settings-malformed', 'argument')) {
  Assert ($src -match [regex]::Escape("`$backstopSource = '$w'") -or $src -match [regex]::Escape("`$backstopSource = '$w'")) `
    'SHARED-WORD' "the gate resolver uses the concurrency vocabulary's ``$w``" ''
}

# The docs claim corrected by this change: the rows are matched anywhere in the file, and the
# section the block used to name has never existed. A fixture with NO headings at all proves it.
$flat = "| Setting | Value |`n|---|---|`n| Today gate backstop | 9 |`n"
$row = Get-GateRow (New-Sandbox $flat)
Assert ("$($row.gate_backstop_source)" -eq 'settings' -and "$($row.gate_backstop_hours)" -eq '9') `
  'NO-SECTION' 'a row is found with no section heading at all, as the corrected docs now say' `
  "src=$($row.gate_backstop_source) val=$($row.gate_backstop_hours)"
Assert ($src -notmatch 'THIS SCRIPT instead, under `## Overnight Agent behaviour`') 'DOCS-CORRECTED' `
  'and the block no longer tells the user to create a section that changes nothing' `
  'the old instruction sentence is still present'

Write-Host ''
if ($script:fail -gt 0) {
  Write-Host ("FAILED: {0} arm(s) disagreed, {1} passed." -f $script:fail, $script:pass) -ForegroundColor Red
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  exit 1
}
Write-Host ("OK: {0} arms agreed. A gate value is published with where it came from." -f $script:pass) -ForegroundColor Green
Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
exit 0
