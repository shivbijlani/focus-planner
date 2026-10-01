# Sandbox construction and inspection helpers for run-sandbox.ps1. Dot-source only.
#
# A sandbox is one directory that stands in for everything the live Overnight Agent touches:
#
#   <sandbox>\home\                          USERPROFILE / HOME
#   <sandbox>\home\.copilot\                 COPILOT_HOME (isolated: no installed plugins, no
#                                            live MCP servers, its own session store)
#   <sandbox>\home\OneDrive\Apps\Focus Planner\   the planner folder (OVERNIGHT_AGENT_PLANNER_DIR)
#   <sandbox>\home\AppData\Local\overnight-agent\ the OA home (OVERNIGHT_AGENT_HOME)
#   <sandbox>\home\AppData\Roaming\          APPDATA
#   <sandbox>\tmp\                           TEMP / TMP
#   <sandbox>\repos\                         the Dev drive (empty: no code tasks)
#   <sandbox>\repo\                          the source under test, exported from -Ref
#   <sandbox>\sandbox-app\                   the stub app host's records (dispatch log)
#
# OA_SANDBOX_ROOT is <sandbox>, so every tripwired script refuses a path outside it.

Set-StrictMode -Off

$script:Utf8NoBom = New-Object Text.UTF8Encoding($false)
$script:Moon = [char]::ConvertFromUtf32(0x1F319)
$script:Sentinel = '<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->'

function Write-Utf8([string]$Path, [string]$Text) {
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [IO.File]::WriteAllText($Path, $Text, $script:Utf8NoBom)
}

function Read-Utf8([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  return [IO.File]::ReadAllText($Path, $script:Utf8NoBom)
}

function Get-SandboxLayout([string]$Root) {
  $home_ = Join-Path $Root 'home'
  $local = Join-Path $home_ 'AppData\Local'
  [pscustomobject]@{
    Root        = $Root
    Home        = $home_
    CopilotHome = Join-Path $home_ '.copilot'
    OneDrive    = Join-Path $home_ 'OneDrive'
    Planner     = Join-Path $home_ 'OneDrive\Apps\Focus Planner'
    Journal     = Join-Path $home_ 'OneDrive\Apps\Focus Planner\journal'
    LocalAppData = $local
    AppData     = Join-Path $home_ 'AppData\Roaming'
    OaHome      = Join-Path $local 'overnight-agent'
    StateDir    = Join-Path $local 'overnight-agent\state'
    TaskChats   = Join-Path $local 'overnight-agent\task-chats'
    Tmp         = Join-Path $Root 'tmp'
    Repos       = Join-Path $Root 'repos'
    Repo        = Join-Path $Root 'repo'
    PluginDir   = Join-Path $Root 'repo\plugins\overnight-agent'
    SkillDir    = Join-Path $Root 'repo\plugins\overnight-agent\skills\overnight-agent'
    AppDir      = Join-Path $Root 'sandbox-app'
    GhConfig    = Join-Path $Root 'gh-config'
    Settings    = Join-Path $home_ 'OneDrive\Apps\Focus Planner\user-settings.md'
  }
}

function New-SandboxDirs($L) {
  foreach ($d in @($L.Root, $L.Home, $L.CopilotHome, $L.Planner, $L.Journal, $L.AppData, $L.OaHome,
      $L.StateDir, $L.TaskChats, $L.Tmp, $L.Repos, $L.AppDir, $L.GhConfig)) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
  }
}

