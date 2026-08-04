<#
.SYNOPSIS
  Hermetic smoke test for oa.ps1 (the Overnight Agent CLI). Exercises every command path
  WITHOUT doing a real overnight run and WITHOUT touching the user's real settings, journals,
  or state store - everything runs against throwaway temp fixtures.

.WHY
  GH #124 / PR #125 offloaded the run mechanics into oa.ps1. This gives that script a fast,
  machine-independent check so its behaviour is verifiable without a full overnight run:
  settings resolution + parsing, placeholder detection, the paths catalog, the Telegram
  invocation (on and off), the run instruction-provider, the oa-state.ps1 delegation
  (seed/scan/mark/get round-trip), and input validation.

.USAGE
  pwsh oa.smoke.ps1        # exit code 0 = all passed, non-zero = one or more failed
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$oa = Join-Path $here 'oa.ps1'
$script:fails = 0
$script:passes = 0

function Assert($cond, [string]$msg) { if (-not $cond) { throw $msg } }

function Check([string]$name, [scriptblock]$body) {
  try { & $body; $script:passes++; Write-Host "  PASS  $name" -ForegroundColor Green }
  catch { $script:fails++; Write-Host "  FAIL  $name -> $($_.Exception.Message)" -ForegroundColor Red }
}

# --- fixtures (temp, thrown away at the end) ---------------------------------
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("oa-smoke-" + [guid]::NewGuid().ToString('N'))
$journalDir = Join-Path $tmp 'journal'
$stateDir = Join-Path $tmp 'state'
New-Item -ItemType Directory -Force -Path $journalDir | Out-Null

# A settings fixture with KNOWN, resolvable values (no <...> placeholders). The Journals
# folder points at our temp journal dir so the `run` scan path exercises real work.
$goodSettings = Join-Path $tmp 'user-settings.good.md'
@"
# fixture
| Setting | Value |
| --- | --- |
| User | ``smoketest`` |
| Timezone | America/Los_Angeles |
| Planner board | ``C:\smoke\Focus Planner\planner.md`` |
| Journals folder | ``$journalDir`` |
| Dev drive (repos) | ``Z:\repos\`` (worktrees in ``Z:\repos\<name>.worktrees\``) |
| GitHub owner | ``github.com/smoketest`` |
| Agent email account | ``smoke@example.com`` ("Overnight Agent") |
| Authorized sender addresses | ``a@example.com``, ``b@example.com`` |

## Telegram
| Setting | Value |
| --- | --- |
| Enabled | ``on`` - mirror journals |
| Chat id | ``-100999`` (test) |
| Bridge CLI | ``Z:\bridge.js`` (node) |
| Tasks | *(empty)* - mirror every task |
"@ | Set-Content -Path $goodSettings -Encoding UTF8

# Same, but Telegram OFF and an unresolved <placeholder> in an operational value.
$offSettings = Join-Path $tmp 'user-settings.off.md'
@"
# fixture
| Setting | Value |
| --- | --- |
| User | ``smoketest`` |
| Planner board | ``C:\smoke\Focus Planner\planner.md`` |
| Journals folder | ``$journalDir`` |
| Dev drive (repos) | ``Z:\repos\`` |
| Agent email account | ``<agent-inbox@example.com>`` |
| Authorized sender addresses | ``<you@example.com>`` |

## Telegram
| Setting | Value |
| --- | --- |
| Enabled | ``off`` |
| Chat id | ``-100999`` |
| Bridge CLI | ``Z:\bridge.js`` |
"@ | Set-Content -Path $offSettings -Encoding UTF8

# A fixture journal so the delegated scan/seed/mark/get commands have something to act on.
@"
# Task 999: smoke fixture

- TODO: nothing real here.
"@ | Set-Content -Path (Join-Path $journalDir 'task-999.md') -Encoding UTF8

function Oa {
  # Never let a child-process stderr line raise under the script's EAP=Stop; callers
  # inspect the merged output (and $LASTEXITCODE) themselves.
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & powershell -NoProfile -ExecutionPolicy Bypass -File $oa @args 2>&1 }
  finally { $ErrorActionPreference = $prev }
}

Write-Host "oa.ps1 smoke test" -ForegroundColor Cyan
Write-Host "  fixtures: $tmp"

# --- 0. co-location: oa.ps1 delegates to oa-state.ps1 -------------------------
Check 'oa.ps1 and oa-state.ps1 are co-located' {
  Assert (Test-Path $oa) "oa.ps1 missing at $oa"
  Assert (Test-Path (Join-Path $here 'oa-state.ps1')) 'oa-state.ps1 not found next to oa.ps1 (delegation would break)'
}

