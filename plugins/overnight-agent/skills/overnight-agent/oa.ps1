<#
.SYNOPSIS
  `oa` - the Overnight Agent CLI. The single script front-end that owns the skill's
  MECHANICAL logic so SKILL.md can stay a thin wrapper of judgment + guardrails.

.WHY
  A skill's SKILL.md is read inline by the LLM every run, so it has a practical size
  ceiling and every behaviour tweak means editing prose. This script moves the
  business/mechanical parts OUT of the prose and into code (which has no size limit):
  settings resolution, the path catalog, the Telegram invocation, and - crucially - an
  instruction-provider `run` command that returns, as text, exactly what the agent
  should do this run. SKILL.md is told to resolve settings and follow what `oa.ps1 run`
  returns, keeping only the judgment the LLM must see inline (approval reading,
  reversibility gating, safety). Future updates land here, not in the doc.

  Graceful degradation: this script is additive. It DELEGATES the existing state
  commands (seed/scan/get/mark) to oa-state.ps1, so nothing regresses if a caller keeps
  using oa-state.ps1 directly, and the run procedure it prints mirrors SKILL.md so the
  agent still receives every phase even if the doc is slimmed.

.COMMANDS
  settings                       Resolve user-settings.md (the ladder) and print path + parsed values (JSON).
  paths                          Print the resolved path catalog (planner, completed, journal, dev drive, telegram) as JSON.
  telegram                       Print the exact Telegram-bridge invocation for this run (or note it's disabled).
  run                            Instruction provider: resolved settings + the scan worklist + the ordered run procedure.
  scan | get | mark | seed       Delegated to oa-state.ps1 (unchanged behaviour), including the
                                 poll lifecycle (-Poll/-PollDone/-PollClear) and -PlannerBoard/-SnoozeStore.

.EXAMPLES
  pwsh oa.ps1 settings
  pwsh oa.ps1 paths
  pwsh oa.ps1 run
  pwsh oa.ps1 scan
  pwsh oa.ps1 mark -Id 305 -Status proposed -Version 1 -PlanId t305-v1
  pwsh oa.ps1 mark -Id 405 -Poll daily        # arm a recurring self-check
  pwsh oa.ps1 mark -Id 405 -PollDone          # re-arm after acting on due_poll
#>

[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('settings', 'paths', 'telegram', 'run', 'scan', 'get', 'mark', 'seed')]
  [string]$Command = 'run',

  [string]$Id,
  [string]$Status,
  [int]$Version,
  [string]$PlanId,
  [switch]$Force,

  # Poll lifecycle (time-triggered tasks). These MUST be declared here or the delegated
  # `mark` breaks: PowerShell binds params on THIS script first, so an undeclared -Poll
  # fails with NamedParameterNotFound before oa-state.ps1 is ever invoked.
  [string]$Poll,
  [switch]$PollDone,
  [switch]$PollClear,

  # Passthrough to oa-state.ps1 for the delegated scan/get/mark/seed commands (backward-compat).
  [string]$JournalDir,
  [string]$StateDir,
  [string]$PlannerBoard,
  [string]$SnoozeStore,

  # Optional explicit settings file (highest-priority override, same as $OVERNIGHT_AGENT_SETTINGS).
  [string]$SettingsFile,
  # Optional project folder to check as ladder step #2 (defaults to the current directory).
  [string]$ProjectFolder = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Expand-Vars([string]$s) {
  if (-not $s) { return $s }
  # Expand %VAR% (and a couple of common OneDrive fallbacks) so path values resolve on any machine.
  $out = [regex]::Replace($s, '%([^%]+)%', {
      param($m)
      $name = $m.Groups[1].Value
      $val = [Environment]::GetEnvironmentVariable($name)
      if (-not $val -and $name -ieq 'OneDrive') {
        $val = $env:OneDriveConsumer; if (-not $val) { $val = $env:OneDriveCommercial }
      }
      if ($val) { $val } else { $m.Value }
    })
  return $out
}

function Resolve-SettingsFile {
  # The ladder from SKILL.md, first existing wins.
  $candidates = @()
  if ($SettingsFile) { $candidates += $SettingsFile }
  if ($env:OVERNIGHT_AGENT_SETTINGS) { $candidates += $env:OVERNIGHT_AGENT_SETTINGS }
  if ($ProjectFolder) { $candidates += (Join-Path $ProjectFolder 'user-settings.md') }
  $od = $env:OneDrive; if (-not $od) { $od = $env:OneDriveConsumer }; if (-not $od) { $od = $env:OneDriveCommercial }
  if ($od) { $candidates += (Join-Path $od 'Apps\Focus Planner\user-settings.md') }
  if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'overnight-agent\user-settings.md') }
  $template = Join-Path $ScriptDir 'user-settings.md'

  foreach ($c in $candidates) {
    if ($c -and (Test-Path $c)) {
      return [pscustomobject]@{ Path = $c; IsTemplate = $false }
    }
  }
  # Nothing external found; the template is the last resort (placeholders only).
  return [pscustomobject]@{ Path = $template; IsTemplate = $true }
}