# The environment every sandboxed process runs with: the live agent's variables, redirected.
# Returned as a hashtable so the harness can apply it to a ProcessStartInfo or to itself.
function Get-SandboxEnv($L, [hashtable]$Extra = @{}) {
  $e = [ordered]@{
    OA_SANDBOX_ROOT             = $L.Root
    OVERNIGHT_AGENT_HOME        = $L.OaHome
    OVERNIGHT_AGENT_PLANNER_DIR = $L.Planner
    OVERNIGHT_AGENT_SETTINGS    = $L.Settings
    COPILOT_HOME                = $L.CopilotHome
    USERPROFILE                 = $L.Home
    HOME                        = $L.Home
    LOCALAPPDATA                = $L.LocalAppData
    APPDATA                     = $L.AppData
    OneDrive                    = $L.OneDrive
    OneDriveConsumer            = $L.OneDrive
    OneDriveCommercial          = $L.OneDrive
    TEMP                        = $L.Tmp
    TMP                         = $L.Tmp
    PLANNER_PATH                = $L.Planner
    FOCUS_PLANNER_REPO          = $L.Repo
    # GitHub is unreachable from inside: gh talks to a host that does not exist and has no
    # stored login; git has no credential helper and may not prompt. Copilot itself still
    # authenticates because COPILOT_GH_HOST pins it to github.com and its own login lives in
    # the OS credential store, not in any of these files.
    GH_CONFIG_DIR               = $L.GhConfig
    GH_HOST                     = 'oa-sandbox.invalid'
    COPILOT_GH_HOST             = 'github.com'
    GH_TOKEN                    = $null
    GITHUB_TOKEN                = $null
    GH_ENTERPRISE_TOKEN         = $null
    GIT_CONFIG_NOSYSTEM         = '1'
    GIT_CONFIG_GLOBAL           = (Join-Path $L.GhConfig 'gitconfig')
    GIT_TERMINAL_PROMPT         = '0'
    GCM_INTERACTIVE             = 'never'
    OA_RUN_TRIGGER              = 'sandbox'
    TELEGRAM_BOT_TOKEN          = $null
  }
  foreach ($k in $Extra.Keys) { $e[$k] = $Extra[$k] }
  return $e
}

# Run a script block with the sandbox environment applied to THIS process, restoring it after.
function Invoke-WithSandboxEnv([hashtable]$Env, [scriptblock]$Body) {
  $saved = @{}
  foreach ($k in $Env.Keys) {
    $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process')
    [Environment]::SetEnvironmentVariable($k, $Env[$k], 'Process')
  }
  try { & $Body } finally {
    foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
  }
}

# Call the sandbox copy of oa-state.ps1 in the sandbox environment. Returns parsed JSON when the
# output is JSON, else the raw text. Throws on a non-zero exit.
function Invoke-SandboxState($L, [hashtable]$Env, [string[]]$Arguments, [switch]$Raw) {
  # In-process (a script invoked with & gets its own script scope and its `exit` ends only the
  # script): a fresh pwsh per call costs minutes on a loaded machine, and seeding makes ~15 calls.
  $script = Join-Path $L.SkillDir 'oa-state.ps1'
  # Array splatting binds every element positionally for a script, so convert `cmd -Name value
  # -Switch` into a hashtable first.
  $named = @{}; $positional = @()
  for ($i = 0; $i -lt $Arguments.Count; $i++) {
    $a = $Arguments[$i]
    if ($a -match '^-[A-Za-z]') {
      $name = $a.Substring(1)
      if ($i + 1 -lt $Arguments.Count -and $Arguments[$i + 1] -notmatch '^-[A-Za-z]') { $named[$name] = $Arguments[$i + 1]; $i++ }
      else { $named[$name] = $true }
    } else { $positional += $a }
  }
  $st = @{ code = 0 }
  $out = Invoke-WithSandboxEnv $Env {
    Push-Location $L.Root
    try {
      $global:LASTEXITCODE = 0
      & $script @positional @named *>&1
      $st.code = $global:LASTEXITCODE
    } catch { $st.code = 1; "$_" } finally { Pop-Location }
  }
  $text = ($out | ForEach-Object { "$_" }) -join "`n"
  if ($st.code -ne 0) { throw "oa-state $($Arguments -join ' ') failed ($($st.code)): $text" }
  if ($Raw) { return $text }
  try { return $text | ConvertFrom-Json -Depth 30 } catch { return $text }
}

