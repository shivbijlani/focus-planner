<#
  Proves the GH #547 task-workspace safety boundary against the real oa-state.ps1.

  Fixtures use isolated LOCALAPPDATA, USERPROFILE and state directories. The migration arm never
  touches live data and verifies that legacy files remain in place while session continuity is
  retained through the normal `replace` verdict.
#>
[CmdletBinding()]
param([string]$ScriptPath)

$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ScriptPath) {
  $candidates = @(
    (Join-Path $Here '..\skills\overnight-agent\oa-state.ps1'),
    (Join-Path $Here 'oa-state.ps1')
  )
  $ScriptPath = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if (-not $ScriptPath) { throw 'oa-state.ps1 not found' }

$Source = (Get-Content -Raw -LiteralPath $ScriptPath) -replace "`r`n", "`n"
$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("mutcheck-task-workspace-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Tmp -Force | Out-Null
$oldLocal = $env:LOCALAPPDATA
$oldUser = $env:USERPROFILE
$oldOneDrive = $env:OneDrive
$oldConsumer = $env:OneDriveConsumer
$oldCommercial = $env:OneDriveCommercial

function New-Subject([string]$Name, [scriptblock]$Mutate) {
  $src = $Source
  if ($Mutate) {
    $next = & $Mutate $src
    if ($next -eq $src) { throw "mutation $Name did not change the source" }
    $src = $next
  }
  $dir = Join-Path $Tmp $Name
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $path = Join-Path $dir 'oa-state.ps1'
  [IO.File]::WriteAllText($path, $src, (New-Object Text.UTF8Encoding $false))
  return $path
}

function Invoke-Session {
  param([string]$Subject, [string]$StateDir, [string[]]$Arguments)
  $all = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Subject, 'session') +
    $Arguments + @('-StateDir', $StateDir, '-JournalDir', (Join-Path $Tmp 'journals'))
  $out = & pwsh @all 2>&1
  [pscustomobject]@{ exit = $LASTEXITCODE; text = ($out | Out-String) }
}

function New-LegacyStore([string]$Name, [string]$Workspace) {
  $dir = Join-Path $Tmp "state-$Name"
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $state = [ordered]@{
    id = '900'
    status = 'in-progress'
    version = 0
    session = [ordered]@{
      session_id = 'aaaaaaaa-1111-2222-3333-444444444444'
      kind = 'folder'
      project = 'legacy-folder-project'
      workspace = $Workspace
      workspace_type = 'folder'
      created_at = '2026-09-01T10:00:00-07:00'
      last_woken_at = '2026-09-25T10:00:00-07:00'
      state = 'live'
      prior_session_id = ''
      replaced_at = ''
    }
  }
  $state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $dir 'task-900.json') -Encoding utf8
  return $dir
}