function Parse-Settings([string]$path) {
  $map = [ordered]@{}
  if (-not (Test-Path $path)) { return $map }
  foreach ($line in (Get-Content -Path $path -Encoding UTF8)) {
    # Match markdown table rows: | key | value |
    $m = [regex]::Match($line, '^\s*\|\s*(?<k>[^|]+?)\s*\|\s*(?<v>.*?)\s*\|\s*$')
    if (-not $m.Success) { continue }
    $k = $m.Groups['k'].Value.Trim()
    $v = $m.Groups['v'].Value.Trim()
    if ($k -ieq 'Setting' -or $k -match '^-+$') { continue }   # header / separator rows
    $map[$k] = $v
  }
  return $map
}

function Clean-Value([string]$v) {
  if (-not $v) { return '' }
  # Take the first backtick-quoted token if present (that's the canonical value); else the raw string.
  $bt = [regex]::Match($v, '`([^`]+)`')
  $val = if ($bt.Success) { $bt.Groups[1].Value } else { $v }
  return (Expand-Vars $val).Trim()
}

function Has-Placeholder([string]$v) { return ($v -match '<[^>]+>') }

function Get-BridgeEnvOverrides([hashtable]$map) {
  # A user-settings row may spell out the exact bridge env var it needs, e.g.
  #   | Approval digest | `on` - set `TELEGRAM_BRIDGE_DIGEST=on` and `TELEGRAM_BRIDGE_DIGEST_TOPIC="Waiting on you"` |
  # Harvest ANY TELEGRAM_BRIDGE_* assignment written anywhere in the settings so a new
  # bridge toggle is a README row + a settings row - no change to oa.ps1 or SKILL.md.
  $found = [ordered]@{}
  if (-not $map) { return $found }
  foreach ($raw in $map.Values) {
    if (-not $raw) { continue }
    foreach ($m in [regex]::Matches([string]$raw, 'TELEGRAM_BRIDGE_([A-Z0-9_]+)\s*=\s*(?:"([^"]*)"|''([^'']*)''|([^`''"\s,;.]+))')) {
      $name = 'TELEGRAM_BRIDGE_' + $m.Groups[1].Value
      $val = if ($m.Groups[2].Success) { $m.Groups[2].Value }
      elseif ($m.Groups[3].Success) { $m.Groups[3].Value }
      else { $m.Groups[4].Value }
      # First spelling wins, so an explicit row can't be clobbered by a later mention.
      if (-not $found.Contains($name)) { $found[$name] = (Expand-Vars $val) }
    }
  }
  return $found
}

