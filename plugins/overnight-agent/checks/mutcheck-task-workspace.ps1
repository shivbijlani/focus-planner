<#
  Proves the GH #547 task-session isolation boundary against the real oa-state.ps1.

  Fixtures use isolated LOCALAPPDATA, USERPROFILE and state directories. Non-code bindings must
  be projectless chats with no workspace. The migration arm never touches live data and verifies
  that legacy files remain in place while chat replacement retains session continuity.
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

function New-LegacyStore(
  [string]$Name,
  [string]$Workspace,
  [string]$TaskId = '900',
  [string]$Kind = 'folder',
  [string]$SessionState = 'live',
  [string]$PriorSessionId = ''
) {
  $dir = Join-Path $Tmp "state-$Name"
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $sessionId = if ($TaskId -eq '900') {
    'aaaaaaaa-1111-2222-3333-444444444444'
  } else {
    "legacy-session-$TaskId"
  }
  $state = [ordered]@{
    id = $TaskId
    status = 'in-progress'
    version = 0
    session = [ordered]@{
      session_id = $sessionId
      kind = $Kind
      project = if ($Kind -eq 'code') { 'legacy-code-project' } else { 'legacy-folder-project' }
      workspace = $Workspace
      workspace_type = if ($Kind -eq 'code') { 'worktree' } else { 'folder' }
      created_at = '2026-09-01T10:00:00-07:00'
      last_woken_at = '2026-09-25T10:00:00-07:00'
      state = $SessionState
      prior_session_id = $PriorSessionId
      replaced_at = ''
    }
  }
  $state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $dir "task-$TaskId.json") -Encoding utf8
  return $dir
}

