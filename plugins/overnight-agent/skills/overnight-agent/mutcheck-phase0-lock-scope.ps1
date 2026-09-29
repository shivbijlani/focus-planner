<#
  mutcheck-phase0-lock-scope.ps1 -- PHASE 0 runs in parallel, so the lock must not serialize it
  (GH #778).

  WHY THIS EXISTS
  ---------------
  Measured live on 2026-09-29 (v1.57.19). The coordinator starts its PHASE 0 steps together, by
  design, and at 13:02:06 four of them landed in the same second:

      check-critical-tools.mjs --run ... --record ...   (run ledger + capabilities.json)
      oa-state.ps1 scan -Compact -ScanOutFile ...       (holds the state lock for 60-90 s)
      collect-google-tasks.ps1
      run-telegram-mirror.ps1 -SyncDownOnly

  Every `oa-state.ps1` command took the single state mutex with a 10 s fail-fast, so the
  capability record queued behind a traversal of a store it never reads and died with
  `state_lock_timeout: ... retry rather than bypassing admission`. It failed twice and succeeded
  on the third attempt; the 12:00 run lost `decisions -RunId ...` the same way. Each retry is a
  model turn, and one more retry would have been a false "couldn't record".

  WHAT IS PINNED HERE
  -------------------
  A  `critical-tools` reads user-settings.md and the MCP config. It must NOT take the state lock.
  B  `decisions` appends to the run ledger, a separate file. It must NOT take the state lock.
  C  A command that DOES need the state lock waits for it and then succeeds -- the queue is the
     answer to a busy lock, not a retry handed back to the model.
  D  That wait is BOUNDED: with the lock held past the budget it still fails, so a genuinely
     stuck holder is reported rather than hung on for ever.
  E  End to end, the exact failing call: `check-critical-tools.mjs --run ... --record ...` while
     the state lock is held, first try, no retry.

  Hermetic: builds its own state dir, settings, MCP config, ledger and capabilities file under
  TEMP, and never reads or writes the live store.

      pwsh -File mutcheck-phase0-lock-scope.ps1 [-ScriptPath <oa-state.ps1>]
#>
[CmdletBinding()]
param(
  [string]$ScriptPath
)

$ErrorActionPreference = 'Stop'

# Resolved HERE, not as a param default: under Windows PowerShell 5.1 `$PSScriptRoot` is still
# empty when param defaults are evaluated. Same idiom as mutcheck-cadence-rearm.ps1.
if (-not $ScriptPath) {
  $here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
  $ScriptPath = Join-Path $here 'oa-state.ps1'
}
$skillDir = Split-Path -Parent $ScriptPath

# Launch the host that actually EXISTS here: `powershell` is Windows-only and would die on the
# Linux runner. Under Core, re-launch the very executable running this script.
$script:PsExe = if ($PSVersionTable.PSEdition -eq 'Core') { (Get-Process -Id $PID).Path } else { 'powershell' }
if (-not $script:PsExe) { $script:PsExe = 'pwsh' }

$root = Join-Path ([IO.Path]::GetTempPath()) ("oa-lockscope-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$sdir = Join-Path $root 'state'
New-Item -ItemType Directory -Path $sdir -Force | Out-Null
$utf8 = New-Object Text.UTF8Encoding($false)
$settings = Join-Path $root 'user-settings.md'
$config = Join-Path $root 'mcp-config.json'
$ledger = Join-Path $root 'run-ledger.jsonl'
$capabilities = Join-Path $root 'capabilities.json'
$scanFile = Join-Path $root 'scan.json'
[IO.File]::WriteAllText($settings, "| Critical tools | ``email`` |`n", $utf8)
[IO.File]::WriteAllText($config, '{"mcpServers":{"email":{}}}', $utf8)
# The `scan -Compact` shape `decisions` requires: a summary plus rows.
[IO.File]::WriteAllText($scanFile, (@{
      summary = @{
        scan_seconds = 1; rows_total = 1; rows_eligible = 0; rows_returned = 1
        rows_omitted = 0; today_holding = $false
      }
      rows    = @(@{ id = '801'; order = 1; section = 'Today'; eligible = $false; status = 'blocked' })
    } | ConvertTo-Json -Depth 6), $utf8)

# The SAME key oa-state.ps1 derives, so this process holds the real state lock.
$lockPath = [IO.Path]::GetFullPath($sdir).TrimEnd([char[]]'\/')
if ($env:OS -eq 'Windows_NT') { $lockPath = $lockPath.ToLowerInvariant() }
$sha = [Security.Cryptography.SHA256]::Create()
try { $lockKey = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($lockPath)))).Replace('-', '') }
finally { $sha.Dispose() }
$mutex = New-Object Threading.Mutex($false, "oa-state-$lockKey")
$held = $false

