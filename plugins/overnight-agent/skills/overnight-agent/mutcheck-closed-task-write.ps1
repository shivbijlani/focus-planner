<#
  mutcheck-closed-task-write.ps1 -- G24, the user-closed task stop on the WRITE side (GH #825).

  `scan` reports a reply on a task the USER closed as `reopened_closed` and never offers it as
  work, but at the write that rule was prose: e2e scenario e1 caught the coordinator appending a
  turn to such a task. G24 makes the sanctioned writer refuse every agent turn into a task that
  oa-state's Test-UserClosed calls closed -- done/skip AND (on planner-completed.md, or
  status_by user, or on neither board) -- with no reply exemption, failing closed when an input
  that decides the verdict cannot be read.

  Hermetic: synthetic planner, journal, state and body files under TEMP, driving write-turn.ps1
  or its Node port with -JournalDir and WRITE_TURN_OA_HOME pointed inside the sandbox. Mutants
  are written BESIDE the target (not into TEMP) so they still find oa-state for G23; a mutant
  that could not run G23 would fail every quiet arm and be "killed" for the wrong reason.
#>
[CmdletBinding()]
param([string]$ScriptPath)

$ErrorActionPreference = 'Stop'

if (-not $ScriptPath) { $ScriptPath = Join-Path $PSScriptRoot 'write-turn.ps1' }
if (-not (Test-Path -LiteralPath $ScriptPath)) { throw "write-turn not found at $ScriptPath" }
$ScriptPath = (Resolve-Path -LiteralPath $ScriptPath).Path
$script:IsNode = $ScriptPath -like '*.mjs'
$script:PsExe = if ($PSVersionTable.PSEdition -eq 'Core') { (Get-Process -Id $PID).Path } else { 'powershell' }
$utf8 = New-Object Text.UTF8Encoding($false)
$MOON = [char]::ConvertFromUtf32(0x1F319)
$SENTINEL = '<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->'

function Get-SubjectPrefix([string]$Path) {
  if ($Path -like '*.mjs') { return @('node', $Path) }
  return @($script:PsExe, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Path)
}

function Write-Utf8([string]$Path, [string]$Text) {
  New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force | Out-Null
  [IO.File]::WriteAllText($Path, $Text, $utf8)
}

function New-World([string]$Name) {
  $root = Join-Path ([IO.Path]::GetTempPath()) ("oa-825-$Name-" + [guid]::NewGuid().ToString('N').Substring(0, 6))
  $journal = Join-Path $root 'data\journal'
  New-Item -ItemType Directory -Path $journal -Force | Out-Null
  Write-Utf8 (Join-Path $journal 'task-9405.md') (
    "# Task 9405: Renew the car registration`n`n- Tabs expire end of month.`n`n---`n$SENTINEL`n`n" +
    "## $MOON Overnight Agent -- renewed`n`n<!-- from: overnight-agent -->`n`n**Status:** Done`n`n" +
    "- Renewed online; confirmation DOL-58213.`n`n**Needs from you:** nothing.`n")
  $body = Join-Path $root 'body.md'
  Write-Utf8 $body "## $MOON Overnight Agent -- emissions check`n`n<!-- from: overnight-agent -->`n`n**Status:** In progress.`n`n**Needs from you:** nothing.`n"
  return [pscustomobject]@{
    root = $root; data = (Join-Path $root 'data'); journal = $journal; body = $body
    home = (Join-Path $root 'home')
  }
}

function Set-State($World, [string]$Status, [string]$StatusBy) {
  $o = [ordered]@{ id = '9405'; status = $Status }
  if ($StatusBy) { $o.status_by = $StatusBy }
  Write-Utf8 (Join-Path $World.home 'state\task-9405.json') ($o | ConvertTo-Json)
}
function Set-Board($World) { Write-Utf8 (Join-Path $World.data 'planner.md') "# Planner`n`n## Today`n`n| ID | Task |`n|----|------|`n| 9405 | Renew the car registration |`n" }
function Set-Completed($World) { Write-Utf8 (Join-Path $World.data 'planner-completed.md') "# Completed`n`n| ID | Task |`n|----|------|`n| 9405 | Renew the car registration |`n" }
function Add-Reply($World) {
  [IO.File]::AppendAllText((Join-Path $World.journal 'task-9405.md'),
    "`n<!-- from: me -->`n`none more thing - can you also check whether the Subaru emissions test is due?`n", $utf8)
}

