<#
  setup.ps1 — bootstrap the portable MCP credential vault on this machine.

  Idempotent. Safe to re-run. Steps:
    (a) Compile the native launcher to the fixed path
        C:\ProgramData\mcp-cred-vault\mcp-cred-launch.exe (self-elevating).
    (b) Verify node/npx and uv/uvx are on PATH; warn if missing.
    (c) Read the per-machine pointer file mcp-secrets.json (see README) to learn
        which credential targets / MCP servers to wire up. Falls back to
        interactive prompts if the pointer file is absent.
    (d) Back up and patch %USERPROFILE%\.copilot\mcp-config.json so each relevant
        server's `command` is the fixed exe path with args
        [target, envVar, realCommand, ...realArgs] and NO plaintext env secret.
        Validates the JSON after editing.
    (e) For any required credential target not yet in Credential Manager, prompt
        for the value and store it via secret-vault.ps1 (DPAPI-encrypted).

  USAGE
    setup.ps1                         Real run against the live config.
    setup.ps1 -DryRun                 Compile to a temp dir, patch a COPY of the
                                      config (…\mcp-config.dryrun.json), never
                                      prompt for or store secrets.
    setup.ps1 -ConfigPath <path>      Override the mcp-config.json to patch.
    setup.ps1 -PointerPath <path>     Override the pointer file location.
    setup.ps1 -ExePath <path>         Override the launcher path written into config.
    setup.ps1 -SkipBuild              Don't (re)compile the launcher.
    setup.ps1 -NoElevate              Never self-elevate the compile step.
#>
[CmdletBinding()]
param(
  [string]$ConfigPath = (Join-Path $env:USERPROFILE '.copilot\mcp-config.json'),
  [string]$PointerPath = (Join-Path $env:USERPROFILE 'OneDrive\Apps\Focus Planner\mcp-secrets.json'),
  [string]$ExePath = 'C:\ProgramData\mcp-cred-vault\mcp-cred-launch.exe',
  [switch]$DryRun,
  [switch]$SkipBuild,
  [switch]$NoElevate
)

$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1's ConvertFrom-Json throws on duplicate object keys,
# which some existing mcp-config.json files contain. PowerShell 7 (pwsh) keeps
# the last occurrence and parses cleanly. Prefer pwsh when we're on 5.x and it's
# installed, by re-launching this same script under it.
if ($PSVersionTable.PSVersion.Major -lt 6) {
  $pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
  if ($pwsh) {
    $fwd = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath)
    if ($PSBoundParameters.ContainsKey('ConfigPath')) { $fwd += @('-ConfigPath', $ConfigPath) }
    if ($PSBoundParameters.ContainsKey('PointerPath')) { $fwd += @('-PointerPath', $PointerPath) }
    if ($PSBoundParameters.ContainsKey('ExePath')) { $fwd += @('-ExePath', $ExePath) }
    if ($DryRun) { $fwd += '-DryRun' }
    if ($SkipBuild) { $fwd += '-SkipBuild' }
    if ($NoElevate) { $fwd += '-NoElevate' }
    & $pwsh.Source @fwd
    exit $LASTEXITCODE
  }
}

$scriptDir = $PSScriptRoot
$secretVault = Join-Path $scriptDir 'secret-vault.ps1'
$buildScript = Join-Path $scriptDir 'build.ps1'

function Info([string]$m) { Write-Host "[setup] $m" }
function Warn([string]$m) { Write-Warning $m }

# --- (a) Build the launcher -------------------------------------------------
if ($SkipBuild) {
  Info "skipping launcher build (-SkipBuild)."
} elseif ($DryRun) {
  $tmp = Join-Path $env:TEMP 'mcp-cred-vault-dryrun'
  Info "dry run: compiling launcher to temp dir $tmp (config will still reference $ExePath)."
  & $buildScript -OutDir $tmp -NoElevate | Out-Null
} else {
  Info "compiling launcher to $ExePath ..."
  $built = & $buildScript -OutDir (Split-Path -Parent $ExePath) -NoElevate:$NoElevate
  if ($built) { $ExePath = ($built | Select-Object -Last 1) }
}

# --- (b) Verify toolchain on PATH -------------------------------------------
foreach ($pair in @(@('node', 'npx'), @('uv', 'uvx'))) {
  $found = $false
  foreach ($cmd in $pair) {
    if (Get-Command $cmd -ErrorAction SilentlyContinue) { $found = $true }
  }
  if (-not $found) {
    Warn "neither '$($pair[0])' nor '$($pair[1])' found on PATH. MCP servers that rely on it will fail to launch until you install it."
  } else {
    Info "toolchain OK: $($pair -join '/') present."
  }
}

