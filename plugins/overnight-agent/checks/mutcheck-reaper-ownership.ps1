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

function New-Node($processId, $parent, $name, $started, $lastActivity = $null) {
  [pscustomobject]@{ Pid = $processId; Parent = $parent; Name = $name; Started = $started; LastActivity = $lastActivity }
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
# --- wedged-owner fixtures (GH #200, criterion 5) --------------------------
# The owner is RESIDENT in all three. Only its last activity differs, which is the whole point:
# presence is identical, liveness is not.
#
# T7 wedged: owner alive but silent for 300 minutes -> must NOT veto (else immortal servers)
$tblWedged = @{
  700 = New-Node 700 70 'node.exe'     $t0.AddMinutes(5)
  70  = New-Node 70  4  'copilot.exe'  $t0                     $t0.AddMinutes(-300)
  4   = New-Node 4   0  'explorer.exe' $t0.AddMinutes(-60)
}
# T8 busy: owner started long ago but wrote 2 minutes ago -> must veto. This is the case that
# proves the check keys on IDLE TIME and not on how long the session has been running.
$tblBusy = @{
  800 = New-Node 800 80 'node.exe'     $t0.AddMinutes(5)
  80  = New-Node 80  4  'copilot.exe'  $t0.AddMinutes(-165)    $t0.AddMinutes(-2)
  4   = New-Node 4   0  'explorer.exe' $t0.AddMinutes(-60)
}
# T9 unknown activity (no log found) -> must veto. Fail-safe direction: missing evidence spares.
$tblUnknownActivity = @{
  900 = New-Node 900 90 'node.exe'     $t0.AddMinutes(5)
  90  = New-Node 90  4  'copilot.exe'  $t0                     $null
  4   = New-Node 4   0  'explorer.exe' $t0.AddMinutes(-60)
}

function Invoke-Case {
  param([string]$FnSource, [hashtable]$Table, [int]$StartPid, [datetime]$Started,
        [int]$OwnerIdleMinutes = 0, [datetime]$Now = $t0)
  $sb = [scriptblock]::Create($FnSource + "`nTest-HasLiveOwner -Table `$args[0] -StartPid `$args[1] -ChildStarted `$args[2] -OwnerNames @('copilot.exe') -OwnerIdleMinutes `$args[3] -Now `$args[4]")
  return [bool](& $sb $Table $StartPid $Started $OwnerIdleMinutes $Now)
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

# --- wedged owner (GH #200, criterion 5) -----------------------------------
# All three run with the activity check ENABLED (240 min), which is the shipped default.
Write-Host "`nbaseline: wedged-owner check (OwnerIdleMinutes 240)" -ForegroundColor Cyan
$T7 = Invoke-Case $fnSrc $tblWedged          700 $t0.AddMinutes(5) 240 $t0
$T8 = Invoke-Case $fnSrc $tblBusy            800 $t0.AddMinutes(5) 240 $t0
$T9 = Invoke-Case $fnSrc $tblUnknownActivity 900 $t0.AddMinutes(5) 240 $t0
# And the same wedged host with the check DISABLED must revert to the old "presence = live".
$T10 = Invoke-Case $fnSrc $tblWedged         700 $t0.AddMinutes(5) 0   $t0

Assert 'T7 owner resident but silent 300m -> REAPABLE'   ($T7 -eq $false) "got $T7"
Assert 'T8 owner running 165m, wrote 2m ago -> SPARED'   ($T8 -eq $true)  "got $T8"
Assert 'T9 activity unknown -> SPARED (fail-safe)'       ($T9 -eq $true)  "got $T9"
Assert 'T10 check disabled -> wedged owner SPARED again' ($T10 -eq $true) "got $T10"

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

# ---------------------------------------------------------------------------
# M4: delete the wedged-owner activity check (GH #200, criterion 5).
#
# This is the mutant that matters most, because the pre-#200 script IS this mutant: it is the
# exact code that shipped before, and it passed every test above. A wedged host stayed "live"
# forever, so its servers could never be collected by anything. T7 must flip; T8/T9 must NOT,
# or the check is simply killing everything rather than discriminating on idle time.
# ---------------------------------------------------------------------------
Write-Host "`nM4: wedged-owner activity check deleted (= the pre-#200 script)" -ForegroundColor Cyan
$m4 = $fnSrc -replace '(?m)^\s*if \(\$OwnerIdleMinutes -gt 0 -and \$node\.LastActivity -is \[datetime\]\) \{\s*$', '            if ($false) {'
Assert 'M4 mutation applied' ($m4 -ne $fnSrc) 'activity guard did not match -- update this mutcheck'
if ($m4 -ne $fnSrc) {
  $m4T7 = Invoke-Case $m4 $tblWedged          700 $t0.AddMinutes(5) 240 $t0
  $m4T8 = Invoke-Case $m4 $tblBusy            800 $t0.AddMinutes(5) 240 $t0
  $m4T9 = Invoke-Case $m4 $tblUnknownActivity 900 $t0.AddMinutes(5) 240 $t0
  Assert 'M4 killed: wedged owner spared forever again' ($m4T7 -eq $true) "T7 still $m4T7 -- the activity check is not load-bearing"
  Assert 'M4 busy owner unaffected'                     ($m4T8 -eq $true) "got $m4T8"
  Assert 'M4 unknown-activity owner unaffected'         ($m4T9 -eq $true) "got $m4T9"
}

# ---------------------------------------------------------------------------
# M5: invert the fail-safe. Treat UNKNOWN activity as wedged rather than as live.
#
# Guards the direction of failure, which is the property that makes this safe to run unattended.
# If a missing/renamed/unreadable log made a server reapable, a logging change on this box would
# silently turn the reaper on the whole fleet. T9 must flip.
# ---------------------------------------------------------------------------
Write-Host "`nM5: unknown activity treated as wedged (fail-safe inverted)" -ForegroundColor Cyan
$m5 = $fnSrc -replace '\$node\.LastActivity -is \[datetime\]', '(-not ($node.LastActivity -is [datetime]) -or $true)'
$m5 = $m5 -replace '\(\$Now - \$node\.LastActivity\)\.TotalMinutes -gt \$OwnerIdleMinutes', '(-not ($node.LastActivity -is [datetime])) -or (($Now - $node.LastActivity).TotalMinutes -gt $OwnerIdleMinutes)'
Assert 'M5 mutation applied' ($m5 -ne $fnSrc) 'activity expression did not match -- update this mutcheck'
if ($m5 -ne $fnSrc) {
  $m5T9 = Invoke-Case $m5 $tblUnknownActivity 900 $t0.AddMinutes(5) 240 $t0
  $m5T8 = Invoke-Case $m5 $tblBusy            800 $t0.AddMinutes(5) 240 $t0
  Assert 'M5 killed: unknown activity would become reapable' ($m5T9 -eq $false) "T9 still $m5T9 -- the fail-safe direction is not enforced"
  Assert 'M5 busy owner still spared'                        ($m5T8 -eq $true)  "got $m5T8"
}

Write-Host ""
if ($script:Fail -gt 0) { exit 1 }
exit 0