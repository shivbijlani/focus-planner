<#
  mutcheck-supervisor-resource.ps1 -- proves every arm of the #403 resource detector is
  load-bearing, by mutating the REAL oa-supervisor.ps1 rather than a copy of its logic.

  WHY THIS SHAPE, AND HOW IT DIFFERS FROM mutcheck-supervisor.ps1
  --------------------------------------------------------------
  That older harness reimplements the classifier inside itself and mutates the copy. It
  works, but a copy can drift from the shipped file and then prove a guard that is no
  longer the guard being run -- the same "green where it was written, broken where it
  runs" class as #463. This one dot-sources the real script's functions out of the real
  file, so what is mutated is what ships.

  WHAT #403 REQUIRES, AND THE ARM THAT ANSWERS EACH
  -------------------------------------------------
    "a sustained leak reaches a non-HEALTHY state"        -> LEAK, from the real numbers
    "a busy-but-healthy machine stays HEALTHY"            -> BUSY (queue low, spike high)
    "a mutation arm should fail if the detector keys on
     instantaneous CPU alone"                             -> mutation `rate->instantaneous`
    "an interactive session is never restarted merely for
     being long-lived" (#178: age-only heuristics kill
     legitimate work)                                     -> OLD (14.7 h, tiny rate)
    "the restart path reuses the existing cooldown"       -> asserted on the ACTION arm

  The LEAK fixture is not invented. It is the live 2026-09-02 measurement from #403:
  7.05 CPU-hours across 14.7 hours of uptime (rate 0.48) with processor queue length 21.

  Run: powershell -NoProfile -ExecutionPolicy Bypass -File mutcheck-supervisor-resource.ps1
  Exit 0 = every arm proven load-bearing. Exit 1 = a mutation survived, or a fixture failed.
#>
[CmdletBinding()]
param([string]$ScriptPath)

$ErrorActionPreference = 'Stop'
if (-not $ScriptPath) {
  # Resolved in the BODY, and from THREE sources, because CI invokes this as
  # `pwsh -command ". '<file>'"` where $PSScriptRoot and $MyInvocation.MyCommand.Path are both
  # null -- Split-Path then throws "Cannot bind argument to parameter 'Path' because it is
  # null" before a single assertion runs. $PSCommandPath survives that form.
  $self = if ($PSCommandPath) { $PSCommandPath } elseif ($MyInvocation.MyCommand.Path) { $MyInvocation.MyCommand.Path } else { $null }
  $here = if ($PSScriptRoot) { $PSScriptRoot } elseif ($self) { Split-Path -Parent $self } else { Join-Path (Get-Location) 'plugins/overnight-agent/checks' }
  $ScriptPath = Join-Path $here 'oa-supervisor.ps1'
}
if (-not (Test-Path $ScriptPath)) { Write-Host "FAIL cannot find oa-supervisor.ps1 at $ScriptPath"; exit 2 }