function Test-Subject([string]$Subject) {
  $failures = @()
  $case = [guid]::NewGuid().ToString('N').Substring(0, 8)
  $state = Join-Path $Tmp "state-bind-$case"
  New-Item -ItemType Directory -Path $state -Force | Out-Null
  $canonical = Join-Path $env:LOCALAPPDATA 'overnight-agent\workspaces\task-101'

  $r = Invoke-Session $Subject $state @(
    '-Id', '101', '-SessionId', '11111111-1111-1111-1111-111111111111', '-SessionKind', 'folder')
  if ($r.exit -ne 0) { $failures += "A1 default folder bind failed: $($r.text)" }
  else {
    $o = $r.text | ConvertFrom-Json
    if ($o.workspace -ne $canonical -or -not (Test-Path -LiteralPath $canonical -PathType Container)) {
      $failures += "A1 folder default was '$($o.workspace)', expected created '$canonical'"
    }
  }

  $inside = Join-Path $env:OneDrive 'legacy\task-102'
  $r = Invoke-Session $Subject $state @(
    '-Id', '102', '-SessionId', '22222222-2222-2222-2222-222222222222',
    '-SessionKind', 'folder', '-SessionWorkspace', $inside)
  if ($r.exit -eq 0 -or $r.text -notmatch 'session_workspace_onedrive') {
    $failures += 'A2 explicit folder workspace under OneDrive was not refused'
  }

  $nested = Join-Path $env:OneDrive 'Apps\Focus Planner'
  $r = Invoke-Session $Subject $state @(
    '-Id', '103', '-SessionId', '33333333-3333-3333-3333-333333333333',
    '-SessionKind', 'folder', '-SessionWorkspace', $nested)
  if ($r.exit -eq 0 -or $r.text -notmatch 'session_workspace_onedrive') {
    $failures += 'A3 planner workspace under OneDrive was not refused'
  }

  $sibling = "$($env:OneDrive)-archive\task-104"
  $r = Invoke-Session $Subject $state @(
    '-Id', '104', '-SessionId', '44444444-4444-4444-4444-444444444444',
    '-SessionKind', 'folder', '-SessionWorkspace', $sibling)
  if ($r.exit -ne 0) { $failures += 'A4 path sharing only the OneDrive prefix was falsely refused' }

  $codeWorkspace = Join-Path $env:OneDrive 'code\task-105'
  $r = Invoke-Session $Subject $state @(
    '-Id', '105', '-SessionId', '55555555-5555-5555-5555-555555555555',
    '-SessionKind', 'code', '-SessionProject', 'repo', '-SessionWorkspace', $codeWorkspace,
    '-WorkspaceType', 'worktree')
  if ($r.exit -eq 0 -or $r.text -notmatch 'session_workspace_onedrive') {
    $failures += 'A5 code workspace under OneDrive was not refused'
  }

  $legacy = Join-Path $env:OneDrive 'overnight-agent\task-workspaces\task-900'
  New-Item -ItemType Directory -Path $legacy -Force | Out-Null
  $evidence = Join-Path $legacy 'keep-me.txt'
  Set-Content -LiteralPath $evidence -Value 'legacy evidence' -Encoding utf8
  $legacyState = New-LegacyStore $case $legacy

  $before = Invoke-Session $Subject $legacyState @('-WorkspaceHealth')
  if ($before.exit -ne 0 -or ($before.text | ConvertFrom-Json).active_onedrive_count -ne 1) {
    $failures += 'A6 health did not expose the active OneDrive binding'
  }

  $migration = Invoke-Session $Subject $legacyState @('-MigrateOneDriveBindings')
  if ($migration.exit -ne 0) { $failures += "A7 migration failed: $($migration.text)" }
  else {
    $m = $migration.text | ConvertFrom-Json
    if ($m.migrated_count -ne 1 -or $m.files_moved -ne 0 -or $m.files_deleted -ne 0) {
      $failures += 'A7 migration did not report one state-only retirement'
    }
    if (-not (Test-Path -LiteralPath $evidence)) {
      $failures += 'A7 migration touched legacy workspace data'
    }
  }

  $retired = Invoke-Session $Subject $legacyState @('-Id', '900')
  if ($retired.exit -ne 0) { $failures += "A8 retired binding read failed: $($retired.text)" }
  else {
    $o = $retired.text | ConvertFrom-Json
    if ($o.verdict -ne 'replace' -or $o.session_id -ne 'aaaaaaaa-1111-2222-3333-444444444444' -or
        $o.kickoff_continuation -notmatch [regex]::Escape($o.session_id)) {
      $failures += 'A8 migration lost the replace verdict or prior-session continuity'
    }
  }

  $replacement = Invoke-Session $Subject $legacyState @(
    '-Id', '900', '-SessionId', '99999999-9999-9999-9999-999999999999', '-SessionKind', 'folder')
  if ($replacement.exit -ne 0) { $failures += "A9 replacement bind failed: $($replacement.text)" }
  else {
    $o = $replacement.text | ConvertFrom-Json
    $expected = Join-Path $env:LOCALAPPDATA 'overnight-agent\workspaces\task-900'
    if ($o.workspace -ne $expected -or $o.prior_session_id -ne 'aaaaaaaa-1111-2222-3333-444444444444') {
      $failures += 'A9 replacement did not use canonical workspace and preserve prior session id'
    }
  }

  $after = Invoke-Session $Subject $legacyState @('-WorkspaceHealth')
  if ($after.exit -ne 0) { $failures += "A10 final health failed: $($after.text)" }
  else {
    $h = $after.text | ConvertFrom-Json
    if (-not $h.migration_complete -or -not $h.defender_exclusion_ready -or
        $h.active_onedrive_count -ne 0 -or $h.active_noncanonical_folder_count -ne 0) {
      $failures += 'A10 migration/Defender gate reported ready state incorrectly'
    }
  }
  return $failures
}