function Invoke-Subject([string]$Path, $World, [string]$Id, [string[]]$Extra = @()) {
  $prefix = Get-SubjectPrefix $Path
  $exe = $prefix[0]
  $argv = @($prefix | Select-Object -Skip 1) + @('-Id', $Id, '-BodyFile', $World.body, '-JournalDir', $World.journal, '-Ask', 'none', '-Validate') + $Extra
  $so = Join-Path $World.root 'stdout.txt'
  $se = Join-Path $World.root 'stderr.txt'
  $env:WRITE_TURN_OA_HOME = $World.home
  $p = Start-Process -FilePath $exe -ArgumentList $argv -NoNewWindow -Wait -PassThru -RedirectStandardOutput $so -RedirectStandardError $se
  $out = ''
  foreach ($f in @($so, $se)) { if (Test-Path -LiteralPath $f) { $out += [IO.File]::ReadAllText($f) } }
  return [pscustomobject]@{ code = $p.ExitCode; out = $out }
}

function Detail($Result) {
  $o = ($Result.out -replace '\s+', ' ').Trim()
  if ($o.Length -gt 240) { $o = $o.Substring(0, 240) + '...' }
  return "exit=$($Result.code) :: $o"
}

$arms = @(
  @{ name = 'completed-board-refused'; refused = $true
     setup = { param($w) Set-State $w 'done' 'agent'; Set-Completed $w } },
  @{ name = 'completed-board-while-on-board-refused'; refused = $true
     setup = { param($w) Set-State $w 'done' 'agent'; Set-Completed $w; Set-Board $w } },
  @{ name = 'status-by-user-on-board-refused'; refused = $true
     setup = { param($w) Set-State $w 'done' 'user'; Set-Board $w } },
  @{ name = 'skip-off-both-boards-refused'; refused = $true
     setup = { param($w) Set-State $w 'skip' 'agent' } },
  @{ name = 'reply-after-close-still-refused'; refused = $true
     expect = 'He replied since the close: "one more thing - can you also check whether the Subaru emissions test is due\?"[\s\S]*reopen the row to continue'
     setup = { param($w) Set-State $w 'done' 'agent'; Set-Completed $w; Add-Reply $w } },
  @{ name = 'closed-without-reply-no-quote-refused'; refused = $true; reject = 'He replied since the close'
     setup = { param($w) Set-State $w 'done' 'agent'; Set-Completed $w } },
  @{ name = 'absent-status-by-off-board-refused'; refused = $true
     setup = { param($w) Set-State $w 'done' '' } },
  @{ name = 'corrupt-state-refused'; refused = $true
     setup = { param($w) Write-Utf8 (Join-Path $w.home 'state\task-9405.json') '{ this is not json' } },
  @{ name = 'unreadable-completed-board-refused'; refused = $true
     setup = { param($w) Set-State $w 'done' 'agent'; Set-Board $w; New-Item -ItemType Directory -Path (Join-Path $w.data 'planner-completed.md') -Force | Out-Null } },
  @{ name = 'disable-guard-g24-still-refused'; refused = $true; extra = @('-DisableGuard', 'G24')
     setup = { param($w) Set-State $w 'done' 'user'; Set-Board $w } },
  @{ name = 'agent-done-on-board-allowed'; refused = $false
     setup = { param($w) Set-State $w 'done' 'agent'; Set-Board $w } },
  @{ name = 'open-status-on-completed-board-allowed'; refused = $false
     setup = { param($w) Set-State $w 'in-progress' 'user'; Set-Completed $w } },
  @{ name = 'user-blocked-is-not-closed-allowed-by-g24'; refused = $false; g24only = $true
     setup = { param($w) Set-State $w 'proposed' 'user' } },
  @{ name = 'no-state-allowed'; refused = $false
     setup = { param($w) Set-Completed $w } },
  @{ name = 'open-status-never-opens-boards-allowed'; refused = $false
     setup = { param($w) Set-State $w 'in-progress' 'agent'; Set-Board $w; New-Item -ItemType Directory -Path (Join-Path $w.data 'planner-completed.md') -Force | Out-Null } }
)