function Get-Resolved {
  $sf = Resolve-SettingsFile
  $map = Parse-Settings $sf.Path

  $plannerBoard = Clean-Value $map['Planner board']
  $completed = Clean-Value $map['Completed board']
  $journals = Clean-Value $map['Journals folder']
  $devDrive = Clean-Value $map['Dev drive (repos)']

  # Derive the planner folder from whichever board path we have.
  $plannerFolder = ''
  if ($plannerBoard) { $plannerFolder = Split-Path -Parent $plannerBoard }
  elseif ($journals) { $plannerFolder = Split-Path -Parent ($journals.TrimEnd('\', '/')) }

  # Telegram section
  $tgEnabled = (Clean-Value $map['Enabled'])
  $tgChat = Clean-Value $map['Chat id']
  $tgBridge = Clean-Value $map['Bridge CLI']
  # Only honour a real comma-separated ID list; prose like "*(empty)* ..." means "all tasks".
  $tgTasksRaw = Clean-Value $map['Tasks']
  $tgTasks = if ($tgTasksRaw -match '^[\d,\s]+$') { ($tgTasksRaw -replace '\s', '') } else { '' }
  # "Archive completed topics" defaults to ON once Telegram is configured; only an
  # explicit "off" disables it. Anything else (missing row, prose) keeps the default.
  $tgArchiveRaw = Clean-Value $map['Archive completed topics']
  $tgArchive = -not ($tgArchiveRaw -match '(?i)^\s*`?off`?\s*$')

  # A run is only "ready" if the OPERATIONAL values resolved (no <...> placeholders in them).
  $opValues = @($plannerBoard, $journals, $devDrive, (Clean-Value $map['Agent email account']),
    (Clean-Value $map['Authorized sender addresses']))
  $hasPlaceholders = ($opValues | Where-Object { Has-Placeholder $_ } | Measure-Object).Count -gt 0

  [pscustomobject]@{
    settings_file       = $sf.Path
    settings_is_template = $sf.IsTemplate
    has_placeholders    = $hasPlaceholders
    user                = Clean-Value $map['User']
    timezone            = Clean-Value $map['Timezone']
    planner_folder      = $plannerFolder
    planner_board       = $plannerBoard
    completed_board     = $completed
    journals_folder     = $journals
    dev_drive           = $devDrive
    github_owner        = Clean-Value $map['GitHub owner']
    agent_email         = Clean-Value $map['Agent email account']
    authorized_senders  = Clean-Value $map['Authorized sender addresses']
    autosend_allowlist  = Clean-Value $map['Auto-send (email) allow-list']
    telegram = [pscustomobject]@{
      enabled = ($tgEnabled -ieq 'on')
      chat_id = $tgChat
      bridge  = $tgBridge
      tasks   = $tgTasks
      archive = $tgArchive
      env     = (Get-BridgeEnvOverrides $map)
    }
  }
}

function Invoke-State([string]$cmd, [hashtable]$params) {
  $state = Join-Path $ScriptDir 'oa-state.ps1'
  if (-not (Test-Path $state)) { throw "oa-state.ps1 not found next to oa.ps1 ($state)" }
  # Hashtable splat binds named params correctly (array splat would pass them positionally).
  if ($params -and $params.Count) { & $state $cmd @params } else { & $state $cmd }
}

function Get-Worklist([string]$journalDir) {
  $p = @{}
  if ($journalDir) { $p['JournalDir'] = $journalDir.TrimEnd('\', '/') }
  try { Invoke-State 'scan' $p } catch { "[]  (scan failed: $($_.Exception.Message))" }
}

function Run-Procedure {
  # The ordered mechanical procedure the agent follows every run. Kept here (unbounded
  # script) instead of in SKILL.md. Judgment/guardrails stay inline in SKILL.md.
  @'
RUN PROCEDURE (do the phases in this order):

PHASE 0 - Check the agent inbox (if Preferences: Inbox check = on).
  Read the agent email account's INBOX for UNREAD mail. Only act on messages whose
  `from` is one of the Authorized sender addresses; ignore everything else. Fold genuine
  instructions into the run (approval / revision / skip / new task). Mark handled mail read.

PHASE 1 - Execute APPROVED plans.
  From the scan worklist, take tasks with stored status `approved` (continue `in-progress`
  whose next step is approved), PLUS any `reopened` task whose newest user message is an
  approval. For each: gather linked-task context first, do the work, write deliverables
  (inline or a linked file), append a Run log, then `oa.ps1 mark -Id <id> -Status <s>`.

PHASE 1.2 - Act on DUE POLLS (time-triggered work the user never touches).
  `scan` flags `due_poll: true` on any task whose recurring self-check is due. Act on every
  such row REGARDLESS of whether the user replied - that is the whole point of a poll - then
  re-arm with `oa.ps1 mark -Id <id> -PollDone`. Arm a new poll with `-Poll <hourly|daily|
  weekly|Nh|Nd|Nm>`; retire one with `-PollClear`. If a poll finds NOTHING new, stay silent:
  write no Run log entry and post nothing (quiet-runs). A check that could not RUN is news.

PHASE 1.5 - Spawn child tasks only when finishing a job needs work that isn't on the board
  (blocked/partially-complete). Cap ~2 children per parent per run; propose rows, don't
  mutate the board unattended on a half-fix.

PHASE 2 - Propose plans for tasks without a current one.
  Default candidates: every task in `## Today` (expand to `## Deferred` as capacity allows).
  Triage by the scan worklist: `snoozed:true` -> SKIP ENTIRELY in every phase (no plan, no
  execution, no board/journal edit, even if `approved`); report only as "skipped (snoozed
  until DATE)" - the sole override is `reopened`. `reopened:true` -> pick up as new input
  (never skip, even if done/skip); `has_agent_block:false` -> propose; stored
  proposed/done/skip + not reopened -> leave alone; stored `revise` -> re-propose overwriting
  in place + bump version. ASSESS current status before planning (don't propose already-done
  work). Gather linked-task context, then write a concrete 2-6 step plan; record with
  `oa.ps1 mark -Id <id> -Status proposed -Version <n> -PlanId t<id>-v<n>`.

PHASE 3 - Mirror to Telegram (LAST, only if Telegram enabled).
  Run `oa.ps1 telegram` to get the exact bridge invocation and run it once. It posts new
  agent turns to each task's forum topic and folds phone replies back into journals. Never
  print the token; a failed mirror must never abort the run.

WRAP UP - Report: From your inbox / Executed / Already done / Waiting on you (incl. blocked
  asks) / Skipped / Mirrored to Telegram.

REMINDERS (judgment stays in SKILL.md): approval gates the IRREVERSIBLE, not the reversible;
  you may do easily-reversible work while planning (incl. opening a DRAFT PR); never edit a
  journal above the OVERNIGHT-AGENT sentinel; browser automation uses a Playwright MCP slot
  only. See SKILL.md for the full guardrails and reversibility rules.
'@
}

function Cmd-Settings {
  Get-Resolved | ConvertTo-Json -Depth 6
}

function Cmd-Paths {
  $r = Get-Resolved
  [pscustomobject]@{
    settings_file   = $r.settings_file
    planner_folder  = $r.planner_folder
    planner_board   = $r.planner_board
    completed_board = $r.completed_board
    journals_folder = $r.journals_folder
    dev_drive       = $r.dev_drive
    state_store     = (Join-Path $env:LOCALAPPDATA 'overnight-agent\state')
    telegram        = $r.telegram
  } | ConvertTo-Json -Depth 6
}

function Cmd-Telegram {
  $r = Get-Resolved
  if (-not $r.telegram.enabled) {
    Write-Output '# Telegram mirror is OFF in user-settings.md (Telegram -> Enabled). Skip PHASE 3.'
    return
  }
  $secret = Join-Path $env:LOCALAPPDATA 'overnight-agent\secrets\telegram-secret.ps1'
  $stateJson = Join-Path $env:LOCALAPPDATA 'overnight-agent\telegram-bridge\state.json'
  $lines = @(
    '# Telegram mirror is ON - run this once as the LAST step of the run:',
    "`$env:TELEGRAM_BOT_TOKEN = & `"$secret`" get   # token from OS vault, never a file",
    "`$env:TELEGRAM_CHAT_ID   = '$($r.telegram.chat_id)'",
    "`$env:PLANNER_PATH       = '$($r.planner_folder)'"
  )
  if ($r.telegram.tasks) { $lines += "`$env:TELEGRAM_BRIDGE_TASKS = '$($r.telegram.tasks)'" }
  # Archive completed topics is ON by default; only emit the override when the
  # user-setting says off, so the bridge's own default holds otherwise.
  if (-not $r.telegram.archive) { $lines += "`$env:TELEGRAM_BRIDGE_ARCHIVE = 'off'" }
  # Any other TELEGRAM_BRIDGE_* the settings spell out verbatim (e.g. the approval
  # digest + its topic). Skip the two handled above so they can't be emitted twice.
  $handled = @('TELEGRAM_BRIDGE_TASKS', 'TELEGRAM_BRIDGE_ARCHIVE')
  if ($r.telegram.env) {
    foreach ($k in $r.telegram.env.Keys) {
      if ($handled -contains $k) { continue }
      $v = ($r.telegram.env[$k] -replace "'", "''")
      $lines += "`$env:$k = '$v'"
    }
  }
  $lines += "if (-not (Test-Path `"$stateJson`")) { node `"$($r.telegram.bridge)`" baseline }  # first-time only"
  $lines += "node `"$($r.telegram.bridge)`" once"
  $lines -join "`n"
}

function Cmd-Run {
  $r = Get-Resolved
  Write-Output '===== OVERNIGHT AGENT - RUN CONTEXT ====='
  Write-Output ''
  if ($r.settings_is_template -or $r.has_placeholders) {
    Write-Output '!! WARNING: settings are unresolved (template/placeholders present).'
    Write-Output ('   Resolved settings file: ' + $r.settings_file)
    Write-Output '   Do NOT do real work until the external user-settings.md is filled in.'
    Write-Output ''
  }
  Write-Output '----- Resolved settings -----'
  Write-Output ($r | ConvertTo-Json -Depth 6)
  Write-Output ''
  Write-Output '----- Scan worklist (per task: status/changed/reopened/has_agent_block/tracked) -----'
  Write-Output (Get-Worklist $r.journals_folder)
  Write-Output ''
  Write-Output '----- ' 
  Write-Output (Run-Procedure)
}

switch ($Command) {
  'settings' { Cmd-Settings }
  'paths'    { Cmd-Paths }
  'telegram' { Cmd-Telegram }
  'run'      { Cmd-Run }
  # Delegated state commands - build named params and hand off to oa-state.ps1 unchanged.
  default {
    $p = @{}
    if ($Id)      { $p['Id']      = $Id }
    if ($Status)  { $p['Status']  = $Status }
    if ($Version) { $p['Version'] = $Version }
    if ($PlanId)  { $p['PlanId']  = $PlanId }
    if ($Force)   { $p['Force']   = $true }
    if ($Poll)      { $p['Poll']      = $Poll }
    if ($PollDone)  { $p['PollDone']  = $true }
    if ($PollClear) { $p['PollClear'] = $true }
    if ($JournalDir) { $p['JournalDir'] = $JournalDir }
    if ($StateDir)   { $p['StateDir']   = $StateDir }
    if ($PlannerBoard) { $p['PlannerBoard'] = $PlannerBoard }
    if ($SnoozeStore)  { $p['SnoozeStore']  = $SnoozeStore }
    Invoke-State $Command $p
  }
}
