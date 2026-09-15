<#
.SYNOPSIS
  Resident OS-dispatched supervisor loop, used by Task Scheduler and Startup.
.DESCRIPTION
  The tick supplies nextCheckUtc, including the preventive deadline. Short UTC-aware
  waits notice sleep/resume without sleeping a fixed polling interval across B.
  Child failures are logged and retried with bounded backoff in BOTH dispatch modes.
  Task Scheduler can additionally restart a crashed daemon; Startup cannot do that.
.PARAMETER IntervalMinutes
  Compatibility parameter for old Startup shims. Does not control tick scheduling.
#>
[CmdletBinding()]
param(
  [int]$IntervalMinutes = 15,
  [switch]$Once,
  [switch]$NoAct,
  [string]$OaHome = (Join-Path $env:LOCALAPPDATA 'overnight-agent')
)

$ErrorActionPreference = 'Stop'
$supervisor = Join-Path $OaHome 'oa-supervisor.ps1'
$lockPath = Join-Path $OaHome 'supervisor-daemon.lock'
$beatPath = Join-Path $OaHome 'supervisor-daemon-heartbeat.json'
$stopPath = Join-Path $OaHome 'supervisor-daemon.stop'
$errorPath = Join-Path $OaHome 'supervisor-daemon-errors.jsonl'
$psExe = (Get-Process -Id $PID -ErrorAction Stop).Path
$jsonOptions = @{}
# PowerShell 7.5+ otherwise converts timestamps to local DateTime objects, losing
# the original offset when cast back to strings for the UTC deadline parser.
if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) {
  $jsonOptions.DateKind = 'String'
}
New-Item -ItemType Directory -Path $OaHome -Force | Out-Null

function Get-DaemonRetrySettings {
  $settings = @{ retryInitialSeconds = 60.0; retryMaxSeconds = 900.0 }
  try {
    foreach ($name in @('supervisor-defaults.json', 'supervisor-config.json')) {
      $file = Join-Path $OaHome $name
      if (-not (Test-Path -LiteralPath $file)) { continue }
      $config = Get-Content -LiteralPath $file -Raw -Encoding utf8 | ConvertFrom-Json
      foreach ($key in @('retryInitialSeconds', 'retryMaxSeconds')) {
        if ($config.PSObject.Properties.Name -contains $key) { $settings[$key] = [double]$config.$key }
      }
    }
    foreach ($value in $settings.Values) {
      if ($value -le 0 -or [double]::IsNaN($value) -or [double]::IsInfinity($value)) { throw 'Retry durations must be finite and positive.' }
    }
    if ($settings.retryInitialSeconds -gt $settings.retryMaxSeconds) { throw 'Retry bounds are reversed.' }
  } catch {
    Write-Warning "[oa-daemon] invalid retry settings; using 60/900 seconds: $_"
    $settings = @{ retryInitialSeconds = 60.0; retryMaxSeconds = 900.0 }
  }
  return $settings
}

# The open handle, not a recorded PID, owns the singleton. Crashes release it and
# PID reuse cannot prevent recovery. Never unlink a lock another process may own.
try {
  $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate,
    [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
} catch [IO.IOException] {
  if (($_.Exception.HResult -band 0xffff) -notin @(32,33)) { throw }
  Write-Host '[oa-daemon] another daemon holds the exclusive lock.'
  exit 0
}

try {
  $identity = @{ pid = $PID; startedUtc = [DateTimeOffset]::UtcNow.ToString('o') }
  $bytes = [Text.Encoding]::UTF8.GetBytes(($identity | ConvertTo-Json -Compress))
  $lock.SetLength(0)
  $lock.Write($bytes, 0, $bytes.Length)
  $lock.Flush()
  $failures = 0
  do {
    if (Test-Path -LiteralPath $stopPath) { break }
    $lastError = $null
    try {
      if (-not (Test-Path -LiteralPath $supervisor)) { throw "Supervisor missing: $supervisor" }
      $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', $supervisor, '-OaHome', $OaHome)
      if ($NoAct) { $arguments += '-NoAct' }
      $out = & $psExe @arguments 2>&1 | Out-String
      # The real tick returns 1 for a successfully performed action, not an error.
      if ($LASTEXITCODE -notin @(0,1)) { throw "Supervisor exited ${LASTEXITCODE}: $out" }
      $line = $out -split "`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1
      if (-not $line) { throw "Supervisor returned no tick JSON: $out" }
      $tick = $line | ConvertFrom-Json @jsonOptions
      $next = [DateTimeOffset]::MinValue
      if (-not [DateTimeOffset]::TryParse([string]$tick.nextCheckUtc,
          [Globalization.CultureInfo]::InvariantCulture,
          [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$next)) {
        throw 'Supervisor returned no valid nextCheckUtc.'
      }
      $failures = 0
    } catch {
      $lastError = "$_"
      $failures = [Math]::Min(31, $failures + 1)
      $retry = Get-DaemonRetrySettings
      $retrySeconds = [Math]::Min($retry.retryMaxSeconds,
        $retry.retryInitialSeconds * [Math]::Pow(2, $failures - 1))
      $next = [DateTimeOffset]::UtcNow.AddSeconds($retrySeconds)
      $tick = @{ state = 'DAEMON-ERROR' }
      Write-Warning "[oa-daemon] $lastError Retrying at $($next.ToString('o'))."
      try {
        @{ event = 'daemon-error'; utc = [DateTimeOffset]::UtcNow.ToString('o')
           error = $lastError; consecutiveFailures = $failures; retrySeconds = $retrySeconds
           nextCheckUtc = $next.ToString('o') } |
          ConvertTo-Json -Compress | Add-Content -LiteralPath $errorPath -Encoding utf8
      } catch { Write-Warning "[oa-daemon] cannot persist error: $_" }
    }
    try {
      @{ pid = $PID; startedUtc = $identity.startedUtc
         lastCheckUtc = [DateTimeOffset]::UtcNow.ToString('o')
         lastState = $tick.state; nextCheckUtc = $next.ToUniversalTime().ToString('o')
         intervalMinutes = $IntervalMinutes; noAct = [bool]$NoAct
         lastError = $lastError; consecutiveFailures = $failures } |
        ConvertTo-Json | Set-Content -LiteralPath $beatPath -Encoding utf8
    } catch { Write-Warning "[oa-daemon] cannot persist heartbeat: $_" }
    if ($Once) { break }

    # Recompute against UTC after every short sleep, including the first after resume.
    do {
      if (Test-Path -LiteralPath $stopPath) { break }
      $remaining = ($next - [DateTimeOffset]::UtcNow).TotalMilliseconds
      if ($remaining -le 0) { break }
      Start-Sleep -Milliseconds ([int][Math]::Max(1, [Math]::Min(1000, $remaining)))
    } while ($true)
  } while ($true)
} finally {
  $lock.Dispose()
}