function Test-Subject([string]$Subject) {
  $failures = @()
  $case = [guid]::NewGuid().ToString('N').Substring(0, 8)
  $state = Join-Path $Tmp "state-bind-$case"
  New-Item -ItemType Directory -Path $state -Force | Out-Null
  $legacyCanonical = Join-Path $env:LOCALAPPDATA 'overnight-agent\workspaces\task-101'
  $r = Invoke-Session $Subject $state @(
    '-Id', '101', '-SessionId', '11111111-1111-1111-1111-111111111111')
  if ($r.exit -ne 0) { $failures += "A1 default chat bind failed: $($r.text)" }
  else {
    $o = $r.text | ConvertFrom-Json
    if ($o.kind -ne 'chat' -or $o.project -or $o.workspace -or $o.workspace_type -or
        (Test-Path -LiteralPath $legacyCanonical)) {
      $failures += 'A1 non-code default was not a projectless chat without a workspace'
    }
  }

  $inside = Join-Path $env:OneDrive 'legacy\task-102'
  $r = Invoke-Session $Subject $state @(
    '-Id', '102', '-SessionId', '22222222-2222-2222-2222-222222222222',
    '-SessionKind', 'chat', '-SessionWorkspace', $inside)
  if ($r.exit -eq 0 -or $r.text -notmatch 'session_chat_scope') {
    $failures += 'A2 chat bind with a workspace was not refused'
  }

  $nested = Join-Path $env:OneDrive 'Apps\Focus Planner'
  $r = Invoke-Session $Subject $state @(
    '-Id', '103', '-SessionId', '33333333-3333-3333-3333-333333333333',
    '-SessionKind', 'chat', '-SessionProject', 'folder-project')
  if ($r.exit -eq 0 -or $r.text -notmatch 'session_chat_scope') {
    $failures += 'A3 chat bind with a project was not refused'
  }

  $sibling = "$($env:OneDrive)-archive\task-104"
  $r = Invoke-Session $Subject $state @(
    '-Id', '104', '-SessionId', '44444444-4444-4444-4444-444444444444',
    '-SessionKind', 'code', '-SessionProject', 'repo', '-SessionWorkspace', $sibling,
    '-WorkspaceType', 'worktree')
  if ($r.exit -ne 0) { $failures += 'A4 path sharing only the OneDrive prefix was falsely refused' }

  $codeWorkspace = Join-Path $env:OneDrive 'code\task-105'
  $r = Invoke-Session $Subject $state @(
    '-Id', '105', '-SessionId', '55555555-5555-5555-5555-555555555555',
    '-SessionKind', 'code', '-SessionProject', 'repo', '-SessionWorkspace', $codeWorkspace)
  if ($r.exit -eq 0 -or $r.text -notmatch 'session_workspace_onedrive') {
    $failures += 'A5 code worktree under OneDrive was not refused'
  }

  $r = Invoke-Session $Subject $state @(
    '-Id', '106', '-SessionId', '66666666-6666-6666-6666-666666666666',
    '-SessionKind', 'code', '-SessionProject', 'repo',
    '-SessionWorkspace', (Join-Path $Tmp 'branch-task-106'), '-WorkspaceType', 'branch')
  if ($r.exit -eq 0 -or $r.text -notmatch 'session_workspace_type') {
    $failures += 'A6 code binding accepted a branch instead of a worktree'
  }

  $r = Invoke-Session $Subject $state @(
    '-Id', '107', '-SessionId', '77777777-7777-7777-7777-777777777777', '-SessionKind', 'folder')
  if ($r.exit -eq 0) {
    $failures += 'A7 legacy folder kind was accepted for a new binding'
  }

  $legacy = Join-Path $env:OneDrive 'overnight-agent\task-workspaces\task-900'
  New-Item -ItemType Directory -Path $legacy -Force | Out-Null
  $evidence = Join-Path $legacy 'keep-me.txt'
  Set-Content -LiteralPath $evidence -Value 'legacy evidence' -Encoding utf8
  $legacyState = New-LegacyStore $case $legacy
  $missingLegacy = Join-Path $env:OneDrive 'overnight-agent\task-workspaces\task-901-missing'
  $missingCodeWorkspace = Join-Path $env:OneDrive 'overnight-agent\task-workspaces\task-902-code'
  $alreadyDeadLegacy = Join-Path $env:OneDrive 'overnight-agent\task-workspaces\task-903-dead'
  if ((Test-Path -LiteralPath $missingLegacy) -or (Test-Path -LiteralPath $missingCodeWorkspace) -or
      (Test-Path -LiteralPath $alreadyDeadLegacy)) {
    $failures += 'A7 missing-workspace fixtures unexpectedly exist before migration'
  }
  [void](New-LegacyStore $case $missingLegacy '901')
  [void](New-LegacyStore $case $missingCodeWorkspace '902' 'code')
  [void](New-LegacyStore $case $alreadyDeadLegacy '903' 'folder' 'dead' 'earlier-session-903')

  $before = Invoke-Session $Subject $legacyState @('-WorkspaceHealth')
  if ($before.exit -ne 0 -or ($before.text | ConvertFrom-Json).active_onedrive_count -ne 3 -or
      ($before.text | ConvertFrom-Json).retired_legacy_count -ne 1) {
    $failures += 'A8 health did not expose all active OneDrive bindings, including missing workspaces'
  }

  $migration = Invoke-Session $Subject $legacyState @('-MigrateOneDriveBindings')
  if ($migration.exit -ne 0) { $failures += "A8 migration failed: $($migration.text)" }
  else {
    $m = $migration.text | ConvertFrom-Json
    $folderReplacement = @($m.migrated | Where-Object { "$($_.id)" -eq '900' -or "$($_.id)" -eq '901' })
    $codeReplacement = @($m.migrated | Where-Object { "$($_.id)" -eq '902' })
    if ($m.migrated_count -ne 3 -or $m.files_moved -ne 0 -or $m.files_deleted -ne 0 -or
        $folderReplacement.Count -ne 2 -or
        @($folderReplacement | Where-Object { $_.replacement_kind -ne 'chat' -or $_.replacement_workspace }).Count -gt 0 -or
        $codeReplacement.Count -ne 1 -or $codeReplacement[0].replacement_kind -ne 'code' -or
        $codeReplacement[0].replacement_workspace) {
      $failures += 'A9 migration did not prescribe chat and code replacements without folder targets'
    }
    if (-not (Test-Path -LiteralPath $evidence)) {
      $failures += 'A9 migration touched legacy workspace data'
    }
    if ((Test-Path -LiteralPath $missingLegacy) -or (Test-Path -LiteralPath $missingCodeWorkspace) -or
        (Test-Path -LiteralPath $alreadyDeadLegacy)) {
      $failures += 'A9 migration recreated a missing legacy workspace'
    }
  }

  $deadBeforeRepeat = Get-Content -Raw -LiteralPath (Join-Path $legacyState 'task-903.json') | ConvertFrom-Json
  $repeatMigration = Invoke-Session $Subject $legacyState @('-MigrateOneDriveBindings')
  if ($repeatMigration.exit -ne 0) { $failures += "A10 repeated migration failed: $($repeatMigration.text)" }
  else {
    $repeat = $repeatMigration.text | ConvertFrom-Json
    $deadAfterRepeat = Get-Content -Raw -LiteralPath (Join-Path $legacyState 'task-903.json') | ConvertFrom-Json
    if ($repeat.migrated_count -ne 0 -or $deadAfterRepeat.session.state -ne 'dead' -or
        $deadAfterRepeat.session.session_id -ne $deadBeforeRepeat.session.session_id -or
        $deadAfterRepeat.session.prior_session_id -ne 'earlier-session-903' -or
        $deadAfterRepeat.session.replaced_at -ne $deadBeforeRepeat.session.replaced_at) {
      $failures += 'A10 repeated migration changed an already-dead binding or its continuity metadata'
    }
  }

  $retired = Invoke-Session $Subject $legacyState @('-Id', '900')
  if ($retired.exit -ne 0) { $failures += "A11 retired binding read failed: $($retired.text)" }
  else {
    $o = $retired.text | ConvertFrom-Json
    if ($o.verdict -ne 'replace' -or $o.session_id -ne 'aaaaaaaa-1111-2222-3333-444444444444' -or
        $o.kickoff_continuation -notmatch [regex]::Escape($o.session_id)) {
      $failures += 'A11 migration lost the replace verdict or prior-session continuity'
    }
  }

  $replacement = Invoke-Session $Subject $legacyState @(
    '-Id', '900', '-SessionId', '99999999-9999-9999-9999-999999999999', '-SessionKind', 'chat')
  if ($replacement.exit -ne 0) { $failures += "A12 replacement bind failed: $($replacement.text)" }
  else {
    $o = $replacement.text | ConvertFrom-Json
    if ($o.kind -ne 'chat' -or $o.project -or $o.workspace -or $o.workspace_type -or
        $o.prior_session_id -ne 'aaaaaaaa-1111-2222-3333-444444444444') {
      $failures += 'A12 replacement did not bind a workspace-free chat and preserve prior session id'
    }
  }

  $deadFolder = Invoke-Session $Subject $legacyState @('-Id', '903')
  if ($deadFolder.exit -ne 0) { $failures += "A13 pre-dead binding read failed: $($deadFolder.text)" }
  else {
    $o = $deadFolder.text | ConvertFrom-Json
    if ($o.verdict -ne 'replace' -or $o.kickoff_continuation -notmatch 'legacy-session-903') {
      $failures += 'A13 an already-dead OneDrive binding did not remain replaceable'
    }
  }

  $deadFolderReplacement = Invoke-Session $Subject $legacyState @(
    '-Id', '903', '-SessionId', 'new-chat-session-903', '-SessionKind', 'chat')
  if ($deadFolderReplacement.exit -ne 0) {
    $failures += "A14 already-dead chat replacement bind failed: $($deadFolderReplacement.text)"
  } else {
    $o = $deadFolderReplacement.text | ConvertFrom-Json
    if ($o.kind -ne 'chat' -or $o.prior_session_id -ne 'legacy-session-903') {
      $failures += 'A14 already-dead chat replacement lost the prior session id'
    }
  }

  $codeReplacement = Invoke-Session $Subject $legacyState @(
    '-Id', '902', '-SessionId', 'new-code-worktree-session', '-SessionKind', 'code',
    '-SessionProject', 'repo', '-SessionWorkspace', (Join-Path $Tmp 'fresh-code-worktree-902'),
    '-WorkspaceType', 'worktree')
  if ($codeReplacement.exit -ne 0) { $failures += "A15 code replacement bind failed: $($codeReplacement.text)" }
  else {
    $o = $codeReplacement.text | ConvertFrom-Json
    if ($o.kind -ne 'code' -or $o.prior_session_id -ne 'legacy-session-902' -or
        $o.workspace -ne (Join-Path $Tmp 'fresh-code-worktree-902')) {
      $failures += 'A15 code replacement lost its kind, worktree, or prior session id'
    }
  }

  $after = Invoke-Session $Subject $legacyState @('-WorkspaceHealth')
  if ($after.exit -ne 0) { $failures += "A16 final health failed: $($after.text)" }
  else {
    $h = $after.text | ConvertFrom-Json
    if (-not $h.migration_complete -or -not $h.defender_exclusion_ready -or
        $h.active_onedrive_count -ne 0 -or $h.active_noncanonical_folder_count -ne 0 -or
        $h.active_chat_count -ne 2 -or $h.active_bindings -ne 3) {
      $failures += 'A16 migration/health gate reported the active chat and code bindings incorrectly'
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
      expect = 'A1'
      mutate = {
        param($s)
        $s.Replace("else { 'chat' }", "else { 'folder' }")
      }
    },
    @{
      name = 'chat-scope-guard-removed'
      expect = 'A2|A3'
      mutate = {
        param($s)
        $s.Replace('if ($SessionProject -or $SessionWorkspace -or $WorkspaceType) {',
          'if ($false) {')
      }
    },
    @{
      name = 'onedrive-guard-removed'
      expect = 'A5'
      mutate = {
        param($s)
        $s.Replace('if ($oneDriveRoot) {', 'if ($false) {')
      }
    },
    @{
      name = 'worktree-type-guard-removed'
      expect = 'A6'
      mutate = {
        param($s)
        $s.Replace("if (`$wsType -ne 'worktree') {", 'if ($false) {')
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
      expect = 'A9|A10|A11|A12|A13|A14|A15|A16'
      mutate = {
        param($s)
        $s.Replace("if (-not `$s -or `"`$(`$s.state)`" -ne 'live') { continue }", 'if ($true) { continue }')
      }
    },
    @{
      name = 'migration-kind-regressed'
      expect = 'A9|A12'
      mutate = {
        param($s)
        $s.Replace("`$replacementKind = if (`"`$(`$s.kind)`" -eq 'folder') { 'chat' }",
          "`$replacementKind = if (`"`$(`$s.kind)`" -eq 'folder') { 'folder' }")
      }
    },
    @{
      name = 'dead-binding-migrated-again'
      expect = 'A9|A10'
      mutate = {
        param($s)
        $s.Replace('"$($s.state)" -ne ''live''', '"$($s.state)" -ne ''never-live''')
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
  Write-Host "PASS: chat/worktree isolation, safe migration and all $($mutants.Count) mutation arms." -ForegroundColor Green
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
