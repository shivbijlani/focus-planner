<#
  mutcheck-supervisor-liveness.ps1 - proves every arm of supervisor-liveness-sweep.ps1
  is load-bearing, by MUTATING THE REAL FILE rather than a copy of its logic.

  WHY IT MUTATES THE REAL FILE
  ----------------------------
  The older mutcheck-supervisor.ps1 re-implements its subject's classifier inside the
  test and mutates the re-implementation. That is cheaper, and it is also the exact
  bug class this whole change exists to remove: a guard that looks like protection
  while being structurally incapable of noticing the real thing drifting. A test copy
  can silently diverge from the file that actually runs. So this one reads
  supervisor-liveness-sweep.ps1 off disk, rewrites one arm, and runs the mutant.

  If a mutation changes no verdict, the arm it broke was decoration and this fails.
  If a mutation changes a verdict it does not own, the arms are entangled and this
  fails too - an arm that cannot be reasoned about alone cannot be trusted alone.

  It drives the subject through -FactsJson, so it needs no scheduled task, no daemon
  and no Windows: it runs unmodified on the Linux runner under pwsh.

  Run: pwsh -File mutcheck-supervisor-liveness.ps1
  Exit 0 = every arm proven load-bearing. Exit 1 = a mutation survived or leaked.
#>
[CmdletBinding()]
param([switch]$Json)

$ErrorActionPreference = 'Stop'

$Subject = Join-Path $PSScriptRoot 'supervisor-liveness-sweep.ps1'
if (-not (Test-Path $Subject)) { throw "subject not found: $Subject" }

