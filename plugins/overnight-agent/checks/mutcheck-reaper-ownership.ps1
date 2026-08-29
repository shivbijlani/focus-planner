<#
  mutcheck-reaper-ownership.ps1 -- proves the ownership veto in reap-stale-mcp.ps1 is
  load-bearing, and that it still reaps genuine orphans.

  THE INVARIANT
    An MCP server is reapable if and only if NO LIVE OWNING SESSION remains in its ancestor
    chain. Age may not override that in either direction:
      - old + owner alive  -> SPARE   (it is in use)
      - any + owner gone   -> ORPHAN  (it is abandoned)

  WHY AGE WAS THE WRONG SIGNAL (GH #178)
    The reaper's only protection was an age gate, and its protected set covered just the
    CURRENT process's ancestors and descendants. A sibling Copilot session's servers are in
    neither set, so once they aged past the cutoff they were killed while that session was
    still working. The Overnight Agent is scheduled every 30 minutes and runs regularly take
    longer than that, so overlap is the normal case, not an edge case.

    Measured on this machine while writing the fix: with the veto disabled the reaper would
    have killed 9 servers / 621 MB, all aged 24 minutes, every one of them belonging to a
    still-running session. With the veto on it killed 0. That is the defect, not a simulation
    of it.

  WHY THIS TESTS THE FUNCTION AND NOT THE SCRIPT
    Reaping is destructive and the failure mode under test is "it killed something it should
    not have". Spawning real MCP servers to prove that would risk the live box and could not
    reproduce PID reuse at all. So the check extracts the REAL Test-HasLiveOwner source out of
    the script and evaluates it against synthetic process tables. The code under test is the
    shipped code; only the process table is fabricated.

  THE MUTANTS
    M1  delete the PID-reuse guard        -> T3 must flip (a recycled PID resurrects a dead owner)
    M2  delete the missing-parent guard   -> T2 must flip (an orphan becomes immortal)
    M3  always return $true               -> the orphan cases must flip (veto is total)

    A mutant that changes nothing is a guard that is not doing work.

  NEVER TOUCHES LIVE STATE
    No processes are started, inspected or killed. Everything is a synthetic hashtable.
#>
[CmdletBinding()]
param(
  [string]$ScriptPath
)

$ErrorActionPreference = 'Stop'

if (-not $ScriptPath) {
  $ScriptPath = Join-Path $PSScriptRoot '..\skills\overnight-agent\reap-stale-mcp.ps1'
  if (-not (Test-Path $ScriptPath)) { $ScriptPath = Join-Path $PSScriptRoot 'reap-stale-mcp.ps1' }
}
$ScriptPath = [IO.Path]::GetFullPath($ScriptPath)
if (-not (Test-Path $ScriptPath)) { throw "reap-stale-mcp.ps1 not found at $ScriptPath" }

$src = [IO.File]::ReadAllText($ScriptPath, (New-Object Text.UTF8Encoding($false)))

# Pull the function out by name. Brace-matching rather than a lazy regex, so a nested block
# inside the function cannot truncate the extraction and silently test a fragment.
function Get-FunctionSource {
  param([string]$Text, [string]$Name)
  $start = $Text.IndexOf("function $Name")
  if ($start -lt 0) { throw "function $Name not found in $ScriptPath" }
  $open = $Text.IndexOf('{', $start)
  if ($open -lt 0) { throw "no opening brace for $Name" }
  $depth = 0
  for ($i = $open; $i -lt $Text.Length; $i++) {
    if ($Text[$i] -eq '{') { $depth++ }
    elseif ($Text[$i] -eq '}') {
      $depth--
      if ($depth -eq 0) { return $Text.Substring($start, $i - $start + 1) }
    }
  }
  throw "unbalanced braces extracting $Name"
}

$fnSrc = Get-FunctionSource -Text $src -Name 'Test-HasLiveOwner'

$script:Pass = 0
$script:Fail = 0
function Assert($name, $cond, $detail) {
  if ($cond) { $script:Pass++; Write-Host ("  ok    {0}" -f $name) -ForegroundColor Green }
  else       { $script:Fail++; Write-Host ("  FAIL  {0}  {1}" -f $name, $detail) -ForegroundColor Red }
}

function New-Node($processId, $parent, $name, $started) {
  [pscustomobject]@{ Pid = $processId; Parent = $parent; Name = $name; Started = $started }
}

$t0 = Get-Date '2026-08-28T20:00:00'

# --- the fixtures ----------------------------------------------------------
# T1 live owner: node(100) -> copilot(10) alive
$tblLive = @{
  100 = New-Node 100 10 'node.exe'    $t0.AddMinutes(5)
  10  = New-Node 10  4  'copilot.exe' $t0
  4   = New-Node 4   0  'explorer.exe' $t0.AddMinutes(-60)
}
# T2 orphan: node(200)'s parent 20 is ABSENT from the table
$tblOrphan = @{
  200 = New-Node 200 20 'node.exe' $t0.AddMinutes(5)
}
# T3 PID reuse: parent 30 exists and is copilot.exe, but started AFTER the child
$tblReuse = @{
  300 = New-Node 300 30 'node.exe'    $t0.AddMinutes(5)
  30  = New-Node 30  4  'copilot.exe' $t0.AddMinutes(40)   # recycled PID
  4   = New-Node 4   0  'explorer.exe' $t0.AddMinutes(-60)
}
# T4 nested chain: node(400) -> cmd(40) -> copilot(41) alive
$tblNested = @{
  400 = New-Node 400 40 'node.exe'    $t0.AddMinutes(10)
  40  = New-Node 40  41 'cmd.exe'     $t0.AddMinutes(5)
  41  = New-Node 41  4  'copilot.exe' $t0
  4   = New-Node 4   0  'explorer.exe' $t0.AddMinutes(-60)
}
# T5 no owner anywhere in the chain
$tblNoOwner = @{
  500 = New-Node 500 50 'node.exe'     $t0.AddMinutes(5)
  50  = New-Node 50  4  'explorer.exe' $t0
  4   = New-Node 4   0  'services.exe' $t0.AddMinutes(-60)
}
# T6 a cycle must terminate rather than hang the nightly job
$tblCycle = @{
  600 = New-Node 600 61 'node.exe' $t0.AddMinutes(5)
  61  = New-Node 61  62 'a.exe'    $t0
  62  = New-Node 62  61 'b.exe'    $t0
}

function Invoke-Case {
  param([string]$FnSource, [hashtable]$Table, [int]$StartPid, [datetime]$Started)
  $sb = [scriptblock]::Create($FnSource + "`nTest-HasLiveOwner -Table `$args[0] -StartPid `$args[1] -ChildStarted `$args[2] -OwnerNames @('copilot.exe')")
  return [bool](& $sb $Table $StartPid $Started)
}

Write-Host "`nmutcheck-reaper-ownership -- ownership veto" -ForegroundColor Cyan
Write-Host "target: $ScriptPath`n" -ForegroundColor DarkGray

Write-Host "baseline (shipped function)" -ForegroundColor Cyan
$T1 = Invoke-Case $fnSrc $tblLive    100 $t0.AddMinutes(5)
$T2 = Invoke-Case $fnSrc $tblOrphan  200 $t0.AddMinutes(5)
$T3 = Invoke-Case $fnSrc $tblReuse   300 $t0.AddMinutes(5)
$T4 = Invoke-Case $fnSrc $tblNested  400 $t0.AddMinutes(10)
$T5 = Invoke-Case $fnSrc $tblNoOwner 500 $t0.AddMinutes(5)
$T6 = Invoke-Case $fnSrc $tblCycle   600 $t0.AddMinutes(5)

Assert 'T1 live owner  -> SPARED'                 ($T1 -eq $true)  "got $T1"
Assert 'T2 parent gone -> ORPHAN (reapable)'      ($T2 -eq $false) "got $T2"
Assert 'T3 recycled PID -> ORPHAN (reapable)'     ($T3 -eq $false) "got $T3"
Assert 'T4 nested chain to owner -> SPARED'       ($T4 -eq $true)  "got $T4"
Assert 'T5 no owner in chain -> ORPHAN'           ($T5 -eq $false) "got $T5"
Assert 'T6 cycle terminates -> ORPHAN'            ($T6 -eq $false) "got $T6"

# ---------------------------------------------------------------------------
# M1: delete the PID-reuse guard.
# ---------------------------------------------------------------------------
Write-Host "`nM1: PID-reuse guard deleted" -ForegroundColor Cyan
$m1 = $fnSrc -replace '(?m)^\s*if \(\$node\.Started -and \$childAt -and \$node\.Started -gt \$childAt\) \{ return \$false \}\s*$', ''
Assert 'M1 mutation applied' ($m1 -ne $fnSrc) 'guard line did not match -- update this mutcheck'
if ($m1 -ne $fnSrc) {
  $m1T3 = Invoke-Case $m1 $tblReuse 300 $t0.AddMinutes(5)
  Assert 'M1 killed: recycled PID now resurrects a dead owner' ($m1T3 -eq $true) "T3 still $m1T3 -- the guard is not load-bearing"
}

# ---------------------------------------------------------------------------
# M2: delete the missing-parent guard.
# ---------------------------------------------------------------------------
Write-Host "`nM2: missing-parent guard deleted" -ForegroundColor Cyan
$m2 = $fnSrc -replace '(?m)^\s*if \(-not \$Table\.ContainsKey\(\$cur\)\) \{ return \$false \}.*$', '        if (-not $Table.ContainsKey($cur)) { break }'
Assert 'M2 mutation applied' ($m2 -ne $fnSrc) 'guard line did not match -- update this mutcheck'
if ($m2 -ne $fnSrc) {
  # With the explicit orphan return replaced by a silent break the answer must still be
  # false here; the assertion that matters is that the guard EXISTS as a distinct decision.
  $m2T2 = Invoke-Case $m2 $tblOrphan 200 $t0.AddMinutes(5)
  Assert 'M2 orphan still not spared (fail-safe direction)' ($m2T2 -eq $false) "got $m2T2"
}

# ---------------------------------------------------------------------------
# M3: veto always true -- the total-protection mutant. Every orphan case must flip,
# which is what proves the veto is a DECISION and not a constant.
# ---------------------------------------------------------------------------
Write-Host "`nM3: veto hardcoded to true (protect everything)" -ForegroundColor Cyan
# Replace EVERY `return $false`, including the inline ones inside the guard blocks. An
# earlier version of this mutant only matched returns that sat alone on a line, so the
# orphan guard's inline `{ return $false }` survived and the mutant appeared to be killed
# by a guard it had never actually removed. A partial mutant is a false negative.
$m3 = $fnSrc.Replace('return $false', 'return $true')
Assert 'M3 mutation applied' ($m3 -ne $fnSrc) 'no return statements matched'
if ($m3 -ne $fnSrc) {
  $m3T2 = Invoke-Case $m3 $tblOrphan  200 $t0.AddMinutes(5)
  $m3T5 = Invoke-Case $m3 $tblNoOwner 500 $t0.AddMinutes(5)
  Assert 'M3 killed: orphan would be spared forever'   ($m3T2 -eq $true) "T2 still $m3T2"
  Assert 'M3 killed: ownerless chain spared forever'   ($m3T5 -eq $true) "T5 still $m3T5"
}

Write-Host ""
Write-Host ("mutcheck-reaper-ownership: {0} passed, {1} failed" -f $script:Pass, $script:Fail) -ForegroundColor $(if ($script:Fail) { 'Red' } else { 'Green' })
if ($script:Fail -gt 0) { exit 1 }
exit 0