# Export the source under test into <sandbox>\repo. -Ref is either a directory (a worktree,
# copied as-is including uncommitted changes) or a git ref (exported with git archive).
function Export-SourceUnderTest([string]$Ref, [string]$RepoRoot, [string]$Dest) {
  New-Item -ItemType Directory -Force -Path $Dest | Out-Null
  if ($Ref -and (Test-Path -LiteralPath $Ref -PathType Container)) {
    $src = (Resolve-Path -LiteralPath $Ref).Path
    $null = & robocopy $src $Dest /MIR /XD node_modules .git dist /XF *.log /NFL /NDL /NJH /NJS /NP
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE) exporting $src" }
    $sha = (& git -C $src rev-parse HEAD 2>$null)
    $dirty = [bool](& git -C $src status --porcelain 2>$null)
    return [pscustomobject]@{ kind = 'worktree'; ref = $src; sha = "$sha"; dirty = $dirty }
  }
  $sha = (& git -C $RepoRoot rev-parse --verify "$Ref^{commit}" 2>$null)
  if (-not $sha) { throw "not a directory and not a git ref: $Ref" }
  $tar = Join-Path ([IO.Path]::GetTempPath()) ("oa-e2e-src-" + [guid]::NewGuid().ToString('N') + '.tar')
  try {
    & git -C $RepoRoot archive --format=tar -o $tar $sha
    if ($LASTEXITCODE -ne 0) { throw "git archive failed for $Ref" }
    & tar -xf $tar -C $Dest
    if ($LASTEXITCODE -ne 0) { throw "tar extract failed for $Ref" }
  } finally { Remove-Item -LiteralPath $tar -Force -ErrorAction SilentlyContinue }
  return [pscustomobject]@{ kind = 'ref'; ref = $Ref; sha = "$sha"; dirty = $false }
}

# A content manifest of the sandbox's mutable data (never the exported source or copilot's own
# internals), used for the before/after diff.
function Get-DataManifest($L) {
  $roots = @($L.Planner, $L.OaHome, $L.Repos, $L.Tmp)
  $m = [ordered]@{}
  foreach ($r in $roots) {
    if (-not (Test-Path -LiteralPath $r)) { continue }
    foreach ($f in Get-ChildItem -LiteralPath $r -Recurse -File -Force -ErrorAction SilentlyContinue) {
      $rel = $f.FullName.Substring($L.Root.Length).TrimStart('\')
      $m[$rel] = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash
    }
  }
  return $m
}

function Compare-Manifest($Before, $After) {
  $added = @(); $modified = @(); $deleted = @()
  foreach ($k in $After.Keys) {
    if (-not $Before.Contains($k)) { $added += $k } elseif ($Before[$k] -ne $After[$k]) { $modified += $k }
  }
  foreach ($k in $Before.Keys) { if (-not $After.Contains($k)) { $deleted += $k } }
  [pscustomobject]@{ added = $added; modified = $modified; deleted = $deleted }
}

# Snapshot the text of every journal and state file, keyed by task id, for assertions.
function Get-TaskSnapshot($L) {
  $j = @{}; $s = @{}
  if (Test-Path -LiteralPath $L.Journal) {
    foreach ($f in Get-ChildItem -LiteralPath $L.Journal -Filter 'task-*.md' -File) {
      if ($f.BaseName -match '^task-(\d+)$') { $j[$Matches[1]] = Read-Utf8 $f.FullName }
    }
  }
  if (Test-Path -LiteralPath $L.StateDir) {
    foreach ($f in Get-ChildItem -LiteralPath $L.StateDir -Filter 'task-*.json' -File) {
      if ($f.BaseName -match '^task-(\d+)$') {
        try { $s[$Matches[1]] = (Read-Utf8 $f.FullName) | ConvertFrom-Json -Depth 30 } catch { $s[$Matches[1]] = $null }
      }
    }
  }
  [pscustomobject]@{ Journals = $j; States = $s }
}

function Stop-ProcessTree([int]$ProcessId) {
  # taskkill walks the tree itself; a CIM walk takes minutes on a loaded machine, during which the
  # children (the MCP stub) die first and the coordinator keeps running against a dead tool.
  $null = & taskkill.exe /PID $ProcessId /T /F 2>&1
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

# The coordinator's own clock: hard_end is the next local :00/:30 after start, minus one minute.
function Get-HardEnd([datetime]$Start) {
  $half = [datetime]::new($Start.Year, $Start.Month, $Start.Day, $Start.Hour, 0, 0)
  if ($Start.Minute -ge 30) { $half = $half.AddMinutes(30) }
  return $half.AddMinutes(30).AddMinutes(-1)
}
