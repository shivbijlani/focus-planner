<#
  Proves the supervisor visibly promotes active OneDrive task bindings to
  WORKSPACE-ONEDRIVE (GH #547). Drives the real supervisor against fixture-only app,
  resource and binding facts, then mutates both the classifier and integration arm.
#>
[CmdletBinding()]
param([string]$ScriptPath)

$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ScriptPath) { $ScriptPath = Join-Path $Here 'oa-supervisor.ps1' }
if (-not (Test-Path -LiteralPath $ScriptPath)) { throw "supervisor not found: $ScriptPath" }
$Source = (Get-Content -Raw -LiteralPath $ScriptPath) -replace "`r`n", "`n"
$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("mutcheck-supervisor-workspace-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Tmp -Force | Out-Null
$oldUser = $env:USERPROFILE
$oldLocal = $env:LOCALAPPDATA

function New-Subject([string]$Name, [scriptblock]$Mutate) {
  $src = $Source
  if ($Mutate) {
    $next = & $Mutate $src
    if ($next -eq $src) { throw "mutation $Name did not change the source" }
    $src = $next
  }
  $path = Join-Path $Tmp "$Name.ps1"
  [IO.File]::WriteAllText($path, $src, (New-Object Text.UTF8Encoding $false))
  return $path
}

function Invoke-Subject([string]$Subject, [string]$WorkspaceFacts) {
  $out = & pwsh -NoProfile -ExecutionPolicy Bypass -File $Subject -NoAct `
    -WorkspaceFactsJson $WorkspaceFacts -ResourceFactsJson (Join-Path $Tmp 'resource.json') 2>&1
  $text = ($out | Out-String)
  if ($LASTEXITCODE -notin @(0, 1)) { return "ERROR: $text" }
  try { return ($text | ConvertFrom-Json) } catch { return "UNPARSEABLE: $text" }
}

function Test-Subject([string]$Subject) {
  $failures = @()
  $bad = Invoke-Subject $Subject (Join-Path $Tmp 'workspace-bad.json')
  if ($bad -is [string]) { $failures += "A1 bad fixture failed: $bad" }
  elseif ($bad.state -ne 'WORKSPACE-ONEDRIVE' -or $bad.workspace.state -ne 'WORKSPACE-ONEDRIVE' -or
      $bad.workspace.activeOneDriveCount -ne 1 -or $bad.workspace.migrationComplete) {
    $failures += 'A1 active OneDrive binding was not promoted to the visible high-priority fault'
  }

  $good = Invoke-Subject $Subject (Join-Path $Tmp 'workspace-good.json')
  if ($good -is [string]) { $failures += "A2 good fixture failed: $good" }
  elseif ($good.state -eq 'WORKSPACE-ONEDRIVE' -or $good.workspace.state -ne 'HEALTHY' -or
      -not $good.workspace.migrationComplete -or -not $good.workspace.defenderExclusionReady) {
    $failures += 'A2 cleared bindings did not report healthy migration/Defender readiness'
  }
  return $failures
}

try {
  $env:USERPROFILE = Join-Path $Tmp 'profile'
  $env:LOCALAPPDATA = Join-Path $Tmp 'local'
  New-Item -ItemType Directory -Path (Join-Path $env:USERPROFILE '.copilot'), $env:LOCALAPPDATA -Force | Out-Null

  @{ queueLength = 0; appCpuHours = 0; appAgeHours = 1; procCount = 0 } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Tmp 'resource.json') -Encoding utf8
  @{
    canonical_root = 'C:\fixture\local\overnight-agent\workspaces'
    active_onedrive_count = 1
    active_onedrive = @(@{ id = '251'; workspace = 'C:\fixture\OneDrive\overnight-agent\task-workspaces\task-251' })
    migration_complete = $false
    defender_exclusion_ready = $false
  } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $Tmp 'workspace-bad.json') -Encoding utf8
  @{
    canonical_root = 'C:\fixture\local\overnight-agent\workspaces'
    active_onedrive_count = 0
    active_onedrive = @()
    migration_complete = $true
    defender_exclusion_ready = $true
  } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $Tmp 'workspace-good.json') -Encoding utf8

  $db = Join-Path $env:USERPROFILE '.copilot\data.db'
  $iso = (Get-Date).ToUniversalTime().AddMinutes(-2).ToString('o')
  $js = @'
const { DatabaseSync } = require('node:sqlite');
const [dbPath, started] = process.argv.slice(1);
const db = new DatabaseSync(dbPath);
db.exec("CREATE TABLE workflows (id INTEGER PRIMARY KEY, name TEXT)");
db.exec("CREATE TABLE workflow_runs (id INTEGER PRIMARY KEY, task_id INTEGER, status TEXT, trigger TEXT, started_at TEXT, completed_at TEXT, error_message TEXT)");
db.prepare("INSERT INTO workflows (id,name) VALUES (1,'Overnight Agent')").run();
db.prepare("INSERT INTO workflow_runs (task_id,status,trigger,started_at) VALUES (1,'completed','schedule',?)").run(started);
'@
  & node -e $js $db $iso
  if ($LASTEXITCODE -ne 0) { throw 'could not create fixture app database' }

  $baseline = @(Test-Subject (New-Subject 'baseline' $null))
  foreach ($failure in $baseline) { Write-Host "  FAIL baseline $failure" -ForegroundColor Red }
  $mutants = @(
    @{
      name = 'classifier-disabled'
      expect = 'A1'
      mutate = { param($s) $s.Replace('if ($count -gt 0) {', 'if ($count -lt 0) {') }
    },
    @{
      name = 'promotion-disabled'
      expect = 'A1'
      mutate = {
        param($s)
        $s.Replace("if (`$workspaceVerdict.state -eq 'WORKSPACE-ONEDRIVE') {",
          "if (`$false) {")
      }
    }
  )
  $survived = @()
  foreach ($mutant in $mutants) {
    try {
      $failures = @(Test-Subject (New-Subject $mutant.name $mutant.mutate))
      if (@($failures | Where-Object { $_ -like "$($mutant.expect)*" }).Count) {
        Write-Host "  KILLED $($mutant.name)"
      } else {
        Write-Host "  SURVIVED $($mutant.name): $($failures -join '; ')" -ForegroundColor Red
        $survived += $mutant.name
      }
    } catch {
      Write-Host "  ERROR $($mutant.name): $($_.Exception.Message)" -ForegroundColor Red
      $survived += $mutant.name
    }
  }

  if ($baseline.Count -or $survived.Count) {
    Write-Host "FAIL: $($baseline.Count) baseline failure(s), $($survived.Count) mutant(s) survived." -ForegroundColor Red
    exit 1
  }
  Write-Host "PASS: supervisor workspace fault and both mutation arms." -ForegroundColor Green
  exit 0
}
finally {
  $env:USERPROFILE = $oldUser
  $env:LOCALAPPDATA = $oldLocal
  Remove-Item -LiteralPath $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}
