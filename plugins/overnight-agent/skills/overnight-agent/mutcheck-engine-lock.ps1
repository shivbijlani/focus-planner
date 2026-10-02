<#
  mutcheck-engine-lock.ps1 -- the two state engines exclude each other (#124, cut-over).

  WHY THIS EXISTS
  ---------------
  oa-state.ps1 serialised its read/modify/write of the state store with a Windows NAMED MUTEX.
  oa-state.mjs (the Node port the agent now runs) cannot take a named mutex and locks a FILE,
  `%TEMP%\oa-state-<sha256 of the case-folded StateDir>.lock`, instead. Each excluded only its
  own kind. After the cut-over PowerShell writers still exist -- the SKILL fallback when node is
  missing, a task session started before the deploy, a check script -- so a PowerShell `mark`
  and a Node `mark` on the same task could interleave and one of the two updates would be lost.

  The fix: oa-state.ps1 ALSO takes Node's lock file (same path, same exclusive create, same
  dead-PID reclaim, no stale age), FIRST, then its mutex.

  WHAT IS PINNED HERE (both directions, with the REAL lock code of each engine)
  ----------------------------------------------------------------------------
  A  A Node writer holds the state lock across a slow read-modify-write of task-950.json (it
     adds `race_probe`); a real `oa-state.ps1 mark -Status blocked` starts during the hold.
     Both updates must land: PowerShell waited for the Node lock.
  B  The mirror: a PowerShell writer holds the lock through oa-state.ps1's OWN lock functions
     (extracted from the target with the PowerShell parser, not re-implemented here) across a
     slow read-modify-write; a real `oa-state.mjs mark -Status blocked` starts during the hold.
     Both must land: Node waited for the PowerShell lock.
  C  A lock file left by a DEAD process is reclaimed at once by oa-state.ps1 (as Node does):
     `mark` with a 3 s wait succeeds.
  D  A LIVE Node holder past oa-state.ps1's wait budget is reported, not overrun: `mark` with a
     2 s wait exits non-zero with `state_lock_timeout` and leaves the state untouched.

  MUTANTS (each must be killed by its arm)
    M1  oa-state.ps1 skips the shared lock file (mutex only, the pre-fix code)  -> A loses an update
    M2  oa-state.ps1 locks a different file name                                -> A and B lose updates
    M3  oa-state.ps1 never reclaims a dead holder                               -> C times out
    M4  oa-state.mjs locks a different directory                                -> A and B lose updates
    M5  oa-state.ps1 ignores -LockWaitSeconds again (the pre-fix 180 s wait)     -> D overruns the holder

  Hermetic: its own temp state dir and journal; never reads or writes the live store.

      pwsh -File mutcheck-engine-lock.ps1 [-ScriptPath <oa-state.ps1>] [-NodePath <oa-state.mjs>]
#>
[CmdletBinding()]
param(
  [string]$ScriptPath,
  [string]$NodePath
)

$ErrorActionPreference = 'Stop'
$here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $ScriptPath) { $ScriptPath = Join-Path $here 'oa-state.ps1' }
if (-not $NodePath) { $NodePath = Join-Path $here 'oa-state.mjs' }
$ScriptPath = (Resolve-Path $ScriptPath).Path
$NodePath = (Resolve-Path $NodePath).Path
. (Join-Path $here 'oa-state-target.ps1')

$utf8 = New-Object Text.UTF8Encoding($false)
$root = Join-Path ([IO.Path]::GetTempPath()) ('oa-englock-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $root -Force | Out-Null
$psHost = if ($PSVersionTable.PSEdition -eq 'Core') { (Get-Process -Id $PID).Path } else { 'powershell' }
$node = (Get-Command node -ErrorAction Stop).Source
$HoldMs = 12000
$Id = '950'

# The Node slow writer: the REAL lock module and the REAL stateLockPath of the target bundle.
$nodeHolder = Join-Path $root 'node-holder.mjs'
[IO.File]::WriteAllText($nodeHolder, @'
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [, , engine, stateDir, id, ready, holdMs] = process.argv;
const { stateLockPath } = await import(pathToFileURL(engine).href);
const { acquireLock, releaseLock } = await import(pathToFileURL(path.join(path.dirname(engine), 'oa-state-lib', 'core', 'lock.mjs')).href);
const lock = acquireLock(stateLockPath(stateDir), 60000, { timeoutMessage: 'holder_lock_timeout', reclaimDeadHolder: true });
try {
  const file = path.join(stateDir, `task-${id}.json`);
  const raw = fs.readFileSync(file, 'utf8');
  const bom = raw.charCodeAt(0) === 0xfeff;
  const st = JSON.parse(bom ? raw.slice(1) : raw);
  fs.writeFileSync(ready, 'held');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs));
  st.race_probe = 'node';
  fs.writeFileSync(file, (bom ? '\uFEFF' : '') + JSON.stringify(st, null, 2));
} finally { releaseLock(lock); }
'@, $utf8)