$src = [IO.File]::ReadAllText($ScriptPath, (New-Object Text.UTF8Encoding($false)))
$root = Join-Path $env:TEMP ('mutcheck-res-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $root | Out-Null
$pass = 0; $fail = 0

function Check([string]$label, [bool]$cond, [string]$detail) {
  if ($cond) { $script:pass++; Write-Host "  PASS  $label" }
  else { $script:fail++; Write-Host "  FAIL  $label$(if ($detail) { " -- $detail" })" }
}

# Lift the two pure functions out of the real source and load them as an isolated in-process
# module. No child process: `powershell.exe` does not exist on the Linux runner, and spawning
# one per fixture per mutation would be both non-portable and slow. New-Module gives each
# variant its own scope, so a mutant cannot leak into the baseline.
function New-Harness([string]$source, [string]$tag) {
  $names = @('Get-ResourceVerdict', 'Get-SupervisorAction')
  $sb = New-Object Text.StringBuilder
  foreach ($n in $names) {
    $i = $source.IndexOf("function $n {")
    if ($i -lt 0) { throw "cannot find function $n in the source" }
    # Brace-match to the end of the function so the extraction cannot silently truncate.
    $depth = 0; $j = $i; $started = $false
    while ($j -lt $source.Length) {
      if ($source[$j] -eq '{') { $depth++; $started = $true }
      elseif ($source[$j] -eq '}') { $depth-- }
      $j++
      if ($started -and $depth -eq 0) { break }
    }
    [void]$sb.AppendLine($source.Substring($i, $j - $i))
  }
  [void]$sb.AppendLine("Export-ModuleMember -Function $($names -join ',')")
  return New-Module -Name "res-$tag" -ScriptBlock ([scriptblock]::Create($sb.ToString())) | Import-Module -PassThru -Force
}

# --- fixtures --------------------------------------------------------------------------
# LEAK  the live #403 measurement: 7.05 CPU-h / 14.7 h uptime = rate 0.48, queue 21.
# BUSY  a real machine under legitimate load: the tree is working hard RIGHT NOW (0.2 CPU-h
#       in half an hour) but the machine is keeping up, so it is not a fault. This is the
#       fixture that dies if the contention gate is removed -- i.e. it is what stops a
#       hard-working machine being called a leak.
# OLD   an interactive session Shiv has left open all day: the same 14.7 h age as the leak,
#       a large-ish ABSOLUTE total, and a trivial rate. It is the fixture that dies if the
#       detector keys on the accumulated total instead of the rate, which is the concrete
#       form of "#403: a mutation arm should fail if the detector keys on instantaneous CPU
#       alone" -- and it is #178's age-only trap in the same breath.
# FOREIGN something else is hogging the box: machine contended, our tree cheap.
# NOSAMPLE sampling failed. Must NOT read as healthy (#346).
$fixtures = [ordered]@{
  LEAK     = @{ sample = @{ queueLength = 21; appCpuHours = 7.05; appAgeHours = 14.7; procCount = 2 }; state = 'RESOURCE-LEAK' }
  BUSY     = @{ sample = @{ queueLength = 2;  appCpuHours = 0.20; appAgeHours = 0.5;  procCount = 2 }; state = 'HEALTHY' }
  OLD      = @{ sample = @{ queueLength = 21; appCpuHours = 0.30; appAgeHours = 14.7; procCount = 2 }; state = 'RESOURCE-CONTENDED' }
  FOREIGN  = @{ sample = @{ queueLength = 18; appCpuHours = 0.05; appAgeHours = 6.0;  procCount = 1 }; state = 'RESOURCE-CONTENDED' }
  NOSAMPLE = @{ sample = $null;                                                                         state = 'RESOURCE-UNKNOWN' }
}

function Invoke-Verdict($harness, $sample) {
  $s = if ($null -eq $sample) { $null } else { [pscustomobject]$sample }
  return "$(& $harness { param($x) (Get-ResourceVerdict -Sample $x).state } $s)".Trim()
}

function Invoke-Action($harness, [string]$state, [bool]$appRunning) {
  return "$(& $harness { param($st, $ar) Get-SupervisorAction -State $st -FlaggedOrphans 0 -HasHungAlive $false -AppRunning $ar } $state $appRunning)".Trim()
}

$base = New-Harness $src 'base'

Write-Host '== baseline (real functions, unmutated) =='
$baseStates = @{}
foreach ($k in $fixtures.Keys) {
  $got = Invoke-Verdict $base $fixtures[$k].sample
  $baseStates[$k] = $got
  Check "$k -> $($fixtures[$k].state)" ($got -eq $fixtures[$k].state) "got '$got'"
}

Write-Host ''
Write-Host '== actions (the restart trigger, and what must NOT act) =='
$actLeak = Invoke-Action $base 'RESOURCE-LEAK' $true
Check 'RESOURCE-LEAK + app running -> restart' ($actLeak -eq 'restart') "got '$actLeak'"
$actLeakDown = Invoke-Action $base 'RESOURCE-LEAK' $false
Check 'RESOURCE-LEAK + app down -> none (nothing to restart)' ($actLeakDown -eq 'none') "got '$actLeakDown'"
$actCont = Invoke-Action $base 'RESOURCE-CONTENDED' $true
Check 'RESOURCE-CONTENDED -> none (not attributable, never acted on)' ($actCont -eq 'none') "got '$actCont'"
$actUnk = Invoke-Action $base 'RESOURCE-UNKNOWN' $true
Check 'RESOURCE-UNKNOWN -> none (cannot measure is not cause to act)' ($actUnk -eq 'none') "got '$actUnk'"

# The cooldown is applied by the caller to any 'restart'. Asserting the ACTION is exactly
# 'restart' -- rather than some new verb -- is what proves the new trigger inherits the
# existing anti-loop instead of routing around it.
Check 'the leak trigger reuses the existing restart verb, so the cooldown applies' ($actLeak -eq 'restart') "got '$actLeak'"

# --- mutations ---------------------------------------------------------------------------
$mutations = @(
  @{ n = 'rate -> absolute accumulated CPU (keying on the total, not the rate)'
     guards = 'OLD'
     find = '  if ($ratio -lt $LeakCpuRatio) {'
     repl = '  if ([double]$Sample.appCpuHours -lt 0.1) {' }
  @{ n = 'contention gate removed (an expensive tree on a machine keeping up reads as a leak)'
     guards = 'BUSY'
     find = '  if ($queue -lt $QueueThreshold) {'
     repl = '  if ($false) {' }
  @{ n = 'leak detector disabled (a real leak reads as merely contended)'
     guards = 'LEAK'
     find = '  return @{ state = ''RESOURCE-LEAK''; detail = $detail; ratio = $ratio; queue = $queue }'
     repl = '  return @{ state = ''RESOURCE-CONTENDED''; detail = $detail; ratio = $ratio; queue = $queue }' }
  @{ n = 'failed sampling reads as HEALTHY (#346 inverted)'
     guards = 'NOSAMPLE'
     find = '    return @{ state = ''RESOURCE-UNKNOWN''; detail = ''resource sampling unavailable''; ratio = $null; queue = $null }'
     repl = '    return @{ state = ''HEALTHY''; detail = ''resource sampling unavailable''; ratio = $null; queue = $null }' }
)

Write-Host ''
Write-Host '== mutations (each killed by exactly one fixture) =='
foreach ($m in $mutations) {
  if ($src.IndexOf($m.find) -lt 0) {
    Check "$($m.n): anchor present in source" $false "not found: $($m.find)"
    continue
  }
  $h = New-Harness ($src.Replace($m.find, $m.repl)) ("mut-" + $m.guards)
  $moved = @()
  foreach ($k in $fixtures.Keys) {
    $got = Invoke-Verdict $h $fixtures[$k].sample
    if ($got -ne $baseStates[$k]) { $moved += $k }
  }
  Check "$($m.n) -> $($m.guards) moves (arm is load-bearing)" ($moved -contains $m.guards) "moved: $($moved -join ',')"
  $extra = @($moved | Where-Object { $_ -ne $m.guards })
  Check "$($m.n): changes nothing else" ($extra.Count -eq 0) "also moved: $($extra -join ',')"
}

# The age-only trap, stated as its own assertion because it is a REQUIREMENT rather than a
# mutation: OLD and LEAK share an age of 14.7 h and differ only in rate. If the detector
# ever keys on age, these two become indistinguishable and #178 comes straight back.
Write-Host ''
Write-Host '== age is not a signal (#178) =='
Check 'OLD and LEAK share an age but not a verdict' ($baseStates['OLD'] -ne $baseStates['LEAK']) `
  "OLD=$($baseStates['OLD']) LEAK=$($baseStates['LEAK'])"

Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ''
Write-Host "$pass passed, $fail failed"
exit $(if ($fail) { 1 } else { 0 })