function Test-Arm([string]$Path, $Arm) {
  $w = New-World $Arm.name
  try {
    & $Arm.setup $w
    $r = Invoke-Subject $Path $w '9405' @($Arm.extra)
    $isRefused = ($r.code -eq 2 -and $r.out -match 'G24 line')
    if ($Arm.expect -and ($r.out -replace '\s+', ' ') -notmatch $Arm.expect) { $isRefused = $false }
    if ($Arm.reject -and $r.out -match $Arm.reject) { $isRefused = $false }
    $ok = if ($Arm.refused) { $isRefused }
          elseif ($Arm.g24only) { $r.out -notmatch 'G24' }
          else { ($r.code -eq 0 -and $r.out -notmatch 'G24') }
    return [pscustomobject]@{ ok = $ok; name = $Arm.name; detail = (Detail $r) }
  } finally {
    Remove-Item -LiteralPath $w.root -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Replace-FirstLiteral([string]$Text, [string]$Needle, [string]$Replacement) {
  $idx = $Text.IndexOf($Needle, [StringComparison]::Ordinal)
  if ($idx -lt 0) { throw "mutation anchor not found: $Needle" }
  return $Text.Substring(0, $idx) + $Replacement + $Text.Substring($idx + $Needle.Length)
}

function New-Mutant([string]$Name, [string]$Needle, [string]$Replacement) {
  $leaf = [IO.Path]::GetFileNameWithoutExtension($ScriptPath)
  $ext = [IO.Path]::GetExtension($ScriptPath)
  $dst = Join-Path (Split-Path -Parent $ScriptPath) ("$leaf.mut825-" + [guid]::NewGuid().ToString('N').Substring(0, 8) + $ext)
  $src = [IO.File]::ReadAllText($ScriptPath)
  # Keep the BOM the original carries (write-turn.ps1 needs it under Windows PowerShell 5.1).
  $bom = New-Object Text.UTF8Encoding($ext -eq '.ps1')
  [IO.File]::WriteAllText($dst, (Replace-FirstLiteral $src $Needle $Replacement), $bom)
  return [pscustomobject]@{ name = $Name; path = $dst }
}

$mutants = if ($script:IsNode) {
  @(
    @{ name = 'guard skipped';                   needle = 'if (closedVerdict) {'; replacement = 'if (false && closedVerdict) {' },
    @{ name = 'any status counts as closed';     needle = "if (!['done', 'skip'].includes(status)) return null;"; replacement = '' },
    @{ name = 'status_by user ignored';          needle = "if (by === 'user') return"; replacement = "if (false) return" },
    @{ name = 'completed board ignored';         needle = "if (writeBoardHasRow(path.join(plannerDir, 'planner-completed.md'), taskId)) {"; replacement = 'if (false) {' },
    @{ name = 'off-board not closed';            needle = "if (!writeBoardHasRow(path.join(plannerDir, 'planner.md'), taskId)) {"; replacement = 'if (false) {' },
    @{ name = 'unreadable input allows';         needle = "return { kind: 'unreadable', why: source, snippet: source };"; replacement = 'return null;' },
    @{ name = 'reply exemption added';           needle = 'const closedVerdict = dest ? writeClosedVerdict(ctx, id) : null;'; replacement = 'const closedVerdict = dest && !/from: me/.test(readAllText(dest)) ? writeClosedVerdict(ctx, id) : null;' },
    @{ name = 'reply dropped from the report';   needle = 'if (verdict.reply !== null && verdict.reply !== undefined) {'; replacement = 'if (false) {' },
    @{ name = 'guard made disableable';          needle = 'if (closedVerdict) {'; replacement = "if (closedVerdict && !ciContains(disabled, 'G24')) {" }
  )
} else {
  @(
    @{ name = 'guard skipped';                   needle = 'if ($script:ClosedVerdict) {'; replacement = 'if ($false -and $script:ClosedVerdict) {' },
    @{ name = 'any status counts as closed';     needle = "if (@('done', 'skip') -notcontains `$status) { return `$null }"; replacement = '' },
    @{ name = 'status_by user ignored';          needle = "if (`$by -eq 'user') { return"; replacement = "if (`$false) { return" },
    @{ name = 'completed board ignored';         needle = "if (Test-WriteBoardHasRow (Join-Path `$plannerDir 'planner-completed.md') `$TaskId) {"; replacement = 'if ($false) {' },
    @{ name = 'off-board not closed';            needle = "if (-not (Test-WriteBoardHasRow (Join-Path `$plannerDir 'planner.md') `$TaskId)) {"; replacement = 'if ($false) {' },
    @{ name = 'unreadable input allows';         needle = "return [pscustomobject]@{ kind = 'unreadable'; why = `$source; snippet = `$source }"; replacement = 'return $null' },
    @{ name = 'reply exemption added';           needle = '$script:ClosedVerdict = if ($dest) {'; replacement = '$script:ClosedVerdict = if ($dest -and ([IO.File]::ReadAllText($dest) -notmatch ''from: me'')) {' },
    @{ name = 'reply dropped from the report';   needle = 'if ($null -ne $Verdict.reply) {'; replacement = 'if ($false) {' },
    @{ name = 'guard made disableable';          needle = 'if ($script:ClosedVerdict) {'; replacement = "if (`$script:ClosedVerdict -and (`$DisableGuard -notcontains 'G24')) {" }
  )
}

Write-Host "target: $ScriptPath"
Write-Host ''
Write-Host 'ARMS'
$fail = 0
foreach ($arm in $arms) {
  $r = Test-Arm $ScriptPath $arm
  if ($r.ok) { Write-Host "  PASS  $($r.name)" }
  else { Write-Host "  FAIL  $($r.name) -- $($r.detail)" -ForegroundColor Red; $fail++ }
}
if ($fail -gt 0) { Write-Host "FAILED: baseline arm(s) disagreed." -ForegroundColor Red; exit 1 }

# DRIFT: G24 must mean exactly what the engine means. (1) The closed status set is oa-state's
# ClosedStatus. (2) On every arm whose inputs are readable, the engine's own scan row, put
# through Test-UserClosed's rule, reaches the same verdict as G24.
Write-Host ''
Write-Host 'DRIFT'
$skillDir = Split-Path -Parent $ScriptPath
$engineText = [IO.File]::ReadAllText((Join-Path $skillDir 'oa-state.ps1'))
if ($engineText -match "\`$script:ClosedStatus\s*=\s*@\(([^)]*)\)") {
  $set = @([regex]::Matches($Matches[1], "'([^']+)'") | ForEach-Object { $_.Groups[1].Value }) | Sort-Object
  if (($set -join ',') -eq 'done,skip') { Write-Host '  PASS  closed-set -- oa-state ClosedStatus is done,skip' }
  else { Write-Host "  FAIL  closed-set -- oa-state ClosedStatus is $($set -join ',')" -ForegroundColor Red; $fail++ }
} else { Write-Host '  FAIL  closed-set -- oa-state ClosedStatus not found' -ForegroundColor Red; $fail++ }
$engine = Join-Path $skillDir 'oa-state.mjs'
foreach ($arm in $arms) {
  if ($arm.name -match 'corrupt|unreadable') { continue }
  $w = New-World $arm.name
  $saved = @{}
  foreach ($k in 'OVERNIGHT_AGENT_HOME', 'OVERNIGHT_AGENT_PLANNER_DIR', 'OA_SANDBOX_ROOT') { $saved[$k] = [Environment]::GetEnvironmentVariable($k) }
  try {
    & $arm.setup $w
    $env:OVERNIGHT_AGENT_HOME = $w.home
    $env:OVERNIGHT_AGENT_PLANNER_DIR = $w.data
    $env:OA_SANDBOX_ROOT = $w.root
    $json = & node $engine scan -SessionStateDir (Join-Path $w.root 'sessions') -McpConfig (Join-Path $w.root 'mcp.json') -UserSettings (Join-Path $w.data 'user-settings.md') 2>$null
    $row = @(($json | Out-String | ConvertFrom-Json)) | Where-Object { "$($_.id)" -eq '9405' } | Select-Object -First 1
    $engineClosed = [bool]($row -and (@('done', 'skip') -contains "$($row.status)".ToLowerInvariant()) -and
      ($row.user_completed -or "$($row.status_by)".ToLowerInvariant() -eq 'user' -or -not $row.on_board))
    if ($engineClosed -eq [bool]$arm.refused) { Write-Host "  PASS  engine-agrees $($arm.name)" }
    else { Write-Host "  FAIL  engine-agrees $($arm.name) -- engine closed=$engineClosed, G24 refused=$($arm.refused)" -ForegroundColor Red; $fail++ }
  } finally {
    foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
    Remove-Item -LiteralPath $w.root -Recurse -Force -ErrorAction SilentlyContinue
  }
}
if ($fail -gt 0) { Write-Host "FAILED: G24 drifted from oa-state's Test-UserClosed." -ForegroundColor Red; exit 1 }

Write-Host ''
Write-Host 'MUTANTS'
foreach ($m in $mutants) {
  $mut = New-Mutant $m.name $m.needle $m.replacement
  try {
    $killedBy = @()
    foreach ($arm in $arms) {
      $r = Test-Arm $mut.path $arm
      if (-not $r.ok) { $killedBy += $r.name }
    }
    if ($killedBy.Count -eq 0) {
      Write-Host "  SURVIVED  $($m.name)" -ForegroundColor Red
      $fail++
    } elseif ($killedBy.Count -eq $arms.Count) {
      # Every arm failing means the mutant did not run at all (a syntax error), not that it was caught.
      Write-Host "  BROKEN    $($m.name) -- every arm failed; the mutant does not run" -ForegroundColor Red
      $fail++
    } else {
      Write-Host "  KILLED    $($m.name) -- $($killedBy -join ', ')"
    }
  } finally {
    Remove-Item -LiteralPath $mut.path -Force -ErrorAction SilentlyContinue
  }
}

if ($fail -gt 0) { Write-Host "FAILED: $fail mutant(s) survived or arm(s) failed." -ForegroundColor Red; exit 1 }
Write-Host ''
Write-Host ("OK: {0} arms passed; {1} mutants killed." -f $arms.Count, $mutants.Count) -ForegroundColor Green
exit 0
