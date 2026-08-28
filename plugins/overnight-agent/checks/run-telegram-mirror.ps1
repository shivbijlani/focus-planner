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
  [switch]$SyncDownOnly
)

$ErrorActionPreference = 'Stop'

$PlannerPath = 'C:\Users\shiv\OneDrive\Apps\Focus Planner'
$Settings    = Join-Path $PlannerPath 'user-settings.md'
$ChatId      = '-1004310604015'
$SecretTool  = Join-Path $env:LOCALAPPDATA 'overnight-agent\secrets\telegram-secret.ps1'
$Bridge      = 'V:\repos\focus-planner\packages\telegram-bridge\bin\telegram-bridge.js'

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

$token = & $SecretTool get
if (-not $token) { throw 'No Telegram bot token in the credential vault.' }
$env:TELEGRAM_BOT_TOKEN = $token

Write-Host "[mirror] digest=$digest topic=$(if($topic){$topic}else{'(n/a - digest off)'}) chat=$ChatId"
if ($digest -eq 'off') { Write-Host "[mirror] General thread will stay silent (task #441)." }

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