# The PowerShell slow writer: oa-state.ps1's OWN lock functions, lifted out of the target by the
# parser so this check exercises the shipped code, plus the engine's key derivation.
$psHolder = Join-Path $root 'ps-holder.ps1'
[IO.File]::WriteAllText($psHolder, @'
param([string]$Engine, [string]$StateDir, [string]$Id, [string]$Ready, [int]$HoldMs)
$ErrorActionPreference = 'Stop'
$ast = [Management.Automation.Language.Parser]::ParseFile($Engine, [ref]$null, [ref]$null)
foreach ($name in 'Get-OaStateLockFilePath', 'Test-OaLockHolderAlive', 'Enter-OaStateFileLock', 'Exit-OaStateFileLock') {
  $fn = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
  if (-not $fn) { throw "ps-holder: $name not found in $Engine" }
  . ([scriptblock]::Create($fn.Extent.Text))
}
$lockPath = [IO.Path]::GetFullPath($StateDir).TrimEnd([char[]]'\/')
if ($env:OS -eq 'Windows_NT') { $lockPath = $lockPath.ToLowerInvariant() }
$sha = [Security.Cryptography.SHA256]::Create()
try { $lockKey = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($lockPath)))).Replace('-', '') }
finally { $sha.Dispose() }
$file = Get-OaStateLockFilePath $lockKey
$stream = Enter-OaStateFileLock $file 60
if (-not $stream) { throw 'ps-holder: lock timeout' }
try {
  $p = Join-Path $StateDir "task-$Id.json"
  $st = [IO.File]::ReadAllText($p) | ConvertFrom-Json
  [IO.File]::WriteAllText($Ready, 'held')
  Start-Sleep -Milliseconds $HoldMs
  $st | Add-Member -NotePropertyName race_probe -NotePropertyValue 'ps' -Force
  [IO.File]::WriteAllText($p, ($st | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($true)))
}
finally { Exit-OaStateFileLock $stream $file }
'@, $utf8)

function New-Store([string]$name) {
  $sx = Join-Path $root $name
  New-Item -ItemType Directory -Path (Join-Path $sx 'state'), (Join-Path $sx 'journal') -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path $sx "journal\task-$Id.md"), "# Task ${Id}: race`n`nnotes`n", $utf8)
  [IO.File]::WriteAllText((Join-Path $sx 'planner.md'), "## Today`n`n| ID | Task |`n|---|---|`n| $Id | race |`n", $utf8)
  $st = [ordered]@{ id = $Id; status = 'proposed'; version = 0; plan_id = ''; processed_file_hash = ''; has_agent_block = $false
    seeded = $false; updated = '2020-03-01T12:00:00Z'; status_by = 'agent' }
  [IO.File]::WriteAllText((Join-Path $sx "state\task-$Id.json"), ($st | ConvertTo-Json), $utf8)
  return $sx
}

function Get-EngineArgs([string]$sx) {
  @('-StateDir', (Join-Path $sx 'state'), '-JournalDir', (Join-Path $sx 'journal'), '-PlannerBoard', (Join-Path $sx 'planner.md'))
}

