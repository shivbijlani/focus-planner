<#
  check-agent-inbox.ps1 -- read the agent inbox in a way that can FAIL, so that
  "no new instructions" is a measurement rather than a default.

  WHY THIS EXISTS (GH #346)
  -------------------------
  PHASE 0 mandates an inbox check every run. The check was a bare search:

      email_search { unreadOnly: true, folder: 'INBOX' }   ->   []

  An empty array is a factual claim about a mailbox, and an unhealthy client is not
  entitled to make it. When the email MCP is missing, wedged, or disconnected, that
  same call returns the same `[]`, so a run that COULD NOT LOOK reports exactly what
  a run that looked and found nothing reports. Emailed instructions are then dropped
  silently, and the wrap-up says the inbox was clear.

  MEASURED, NOT THEORISED (2026-09-02 ~12:52 PT, live)
    1. email_list_accounts   -> the Overnight Agent account with "connected": false
    2. email_search unread   -> []
    3. email_test_account    -> {"success":true,"folderCount":10}

  Read (1) and (2) together and the obvious conclusion -- "the client is down, the
  empty result is meaningless" -- is WRONG: (3) proves the server was reachable the
  whole time. Read (2) alone and the conclusion "the inbox is empty" is unsupported.
  The only call that settled it is the one PHASE 0 never asked for. Hence this file.

  THE RULE
  --------
  Emptiness may only be reported after a POSITIVE health probe. `unread` is NULL --
  never 0 -- whenever the probe did not pass. An empty list must not be able to mean
  two things.

  Note which signal is authoritative: `success` from email_test_account, NOT
  `connected` from email_list_accounts. Observation (1) vs (3) above is a live
  disagreement between the advertised flag and reality, and the advertised flag lost.
  A verdict is taken from a call that does work, never from a field that claims it.

  GUARDS (each must be load-bearing; see mutcheck-inbox-check.ps1)
    G1 the health gate. A COUNT is a claim about the mailbox, and only a client that has
       just proved it can do work may make one. The probe and the search run in the SAME
       MCP session, health first, because a probe on a different connection says nothing
       about the connection that answered the search. An unhealthy session's [] is
       discarded even though it was already fetched. Disabling this restores the exact
       #346 defect: probe fails, search says [], run says "inbox clear".
    G2 every call is bounded, and the child is killed at the budget. A check that can hang
       the run is a worse failure than the one it replaces (#346 criterion 4, #261 no
       run-level timeout). The prober's own budget is set BELOW this one so it gives up
       first and kills its MCP child on the way out -- a timeout that orphans a server
       would manufacture the process pile-up that starves the next run's handshake, which
       is #346's own root cause.
    G3 `unread` is null on an unreadable inbox. Reporting 0 there re-creates the
       ambiguity one layer up, in this script's own output.
    G4 ONE verdict, resolved BEFORE the output-format branch, and ONE exit that reads
       it. This is #347's rule: identical data must not yield opposite answers
       depending on how the caller asked.
    G5 an unexpected error is an unreadable inbox, not a crash. Fail closed: the
       expensive direction is silently deciding the mailbox was empty.

  The capability list is NOT in this file. It is declared once in
  run-capabilities.json (#346 criterion 2); a list embedded here would be the same
  prose-in-a-different-font that let the gap exist.

  Usage:
    check-agent-inbox.ps1                 # human table + the wrap-up sentence
    check-agent-inbox.ps1 -Json           # same verdict, machine readable
    check-agent-inbox.ps1 -Capability email
    check-agent-inbox.ps1 -TimeoutSec 20

  Exit codes:
    0  every mandatory capability is healthy; the inbox was genuinely read.
    2  at least one mandatory capability could not be confirmed. SURFACE AS AN ASK.
    1  usage error (bad arguments only). Never used for "the inbox looked empty".
#>
[CmdletBinding()]
param(
  [switch]$Json,
  [string]$Manifest,
  [string]$Capability,
  [string]$Account,
  [int]$TimeoutSec = 45,
  [string]$ProberCommand = 'node',
  [string]$ProberScript
)

Set-StrictMode -Off
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# ---------------------------------------------------------------- resolution
# Resolved by SEARCH, never assumed to be a sibling. This script is deployed into the
# flat OA home (%LOCALAPPDATA%\overnight-agent) as well as the plugin tree, and
# assuming a sibling is what made PR #303 green and still broken (#305).
function Resolve-First {
  param([string[]]$Candidates)
  foreach ($c in $Candidates) {
    if ($c -and (Test-Path -LiteralPath $c)) { return (Resolve-Path -LiteralPath $c).Path }
  }
  return $null
}

# Join-Path throws on a null base, and $env:LOCALAPPDATA is null everywhere that is not
# Windows -- including the Linux runner this file's mutation check runs on.
function Join-IfSet {
  param([string]$Base, [string]$Child)
  if (-not $Base) { return $null }
  return (Join-Path $Base $Child)
}

$manifestPath = Resolve-First @(
  $Manifest,
  (Join-Path $here 'run-capabilities.json'),
  (Join-Path $here '..\..\skills\overnight-agent\run-capabilities.json'),
  (Join-IfSet $env:LOCALAPPDATA 'overnight-agent\run-capabilities.json')
)

$proberPath = Resolve-First @(
  $ProberScript,
  (Join-Path $here 'mcp-probe.mjs'),
  (Join-Path $here '..\..\checks\mcp-probe.mjs'),
  (Join-IfSet $env:LOCALAPPDATA 'overnight-agent\mcp-probe.mjs')
)

$BudgetMs = [Math]::Max(1000, $TimeoutSec * 1000)

# ---------------------------------------------------------------- bounded child
function ConvertTo-QuotedArg {
  param([string]$Value)
  if ($null -eq $Value) { return '""' }
  $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
  $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
  return '"' + $escaped + '"'
}

function Stop-Bounded {
  param($Process)
  # 1. PowerShell 7 / .NET Core: kills the whole tree in one call, with no process spawn.
  try { $Process.Kill($true); return } catch { }
  # 2. Windows PowerShell 5.1 -- which is what the skill actually invokes -- has no tree
  #    overload, and every workaround costs a process spawn or a WMI query. Both were tried
  #    and both are pathological under load: a WMI descendant walk measured 10+ seconds and
  #    `taskkill /T /F /PID` measured 41 seconds on a busy box. Cleanup that outlasts the
  #    budget it is enforcing is not cleanup. So the grandchild is handled a layer DOWN
  #    instead: MCP_PROBE_TIMEOUT_MS is set BELOW this budget, so in the normal case the
  #    prober times out first and kills its own MCP child on the way out. This kill is the
  #    last resort for a prober that is itself wedged, and it is immediate.
  #    A grandchild that still survives that is exactly what reap-stale-mcp.ps1 collects.
  try { $Process.Kill() } catch { }
}

function Invoke-Bounded {
  param([string]$FilePath, [string[]]$ArgumentList, [int]$Budget)

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $FilePath
  $psi.Arguments = (($ArgumentList | ForEach-Object { ConvertTo-QuotedArg $_ }) -join ' ')
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  # Tell the prober to give up BEFORE this budget expires, not at the same moment. The
  # prober kills its own MCP child on the way out, so letting it finish first is what keeps
  # a timeout from orphaning a server -- and an orphaned MCP server is #346's own root
  # cause. The outer budget below is then a genuine last resort rather than the normal path.
  $psi.EnvironmentVariables['MCP_PROBE_TIMEOUT_MS'] = [string]([Math]::Max(1000, $Budget - 3000))

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $proc = [System.Diagnostics.Process]::Start($psi)
  } catch {
    return [pscustomobject]@{
      Started = $false; TimedOut = $false; ExitCode = -1
      StdOut = ''; StdErr = $_.Exception.Message; ElapsedMs = $sw.ElapsedMilliseconds
    }
  }

  $outTask = $proc.StandardOutput.ReadToEndAsync()
  $errTask = $proc.StandardError.ReadToEndAsync()

  # G2 -- THE BUDGET. WaitForExit(ms) returns false when the child outlived it, and the
  # child TREE is killed rather than waited on. Without the kill this becomes an unbounded
  # wait on a hung MCP server, which is the one failure worse than the one being fixed.
  $timedOut = $false
  if (-not $proc.WaitForExit($Budget)) {
    $timedOut = $true
    Stop-Bounded $proc
  }

  # WaitForExit(ms) does NOT flush the async readers -- only the parameterless overload
  # does, and that one cannot be bounded. So wait on the READERS explicitly, with their own
  # budget, and treat an unflushed reader as a failed read.
  #
  # This is not defensive padding. Measured while writing this file: a 2-step session
  # returned 292 of ~450 bytes, and PowerShell 5.1's ConvertFrom-Json parsed the TRUNCATED
  # array without complaint -- yielding 1 result for 2 steps. A short read that still parses
  # is the same defect class as an empty search that still parses: partial data wearing the
  # costume of a complete answer.
  $flushed = $false
  # On a timeout the output is discarded anyway, so do not spend the full flush budget
  # proving that a killed child said nothing.
  $flushBudget = 15000
  if ($timedOut) { $flushBudget = 2000 }
  try {
    $flushed = [System.Threading.Tasks.Task]::WaitAll([System.Threading.Tasks.Task[]]@($outTask, $errTask), $flushBudget)
  } catch { $flushed = $false }

  $stdout = ''
  $stderr = ''
  if ($flushed) {
    try { $stdout = $outTask.Result } catch { }
    try { $stderr = $errTask.Result } catch { }
  }

  $code = -1
  try { if ($proc.HasExited) { $code = $proc.ExitCode } } catch { }

  return [pscustomobject]@{
    Started = $true; TimedOut = $timedOut; Flushed = $flushed; ExitCode = $code
    StdOut = $stdout; StdErr = $stderr; ElapsedMs = $sw.ElapsedMilliseconds
  }
}

# ---------------------------------------------------------------- MCP session
function ConvertFrom-JsonArray {
  param([string]$Text)
  # PowerShell 5.1's ConvertFrom-Json emits a JSON array as ONE object instead of
  # enumerating it, so `@($text | ConvertFrom-Json)` yields a single element that happens
  # to BE the array -- and a length check against it silently reads 1 for any input.
  # PowerShell 7 enumerates. Enumerate explicitly so the count means the same thing on
  # both hosts; this script runs under 5.1 in production and 7 in CI.
  $parsed = ConvertFrom-Json -InputObject $Text
  $out = @()
  foreach ($item in $parsed) { $out += $item }
  return , $out
}

function Read-StepResult {
  param($Entry, [string]$Tool)
  if ($null -eq $Entry) {
    return [pscustomobject]@{ Ok = $false; Reason = 'unparsable'; Detail = "$Tool returned no step result"; Payload = $null }
  }
  if ($Entry.PSObject.Properties.Name -contains 'error' -and $Entry.error) {
    return [pscustomobject]@{ Ok = $false; Reason = 'mcp-error'; Detail = "${Tool}: $($Entry.error | ConvertTo-Json -Compress -Depth 4)"; Payload = $null }
  }
  $res = $Entry.result
  if ($null -eq $res) {
    return [pscustomobject]@{ Ok = $false; Reason = 'unparsable'; Detail = "$Tool returned no result"; Payload = $null }
  }
  if ($res.PSObject.Properties.Name -contains 'isError' -and $res.isError) {
    return [pscustomobject]@{ Ok = $false; Reason = 'tool-error'; Detail = "$Tool reported isError"; Payload = $null }
  }

  # MCP wraps a tool result as { content: [ { type: 'text', text: '<json>' } ] }.
  $text = $null
  if ($res.PSObject.Properties.Name -contains 'content') {
    $first = @($res.content) | Select-Object -First 1
    if ($first -and ($first.PSObject.Properties.Name -contains 'text')) { $text = $first.text }
  }
  if ($null -eq $text) {
    return [pscustomobject]@{ Ok = $true; Reason = ''; Detail = ''; Payload = $res }
  }
  $payload = $null
  try { $payload = $text | ConvertFrom-Json } catch { $payload = $text }
  return [pscustomobject]@{ Ok = $true; Reason = ''; Detail = ''; Payload = $payload }
}

function Invoke-McpSession {
  param([string]$Server, [array]$Steps)

  $names = @($Steps | ForEach-Object { [string]$_.name })
  $label = ($names -join '+')

  if (-not $proberPath) {
    return [pscustomobject]@{ Ok = $false; Reason = 'prober-missing'; Detail = 'mcp-probe.mjs not found'; Steps = @() }
  }

  $stepJson = ConvertTo-Json -InputObject @($Steps) -Compress -Depth 6
  # PowerShell 5.1 unwraps a one-element array on the way into ConvertTo-Json; 7.x does not.
  # Test the output rather than the host version, so this cannot drift with the shell.
  if (-not $stepJson.TrimStart().StartsWith('[')) { $stepJson = '[' + $stepJson + ']' }
  $run = Invoke-Bounded -FilePath $ProberCommand -ArgumentList @($proberPath, $Server, 'calls', $stepJson) -Budget $BudgetMs

  if ($run.TimedOut) {
    return [pscustomobject]@{ Ok = $false; Reason = 'timeout'; Detail = "$label exceeded ${BudgetMs}ms and was killed"; Steps = @() }
  }
  if (-not $run.Started) {
    return [pscustomobject]@{ Ok = $false; Reason = 'mcp-unavailable'; Detail = "could not launch '$ProberCommand': $($run.StdErr)"; Steps = @() }
  }
  if (-not $run.Flushed) {
    return [pscustomobject]@{ Ok = $false; Reason = 'read-incomplete'; Detail = "$label produced output that could not be read in full"; Steps = @() }
  }
  if ($run.ExitCode -ne 0) {
    $d = ($run.StdErr + ' ' + $run.StdOut).Trim()
    if ($d.Length -gt 300) { $d = $d.Substring(0, 300) }
    return [pscustomobject]@{ Ok = $false; Reason = 'mcp-unavailable'; Detail = "$label exit $($run.ExitCode): $d"; Steps = @() }
  }

  $entries = $null
  try { $entries = ConvertFrom-JsonArray $run.StdOut } catch {
    return [pscustomobject]@{ Ok = $false; Reason = 'unparsable'; Detail = "$label did not return JSON"; Steps = @() }
  }
  if (@($entries).Count -ne $Steps.Count) {
    # A short array would renumber the steps after the missing one, so one call's answer
    # could be read as another's. Refuse rather than realign.
    return [pscustomobject]@{ Ok = $false; Reason = 'step-count-mismatch'; Detail = "$label returned $(@($entries).Count) result(s) for $($Steps.Count) step(s)"; Steps = @() }
  }

  $parsed = @()
  for ($i = 0; $i -lt $Steps.Count; $i++) {
    $parsed += (Read-StepResult -Entry (@($entries)[$i]) -Tool $names[$i])
  }
  return [pscustomobject]@{ Ok = $true; Reason = ''; Detail = ''; Steps = @($parsed) }
}

# ---------------------------------------------------------------- row builders
function New-Row {
  param(
    [string]$Id, [string]$Server, [bool]$Mandatory, [string]$Kind,
    [string]$Verdict, [string]$Reason, [string]$Detail, $Unread, [int]$ElapsedMs
  )
  return [pscustomobject]@{
    id = $Id; server = $Server; mandatory = $Mandatory; kind = $Kind
    verdict = $Verdict; reason = $Reason; detail = $Detail
    unread = $Unread; elapsedMs = $ElapsedMs
  }
}

function New-UnreadableRow {
  param([string]$Id, [string]$Server, [bool]$Mandatory, [string]$Reason, [string]$Detail, [int]$ElapsedMs)
  # G3 -- `unread` is NULL here, not 0. Reporting 0 for an inbox nobody could read
  # rebuilds the exact ambiguity this file exists to remove, one layer up.
  return New-Row -Id $Id -Server $Server -Mandatory $Mandatory -Kind 'email-inbox' `
    -Verdict 'unreadable' -Reason $Reason -Detail $Detail -Unread $null -ElapsedMs $ElapsedMs
}

# ---------------------------------------------------------------- probes
function Test-EmailInbox {
  param($Cap)

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $server = [string]$Cap.server
  $mandatory = [bool]$Cap.mandatory
  $p = $Cap.probe

  $listSession = Invoke-McpSession -Server $server -Steps @(@{ name = [string]$p.listTool; arguments = @{} })
  if (-not $listSession.Ok) {
    return New-UnreadableRow -Id $Cap.id -Server $server -Mandatory $mandatory `
      -Reason $listSession.Reason -Detail $listSession.Detail -ElapsedMs $sw.ElapsedMilliseconds
  }
  $listed = @($listSession.Steps)[0]
  if (-not $listed.Ok) {
    return New-UnreadableRow -Id $Cap.id -Server $server -Mandatory $mandatory `
      -Reason $listed.Reason -Detail $listed.Detail -ElapsedMs $sw.ElapsedMilliseconds
  }

  $accounts = @($listed.Payload)
  if ($accounts.Count -eq 0) {
    return New-UnreadableRow -Id $Cap.id -Server $server -Mandatory $mandatory `
      -Reason 'no-account' -Detail 'the email MCP reports no configured accounts' -ElapsedMs $sw.ElapsedMilliseconds
  }

  $selector = $Account
  if (-not $selector) { $selector = [string]$Cap.accountSelector }
  $chosen = $null
  if ($selector) {
    $chosen = @($accounts | Where-Object {
      ($_.email -and $_.email.ToString().ToLowerInvariant() -eq $selector.ToLowerInvariant()) -or
      ($_.name -and $_.name.ToString().ToLowerInvariant() -eq $selector.ToLowerInvariant()) -or
      ($_.id -and $_.id.ToString() -eq $selector)
    }) | Select-Object -First 1
    if (-not $chosen) {
      return New-UnreadableRow -Id $Cap.id -Server $server -Mandatory $mandatory `
        -Reason 'no-account' -Detail "no account matches '$selector'" -ElapsedMs $sw.ElapsedMilliseconds
    }
  } elseif ($accounts.Count -eq 1) {
    $chosen = $accounts[0]
  } else {
    # Ambiguity is not emptiness. Guessing which mailbox to read would make the
    # answer depend on account ordering, so this fails closed and names the fix.
    return New-UnreadableRow -Id $Cap.id -Server $server -Mandatory $mandatory `
      -Reason 'ambiguous-account' -Detail "$($accounts.Count) accounts configured; set accountSelector in run-capabilities.json or pass -Account" -ElapsedMs $sw.ElapsedMilliseconds
  }

  $accountId = [string]$chosen.id

  # The POSITIVE health probe and the search run in ONE session, health first. This is
  # the call PHASE 0 never made, and running it in the same session is what makes it
  # evidence: a probe on a different connection says nothing about the connection that
  # actually answered the search.
  $searchArgs = @{ accountId = $accountId; unreadOnly = $true }
  if ($p.folder) { $searchArgs['folder'] = [string]$p.folder }
  if ($p.limit) { $searchArgs['limit'] = [int]$p.limit }

  $session = Invoke-McpSession -Server $server -Steps @(
    @{ name = [string]$p.healthTool; arguments = @{ accountId = $accountId } },
    @{ name = [string]$p.searchTool; arguments = $searchArgs }
  )
  if (-not $session.Ok) {
    return New-UnreadableRow -Id $Cap.id -Server $server -Mandatory $mandatory `
      -Reason $session.Reason -Detail $session.Detail -ElapsedMs $sw.ElapsedMilliseconds
  }

  $health = @($session.Steps)[0]
  $search = @($session.Steps)[1]

  $healthField = [string]$p.healthField
  if (-not $healthField) { $healthField = 'success' }
  $healthy = $false
  if ($health.Ok -and $health.Payload) {
    $healthy = ($health.Payload.PSObject.Properties.Name -contains $healthField) -and ([bool]$health.Payload.$healthField)
  }

  # G1 -- THE HEALTH GATE. Below this line a COUNT may be produced, and a count is a
  # claim about the mailbox. Only a client that has just proved it can do work is allowed
  # to make one. Note the search has ALREADY run at this point and its answer is discarded
  # regardless: an unhealthy client's [] is not evidence of anything. Removing this gate
  # restores #346 exactly -- the search still answers [], and [] still reads as
  # "no new instructions".
  if (-not $healthy) {
    $reason = if ($health.Ok) { 'probe-failed' } else { $health.Reason }
    $detail = if ($health.Ok) { "$($p.healthTool) did not report $healthField=true" } else { $health.Detail }
    return New-UnreadableRow -Id $Cap.id -Server $server -Mandatory $mandatory `
      -Reason $reason -Detail $detail -ElapsedMs $sw.ElapsedMilliseconds
  }

  if (-not $search.Ok) {
    return New-UnreadableRow -Id $Cap.id -Server $server -Mandatory $mandatory `
      -Reason $search.Reason -Detail $search.Detail -ElapsedMs $sw.ElapsedMilliseconds
  }

  $messages = @()
  if ($null -ne $search.Payload) {
    if ($search.Payload -is [array]) { $messages = @($search.Payload) }
    elseif ($search.Payload.PSObject.Properties.Name -contains 'messages') { $messages = @($search.Payload.messages) }
    elseif ($search.Payload.PSObject.Properties.Name -contains 'results') { $messages = @($search.Payload.results) }
    else { $messages = @($search.Payload) }
  }
  $messages = @($messages | Where-Object { $null -ne $_ })

  return New-Row -Id $Cap.id -Server $server -Mandatory $mandatory -Kind 'email-inbox' `
    -Verdict 'checked' -Reason '' -Detail "$($p.healthTool) reported $healthField=true for $accountId in the same session as the search" `
    -Unread $messages.Count -ElapsedMs $sw.ElapsedMilliseconds
}

function Test-McpTools {
  param($Cap)
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $server = [string]$Cap.server
  $mandatory = [bool]$Cap.mandatory
  $required = @($Cap.probe.requiredTools)

  if (-not $proberPath) {
    return New-Row -Id $Cap.id -Server $server -Mandatory $mandatory -Kind 'mcp-tools' `
      -Verdict 'unavailable' -Reason 'prober-missing' -Detail 'mcp-probe.mjs not found' -Unread $null -ElapsedMs $sw.ElapsedMilliseconds
  }

  $run = Invoke-Bounded -FilePath $ProberCommand -ArgumentList @($proberPath, $server, 'list') -Budget $BudgetMs
  if ($run.TimedOut) {
    return New-Row -Id $Cap.id -Server $server -Mandatory $mandatory -Kind 'mcp-tools' `
      -Verdict 'unavailable' -Reason 'timeout' -Detail "tools/list exceeded ${BudgetMs}ms and was killed" -Unread $null -ElapsedMs $sw.ElapsedMilliseconds
  }
  if (-not $run.Started -or $run.ExitCode -ne 0) {
    $d = ($run.StdErr + ' ' + $run.StdOut).Trim()
    if ($d.Length -gt 300) { $d = $d.Substring(0, 300) }
    return New-Row -Id $Cap.id -Server $server -Mandatory $mandatory -Kind 'mcp-tools' `
      -Verdict 'unavailable' -Reason 'mcp-unavailable' -Detail $d -Unread $null -ElapsedMs $sw.ElapsedMilliseconds
  }

  $tools = @()
  try { $tools = ConvertFrom-JsonArray $run.StdOut } catch {
    return New-Row -Id $Cap.id -Server $server -Mandatory $mandatory -Kind 'mcp-tools' `
      -Verdict 'unavailable' -Reason 'unparsable' -Detail 'tools/list did not return JSON' -Unread $null -ElapsedMs $sw.ElapsedMilliseconds
  }

  $missing = @($required | Where-Object { $_ -and ($tools -notcontains $_) })
  if ($missing.Count -gt 0) {
    return New-Row -Id $Cap.id -Server $server -Mandatory $mandatory -Kind 'mcp-tools' `
      -Verdict 'unavailable' -Reason 'missing-tools' -Detail ("missing: " + ($missing -join ', ')) -Unread $null -ElapsedMs $sw.ElapsedMilliseconds
  }

  return New-Row -Id $Cap.id -Server $server -Mandatory $mandatory -Kind 'mcp-tools' `
    -Verdict 'available' -Reason '' -Detail "$($required.Count)/$($required.Count) required tools present" -Unread $null -ElapsedMs $sw.ElapsedMilliseconds
}

function Test-Delegated {
  param($Cap)
  return New-Row -Id $Cap.id -Server ([string]$Cap.server) -Mandatory ([bool]$Cap.mandatory) -Kind 'delegated' `
    -Verdict 'delegated' -Reason '' -Detail "owned by $($Cap.probe.owner)" -Unread $null -ElapsedMs 0
}

# ---------------------------------------------------------------- wrap-up wording
function Get-WrapUp {
  param($Row)
  if ($null -eq $Row) {
    return 'From your inbox: NOT CHECKED -- no inbox capability is declared in run-capabilities.json. Raise this as an ask; do not report the inbox as empty.'
  }
  if ($Row.verdict -eq 'checked') {
    if ([int]$Row.unread -eq 0) { return 'From your inbox: checked -- 0 unread, no new instructions.' }
    return "From your inbox: checked -- $($Row.unread) unread message(s) to triage."
  }
  $why = $Row.reason
  if ($Row.detail) { $why = "$($Row.reason): $($Row.detail)" }
  return "From your inbox: NOT CHECKED -- the email capability is unavailable ($why). Emailed instructions may have been missed this run. Raise this as an ask; do not report the inbox as empty."
}

# ---------------------------------------------------------------- resolve ONE verdict
function Resolve-Verdict {
  if (-not $manifestPath) {
    $row = New-UnreadableRow -Id 'email' -Server 'email' -Mandatory $true -Reason 'manifest-missing' `
      -Detail 'run-capabilities.json not found' -ElapsedMs 0
    return [pscustomobject]@{
      Rows = @($row); Inbox = $row; ExitCode = 2
      ManifestPath = ''; Error = 'run-capabilities.json not found'
    }
  }

  $doc = $null
  try { $doc = (Get-Content -LiteralPath $manifestPath -Raw) | ConvertFrom-Json } catch {
    $row = New-UnreadableRow -Id 'email' -Server 'email' -Mandatory $true -Reason 'manifest-unreadable' `
      -Detail "could not parse $manifestPath" -ElapsedMs 0
    return [pscustomobject]@{
      Rows = @($row); Inbox = $row; ExitCode = 2
      ManifestPath = $manifestPath; Error = 'manifest unreadable'
    }
  }

  $caps = @($doc.capabilities)
  if ($Capability) { $caps = @($caps | Where-Object { $_.id -eq $Capability }) }

  $rows = @()
  foreach ($cap in $caps) {
    $kind = [string]$cap.probe.kind
    switch ($kind) {
      'email-inbox' { $rows += (Test-EmailInbox $cap) }
      'mcp-tools'   { $rows += (Test-McpTools $cap) }
      'delegated'   { $rows += (Test-Delegated $cap) }
      default {
        $rows += (New-Row -Id $cap.id -Server ([string]$cap.server) -Mandatory ([bool]$cap.mandatory) -Kind $kind `
          -Verdict 'unavailable' -Reason 'unknown-probe-kind' -Detail "probe.kind '$kind' is not implemented" -Unread $null -ElapsedMs 0)
      }
    }
  }

  $inbox = @($rows | Where-Object { $_.kind -eq 'email-inbox' }) | Select-Object -First 1
  $badMandatory = @($rows | Where-Object { $_.mandatory -and ($_.verdict -ne 'checked') -and ($_.verdict -ne 'available') -and ($_.verdict -ne 'delegated') })
  $code = if ($badMandatory.Count -gt 0) { 2 } else { 0 }

  return [pscustomobject]@{
    Rows = @($rows); Inbox = $inbox; ExitCode = $code
    ManifestPath = $manifestPath; Error = ''
  }
}

# G5 -- an unexpected error is an unreadable inbox, never a crash and never a pass.
$resolved = $null
try {
  $resolved = Resolve-Verdict
} catch {
  $row = New-UnreadableRow -Id 'email' -Server 'email' -Mandatory $true -Reason 'internal-error' `
    -Detail $_.Exception.Message -ElapsedMs 0
  $resolved = [pscustomobject]@{
    Rows = @($row); Inbox = $row; ExitCode = 2; ManifestPath = ''; Error = $_.Exception.Message
  }
}

# G4 -- THE VERDICT IS RESOLVED ONCE, HERE, BEFORE THE OUTPUT-FORMAT BRANCH (GH #347).
# `-Json` and the human table are two renderings of this one object; neither may decide
# anything. Identical data must never yield opposite answers depending on how it is asked.
$inboxRow = $resolved.Inbox
$result = [pscustomobject]@{
  schema       = 'oa-inbox-check/1'
  checkedAtUtc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  verdict      = if ($inboxRow) { $inboxRow.verdict } else { 'unreadable' }
  unread       = if ($inboxRow) { $inboxRow.unread } else { $null }
  reason       = if ($inboxRow) { $inboxRow.reason } else { 'no-inbox-capability' }
  detail       = if ($inboxRow) { $inboxRow.detail } else { 'no capability with probe.kind email-inbox' }
  ask          = ($resolved.ExitCode -ne 0)
  wrapUp       = (Get-WrapUp $inboxRow)
  budgetMs     = $BudgetMs
  manifest     = $resolved.ManifestPath
  capabilities = @($resolved.Rows)
  exitCode     = $resolved.ExitCode
}

if ($Json) {
  $result | ConvertTo-Json -Depth 6
} else {
  Write-Host "[inbox] manifest : $($result.manifest)"
  Write-Host "[inbox] prober   : $ProberCommand $proberPath (budget $([int]($BudgetMs/1000))s per call)"
  foreach ($r in @($result.capabilities)) {
    $v = $r.verdict.ToUpperInvariant()
    $tail = $r.detail
    if ($r.verdict -eq 'checked') { $tail = "$($r.unread) unread  ($($r.detail))" }
    elseif ($r.reason) { $tail = "$($r.reason): $($r.detail)" }
    Write-Host ("[inbox] {0,-14}{1,-12}{2}" -f $r.id, $v, $tail)
  }
  Write-Host '[inbox]'
  Write-Host "[inbox] $($result.wrapUp)"
  if ($result.ask) {
    Write-Host '[inbox] ASK: an inbox nobody could read is not an empty inbox. Say so in the wrap-up.'
  }
}

# ONE exit, reading the ONE verdict. Do not branch this on the output format.
exit $result.exitCode
