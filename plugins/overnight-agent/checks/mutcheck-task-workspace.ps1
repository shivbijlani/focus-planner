<#
  Proves the GH #547 task-session isolation boundary against the real oa-state.ps1.

  Fixtures use isolated LOCALAPPDATA, USERPROFILE and state directories. Non-code bindings must
  be projectless chats with no workspace; code bindings must use isolated worktrees outside
  OneDrive.
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

function Test-Subject([string]$Subject) {
  $failures = @()
  $case = [guid]::NewGuid().ToString('N').Substring(0, 8)
  $state = Join-Path $Tmp "state-bind-$case"
  New-Item -ItemType Directory -Path $state -Force | Out-Null
  $r = Invoke-Session $Subject $state @(
    '-Id', '101', '-SessionId', '11111111-1111-1111-1111-111111111111')
  if ($r.exit -ne 0) { $failures += "A1 default chat bind failed: $($r.text)" }
  else {
    $o = $r.text | ConvertFrom-Json
    if ($o.kind -ne 'chat' -or $o.project -or $o.workspace -or $o.workspace_type) {
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
  if ($r.exit -eq 0) { $failures += 'A7 legacy folder kind was accepted for a new binding' }

  return $failures
}

try {
  $env:USERPROFILE = Join-Path $Tmp 'profile'
  $env:LOCALAPPDATA = Join-Path $Tmp 'local'
  $env:OneDrive = Join-Path $env:USERPROFILE 'OneDrive'
  $env:OneDriveConsumer = ''
  $env:OneDriveCommercial = ''
  New-Item -ItemType Directory -Path $env:LOCALAPPDATA, $env:OneDrive, (Join-Path $Tmp 'journals') -Force | Out-Null

  $baseline = @(Test-Subject (New-Subject 'baseline' $null))
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
  Write-Host "PASS: chat/worktree isolation, OneDrive refusal and all $($mutants.Count) mutation arms." -ForegroundColor Green
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
