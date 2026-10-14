<#
  ps-fn-host.ps1 -- call oa-state.ps1's INTERNAL functions directly, for function-level
  differential tests of the Node port (tests/oa-state-port/fn-diff.mjs).

  It loads oa-state.ps1 the way the script itself runs -- the param block bound from -ParamsJson,
  every script-scope variable and function defined -- but stops before the command dispatch, so
  nothing is executed and no lock is taken. It then reads one JSON request per stdin line:
      { "fn": "Get-AgentEndIndex", "args": ["...journal text..."] }
  and writes one JSON line per request: { "ok": true, "value": <result> } or
  { "ok": false, "error": "<message>" }. A function's pipeline output is returned as PowerShell
  collects it: nothing -> null, one object -> that object, several -> an array.
  `{ "eval": "<script>" }` runs a script in the same scope (to set $script: state between calls).
#>
param(
  [Parameter(Mandatory)][string]$ScriptPath,
  [string]$ParamsJson = '{}'
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)

$text = [IO.File]::ReadAllText($ScriptPath)
$cut = $text.IndexOf("if ((`$CheckDispatch -or `$ForDispatch) -and `$Command -ne 'session')")
if ($cut -lt 0) { throw 'ps-fn-host: dispatch block not found in oa-state.ps1' }
$body = $text.Substring(0, $cut)
# $PSScriptRoot inside the loaded text must still name the skill folder (settings-value.ps1).
$body = $body.Replace('$PSScriptRoot', "'" + (Split-Path -Parent $ScriptPath).Replace("'", "''") + "'")
$fnHostParams = @{}
$pj = $ParamsJson | ConvertFrom-Json
foreach ($prop in $pj.PSObject.Properties) { $fnHostParams[$prop.Name] = $prop.Value }
. ([scriptblock]::Create($body)) @fnHostParams
Resolve-GateSettings
Resolve-PacingSettings

while ($null -ne ($fnHostLine = [Console]::In.ReadLine())) {
  if (-not $fnHostLine.Trim()) { continue }
  $fnHostReq = $fnHostLine | ConvertFrom-Json -NoEnumerate
  try {
    if ($fnHostReq.PSObject.Properties['eval']) {
      $fnHostR = . ([scriptblock]::Create($fnHostReq.eval))
    }
    else {
      $fnHostArgs = @()
      if ($fnHostReq.PSObject.Properties['args'] -and $null -ne $fnHostReq.args) { $fnHostArgs = @($fnHostReq.args) }
      $fnHostR = & $fnHostReq.fn @fnHostArgs
    }
    $fnHostOut = [ordered]@{ ok = $true; value = $fnHostR }
  }
  catch {
    $fnHostOut = [ordered]@{ ok = $false; error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $fnHostOut -Depth 40 -Compress))
  [Console]::Out.Flush()
}
