<#
  build.ps1 — compile the native MCP credential launcher.

  Compiles src/mcp-cred-launch.cs into a single self-contained .exe using the
  in-box .NET Framework C# compiler (csc.exe). No .NET SDK required: .NET
  Framework 4.x ships in-box on Windows 10/11, so this recompiles from source on
  any machine.

  WHY A FIXED PATH: Copilot's mcp-config.json does NOT expand ${env}, so each
  server's `command` must be a literal absolute path that is identical on every
  machine. That path is C:\ProgramData\mcp-cred-vault\mcp-cred-launch.exe.
  Writing under ProgramData needs elevation, so this script self-elevates for
  that one step (unless -NoElevate is set or -OutDir points somewhere writable).

  USAGE
    build.ps1                       Compile to C:\ProgramData\mcp-cred-vault (self-elevating).
    build.ps1 -OutDir <dir>         Compile to a custom dir (e.g. a temp dir for a dry run).
    build.ps1 -NoElevate            Never self-elevate; fail if the target isn't writable.

  Prints the full path of the produced exe to stdout on success.
#>
[CmdletBinding()]
param(
  [string]$OutDir = 'C:\ProgramData\mcp-cred-vault',
  [string]$SourcePath,
  [switch]$NoElevate
)

$ErrorActionPreference = 'Stop'

function Write-Info([string]$msg) { Write-Host "[build] $msg" }

# Resolve the launcher source relative to this script if not provided.
if ([string]::IsNullOrWhiteSpace($SourcePath)) {
  $SourcePath = Join-Path $PSScriptRoot '..\src\mcp-cred-launch.cs'
}
$SourcePath = [System.IO.Path]::GetFullPath($SourcePath)
if (-not (Test-Path -LiteralPath $SourcePath)) {
  throw "launcher source not found: $SourcePath"
}

function Find-Csc {
  $candidates = @(
    "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
    "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
  )
  foreach ($c in $candidates) { if (Test-Path -LiteralPath $c) { return $c } }
  throw "in-box C# compiler (csc.exe) not found. Expected under $env:WINDIR\Microsoft.NET\Framework(64)\v4.0.30319."
}

function Test-Admin {
  $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object System.Security.Principal.WindowsPrincipal($id)
  return $p.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-DirWritable([string]$dir) {
  try {
    if (-not (Test-Path -LiteralPath $dir)) {
      New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
    $probe = Join-Path $dir ('.write-probe-' + [System.Guid]::NewGuid().ToString('N'))
    Set-Content -LiteralPath $probe -Value 'x' -ErrorAction Stop
    Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
    return $true
  } catch {
    return $false
  }
}

$OutDir = [System.IO.Path]::GetFullPath($OutDir)
$exePath = Join-Path $OutDir 'mcp-cred-launch.exe'

# If we can't write the target dir, self-elevate (unless suppressed).
if (-not (Test-DirWritable $OutDir)) {
  if ($NoElevate) {
    throw "output dir is not writable and -NoElevate was set: $OutDir. Re-run as Administrator or pass a writable -OutDir."
  }
  if (Test-Admin) {
    throw "output dir is not writable even though this process is elevated: $OutDir"
  }
  Write-Info "elevation required to write $OutDir; relaunching as Administrator..."
  $argList = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', "`"$PSCommandPath`"",
    '-OutDir', "`"$OutDir`"",
    '-SourcePath', "`"$SourcePath`""
  )
  $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -Verb RunAs -Wait -PassThru
  if ($proc.ExitCode -ne 0) {
    throw "elevated build failed with exit code $($proc.ExitCode)."
  }
  if (-not (Test-Path -LiteralPath $exePath)) {
    throw "elevated build reported success but exe is missing: $exePath"
  }
  Write-Info "built (elevated): $exePath"
  Write-Output $exePath
  return
}

$csc = Find-Csc
Write-Info "compiler: $csc"
Write-Info "source:   $SourcePath"
Write-Info "output:   $exePath"

& $csc /nologo /optimize+ ("/out:" + $exePath) $SourcePath
if ($LASTEXITCODE -ne 0) {
  throw "csc failed with exit code $LASTEXITCODE."
}
if (-not (Test-Path -LiteralPath $exePath)) {
  throw "csc reported success but exe is missing: $exePath"
}

Write-Info "built: $exePath"
Write-Output $exePath
