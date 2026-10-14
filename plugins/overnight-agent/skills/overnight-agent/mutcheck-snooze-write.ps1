<#
  mutcheck-snooze-write.ps1 -- G22, the snoozed-task stop on the WRITE side (GH #816).

  A scan row that is `snoozed: true` is ineligible, but a session that is already alive can
  still try to append a plan or execution turn. G22 closes that write-side hole in the sanctioned
  journal writer and fails closed when the structured snooze store cannot be verified.

  Hermetic: synthetic planner, journal and body files under TEMP, driving write-turn.ps1 or its
  Node port with -JournalDir pointed inside the sandbox. No live planner, no network.
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
$today = (Get-Date).Date
$dates = @{
  yesterday = $today.AddDays(-1).ToString('yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
  today     = $today.ToString('yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
  tomorrow  = $today.AddDays(1).ToString('yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
}

function Get-SubjectPrefix([string]$Path) {
  if ($Path -like '*.mjs') { return @('node', $Path) }
  return @($script:PsExe, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Path)
}

function Write-Utf8([string]$Path, [string]$Text) {
  New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force | Out-Null
  [IO.File]::WriteAllText($Path, $Text, $utf8)
}

function New-World([string]$Name) {
  $root = Join-Path ([IO.Path]::GetTempPath()) ("oa-816-$Name-" + [guid]::NewGuid().ToString('N').Substring(0, 6))
  $journal = Join-Path $root 'data\journal'
  New-Item -ItemType Directory -Path $journal -Force | Out-Null
  Write-Utf8 (Join-Path $journal 'task-9406.md') "# Task 9406: Snooze target`n`n---`n<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->`n"
  Write-Utf8 (Join-Path $journal 'task-9407.md') "# Task 9407: Other target`n`n---`n<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->`n"
  $body = Join-Path $root 'body.md'
  Write-Utf8 $body "## $MOON Overnight Agent -- snooze guard`n`n<!-- from: overnight-agent -->`n`n**Status:** In progress.`n`n**Needs from you:** nothing.`n"
  return [pscustomobject]@{ root = $root; data = (Join-Path $root 'data'); journal = $journal; body = $body }
}

function Invoke-Subject([string]$Path, $World, [string]$Id, [string[]]$Extra = @()) {
  $prefix = Get-SubjectPrefix $Path
  $exe = $prefix[0]
  $argv = @($prefix | Select-Object -Skip 1) + @('-Id', $Id, '-BodyFile', $World.body, '-JournalDir', $World.journal, '-Ask', 'none', '-Validate') + $Extra
  $so = Join-Path $World.root 'stdout.txt'
  $se = Join-Path $World.root 'stderr.txt'
  $env:WRITE_TURN_OA_HOME = Join-Path $World.root 'home'
  $p = Start-Process -FilePath $exe -ArgumentList $argv -NoNewWindow -Wait -PassThru -RedirectStandardOutput $so -RedirectStandardError $se
  $out = ''
  foreach ($f in @($so, $se)) { if (Test-Path -LiteralPath $f) { $out += [IO.File]::ReadAllText($f) } }
  return [pscustomobject]@{ code = $p.ExitCode; out = $out }
}

function Detail($Result) {
  $o = ($Result.out -replace '\s+', ' ').Trim()
  if ($o.Length -gt 220) { $o = $o.Substring(0, 220) + '...' }
  return "exit=$($Result.code) :: $o"
}

$arms = @(
  @{
    name = 'store-snoozed-refused'; id = '9406'; refused = $true
    setup = { param($w) Write-Utf8 (Join-Path $w.data 'snooze.json') "{`"9406`":`"$($dates.tomorrow)`"}" }
  },
  @{
    name = 'board-marker-refused'; id = '9406'; refused = $true
    setup = { param($w) Write-Utf8 (Join-Path $w.data 'planner.md') "| ID | Task |`n| 9406 | target | <!-- snooze:$($dates.tomorrow) -->`n" }
  },
  @{
    name = 'today-refused'; id = '9406'; refused = $true
    setup = { param($w) Write-Utf8 (Join-Path $w.data 'snooze.json') "{`"9406`":`"$($dates.today)`"}" }
  },
  @{
    name = 'yesterday-allowed'; id = '9406'; refused = $false
    setup = { param($w) Write-Utf8 (Join-Path $w.data 'snooze.json') "{`"9406`":`"$($dates.yesterday)`"}" }
  },
  @{
    name = 'other-task-allowed'; id = '9406'; refused = $false
    setup = { param($w) Write-Utf8 (Join-Path $w.data 'snooze.json') "{`"9407`":`"$($dates.tomorrow)`"}" }
  },
  @{
    name = 'malformed-store-refused'; id = '9406'; refused = $true
    setup = { param($w) Write-Utf8 (Join-Path $w.data 'snooze.json') '{ this is not json' }
  },
  @{
    name = 'disable-guard-g22-still-refused'; id = '9406'; refused = $true; extra = @('-DisableGuard', 'G22')
    setup = { param($w) Write-Utf8 (Join-Path $w.data 'snooze.json') "{`"9406`":`"$($dates.tomorrow)`"}" }
  }
)

function Test-Arm([string]$Path, $Arm) {
  $w = New-World $Arm.name
  try {
    & $Arm.setup $w
    $r = Invoke-Subject $Path $w $Arm.id @($Arm.extra)
    $isRefused = ($r.code -eq 2 -and $r.out -match 'G22')
    $ok = if ($Arm.refused) { $isRefused } else { ($r.code -eq 0 -and $r.out -notmatch 'G22') }
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
  $safeName = ($Name -replace '[^A-Za-z0-9_.-]', '-')
  $dir = Join-Path ([IO.Path]::GetTempPath()) ("oa-816-mut-$safeName-" + [guid]::NewGuid().ToString('N').Substring(0, 6))
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $dst = Join-Path $dir ([IO.Path]::GetFileName($ScriptPath))
  $src = [IO.File]::ReadAllText($ScriptPath)
  [IO.File]::WriteAllText($dst, (Replace-FirstLiteral $src $Needle $Replacement), $utf8)
  return [pscustomobject]@{ name = $Name; path = $dst; root = $dir }
}

$mutants = if ($script:IsNode) {
  @(
    @{ name = 'guard skipped';                 needle = 'if (snoozeVerdict) {'; replacement = 'if (false && snoozeVerdict) {' },
    @{ name = 'today comparison changed to >'; needle = 'return key >= today ? p.text : null;'; replacement = 'return key > today ? p.text : null;' },
    @{ name = 'store ignored';                 needle = 'if (testPath(storePath)) {'; replacement = 'if (false && testPath(storePath)) {' },
    @{ name = 'malformed store treated empty'; needle = "return { kind: 'malformed', until: '', source: 'snooze.json', snippet: 'snooze.json' };"; replacement = 'return null;' },
    @{ name = 'guard made disableable';        needle = 'if (snoozeVerdict) {'; replacement = "if (snoozeVerdict && !ciContains(disabled, 'G22')) {" }
  )
} else {
  @(
    @{ name = 'guard skipped';                 needle = 'if ($script:SnoozeVerdict) {'; replacement = 'if ($false -and $script:SnoozeVerdict) {' },
    @{ name = 'today comparison changed to >'; needle = '$d.Date -ge (Get-Date).Date'; replacement = '$d.Date -gt (Get-Date).Date' },
    @{ name = 'store ignored';                 needle = 'if (Test-Path -LiteralPath $storePath) {'; replacement = 'if ($false -and (Test-Path -LiteralPath $storePath)) {' },
    @{ name = 'malformed store treated empty'; needle = "return [pscustomobject]@{ kind = 'malformed'; until = ''; source = 'snooze.json'; snippet = 'snooze.json' }"; replacement = 'return $null' },
    @{ name = 'guard made disableable';        needle = 'if ($script:SnoozeVerdict) {'; replacement = "if (`$script:SnoozeVerdict -and (`$DisableGuard -notcontains 'G22')) {" }
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
    } else {
      Write-Host "  KILLED    $($m.name) -- $($killedBy -join ', ')"
    }
  } finally {
    Remove-Item -LiteralPath $mut.root -Recurse -Force -ErrorAction SilentlyContinue
  }
}

if ($fail -gt 0) { Write-Host "FAILED: $fail mutant(s) survived or arm(s) failed." -ForegroundColor Red; exit 1 }
Write-Host ''
Write-Host ("OK: {0} arms passed; {1} mutants killed." -f $arms.Count, $mutants.Count) -ForegroundColor Green
exit 0