# The host running THIS file, so the mutant runs under the same engine on either OS.
$PsExe = (Get-Process -Id $PID).Path
$Root  = Join-Path ([IO.Path]::GetTempPath()) ("mutcheck-sl-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $Root -Force | Out-Null

$script:pass = 0
$script:fail = 0
$script:notes = @()
function Assert([bool]$Cond, [string]$Id, [string]$Why) {
  if ($Cond) { $script:pass++ }
  else { $script:fail++; $script:notes += "$Id : $Why" ; Write-Host "  FAIL $Id : $Why" }
}

function New-Unit {
  param(
    [string]$Name, [bool]$Task = $false, [string]$TaskState = '', $TaskLastRunMin = $null,
    [bool]$Shim = $false, [bool]$Alive = $false, $SignalAgeMin = $null, [int]$Cadence = 15
  )
  [ordered]@{
    name = $Name; issue = '#261'; purpose = 'fixture'
    taskInstalled = $Task; taskState = $TaskState; taskLastRunMin = $TaskLastRunMin
    shimInstalled = $Shim; shimPath = $(if ($Shim) { 'shim' } else { '' })
    processAlive = $Alive; processPid = $(if ($Alive) { 42 } else { 0 })
    signalPath = 'signal'; signalAgeMin = $SignalAgeMin; cadenceMin = $Cadence
  }
}

# --- fixtures ------------------------------------------------------------------------
# Each expectation is OWNED by exactly one arm. The two owner='' rows are the
# false-positive guards: no mutation may make them fail, and nothing may make them
# noisy in normal operation. run-sweeps.ps1 records at length what a permanently red
# line does to a reader, so "stays green when healthy" is a real requirement here.
$fixtures = @(
  @{ owner = 'install'; expect = 'ABSENT'
     unit = (New-Unit -Name 'absent') }

  @{ owner = 'task';    expect = 'HEALTHY'
     unit = (New-Unit -Name 'task-only' -Task $true -TaskState 'Ready' -TaskLastRunMin 5) }

  # Dead process but a heartbeat written one minute before it died. This is why
  # liveness and freshness must be separate arms: the freshest possible signal is
  # still no evidence that anything is running.
  @{ owner = 'process'; expect = 'DEAD'
     unit = (New-Unit -Name 'dead-daemon' -Shim $true -Alive $false -SignalAgeMin 2) }

  # Alive but not beating: wedged inside its own child call, which is the failure the
  # heartbeat was written for and the one a process check alone cannot see.
  @{ owner = 'fresh';   expect = 'STALE'
     unit = (New-Unit -Name 'stale-daemon' -Shim $true -Alive $true -SignalAgeMin 300) }

  @{ owner = '';        expect = 'HEALTHY'
     unit = (New-Unit -Name 'healthy-daemon' -Shim $true -Alive $true -SignalAgeMin 3) }

  # One missed beat (40 min at a 15 min cadence, floor 45) must NOT alarm.
  @{ owner = '';        expect = 'HEALTHY'
     unit = (New-Unit -Name 'slow-but-ok' -Shim $true -Alive $true -SignalAgeMin 40) }
)

$FactsPath = Join-Path $Root 'facts.json'
[ordered]@{ collectedUtc = '2026-09-04T00:00:00Z'; units = @($fixtures | ForEach-Object { $_.unit }) } |
  ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $FactsPath -Encoding utf8

function Invoke-Subject([string]$ScriptPath) {
  $so = Join-Path $Root ('out-' + [Guid]::NewGuid().ToString('N').Substring(0, 6) + '.json')
  $p = Start-Process -FilePath $PsExe `
        -ArgumentList @('-NoProfile', '-File', $ScriptPath, '-FactsJson', $FactsPath, '-Json') `
        -NoNewWindow -Wait -PassThru -RedirectStandardOutput $so
  $raw = if (Test-Path $so) { Get-Content $so -Raw } else { '' }
  if (-not $raw -or -not $raw.Trim()) { return $null }
  try { return ($raw | ConvertFrom-Json) } catch { return $null }
}

function Get-Verdicts($Result) {
  $map = @{}
  if ($Result -and $Result.units) { foreach ($u in $Result.units) { $map[$u.name] = $u.verdict } }
  return $map
}

# Names whose verdict differs from the fixture expectation.
function Get-Broken($Result) {
  $v = Get-Verdicts $Result
  $broken = @()
  foreach ($f in $fixtures) {
    $n = $f.unit.name
    if (-not $v.ContainsKey($n) -or $v[$n] -ne $f.expect) { $broken += $n }
  }
  return , $broken
}

function New-Mutant {
  param([string]$Name, [string]$Find, [string]$Replace)
  $src = [IO.File]::ReadAllText($Subject, (New-Object Text.UTF8Encoding($false)))
  if ($src -notmatch [regex]::Escape($Find)) { throw "mutant $Name : anchor not found -> $Find" }
  $dst = Join-Path $Root "mutant-$Name.ps1"
  [IO.File]::WriteAllText($dst, $src.Replace($Find, $Replace), (New-Object Text.UTF8Encoding($false)))
  return $dst
}

Write-Host "[mutcheck-supervisor-liveness] subject = $Subject"
Write-Host "[mutcheck-supervisor-liveness] host    = $PsExe"
Write-Host ''

# --- 1. BASELINE: the real, unmutated file must classify every fixture correctly -----
$base = Invoke-Subject $Subject
Assert ($null -ne $base) 'T_BASELINE_RUNS' 'the unmutated sweep produced no parseable JSON'
$baseBroken = Get-Broken $base
Assert ($baseBroken.Count -eq 0) 'T_BASELINE' "unmutated sweep misclassified: $($baseBroken -join ', ')"

# The sweep must also REPORT findings, not merely compute them: a detector that
# classifies correctly and exits 0 is invisible to run-sweeps.ps1.
Assert ($base -and $base.findings -eq 3) 'T_FINDINGS_COUNTED' "expected 3 non-healthy units, got $($base.findings)"

# --- 2. Each arm, mutated alone, must break its own fixture and only its own ---------
$arms = @(
  @{ id = 'install'
     find    = "  if (-not `$installed) { return 'ABSENT' }"
     replace = "  if (`$false) { return 'ABSENT' }"
     why     = 'without it, "never installed" is indistinguishable from "installed but dead"' }

  @{ id = 'task'
     find    = "  `$taskHealthy = ([bool]`$Unit.taskInstalled) -and"
     replace = "  `$taskHealthy = `$false -and ([bool]`$Unit.taskInstalled) -and"
     why     = 'without it, the elevated scheduled-task install reports DEAD forever' }

  @{ id = 'process'
     find    = "  `$daemonAlive = ([bool]`$Unit.shimInstalled) -and ([bool]`$Unit.processAlive)"
     replace = "  `$daemonAlive = ([bool]`$Unit.shimInstalled)"
     why     = 'without it, a shim on disk is mistaken for a running daemon' }

  @{ id = 'fresh'
     find    = "  `$daemonFresh = (`$null -ne `$Unit.signalAgeMin) -and ([double]`$Unit.signalAgeMin -le `$tolerance)"
     replace = "  `$daemonFresh = `$true"
     why     = 'without it, a wedged daemon that stopped beating still reads healthy' }
)

$report = [ordered]@{}
foreach ($arm in $arms) {
  $mutant = New-Mutant $arm.id $arm.find $arm.replace
  $r = Invoke-Subject $mutant
  $broken = Get-Broken $r

  $ownNames = @($fixtures | Where-Object { $_.owner -eq $arm.id } | ForEach-Object { $_.unit.name })
  $own      = @($broken | Where-Object { $ownNames -contains $_ })
  $foreign  = @($broken | Where-Object { $ownNames -notcontains $_ })

  $verdict =
    if ($broken.Count -eq 0) { 'MUTATION SURVIVED - this arm is decoration' }
    elseif ($foreign.Count -gt 0) { "arm is entangled - it also broke: $($foreign -join ', ')" }
    elseif ($own.Count -eq 0) { 'broke something, but not its own fixture' }
    else { 'load-bearing' }

  $report[$arm.id] = @{ broke = $broken.Count; own = $own.Count; foreign = $foreign.Count; verdict = $verdict }
  Write-Host ("  {0,-9} {1,-12} own={2} foreign={3}  {4}" -f $arm.id, "broke=$($broken.Count)", $own.Count, $foreign.Count, $verdict)
  Assert ($verdict -eq 'load-bearing') "M_$($arm.id)" "$($arm.why) -- got: $verdict"
}

# --- 3. The two false-positive guards must survive EVERY mutation --------------------
# Stated as its own assertion because "stays green when healthy" is the property that
# decides whether anyone still reads this sweep in a month.
$greenNames = @($fixtures | Where-Object { $_.owner -eq '' } | ForEach-Object { $_.unit.name })
foreach ($arm in $arms) {
  $r = Invoke-Subject (Join-Path $Root "mutant-$($arm.id).ps1")
  $v = Get-Verdicts $r
  foreach ($g in $greenNames) {
    Assert ($v.ContainsKey($g) -and $v[$g] -eq 'HEALTHY') "G_$($arm.id)_$g" `
      "mutating '$($arm.id)' turned the healthy fixture '$g' into '$($v[$g])' - that is a false positive"
  }
}

# --- 4. Exit code must carry the finding ---------------------------------------------
# run-sweeps.ps1 classifies purely on exit code, so a sweep that prints DORMANT and
# exits 0 is silent where it counts.
$soClean = Join-Path $Root 'clean-facts.json'
[ordered]@{ collectedUtc = '2026-09-04T00:00:00Z'; units = @((New-Unit -Name 'ok' -Shim $true -Alive $true -SignalAgeMin 3)) } |
  ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $soClean -Encoding utf8
$pClean = Start-Process -FilePath $PsExe -ArgumentList @('-NoProfile', '-File', $Subject, '-FactsJson', $soClean) `
            -NoNewWindow -Wait -PassThru -RedirectStandardOutput (Join-Path $Root 'clean.txt')
Assert ($pClean.ExitCode -eq 0) 'T_EXIT_CLEAN' "all-healthy must exit 0, got $($pClean.ExitCode)"

$pDirty = Start-Process -FilePath $PsExe -ArgumentList @('-NoProfile', '-File', $Subject, '-FactsJson', $FactsPath) `
            -NoNewWindow -Wait -PassThru -RedirectStandardOutput (Join-Path $Root 'dirty.txt')
Assert ($pDirty.ExitCode -eq 1) 'T_EXIT_FINDINGS' "a dormant unit must exit 1, got $($pDirty.ExitCode)"

Remove-Item $Root -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host ("[mutcheck-supervisor-liveness] {0} passed, {1} failed" -f $script:pass, $script:fail)
if ($Json) { [pscustomobject]@{ passed = $script:pass; failed = $script:fail; arms = $report; notes = $script:notes } | ConvertTo-Json -Depth 5 }
exit ($(if ($script:fail) { 1 } else { 0 }))