function Oa-Args([string[]]$OaArgs) {
  return @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath) + $OaArgs +
  @('-StateDir', $sdir, '-UserSettings', $settings, '-McpConfig', $config, '-RunLedger', $ledger)
}
function Invoke-Oa {
  param([string[]]$OaArgs)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $out = & $script:PsExe @(Oa-Args $OaArgs) 2>&1 | Out-String -Width 4096
  $ErrorActionPreference = $prev
  return [pscustomobject]@{ Output = $out; ExitCode = $LASTEXITCODE }
}
# Started, not awaited: the point of arm C is that the callee is still queueing when the lock is
# released, which cannot be observed from a blocking call.
function Start-Oa {
  param([string[]]$OaArgs, [string]$Tag)
  $stdout = Join-Path $root "$Tag.out"
  $stderr = Join-Path $root "$Tag.err"
  return [pscustomobject]@{
    Process = Start-Process -FilePath $script:PsExe -ArgumentList (Oa-Args $OaArgs) -PassThru `
      -NoNewWindow -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    Out     = $stdout
    Err     = $stderr
  }
}

$results = [ordered]@{}
function Check([string]$name, [scriptblock]$body) {
  try { $results[$name] = [bool](& $body) }
  catch { $results[$name] = $false }
}

try {
  $held = $mutex.WaitOne(10000)
  if (-not $held) { throw 'mutcheck could not take its own state lock' }

  # --- A: critical-tools must not need the state lock ----------------------------------------
  $started = Get-Date
  $a = Invoke-Oa @('critical-tools')
  $aSeconds = ((Get-Date) - $started).TotalSeconds
  Check 'A critical-tools succeeds while the state lock is held' { $a.ExitCode -eq 0 }
  Check 'A- and it does not report state_lock_timeout' { $a.Output -notmatch 'state_lock_timeout' }
  Check 'A-- and it returns immediately rather than queueing' { $aSeconds -lt 30 }
  Check 'A--- and it still answers with the policy' {
    (($a.Output | ConvertFrom-Json).tools -join ',') -eq 'email'
  }

  # --- B: decisions writes the ledger, not the state store ------------------------------------
  $b = Invoke-Oa @('decisions', '-RunId', 'lock-scope-run', '-ScanFile', $scanFile)
  Check 'B decisions succeeds while the state lock is held' { $b.ExitCode -eq 0 }
  Check 'B- and it does not report state_lock_timeout' { $b.Output -notmatch 'state_lock_timeout' }
  Check 'B-- and the decision line really landed in the ledger' {
    (Test-Path -LiteralPath $ledger) -and
    (@(Get-Content -LiteralPath $ledger | Where-Object { $_ -match '"runId":"lock-scope-run"' }).Count -eq 1)
  }
  Check 'B--- and its own lock file is released, not left behind' { -not (Test-Path -LiteralPath "$ledger.lock") }

  # --- E: the exact call that failed live, while the lock is held ------------------------------
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) {
    $checker = Join-Path $skillDir 'check-critical-tools.mjs'
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $eOut = & $node.Source @($checker, '--settings', $settings, '--mcp-config', $config,
      '--state', $capabilities, '--ledger', $ledger, '--state-dir', $sdir,
      '--run', 'lock-scope-record', '--record', 'email=ok') 2>&1 | Out-String -Width 4096
    $eCode = $LASTEXITCODE
    $ErrorActionPreference = $prev
    Check 'E --record succeeds on the FIRST try while the state lock is held' { $eCode -eq 0 }
    Check 'E- and it never reports state_lock_timeout' { $eOut -notmatch 'state_lock_timeout' }
    Check 'E-- and the run really reached the ledger' {
      @(Get-Content -LiteralPath $ledger | Where-Object { $_ -match '"runId":"lock-scope-record"' }).Count -eq 1
    }
    Check 'E--- and capabilities.json was written' {
      (Test-Path -LiteralPath $capabilities) -and
      ((Get-Content -LiteralPath $capabilities -Raw | ConvertFrom-Json).tools.email.status -eq 'ok')
    }
  }
  else {
    $results['E skipped (no node on PATH)'] = $true
  }

  # --- C: a state command WAITS for the lock instead of handing back a retry --------------------
  # Held for longer than the OLD 10 s fail-fast, deliberately: a 3 s hold would be satisfied by
  # the very timeout this replaces, and the arm would pass against the defect it exists to pin.
  $c = Start-Oa @('whoami') 'waiter'
  Start-Sleep -Seconds 12
  $stillRunning = -not $c.Process.HasExited
  $mutex.ReleaseMutex()
  $held = $false
  $null = $c.Process.WaitForExit(120000)
  $cOut = (Get-Content -LiteralPath $c.Out -Raw -ErrorAction SilentlyContinue) +
  (Get-Content -LiteralPath $c.Err -Raw -ErrorAction SilentlyContinue)
  Check 'C a state command is still WAITING past the old 10 s fail-fast' { $stillRunning }
  Check 'C- and it succeeds once the lock is released' { $c.Process.ExitCode -eq 0 }
  Check 'C-- rather than failing with state_lock_timeout' { "$cOut" -notmatch 'state_lock_timeout' }

  # --- D: the wait is bounded, so a STUCK holder is reported and not waited on for ever ---------
  $held = $mutex.WaitOne(10000)
  if (-not $held) { throw 'mutcheck could not retake its own state lock' }
  $d = Invoke-Oa @('whoami', '-LockWaitSeconds', '1')
  Check 'D a bounded wait still fails when the holder never lets go' { $d.ExitCode -ne 0 }
  Check 'D- and it says the holder is stuck, not merely busy' { $d.Output -match 'state_lock_timeout' }
}
finally {
  if ($held) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}

# --- report --------------------------------------------------------------------------------------
$pass = 0; $fail = 0
foreach ($k in $results.Keys) {
  if ($results[$k]) { "  PASS  $k"; $pass++ } else { "  FAIL  $k"; $fail++ }
}
"`n$pass passed, $fail failed  (script: $ScriptPath)"

Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
if ($fail) { exit 1 }
exit 0