function Start-Holder([string]$kind, [string]$engine, [string]$sx) {
  $ready = Join-Path $sx 'held.flag'
  $hargs = if ($kind -eq 'node') { @($nodeHolder, $engine, (Join-Path $sx 'state'), $Id, $ready, "$HoldMs") }
  else { @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $psHolder, '-Engine', $engine, '-StateDir', (Join-Path $sx 'state'), '-Id', $Id, '-Ready', $ready, '-HoldMs', "$HoldMs") }
  $exe = if ($kind -eq 'node') { $node } else { $psHost }
  $proc = Start-Process -FilePath $exe -ArgumentList ($hargs | ForEach-Object { if ($_ -match '\s') { "`"$_`"" } else { $_ } }) -PassThru -NoNewWindow `
    -RedirectStandardError (Join-Path $sx 'holder.err') -RedirectStandardOutput (Join-Path $sx 'holder.out')
  $deadline = (Get-Date).AddSeconds(60)
  while (-not (Test-Path -LiteralPath $ready)) {
    if ($proc.HasExited -or (Get-Date) -gt $deadline) { throw "holder ($kind) never took the lock: $(Get-Content -Raw (Join-Path $sx 'holder.err') -ErrorAction SilentlyContinue)" }
    Start-Sleep -Milliseconds 50
  }
  return $proc
}

function Invoke-Mark([string]$engine, [string]$sx, [string[]]$extra = @()) {
  $cmd = Get-OaStateCommand $engine
  $out = & $cmd.Exe @($cmd.Prefix + @('mark', '-Id', $Id, '-Status', 'blocked') + $extra + (Get-EngineArgs $sx)) 2>&1 | Out-String
  return [pscustomobject]@{ exit = $LASTEXITCODE; text = $out }
}

function Read-Store([string]$sx) { [IO.File]::ReadAllText((Join-Path $sx "state\task-$Id.json")) | ConvertFrom-Json }

# A: Node holds, PowerShell marks.  B: PowerShell holds, Node marks.
function Test-Race([string]$arm, [string]$holderKind, [string]$holderEngine, [string]$markEngine, [string]$tag) {
  $sx = New-Store "$tag-$arm"
  $proc = Start-Holder $holderKind $holderEngine $sx
  $r = Invoke-Mark $markEngine $sx
  $proc.WaitForExit()
  $st = Read-Store $sx
  $probe = if ($holderKind -eq 'node') { 'node' } else { 'ps' }
  if ($r.exit -ne 0) { return "mark exited $($r.exit): $($r.text.Trim())" }
  if ($proc.ExitCode -ne 0) { return "holder exited $($proc.ExitCode)" }
  $lost = @()
  if ("$($st.race_probe)" -ne $probe) { $lost += "holder's race_probe" }
  if ("$($st.status)" -ne 'blocked') { $lost += "mark's status (got '$($st.status)')" }
  if ($lost.Count) { return "LOST UPDATE: $($lost -join ', ')" }
  return 'ok'
}

function Test-DeadHolder([string]$engine, [string]$tag) {
  $sx = New-Store "$tag-C"
  $dead = Start-Process -FilePath $node -ArgumentList '-e', '0' -PassThru -NoNewWindow
  $dead.WaitForExit()
  $deadPid = $dead.Id
  $lockFile = & $node --input-type=module -e "const { stateLockPath } = await import(process.argv[1]); console.log(stateLockPath(process.argv[2]));" `
    ([Uri](Resolve-Path $NodePath).Path).AbsoluteUri (Join-Path $sx 'state')
  [IO.File]::WriteAllText($lockFile, "$deadPid")
  try {
    $r = Invoke-Mark $engine $sx @('-LockWaitSeconds', '3')
    if ($r.exit -ne 0) { return "mark exited $($r.exit): $($r.text.Trim() -replace '\s+', ' ')" }
    if ("$((Read-Store $sx).status)" -ne 'blocked') { return 'status not written' }
    return 'ok'
  }
  finally { Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue }
}

function Test-LiveHolder([string]$engine, [string]$nodeEngine, [string]$tag) {
  $sx = New-Store "$tag-D"
  $proc = Start-Holder 'node' $nodeEngine $sx
  $r = Invoke-Mark $engine $sx @('-LockWaitSeconds', '2')
  $statusDuringHold = "$((Read-Store $sx).status)"
  $proc.WaitForExit()
  if ($r.exit -eq 0) { return "mark ran while a live holder held the lock (status $statusDuringHold)" }
  if ($r.text -notmatch 'state_lock_timeout') { return "refused without state_lock_timeout: $($r.text.Trim() -replace '\s+', ' ')" }
  if ($statusDuringHold -ne 'proposed') { return "state changed while refused ($statusDuringHold)" }
  return 'ok'
}

function Test-Arms([string]$ps, [string]$nodeEngine, [string]$tag, [switch]$Verbose) {
  $res = [ordered]@{
    A = Test-Race 'A' 'node' $nodeEngine $ps $tag
    B = Test-Race 'B' 'ps' $ps $nodeEngine $tag
    C = Test-DeadHolder $ps $tag
    D = Test-LiveHolder $ps $nodeEngine $tag
  }
  if ($Verbose) { foreach ($k in $res.Keys) { Write-Host ("  {0} {1}  {2}" -f $(if ($res[$k] -eq 'ok') { 'PASS' } else { 'FAIL' }), $k, $res[$k]) } }
  return , @($res.Keys | Where-Object { $res[$_] -ne 'ok' })
}

$psMutants = @(
  @{ n = 'M1'; kills = @('A'); find = "    `$stateFileLock = Enter-OaStateFileLock `$stateFileLockPath `$stateLockWait`r`n    if (-not `$stateFileLock) { throw `$stateLockTimeout }"; repl = '    $stateFileLock = $null' },
  @{ n = 'M2'; kills = @('A', 'B'); find = '"oa-state-$lockKey.lock"'; repl = '"oa-state-$lockKey.ps.lock"' },
  @{ n = 'M3'; kills = @('C'); find = '  if (-not (Test-OaLockHolderAlive $lockPath)) {'; repl = '  if ($false) {' },
  @{ n = 'M5'; kills = @('D'); find = 'if ($LockWaitSeconds -gt 0) { $stateLockWait = $LockWaitSeconds }'; repl = 'if ($false) { }' }
)
$nodeMutants = @(
  @{ n = 'M4'; kills = @('A', 'B'); find = 'return path.join(os.tmpdir(), `oa-state-${key}.lock`);'; repl = 'return path.join(os.tmpdir(), `oa-state-${key}.node.lock`);' }
)

$bad = 0
try {
  Write-Host "[mutcheck-engine-lock] ps = $ScriptPath"
  Write-Host "[mutcheck-engine-lock] node = $NodePath"
  Write-Host '[baseline]'
  $base = Test-Arms $ScriptPath $NodePath 'baseline' -Verbose
  if ($base.Count) { Write-Host "FAIL: baseline arms failed: $($base -join ', ')" -ForegroundColor Red; $bad++ }
  foreach ($m in $psMutants) {
    $find = $m.find
    if (-not ([IO.File]::ReadAllText($ScriptPath)).Contains($find)) { $find = $find.Replace("`r`n", "`n") }
    $mut = New-OaStateMutant $ScriptPath $m.n $find $m.repl (Join-Path $root 'mutants')
    $failed = Test-Arms $mut $NodePath $m.n
    $ok = @($m.kills | Where-Object { $failed -notcontains $_ }).Count -eq 0
    Write-Host ("  [{0}] {1} failed {2} (must fail {3})" -f $(if ($ok) { 'KILLED' } else { 'SURVIVED' }), $m.n, $(if ($failed.Count) { $failed -join ',' } else { 'nothing' }), ($m.kills -join ','))
    if (-not $ok) { $bad++ }
  }
  foreach ($m in $nodeMutants) {
    $mut = New-OaStateMutant $NodePath $m.n $m.find $m.repl (Join-Path $root 'mutants')
    $failed = Test-Arms $ScriptPath $mut $m.n
    $ok = @($m.kills | Where-Object { $failed -notcontains $_ }).Count -eq 0
    Write-Host ("  [{0}] {1} failed {2} (must fail {3})" -f $(if ($ok) { 'KILLED' } else { 'SURVIVED' }), $m.n, $(if ($failed.Count) { $failed -join ',' } else { 'nothing' }), ($m.kills -join ','))
    if (-not $ok) { $bad++ }
  }
}
finally { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
if ($bad) { Write-Host "FAILED ($bad)" -ForegroundColor Red; exit 1 }
Write-Host 'PASS: the engines exclude each other, and every mutant is killed by its arm.'
exit 0