# --- 1. settings: parse + resolve, no placeholders ---------------------------
Check 'settings resolves values with no placeholders' {
  $r = (Oa settings -SettingsFile $goodSettings | Out-String | ConvertFrom-Json)
  Assert ($r.settings_is_template -eq $false) 'should not fall back to template'
  Assert ($r.has_placeholders -eq $false) "has_placeholders should be false, got $($r.has_placeholders)"
  Assert ($r.user -eq 'smoketest') "user parsed wrong: '$($r.user)'"
  Assert ($r.dev_drive -eq 'Z:\repos\') "dev_drive parsed wrong: '$($r.dev_drive)'"
  Assert ($r.planner_folder -eq 'C:\smoke\Focus Planner') "planner_folder derived wrong: '$($r.planner_folder)'"
  Assert ($r.agent_email -eq 'smoke@example.com') "agent_email parsed wrong: '$($r.agent_email)'"
  Assert ($r.telegram.enabled -eq $true) 'telegram.enabled should be true'
  Assert ($r.telegram.chat_id -eq '-100999') "telegram.chat_id wrong: '$($r.telegram.chat_id)'"
}

# --- 2. placeholder + template detection -------------------------------------
Check 'placeholders in operational values are detected' {
  $r = (Oa settings -SettingsFile $offSettings | Out-String | ConvertFrom-Json)
  Assert ($r.has_placeholders -eq $true) 'has_placeholders should be true when <...> present in an operational value'
}

# --- 3. paths catalog --------------------------------------------------------
Check 'paths emits the resolved catalog' {
  $r = (Oa paths -SettingsFile $goodSettings | Out-String | ConvertFrom-Json)
  Assert ($r.planner_board -eq 'C:\smoke\Focus Planner\planner.md') "planner_board wrong: '$($r.planner_board)'"
  Assert ($r.journals_folder -eq $journalDir) "journals_folder wrong: '$($r.journals_folder)'"
  Assert ($r.state_store -match 'overnight-agent[\\/]state$') "state_store wrong: '$($r.state_store)'"
  Assert ($r.telegram.enabled -eq $true) 'paths telegram.enabled should be true'
}

# --- 4. telegram invocation (ON) ---------------------------------------------
Check 'telegram (ON) prints a runnable bridge invocation' {
  $out = (Oa telegram -SettingsFile $goodSettings | Out-String)
  Assert ($out -match 'Telegram mirror is ON') 'missing ON banner'
  Assert ($out -match [regex]::Escape('-100999')) 'chat id not embedded'
  Assert ($out -match [regex]::Escape('Z:\bridge.js')) 'bridge path not embedded'
  Assert ($out -match 'node .* once') 'missing `node ... once` line'
  Assert ($out -notmatch 'TELEGRAM_BOT_TOKEN\s*=\s*[A-Za-z0-9:_-]{20,}') 'a raw token must never be printed'
}

# --- 5. telegram invocation (OFF) --------------------------------------------
Check 'telegram (OFF) prints the skip note, not an invocation' {
  $out = (Oa telegram -SettingsFile $offSettings | Out-String)
  Assert ($out -match 'Telegram mirror is OFF') 'missing OFF note'
  Assert ($out -notmatch 'node .* once') 'must not emit a bridge invocation when disabled'
}

# --- 6. run instruction-provider --------------------------------------------
Check 'run emits settings + worklist + the ordered procedure' {
  $out = (Oa run -SettingsFile $goodSettings | Out-String)
  foreach ($needle in @('RUN CONTEXT', 'Resolved settings', 'Scan worklist', 'RUN PROCEDURE',
      'PHASE 0', 'PHASE 1', 'PHASE 2', 'PHASE 3', 'WRAP UP')) {
    Assert ($out -match [regex]::Escape($needle)) "run output missing '$needle'"
  }
}

# --- 7. oa-state delegation round-trip (seed -> scan -> mark -> get) ----------
Check 'scan/seed/mark/get delegate to oa-state.ps1 and round-trip' {
  Oa seed -JournalDir $journalDir -StateDir $stateDir | Out-Null
  $scan = (Oa scan -JournalDir $journalDir -StateDir $stateDir | Out-String | ConvertFrom-Json)
  $row = @($scan) | Where-Object { "$($_.id)" -eq '999' }
  Assert ($null -ne $row) 'scan did not report the fixture task 999'
  Oa mark -Id 999 -Status proposed -Version 1 -PlanId t999-v1 -JournalDir $journalDir -StateDir $stateDir | Out-Null
  $got = (Oa get -Id 999 -JournalDir $journalDir -StateDir $stateDir | Out-String | ConvertFrom-Json)
  Assert ($got.status -eq 'proposed') "mark/get round-trip failed, status='$($got.status)'"
}

# --- 8. input validation -----------------------------------------------------
Check 'an unknown command is rejected (ValidateSet)' {
  $out = (Oa 'bogus-command' | Out-String)
  $code = $LASTEXITCODE
  Assert (($code -ne 0) -or ($out -match 'does not belong to the set|Cannot validate argument')) 'invalid command should be rejected'
}

# --- cleanup + summary -------------------------------------------------------
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue

Write-Host ''
Write-Host "  $($script:passes) passed, $($script:fails) failed" -ForegroundColor ($(if ($script:fails) { 'Red' } else { 'Green' }))
if ($script:fails) { exit 1 } else { exit 0 }