try {
  $env:USERPROFILE = Join-Path $Tmp 'profile'
  $env:LOCALAPPDATA = Join-Path $Tmp 'local'
  $env:OneDrive = Join-Path $env:USERPROFILE 'OneDrive'
  $env:OneDriveConsumer = ''
  $env:OneDriveCommercial = ''
  New-Item -ItemType Directory -Path $env:LOCALAPPDATA, $env:OneDrive, (Join-Path $Tmp 'journals') -Force | Out-Null

  $baselineSubject = New-Subject 'baseline' $null
  $baseline = @(Test-Subject $baselineSubject)
  foreach ($failure in $baseline) { Write-Host "  FAIL baseline $failure" -ForegroundColor Red }

  $mutants = @(
    @{
      name = 'default-removed'
      expect = 'A1|A9'
      mutate = {
        param($s)
        $s.Replace("elseif (`$kind -eq 'folder') { Get-CanonicalTaskWorkspace `$Id }",
          "elseif (`$kind -eq 'folder') { '' }")
      }
    },
    @{
      name = 'onedrive-guard-removed'
      expect = 'A2|A3|A5|A6'
      mutate = {
        param($s)
        $s.Replace('if (Test-PathUnderRoot $path $root) { return $root }',
          'if ($false) { return $root }')
      }
    },
    @{
      name = 'root-boundary-removed'
      expect = 'A4'
      mutate = {
        param($s)
        $s.Replace("`$candidate.StartsWith((`$parent + '\'), [StringComparison]::OrdinalIgnoreCase)",
          "`$candidate.StartsWith(`$parent, [StringComparison]::OrdinalIgnoreCase)")
      }
    },
    @{
      name = 'migration-retirement-removed'
      expect = 'A7|A8|A9|A10'
      mutate = {
        param($s)
        $s.Replace("if (-not `$s -or `"`$(`$s.state)`" -ne 'live') { continue }", 'if ($true) { continue }')
      }
    }
  )

  $survived = @()
  foreach ($mutant in $mutants) {
    try {
      $subject = New-Subject $mutant.name $mutant.mutate
      $failures = @(Test-Subject $subject)
      if (@($failures | Where-Object { $_ -match "^($($mutant.expect))" }).Count -gt 0) {
        Write-Host ("  KILLED {0}" -f $mutant.name)
      } else {
        Write-Host ("  SURVIVED {0}: {1}" -f $mutant.name, ($failures -join '; ')) -ForegroundColor Red
        $survived += $mutant.name
      }
    } catch {
      Write-Host ("  ERROR {0}: {1}" -f $mutant.name, $_.Exception.Message) -ForegroundColor Red
      $survived += $mutant.name
    }
  }

  if ($baseline.Count -or $survived.Count) {
    Write-Host "FAIL: $($baseline.Count) baseline failure(s), $($survived.Count) mutant(s) survived." -ForegroundColor Red
    exit 1
  }
  Write-Host "PASS: workspace isolation, safe migration and all $($mutants.Count) mutation arms." -ForegroundColor Green
  exit 0
}
finally {
  $env:LOCALAPPDATA = $oldLocal
  $env:USERPROFILE = $oldUser
  $env:OneDrive = $oldOneDrive
  $env:OneDriveConsumer = $oldConsumer
  $env:OneDriveCommercial = $oldCommercial
  Remove-Item -LiteralPath $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}
