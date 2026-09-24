<#
  run-telegram-mirror.ps1 — the ONLY sanctioned way to run PHASE 3.

  WHY THIS EXISTS
  ---------------
  `TELEGRAM_BRIDGE_DIGEST` is fail-OPEN: config.js:69 treats an ABSENT variable as
  "digest enabled", and an absent `TELEGRAM_BRIDGE_DIGEST_TOPIC` as "post to General".
  So a run that simply forgets the vars does the single thing Shiv asked us to stop
  doing (task #441) — it dumps the whole approval queue into the General thread, and
  the bridge does not persist the sent message id, so it can NEVER be undone.

  That mistake has now happened twice (2026-08-24 00:50 and again 12:22) despite being
  documented in user-settings.md. A prose warning is evidently not enough, so this
  wrapper makes the flag impossible to omit: it reads the desired state from
  user-settings.md and ALWAYS exports an explicit value.

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File run-telegram-mirror.ps1 [-WhatIf] [-SkipSyncDown]

  PHASE ORDERING NOTE
  -------------------
  user-settings.md requires `sync-down` to run BEFORE `oa-state.ps1 scan`, so phone
  replies are folded into the journals before the scan decides what is `reopened`.
  PHASE 3 itself runs at the END of the run. Use `-SyncDownOnly` for that early call so
  the pre-scan fold still goes through this wrapper rather than a hand-rolled command
  line (which is exactly how the General-thread flood keeps happening).

  WHY $Bridge POINTS AT main, NOT AT A WORKTREE
  --------------------------------------------
  This used to pin the bridge to the `oa-block-stray-marker` worktree, because that
  branch carried digest/ordering fixes that `main` did not have. Those fixes are now
  merged: `git diff origin/main oa-block-stray-marker -- packages/telegram-bridge/src`
  is EMPTY, so the pin bought nothing and cost a second, invisible deploy target — a
  merge into `main` (e.g. the #210/#211 ask-truncation split, #219) would not reach the
  running bridge at all. Keep this pointed at the checkout so "merged" means "running".
#>
[CmdletBinding()]
param(
  [switch]$WhatIf,
  [switch]$SkipSyncDown,
  [switch]$SyncDownOnly,
  # #613: test seams. The retry-and-unwrap around the vault read is the fix this issue
  # asks for, and a fix nothing can exercise is a fix nobody can prove still works. These
  # let a mutation check drive the failure path with a stub vault and a synthetic settings
  # file, against the REAL script. A production run passes none of them.
  [string]$SecretToolPath,
  [string]$SettingsPath,
  [string]$BridgePath
)

$ErrorActionPreference = 'Stop'

$PlannerPath = 'C:\Users\shiv\OneDrive\Apps\Focus Planner'
$Settings    = if ($SettingsPath) { $SettingsPath } else { Join-Path $PlannerPath 'user-settings.md' }
$ChatId      = '-1004310604015'
$SecretTool  = if ($SecretToolPath) { $SecretToolPath } else { Join-Path $env:LOCALAPPDATA 'overnight-agent\secrets\telegram-secret.ps1' }
$Bridge      = if ($BridgePath) { $BridgePath } else { 'V:\repos\focus-planner\packages\telegram-bridge\bin\telegram-bridge.js' }

if (-not (Test-Path $Settings)) { throw "user-settings.md not found at $Settings" }
if (-not (Test-Path $Bridge))   { throw "bridge CLI not found at $Bridge" }

# --- Resolve the digest setting from user-settings.md (source of truth) -------------
# The row looks like:  | Approval digest (General thread) | ... `off` as of ... |
$row = Select-String -Path $Settings -Pattern '^\|\s*Approval digest' | Select-Object -First 1
if (-not $row) {
  Write-Warning "No 'Approval digest' row found in user-settings.md - defaulting to OFF (safe)."
  $digest = 'off'
} else {
  # Take the FIRST backticked on/off token in the row: that is the live value, and the
  # rest of the cell is historical narrative that must not be parsed as the setting.
  $m = [regex]::Match($row.Line, '`(on|off)`')
  $digest = if ($m.Success) { $m.Groups[1].Value.ToLower() } else { 'off' }
}

$topic = $null
if ($digest -eq 'on') {
  $tm = [regex]::Match($row.Line, 'TELEGRAM_BRIDGE_DIGEST_TOPIC\s*=\s*"([^"]+)"')
  $topic = if ($tm.Success) { $tm.Groups[1].Value } else { 'Waiting on you' }
}

# --- Export explicitly. Never leave these unset. ------------------------------------
$env:PLANNER_PATH           = $PlannerPath
$env:TELEGRAM_CHAT_ID       = $ChatId
$env:TELEGRAM_BRIDGE_DIGEST = $digest            # <-- the whole point: always explicit
if ($topic) { $env:TELEGRAM_BRIDGE_DIGEST_TOPIC = $topic }
else        { Remove-Item Env:\TELEGRAM_BRIDGE_DIGEST_TOPIC -ErrorAction SilentlyContinue }

# THE BANNER MOVES ABOVE THE TOKEN FETCH (#613), and that is a fix rather than tidying.
# It used to print after it, so when the vault read threw, the phase produced NO OUTPUT AT
# ALL -- exit -2146233082 and not one line, so a reader had nothing to anchor on and could
# not even tell which phase had died. A banner is worth most precisely on the run that
# fails, so it must come before the first thing that can throw.
Write-Host "[mirror] digest=$digest topic=$(if($topic){$topic}else{'(n/a - digest off)'}) chat=$ChatId"
if ($digest -eq 'off') { Write-Host "[mirror] General thread will stay silent (task #441)." }

# --- The credential vault read (GH #613) ---------------------------------------------
#
# This one line took out the whole phase on 2026-09-07. `telegram-secret.ps1 get` calls
# `Add-Type -TypeDefinition`, which JIT-compiles C# and needs a burst of COMMITTED memory.
# The box was at its commit limit (20.0 / 20.0 GB), so the compile threw "Insufficient
# memory to continue the execution of the program" -- surfacing here as an unwrapped
# AggregateException whose entire text is "One or more errors occurred."
#
# Three separate defects, fixed separately below, because each fails on its own:
#
#   1. IT IS RETRYABLE AND WAS NOT RETRIED. Ten minutes later the identical call succeeded
#      on attempt 1. A one-shot allocation failure cost a whole phase that would have
#      worked seconds later.
#   2. THE MESSAGE NAMED NOTHING. "One or more errors occurred." mentions no memory, no
#      Add-Type, no vault, no step. Diagnosing it meant hand-running an inner script the
#      wrapper calls. That is the #346 class: a failure indistinguishable from any other.
#   3. IT FAILS AT THE WORST POINT. The fetch happens BEFORE the banner below and BEFORE
#      `sync-down`, so the second invocation printed nothing at all -- not even a phase
#      banner to anchor on.
#
# The retry is bounded and short: the measurement says one retry is very likely enough,
# and a phase that hangs retrying is worse than one that fails with a clear reason.
$token = $null
$tokenError = $null
for ($attempt = 1; $attempt -le 3; $attempt++) {
  try {
    $token = & $SecretTool get
    if ($token) { break }
    # A vault that returns nothing is not an exception, but it is also not success. Treat
    # it as a failed attempt so an empty read gets the same retry as a thrown one.
    $tokenError = 'the vault returned no token'
  }
  catch {
    # UNWRAP. An AggregateException stringifies to "One or more errors occurred." and hides
    # every inner message, which is the whole reason this issue took a hand-investigation.
    $ex = $_.Exception
    while ($ex.InnerException) { $ex = $ex.InnerException }
    $tokenError = $ex.Message
  }
  if ($attempt -lt 3) {
    Write-Host ("[mirror] token fetch attempt {0} failed: {1}" -f $attempt, $tokenError)
    Start-Sleep -Seconds (2 * $attempt)
  }
}

if (-not $token) {
  # NAME THE STEP AND THE CAUSE. A run that reports only "the Telegram mirror failed" gives
  # the next reader no path to the reason; this is the same argument check-agent-inbox.ps1
  # makes for reporting NOT CHECKED rather than an empty result (#346).
  Write-Host "[mirror] TOKEN FETCH FAILED after 3 attempts - the Telegram mirror did not run." -ForegroundColor Red
  Write-Host ("[mirror]   reason: {0}" -f $(if ($tokenError) { $tokenError } else { 'no detail reported' }))
  Write-Host ("[mirror]   vault : {0}" -f $SecretTool)
  # The memory precondition, reported only when it is actually the likely cause. Stated as
  # an observation rather than a diagnosis: committed memory at the limit is what made
  # `Add-Type` fail here, and saying so turns an opaque death into an actionable one.
  try {
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    $commitMb = [int](($os.TotalVirtualMemorySize - $os.FreeVirtualMemory) / 1024)
    $limitMb  = [int]($os.TotalVirtualMemorySize / 1024)
    if ($limitMb -gt 0 -and ($commitMb / $limitMb) -gt 0.95) {
      Write-Host ("[mirror]   NOTE: committed memory is {0} / {1} MB - the vault read compiles C# (Add-Type) and needs a burst of commit (#613)." -f $commitMb, $limitMb)
    }
  }
  catch {
    # A missing counter must not replace the real error with a new one.
  }
  throw "Telegram mirror aborted: could not read the bot token from the vault ($tokenError)"
}
$env:TELEGRAM_BOT_TOKEN = $token

if ($WhatIf) {
  Write-Host '[mirror] -WhatIf: environment prepared, bridge NOT invoked.'
  return
}

if (-not $SkipSyncDown) {
  Write-Host '[mirror] sync-down (fold phone replies first)...'
  & node $Bridge sync-down
}

if ($SyncDownOnly) {
  Write-Host '[mirror] -SyncDownOnly: stopping before the posting pass.'
  return
}

Write-Host '[mirror] once...'
& node $Bridge once
