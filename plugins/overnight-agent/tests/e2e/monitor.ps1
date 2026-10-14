<#
.SYNOPSIS
  Watch a sandbox run live: the coordinator's tool calls as they happen, and every dispatch.

.DESCRIPTION
  A sandbox run uses an isolated COPILOT_HOME, so its session is NOT in your normal session store
  (the session_store_sql tool will not see it). Everything is on disk instead:
    <run>\sandbox\home\.copilot\session-state\<session id>\events.jsonl   live event stream
    <run>\sandbox\home\.copilot\session-store.db                          its own session store
    <run>\sandbox\sandbox-app\dispatch-log.jsonl                          every app-tool call
  This script tails the first two sources of truth and prints one line per tool call.

.EXAMPLE
  pwsh -File monitor.ps1 -RunDir $env:TEMP\oa-e2e\20261001-0102-candidate\attempt-1-all
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$RunDir,
  [int]$PollSeconds = 5,
  [switch]$Once
)
$ErrorActionPreference = 'Stop'
$home_ = Join-Path $RunDir 'sandbox\home\.copilot\session-state'
$log = Join-Path $RunDir 'sandbox\sandbox-app\dispatch-log.jsonl'
$seenEvents = 0; $seenDispatch = 0
while ($true) {
  $ev = Get-ChildItem -LiteralPath $home_ -Filter events.jsonl -Recurse -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($ev) {
    $lines = @(Get-Content -LiteralPath $ev.FullName -ErrorAction SilentlyContinue)
    for ($i = $seenEvents; $i -lt $lines.Count; $i++) {
      try { $e = $lines[$i] | ConvertFrom-Json -Depth 20 } catch { continue }
      $t = ([datetime]$e.timestamp).ToLocalTime().ToString('HH:mm:ss')
      switch ($e.type) {
        'tool.execution_start' {
          $a = $e.data.arguments
          $what = if ($a.PSObject.Properties['command']) { $a.command } elseif ($a.PSObject.Properties['path']) { $a.path } else { ($a | ConvertTo-Json -Compress -Depth 4) }
          $what = "$what" -replace '\s+', ' '
          Write-Host ("{0} > {1,-28} {2}" -f $t, $e.data.toolName, $what.Substring(0, [Math]::Min(150, $what.Length)))
        }
        'tool.execution_complete' { if ($e.data.success -eq $false) { Write-Host "$t   ! tool failed: $($e.data.error)" -ForegroundColor Yellow } }
        'assistant.message' { if ("$($e.data.content)".Trim()) { Write-Host "$t # $(("$($e.data.content)" -replace '\s+', ' ').Substring(0, [Math]::Min(200, "$($e.data.content)".Length)))" -ForegroundColor Cyan } }
        'session.shutdown' { Write-Host "$t == session shut down" -ForegroundColor Green }
      }
    }
    $seenEvents = $lines.Count
  }
  if (Test-Path -LiteralPath $log) {
    $d = @(Get-Content -LiteralPath $log)
    for ($i = $seenDispatch; $i -lt $d.Count; $i++) {
      $x = $d[$i] | ConvertFrom-Json -Depth 20
      $first = if ($x.args.PSObject.Properties['message']) { ("$($x.args.message)" -split "`n")[0] } else { '' }
      Write-Host ("{0} >> APP {1} {2} {3}" -f ([datetime]$x.at).ToLocalTime().ToString('HH:mm:ss'), $x.tool, $x.args.session_id, $first) -ForegroundColor Magenta
    }
    $seenDispatch = $d.Count
  }
  if ($Once) { break }
  if ($ev -and (Get-Content -LiteralPath $ev.FullName -Tail 3 | Select-String 'session.shutdown' -Quiet)) { break }
  Start-Sleep -Seconds $PollSeconds
}