# --- (c) Load the pointer file ----------------------------------------------
function Read-Pointer([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  try {
    $obj = Get-Content -Raw -LiteralPath $path | ConvertFrom-Json
  } catch {
    throw "pointer file is not valid JSON ($path): $($_.Exception.Message)"
  }
  if ($null -eq $obj.secrets) { throw "pointer file $path is missing a 'secrets' array." }
  return $obj
}

$pointer = Read-Pointer $PointerPath
$entries = @()
if ($pointer) {
  Info "read pointer file: $PointerPath"
  $entries = @($pointer.secrets)
} else {
  Warn "pointer file not found at $PointerPath."
  if ($DryRun) {
    Info "dry run: nothing to patch without a pointer file. Exiting."
    return
  }
  Info "falling back to interactive entry. Describe each secret to wire up."
  do {
    $server = Read-Host 'MCP server key in mcp-config.json (blank to finish)'
    if ([string]::IsNullOrWhiteSpace($server)) { break }
    $target = Read-Host "  Credential target name (e.g. overnight-agent:$server-token)"
    $envVar = Read-Host '  Env var to inject the secret into (e.g. TELEGRAM_BOT_TOKEN)'
    $cmd    = Read-Host '  Real MCP command (e.g. uvx)'
    $argRaw = Read-Host '  Real MCP args, space-separated (e.g. better-telegram-mcp)'
    $argArr = @()
    if (-not [string]::IsNullOrWhiteSpace($argRaw)) { $argArr = $argRaw.Trim() -split '\s+' }
    $entries += [pscustomobject]@{ server = $server; target = $target; envVar = $envVar; command = $cmd; args = $argArr }
  } while ($true)
}

# Validate entries.
foreach ($e in $entries) {
  foreach ($k in 'server', 'target', 'envVar', 'command') {
    if ([string]::IsNullOrWhiteSpace($e.$k)) { throw "a pointer 'secrets' entry is missing required field '$k'." }
  }
}
if ($entries.Count -eq 0) { Info 'no secrets to wire up. Done.'; return }

# --- (d) Patch mcp-config.json ----------------------------------------------
if (-not (Test-Path -LiteralPath $ConfigPath)) {
  throw "mcp-config.json not found at $ConfigPath. Launch Copilot CLI once to create it, or pass -ConfigPath."
}

$targetConfigPath = $ConfigPath
if ($DryRun) {
  $targetConfigPath = [System.IO.Path]::ChangeExtension($ConfigPath, '.dryrun.json')
  Copy-Item -LiteralPath $ConfigPath -Destination $targetConfigPath -Force
  Info "dry run: patching a COPY at $targetConfigPath (live config untouched)."
}

try {
  $cfg = Get-Content -Raw -LiteralPath $targetConfigPath | ConvertFrom-Json
} catch {
  throw "mcp-config.json is not valid JSON ($targetConfigPath): $($_.Exception.Message). If this mentions duplicate keys, remove the duplicate server entry and re-run."
}
if ($null -eq $cfg.mcpServers) { throw "mcp-config.json has no 'mcpServers' object." }

# Back up the file we're about to edit (skip for dry-run copies).
if (-not $DryRun) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backup = "$ConfigPath.bak-$stamp"
  Copy-Item -LiteralPath $ConfigPath -Destination $backup -Force
  Info "backed up config to $backup"
}

foreach ($e in $entries) {
  $srv = $cfg.mcpServers.PSObject.Properties[$e.server]
  if (-not $srv) {
    Warn "server '$($e.server)' not present in mcp-config.json; skipping. Add the server first, then re-run."
    continue
  }
  $node = $srv.Value
  $argList = @($e.target, $e.envVar, $e.command)
  if ($e.args) { $argList += @($e.args) }

  # Ensure stdio server shape and the launcher command/args.
  if ($node.PSObject.Properties['type']) { $node.type = 'stdio' }
  else { $node | Add-Member -NotePropertyName type -NotePropertyValue 'stdio' -Force }

  if ($node.PSObject.Properties['command']) { $node.command = $ExePath }
  else { $node | Add-Member -NotePropertyName command -NotePropertyValue $ExePath -Force }

  if ($node.PSObject.Properties['args']) { $node.args = $argList }
  else { $node | Add-Member -NotePropertyName args -NotePropertyValue $argList -Force }

  # Remove any plaintext env secret block.
  if ($node.PSObject.Properties['env']) {
    $node.PSObject.Properties.Remove('env')
    Info "removed plaintext 'env' block from server '$($e.server)'."
  }
  Info "wired server '$($e.server)' -> launcher [$($e.target), $($e.envVar), $($e.command)$(if($e.args){', '+($e.args -join ', ')})]."
}

# Serialize, validate, then write.
$json = $cfg | ConvertTo-Json -Depth 100
try { $null = $json | ConvertFrom-Json } catch { throw "patched config failed JSON validation: $($_.Exception.Message)" }
Set-Content -LiteralPath $targetConfigPath -Value $json -Encoding UTF8
Info "wrote patched config: $targetConfigPath"

# --- (e) Store any missing secrets ------------------------------------------
foreach ($e in $entries) {
  $status = & $secretVault test -Target $e.target
  $missing = ($status -match 'no secret stored')
  if (-not $missing) {
    Info "secret already present for '$($e.target)'."
    continue
  }
  if ($DryRun) {
    Info "dry run: would prompt for and store a secret for '$($e.target)'."
    continue
  }
  Info "no secret stored for '$($e.target)'."
  $secure = Read-Host "  Paste the secret value for '$($e.target)'" -AsSecureString
  $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
  if ([string]::IsNullOrWhiteSpace($plain)) { Warn "empty value; skipped storing '$($e.target)'."; continue }
  & $secretVault set -Target $e.target -Token $plain | Out-Null
  $plain = $null
  Info "stored secret for '$($e.target)' in Credential Manager."
}

Info 'done.'
if ($DryRun) { Info "review the dry-run config at $targetConfigPath" }
else { Info 'restart Copilot CLI to pick up the patched MCP config.' }
