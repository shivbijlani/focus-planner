<#
  collect-google-tasks.ps1 -- read the open Google Tasks backlog in a way that can FAIL,
  so that "the backlog is small" is a measurement rather than the shape of a short page.

  WHY THIS EXISTS (GH #524)
  -------------------------
  PHASE 2 step 2 collects open Google Tasks as extra planner candidates. It was prescribed
  as a bare list:

      list_tasks { task_list_id: '@default' }   ->   20 tasks, 9 of them needsAction

  The Google Tasks API defaults to a 20-item page. Measured live on 2026-09-05, same tool,
  same list, ONE ARGUMENT APART:

      list_tasks { task_list_id:'@default' }                                 -> 20 returned,  9 open
      list_tasks { task_list_id:'@default', max_results:100,
                   show_completed:false }                                    -> 35 returned, 35 open

  9 is not "a bit short". It is 26% of the truth, and the shortfall is not random: the
  truncated page was completed-heavy (11 of its 20 slots were already-completed tasks,
  pure page-budget waste), so the OPEN count collapsed hardest.

  THE HARD PART IS THAT BOTH SHAPES LOOK IDENTICAL. There is no error, no warning and no
  partial-result flag. A short list is exactly what a genuinely short backlog looks like,
  so the run's honest reading -- "Shiv burned down 26 tasks this week, the 08-31 import
  proposal is moot" -- is a confident, checkable, WRONG claim built on data nobody could
  tell was incomplete. This is #346 and #520 on a third surface:

      a collector that could only see part of the input returns the same shape as a
      collector that saw all of it and found little.

  THE RULE
  --------
  A TOTAL is a claim about the backlog, and only a read that reached the END of every list
  may make one. `open` is NULL -- never a number, and never 0 -- whenever the read did not
  complete. This is the same fail-closed direction check-agent-inbox.ps1 takes for `unread`.

  GUARDS (each must be load-bearing; see mutcheck-google-tasks.ps1)
    G1 THE TRUNCATION GATE. A page whose length EQUALS the requested page size, with no
       continuation token to follow, is PRESUMED TRUNCATED -- not complete. The API is
       entitled to cap silently, so a full page is evidence of a cap, not of exhaustion.
       Disabling this restores #524 verbatim: 20 comes back, 20 is what there is, 9 open.
    G2 EVERY PAGE IS FOLLOWED. The read pages on `nextPageToken` until the list is
       exhausted, bounded by -MaxPages. Hitting the cap is TRUNCATED, never complete:
       a bound that silently becomes an answer is the defect wearing a budget's clothes.
    G3 EVERY LIST, NOT JUST @default. The lists are enumerated and each one is paged. The
       enumeration gets G1 applied to itself, because a truncated list-of-lists hides whole
       lists the same way a truncated page hides tasks.
    G4 `open` IS NULL ON ANYTHING BUT A COMPLETE READ. Reporting a number for a read that
       stopped early rebuilds the exact ambiguity this file exists to remove, one layer up
       -- and the number would be plausible, which is worse than absent.
    G5 show_completed:false. Completed tasks are page-budget waste: 11 of the 20 slots in
       the live read. Spending page budget on items that can never be candidates is what
       turned a 43% shortfall in TASKS into a 74% shortfall in OPEN tasks.
    G6 ONE verdict, resolved BEFORE the output-format branch, and ONE exit that reads it
       (#347's rule): identical data must not yield opposite answers depending on how the
       caller asked.
    G7 bounded child, and an unexpected error is an UNREADABLE backlog rather than a crash
       or a pass. Fail closed: the expensive direction is silently deciding it was small.

  WHAT #554 ADDED
  ---------------
  The first version of G3 called `list_task_lists`. THAT TOOL DOES NOT EXIST. The
  google-workspace MCP's complete Tasks surface is `list_tasks`, `get_task`, `manage_task`
  -- there is no list-enumeration tool at all -- so every real run died on its first call
  with `unreadable / tool-error / listsRead: 0` and the collector never once succeeded. CI
  could not see it because the mutation check MOCKS the prober, and a mock answers to
  whatever name it is asked for; a suite that invents the server cannot catch a tool name
  the server never had.

  The lesson is that "this tool is not on this server" is a CAPABILITY fact, not a
  transport failure, and the two must not share a verdict: one is fixed by retrying, the
  other never is. So:

    G8 THE TOOL NAMES ARE ASKED FOR, NOT ASSUMED. `tools/list` is read first and the
       collector only ever sends names that came back from it. A name this file made up
       cannot reach the wire. Disabling this restores #553 verbatim.
    G9 A MISSING LISTS TOOL DEGRADES, IT DOES NOT ABORT. With no way to enumerate lists the
       `@default` read still happens, and an `Unknown tool` reply (belt-and-braces, for a
       server that advertises a tool it will not answer to) is read as the same capability
       fact rather than as a transport error.
    G10 DEGRADED IS ITS OWN VERDICT. `partial` + `lists-tool-unavailable` is neither
       `unreadable` (nothing was read) nor `complete` (everything was read). `open` stays
       NULL because a grand total is not claimable when whole lists may be invisible; the
       count that WAS measured is reported as `defaultListOpen`, in its own field, where it
       cannot be mistaken for the backlog. G4's rule is unchanged, not weakened.
    G11 THE USER CAN RESOLVE THE AMBIGUITY ONCE. `-DefaultListOnly` -- or the
       `| Google Tasks lists | default only |` row in user-settings.md -- says the default
       list IS the backlog, which makes the read genuinely complete: a real total, exit 0.
       A permanent exit 2 nobody can clear is alarm fatigue, and alarm fatigue is how a
       real truncation gets ignored.
    G12 THE PROSE SHAPE IS READ, AND ONLY WHEN IT IS RECOGNISED. The live server answers
       list_tasks with a human report, not JSON -- the SECOND wrong assumption #553 was
       hiding behind the first. It is parsed, but strictly: an unrecognised payload stays
       `unreadable` and never becomes an empty list. A parser is the easiest place in this
       file to turn "I did not understand" into "there is nothing here".

  READ-ONLY BY CONSTRUCTION. This script issues list calls only. Completing or deleting a
  task back in Google is irreversible and stays gated on an explicit OK from the user
  (SKILL.md PHASE 2 step 2); nothing here can perform one.

  Usage:
    collect-google-tasks.ps1 -Account shiv@example.com
    collect-google-tasks.ps1 -Account shiv@example.com -Json
    collect-google-tasks.ps1 -Account shiv@example.com -DefaultListOnly
    collect-google-tasks.ps1 -Account shiv@example.com -PageSize 100 -MaxPages 25

  Exit codes:
    0  every list that exists was read to its end; `open` is a real total.
    2  the backlog was not read completely -- `partial` (lists could not be enumerated),
       `truncated`, or `unreadable`. `open` is null.
       SURFACE AS AN ASK -- do NOT write a burn-down narrative on this.
    1  usage error (bad arguments only). Never used for "the backlog looked small".
#>
[CmdletBinding()]
param(
  [string]$Account,
  [string]$Server = 'google-workspace',
  [string]$TaskList,
  [int]$PageSize = 100,
  [int]$MaxPages = 25,
  [int]$TimeoutSec = 60,
  [string[]]$ListsToolCandidates = @('list_task_lists', 'list_tasklists', 'list_task_list'),
  [string]$TasksTool = 'list_tasks',
  [switch]$DefaultListOnly,
  [string]$DefaultListId = '@default',
  [string]$UserSettings,
  [switch]$Json,
  [string]$ProberCommand = 'node',
  [string]$ProberScript
)

Set-StrictMode -Off
$ErrorActionPreference = 'Stop'

if ($PageSize -lt 1) { Write-Host 'usage: -PageSize must be >= 1'; exit 1 }
if ($MaxPages -lt 1) { Write-Host 'usage: -MaxPages must be >= 1'; exit 1 }

$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# ---------------------------------------------------------------- resolution
# Resolved by SEARCH, never assumed to be a sibling: this file is deployed into the flat OA
# home (%LOCALAPPDATA%\overnight-agent) as well as the plugin tree, and assuming a sibling
# is what made PR #303 green and still broken (#305).
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

$proberPath = Resolve-First @(
  $ProberScript,
  (Join-Path $here 'mcp-probe.mjs'),
  (Join-Path $here '..\..\checks\mcp-probe.mjs'),
  (Join-IfSet $env:LOCALAPPDATA 'overnight-agent\mcp-probe.mjs')
)

$BudgetMs = [Math]::Max(1000, $TimeoutSec * 1000)

# ---------------------------------------------------------------- G11 -- the one-time answer
# "The default list IS my backlog" is a fact only the user knows, and once he has said it the
# read is genuinely complete. Precedence: -DefaultListOnly > the user-settings.md row > off.
# A settings file that is missing, locked or half-synced falls through to OFF rather than
# throwing: the fail-closed direction here is to keep asking, never to assume completeness.
function Get-UserSettingsPath {
  if ($UserSettings) { if (Test-Path -LiteralPath $UserSettings) { return $UserSettings } else { return $null } }
  $candidates = @(
    $env:OVERNIGHT_AGENT_SETTINGS,
    (Join-Path (Get-Location).Path 'user-settings.md'),
    (Join-IfSet $env:USERPROFILE 'OneDrive\Apps\Focus Planner\user-settings.md'),
    (Join-IfSet $env:LOCALAPPDATA 'overnight-agent\user-settings.md')
  )
  foreach ($c in $candidates) { if ($c -and (Test-Path -LiteralPath $c)) { return $c } }
  return $null
}

function Get-SettingRow {
  param([string]$Text, [string]$Name)
  if (-not $Text) { return $null }
  $re = '(?im)^\s*\|\s*' + [regex]::Escape($Name) + '\s*\|\s*([^|\r\n]*?)\s*\|'
  $m = [regex]::Match($Text, $re)
  if (-not $m.Success) { return $null }
  return ($m.Groups[1].Value -replace '`', '').Trim()
}

function Resolve-DefaultListOnly {
  if ($DefaultListOnly) { return [pscustomobject]@{ On = $true; Source = '-DefaultListOnly' } }
  $path = Get-UserSettingsPath
  if (-not $path) { return [pscustomobject]@{ On = $false; Source = '' } }
  $text = $null
  try { $text = [IO.File]::ReadAllText($path) } catch { $text = $null }
  $v = Get-SettingRow -Text $text -Name 'Google Tasks lists'
  if (-not $v) { return [pscustomobject]@{ On = $false; Source = '' } }
  # Only an affirmative, unambiguous value counts. A typo must not silently claim a complete
  # read, so anything unrecognised is ignored rather than guessed at.
  if ($v -match '^(?i)\s*(@?default(\s+list)?(\s+only)?|only\s+the\s+default(\s+list)?)\s*$') {
    return [pscustomobject]@{ On = $true; Source = "user-settings.md 'Google Tasks lists = $v'" }
  }
  return [pscustomobject]@{ On = $false; Source = '' }
}

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
  # PowerShell 7 kills the tree in one call. Windows PowerShell 5.1 -- which is what the
  # skill actually invokes -- has no tree overload, and every workaround (WMI descendant
  # walk, taskkill /T) measured slower than the budget it was enforcing. The grandchild is
  # handled a layer DOWN instead: MCP_PROBE_TIMEOUT_MS is set below this budget so the
  # prober gives up first and kills its own MCP child on the way out. An orphaned MCP
  # server is #346's own root cause, so a timeout that creates one is not a fix.
  try { $Process.Kill($true); return } catch { }
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
  $psi.EnvironmentVariables['MCP_PROBE_TIMEOUT_MS'] = [string]([Math]::Max(1000, $Budget - 3000))

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $proc = [System.Diagnostics.Process]::Start($psi)
  } catch {
    return [pscustomobject]@{
      Started = $false; TimedOut = $false; Flushed = $true; ExitCode = -1
      StdOut = ''; StdErr = $_.Exception.Message; ElapsedMs = $sw.ElapsedMilliseconds
    }
  }

  $outTask = $proc.StandardOutput.ReadToEndAsync()
  $errTask = $proc.StandardError.ReadToEndAsync()

  # G7 -- THE BUDGET. WaitForExit(ms) returns false when the child outlived it, and the
  # child is killed rather than waited on. An unbounded wait on a hung MCP server is the
  # one failure worse than the one this file fixes.
  $timedOut = $false
  if (-not $proc.WaitForExit($Budget)) {
    $timedOut = $true
    Stop-Bounded $proc
  }

  # WaitForExit(ms) does NOT flush the async readers -- only the parameterless overload
  # does, and that one cannot be bounded. So wait on the READERS explicitly and treat an
  # unflushed reader as a failed read. This is not padding: a short read that still parses
  # is the same defect class as a short page that still parses -- partial data wearing the
  # costume of a complete answer.
  $flushBudget = 15000
  if ($timedOut) { $flushBudget = 2000 }
  $flushed = $false
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
  # enumerating it, so a length check against it silently reads 1 for any input.
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
    $msg = ''
    try { $msg = [string]$Entry.error.message } catch { }
    $code = ''
    try { $code = [string]$Entry.error.code } catch { }
    # Same capability-vs-transport split as the isError branch below: a JSON-RPC
    # "method not found" (-32601) names a tool this server does not have.
    if ($code -eq '-32601' -or $msg -match '(?i)unknown tool|tool not found|no such tool|method not found') {
      return [pscustomobject]@{ Ok = $false; Reason = 'unknown-tool'; Detail = "$Tool is not a tool this server answers to"; Payload = $null }
    }
    return [pscustomobject]@{ Ok = $false; Reason = 'mcp-error'; Detail = "${Tool}: $($Entry.error | ConvertTo-Json -Compress -Depth 4)"; Payload = $null }
  }
  $res = $Entry.result
  if ($null -eq $res) {
    return [pscustomobject]@{ Ok = $false; Reason = 'unparsable'; Detail = "$Tool returned no result"; Payload = $null }
  }
  if ($res.PSObject.Properties.Name -contains 'isError' -and $res.isError) {
    # G9 -- "Unknown tool" is a CAPABILITY fact, not a transport failure. #553 shipped a
    # tool name the server had never heard of, and reading that reply as `tool-error` made
    # a permanent, unfixable-by-retry condition wear the costume of a flaky one -- so the
    # collector aborted with listsRead: 0 on every run for its entire life. The two must
    # not share a verdict: one is fixed by trying again, the other never is.
    $errText = ''
    if ($res.PSObject.Properties.Name -contains 'content') {
      foreach ($c in @($res.content)) {
        if ($c -and ($c.PSObject.Properties.Name -contains 'text')) { $errText += [string]$c.text }
      }
    }
    if ($errText -match '(?i)unknown tool|tool not found|no such tool|method not found') {
      return [pscustomobject]@{ Ok = $false; Reason = 'unknown-tool'; Detail = "$Tool is not a tool this server answers to"; Payload = $null }
    }
    $tail = $errText.Trim()
    if ($tail.Length -gt 160) { $tail = $tail.Substring(0, 160) }
    return [pscustomobject]@{ Ok = $false; Reason = 'tool-error'; Detail = "$Tool reported isError$(if ($tail) { ": $tail" })"; Payload = $null }
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
  param([string]$ServerName, [array]$Steps)

  $names = @($Steps | ForEach-Object { [string]$_.name })
  $label = ($names -join '+')

  if (-not $proberPath) {
    return [pscustomobject]@{ Ok = $false; Reason = 'prober-missing'; Detail = 'mcp-probe.mjs not found'; Steps = @() }
  }

  $stepJson = ConvertTo-Json -InputObject @($Steps) -Compress -Depth 8
  # PowerShell 5.1 unwraps a one-element array on the way into ConvertTo-Json; 7.x does not.
  # Test the OUTPUT rather than the host version, so this cannot drift with the shell.
  if (-not $stepJson.TrimStart().StartsWith('[')) { $stepJson = '[' + $stepJson + ']' }
  $run = Invoke-Bounded -FilePath $ProberCommand -ArgumentList @($proberPath, $ServerName, 'calls', $stepJson) -Budget $BudgetMs

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
    # A short array renumbers the steps after the missing one, so one call's answer could
    # be read as another's. Refuse rather than realign.
    return [pscustomobject]@{ Ok = $false; Reason = 'step-count-mismatch'; Detail = "$label returned $(@($entries).Count) result(s) for $($Steps.Count) step(s)"; Steps = @() }
  }

  $parsed = @()
  for ($i = 0; $i -lt $Steps.Count; $i++) {
    $parsed += (Read-StepResult -Entry (@($entries)[$i]) -Tool $names[$i])
  }
  return [pscustomobject]@{ Ok = $true; Reason = ''; Detail = ''; Steps = @($parsed) }
}

# ---------------------------------------------------------------- G8 -- ask, don't assume
# The server is asked what tools it HAS before any of them is called, and only names that
# came back may be sent. #553's whole defect was a tool name this file invented: it read
# plausible, it passed review, it passed CI (the mutation check mocks the prober, and a mock
# answers to any name), and it failed 100% of the time on the wire. A name that never
# reaches the wire cannot fail there.
function Get-AdvertisedTools {
  param([string]$ServerName)

  if (-not $proberPath) {
    return [pscustomobject]@{ Ok = $false; Reason = 'prober-missing'; Detail = 'mcp-probe.mjs not found'; Tools = @() }
  }

  $run = Invoke-Bounded -FilePath $ProberCommand -ArgumentList @($proberPath, $ServerName, 'list') -Budget $BudgetMs

  if ($run.TimedOut) {
    return [pscustomobject]@{ Ok = $false; Reason = 'timeout'; Detail = "tools/list exceeded ${BudgetMs}ms and was killed"; Tools = @() }
  }
  if (-not $run.Started) {
    return [pscustomobject]@{ Ok = $false; Reason = 'mcp-unavailable'; Detail = "could not launch '$ProberCommand': $($run.StdErr)"; Tools = @() }
  }
  if (-not $run.Flushed) {
    return [pscustomobject]@{ Ok = $false; Reason = 'read-incomplete'; Detail = 'tools/list produced output that could not be read in full'; Tools = @() }
  }
  if ($run.ExitCode -ne 0) {
    $d = ($run.StdErr + ' ' + $run.StdOut).Trim()
    if ($d.Length -gt 300) { $d = $d.Substring(0, 300) }
    return [pscustomobject]@{ Ok = $false; Reason = 'mcp-unavailable'; Detail = "tools/list exit $($run.ExitCode): $d"; Tools = @() }
  }

  $names = $null
  try { $names = ConvertFrom-JsonArray $run.StdOut } catch {
    return [pscustomobject]@{ Ok = $false; Reason = 'unparsable'; Detail = 'tools/list did not return a JSON array of tool names'; Tools = @() }
  }
  $flat = @()
  foreach ($n in @($names)) {
    if ($null -eq $n) { continue }
    if ($n -is [string]) { $flat += $n; continue }
    if ($n.PSObject.Properties.Name -contains 'name') { $flat += [string]$n.name }
  }
  if ($flat.Count -eq 0) {
    # An empty tool list is not "this server has no Tasks tools" -- it is a read that told
    # us nothing. Guessing past it is exactly the substitution this file exists to prevent.
    return [pscustomobject]@{ Ok = $false; Reason = 'no-tools-advertised'; Detail = 'tools/list returned no tool names'; Tools = @() }
  }
  return [pscustomobject]@{ Ok = $true; Reason = ''; Detail = "$($flat.Count) tool(s) advertised"; Tools = @($flat) }
}

# ---------------------------------------------------------------- payload shape
function ConvertFrom-TaskProse {
  param([string]$Text)
  # THE SHAPE THE LIVE SERVER ACTUALLY RETURNS (measured 2026-09-06). google-workspace's
  # list_tasks does not answer with JSON at all -- neither `content[0].text` nor
  # `structuredContent.result` is machine-readable. It answers with a human report:
  #
  #   Tasks in list @default for shiv@bijlanis.com:
  #   - Meeting with Sneha in the lobby (ID: bUVZVEw3NG1sRzBPWWhzUA)
  #     Status: needsAction
  #     Due: 2026-08-10T00:00:00.000Z
  #
  # #553 never learned this because it died one call earlier, on a tool name that did not
  # exist -- so the SECOND wrong assumption sat behind the first, untested, all along.
  #
  # STRICT ON PURPOSE. This returns $null for anything it does not positively recognise, so
  # an unrecognised payload stays `unreadable` and never becomes "nothing here". Turning "I
  # did not understand" into "the backlog is empty" is the exact substitution this whole
  # file exists to prevent, and a prose parser is the easiest place in it to do so by
  # accident.
  if (-not $Text) { return $null }

  $isHeader = [regex]::IsMatch($Text, '(?im)^\s*Tasks?\s+in\s+list\b')
  $isEmpty = [regex]::IsMatch($Text, '(?im)^\s*(no\s+tasks\b|there\s+are\s+no\s+tasks\b)')
  if (-not $isHeader -and -not $isEmpty) { return $null }

  $items = @()
  $lines = [regex]::Split($Text, '\r?\n')
  $current = $null
  foreach ($line in $lines) {
    $m = [regex]::Match($line, '^\s*-\s+(?<title>.*?)\s*\(ID:\s*(?<id>[^)]+)\)\s*$')
    if ($m.Success) {
      if ($current) { $items += $current }
      # No `status` line seen yet. G5 requests show_completed:false, and Test-Open treats a
      # statusless task as open, so the default here must match that: absent != completed.
      $current = [pscustomobject]@{ id = $m.Groups['id'].Value.Trim(); title = $m.Groups['title'].Value.Trim(); status = $null }
      continue
    }
    if ($current) {
      $s = [regex]::Match($line, '^\s*Status:\s*(?<s>\S+)\s*$')
      if ($s.Success) { $current.status = $s.Groups['s'].Value.Trim() }
    }
  }
  if ($current) { $items += $current }

  if ($items.Count -eq 0 -and -not $isEmpty) {
    # A header with no parseable rows is not an empty backlog -- it is a report this reader
    # could not read. Fail closed.
    if (-not [regex]::IsMatch($Text, '(?im)^\s*Tasks?\s+in\s+list\b.*:\s*$')) { return $null }
  }
  return , @($items)
}

function Get-PageItems {
  param($Payload)
  # The Tasks tools answer either a bare array, an envelope, or -- on the live
  # google-workspace server -- a prose report. Accept all three rather than pinning one
  # shape, but NEVER invent an empty array for a payload that was not recognised -- that
  # would manufacture "nothing here" out of "I did not understand", the very substitution
  # this file exists to prevent. Unrecognised => $null => unreadable.
  if ($null -eq $Payload) { return $null }
  if ($Payload -is [string]) { return ConvertFrom-TaskProse $Payload }
  if ($Payload -is [array]) { return , @($Payload) }
  $props = $Payload.PSObject.Properties.Name
  foreach ($k in @('items', 'tasks', 'taskLists', 'task_lists', 'results')) {
    if ($props -contains $k) {
      $v = $Payload.$k
      if ($null -eq $v) { return , @() }
      return , @($v)
    }
  }
  # fastmcp wraps the same prose in `structuredContent.result`; a string there is the same
  # report by another route, not an object shape.
  if ($props -contains 'result' -and ($Payload.result -is [string])) { return ConvertFrom-TaskProse $Payload.result }
  return $null
}

function Get-PageToken {
  param($Payload)
  if ($null -eq $Payload -or $Payload -is [string] -or $Payload -is [array]) { return $null }
  $props = $Payload.PSObject.Properties.Name
  foreach ($k in @('nextPageToken', 'next_page_token', 'nextpagetoken')) {
    if ($props -contains $k) {
      $v = [string]$Payload.$k
      if ($v) { return $v }
    }
  }
  return $null
}

function Test-Open {
  param($Task)
  # show_completed:false is requested (G5), so a task with no status is taken as open.
  # `completed` is the only value that removes an item from the candidate pool.
  if ($null -eq $Task) { return $false }
  if ($Task -is [string]) { return $false }
  $props = $Task.PSObject.Properties.Name
  if ($props -notcontains 'status') { return $true }
  return ([string]$Task.status -ne 'completed')
}

# ---------------------------------------------------------------- paged read
function Read-PagedList {
  param([string]$Tool, [hashtable]$BaseArgs, [string]$Label)

  $items = @()
  $pages = 0
  $token = $null

  # G2 -- FOLLOW EVERY PAGE. The loop is bounded by -MaxPages, and the bound is reported as
  # truncation below rather than quietly becoming the answer.
  while ($pages -lt $MaxPages) {
    $callArgs = @{}
    foreach ($k in $BaseArgs.Keys) { $callArgs[$k] = $BaseArgs[$k] }
    $callArgs['max_results'] = $PageSize
    if ($token) { $callArgs['page_token'] = $token }

    $session = Invoke-McpSession -ServerName $Server -Steps @(@{ name = $Tool; arguments = $callArgs })
    if (-not $session.Ok) {
      return [pscustomobject]@{ Verdict = 'unreadable'; Reason = $session.Reason; Detail = "$Label - $($session.Detail)"; Items = @(); Pages = $pages }
    }
    $step = @($session.Steps)[0]
    if (-not $step.Ok) {
      # G9 -- a tool the server does not have is `unavailable`, a capability verdict the
      # caller can degrade around. Every other failure stays `unreadable`.
      $v = 'unreadable'
      if ($step.Reason -eq 'unknown-tool') { $v = 'unavailable' }
      return [pscustomobject]@{ Verdict = $v; Reason = $step.Reason; Detail = "$Label - $($step.Detail)"; Items = @(); Pages = $pages }
    }

    $page = Get-PageItems $step.Payload
    if ($null -eq $page) {
      return [pscustomobject]@{ Verdict = 'unreadable'; Reason = 'unparsable'; Detail = "$Label - $Tool returned a payload with no recognisable item list"; Items = @(); Pages = $pages }
    }
    $page = @($page)
    $pages++
    $items += $page

    $token = Get-PageToken $step.Payload
    if ($token) { continue }

    # G1 -- THE TRUNCATION GATE. No continuation token, and the page came back EXACTLY
    # full. The API is entitled to cap a page silently, so a full page is evidence of a
    # cap, not of exhaustion. Presume truncated. Removing this branch is #524 verbatim:
    # 20 comes back, 20 becomes the whole backlog, and 9 open becomes a burn-down.
    if ($page.Count -ge $PageSize) {
      return [pscustomobject]@{ Verdict = 'truncated'; Reason = 'full-page-no-token'; Detail = "$Label - $Tool returned exactly max_results=$PageSize with no nextPageToken, so the end of the list was never observed"; Items = @($items); Pages = $pages }
    }

    return [pscustomobject]@{ Verdict = 'complete'; Reason = ''; Detail = "$Label - read to the end in $pages page(s)"; Items = @($items); Pages = $pages }
  }

  # The page budget ran out with a token still in hand. A bound that becomes an answer is
  # the same defect in a budget's clothing, so this is truncation, not a short backlog.
  return [pscustomobject]@{ Verdict = 'truncated'; Reason = 'page-budget-exhausted'; Detail = "$Label - still paging after -MaxPages=$MaxPages pages of $PageSize"; Items = @($items); Pages = $pages }
}

# ---------------------------------------------------------------- the read
function Resolve-Verdict {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()

  $accountArgs = @{}
  if ($Account) { $accountArgs['user_google_email'] = $Account }

  $defaultOnly = Resolve-DefaultListOnly

  $blank = @{
    Open = $null; DefaultListOpen = $null; Lists = @(); ListsTool = $null
    ListsToolAvailable = $false; DefaultListOnly = $defaultOnly.On
    DefaultListOnlySource = $defaultOnly.Source; Advertised = @()
  }
  function New-Outcome {
    param([string]$Verdict, [string]$Reason, [string]$Detail, [hashtable]$With)
    $o = @{} + $blank
    foreach ($k in $With.Keys) { $o[$k] = $With[$k] }
    $o['Verdict'] = $Verdict; $o['Reason'] = $Reason; $o['Detail'] = $Detail
    $o['ElapsedMs'] = $sw.ElapsedMilliseconds
    return [pscustomobject]$o
  }

  # G8 -- ASK WHAT EXISTS BEFORE CALLING ANYTHING. A name that did not come back from
  # tools/list is never sent, so #553's invented tool cannot reach the wire again.
  $adv = Get-AdvertisedTools -ServerName $Server
  if (-not $adv.Ok) {
    return New-Outcome 'unreadable' $adv.Reason "tool discovery - $($adv.Detail)" @{}
  }
  $advertised = @($adv.Tools)

  if ($advertised -notcontains $TasksTool) {
    # Without the tasks tool nothing can be read at all. This is not a degraded read, it is
    # no read: the server simply does not expose Google Tasks.
    return New-Outcome 'unreadable' 'tasks-tool-unavailable' "$TasksTool is not advertised by '$Server' (advertised: $($advertised.Count) tool(s))" @{ Advertised = $advertised }
  }

  $listsTool = $null
  foreach ($cand in @($ListsToolCandidates)) {
    if ($cand -and ($advertised -contains $cand)) { $listsTool = $cand; break }
  }

  # G3 -- EVERY LIST, NOT JUST @default, WHENEVER THAT IS POSSIBLE. The lists are enumerated
  # first and the SAME paging and truncation rules are applied to the enumeration, because a
  # truncated list-of-lists hides whole lists exactly the way a truncated page hides tasks.
  $listRows = @()
  $listsLimited = $false          # true => whole lists may be invisible to this read
  $listsLimitReason = ''
  $listsLimitDetail = ''

  if ($TaskList) {
    $listRows = @([pscustomobject]@{ id = $TaskList; title = $TaskList })
  } elseif (-not $listsTool) {
    # G9/G10 -- THE #554 CASE. google-workspace exposes list_tasks, get_task, manage_task and
    # nothing else: there is no list-enumeration tool on this server at all. That is a fact
    # about the server, not a failure of this run, so the read DEGRADES to the default list
    # instead of aborting -- but it must never be mistaken for a complete read, because a
    # second list would be invisible in exactly the way a second page is.
    $listRows = @([pscustomobject]@{ id = $DefaultListId; title = $DefaultListId })
    $listsLimited = $true
    $listsLimitReason = 'lists-tool-unavailable'
    $listsLimitDetail = "'$Server' advertises no task-list enumeration tool (tried: $((@($ListsToolCandidates)) -join ', ')), so only '$DefaultListId' could be read; any other list is invisible to this read"
  } else {
    $lists = Read-PagedList -Tool $listsTool -BaseArgs $accountArgs -Label 'task lists'
    if ($lists.Verdict -eq 'unavailable') {
      # Advertised but not answered to. Same capability fact, one layer later.
      $listRows = @([pscustomobject]@{ id = $DefaultListId; title = $DefaultListId })
      $listsLimited = $true
      $listsLimitReason = 'lists-tool-unavailable'
      $listsLimitDetail = "$listsTool is advertised by '$Server' but does not answer to it, so only '$DefaultListId' could be read"
      $listsTool = $null
    } elseif ($lists.Verdict -ne 'complete') {
      return New-Outcome $lists.Verdict $lists.Reason $lists.Detail @{ Advertised = $advertised; ListsTool = $listsTool; ListsToolAvailable = $true }
    } else {
      foreach ($l in @($lists.Items)) {
        if ($null -eq $l) { continue }
        $id = $null
        $title = $null
        if ($l -is [string]) { $id = $l; $title = $l }
        else {
          $p = $l.PSObject.Properties.Name
          if ($p -contains 'id') { $id = [string]$l.id }
          if ($p -contains 'title') { $title = [string]$l.title }
          elseif ($p -contains 'name') { $title = [string]$l.name }
        }
        if (-not $id) { continue }
        if (-not $title) { $title = $id }
        $listRows += [pscustomobject]@{ id = $id; title = $title }
      }
      if ($listRows.Count -eq 0) {
        return New-Outcome 'unreadable' 'no-task-lists' "$listsTool returned no usable task lists" @{ Advertised = $advertised; ListsTool = $listsTool; ListsToolAvailable = $true }
      }
    }
  }

  # G11 -- the user's one-time answer. Once he has said the default list IS the backlog,
  # not being able to enumerate lists stops being a hole in the read.
  if ($listsLimited -and $defaultOnly.On) {
    $listsLimited = $false
    $listsLimitReason = ''
    $listsLimitDetail = ''
  }

  $rows = @()
  $worst = 'complete'
  $worstReason = ''
  $worstDetail = ''
  $running = 0
  $defaultOpen = $null

  foreach ($l in $listRows) {
    $taskArgs = @{}
    foreach ($k in $accountArgs.Keys) { $taskArgs[$k] = $accountArgs[$k] }
    $taskArgs['task_list_id'] = $l.id
    # G5 -- show_completed:false. Completed tasks can never be planner candidates and cost
    # page budget: 11 of the 20 slots in the live 2026-09-05 read were already completed.
    $taskArgs['show_completed'] = $false

    $read = Read-PagedList -Tool $TasksTool -BaseArgs $taskArgs -Label "list $($l.id)"
    $openHere = @(@($read.Items) | Where-Object { Test-Open $_ }).Count

    $rows += [pscustomobject]@{
      id = $l.id; title = $l.title; verdict = $read.Verdict; reason = $read.Reason
      detail = $read.Detail; pages = $read.Pages; returned = @($read.Items).Count
      open = $(if ($read.Verdict -eq 'complete') { $openHere } else { $null })
    }

    if ($read.Verdict -eq 'complete') {
      $running += $openHere
      if ($l.id -eq $DefaultListId) { $defaultOpen = $openHere }
    } elseif ($worst -ne 'unreadable') {
      # `unreadable` outranks `truncated`: both refuse a total, but they name different
      # fixes, and the harder failure must not be masked by a softer one.
      if ($read.Verdict -eq 'unreadable' -or $read.Verdict -eq 'unavailable' -or $worst -eq 'complete') {
        $v = $read.Verdict
        if ($v -eq 'unavailable') { $v = 'unreadable' }   # the TASKS tool, not the lists tool
        $worst = $v; $worstReason = $read.Reason; $worstDetail = $read.Detail
      }
    }
  }

  # G10 -- DEGRADED IS ITS OWN VERDICT, and it ranks BELOW a per-list failure. `partial`
  # says "what I read, I read to the end -- but I could not see how much there was to
  # read". It is neither `unreadable` (which read nothing) nor `complete` (which read
  # everything), and giving it its own name is the entire point: #554 happened because a
  # capability gap and a transport failure shared one word.
  if ($worst -eq 'complete' -and $listsLimited) {
    $worst = 'partial'
    $worstReason = $listsLimitReason
    $worstDetail = $listsLimitDetail
  }

  # G4 -- `open` IS NULL unless EVERY list that exists was read to its end. A partial sum is
  # the most dangerous number in this file: it is plausible, it is checkable, and it is
  # wrong. The count that WAS measured lives in `defaultListOpen`, where its scope is in
  # its name and it cannot be read as the backlog.
  $total = $null
  if ($worst -eq 'complete') { $total = $running }

  return New-Outcome $worst $worstReason $(if ($worstDetail) { $worstDetail } else { "$($rows.Count) list(s) read to the end" }) @{
    Open = $total; DefaultListOpen = $defaultOpen; Lists = @($rows); Advertised = $advertised
    ListsTool = $listsTool; ListsToolAvailable = [bool]$listsTool
  }
}

function Get-WrapUp {
  param($R)
  if ($R.Verdict -eq 'complete') {
    return "Google Tasks: $($R.Open) open across $(@($R.Lists).Count) list(s), read to the end."
  }
  if ($R.Verdict -eq 'partial') {
    $n = $R.DefaultListOpen
    $seen = $(if ($null -eq $n) { 'an unknown number of' } else { "$n" })
    return "Google Tasks: PARTIAL - $seen open in '$DefaultListId', read to the end, but this server exposes no way to enumerate task lists, so any OTHER list is invisible. Total UNKNOWN; do not report a total or a burn-down. To settle it, pass -DefaultListOnly or add ``| Google Tasks lists | default only |`` to user-settings.md."
  }
  if ($R.Verdict -eq 'truncated') {
    return "Google Tasks: open backlog UNKNOWN - the read was truncated ($($R.Reason)). Do not report a total or a burn-down."
  }
  return "Google Tasks: NOT READ - the backlog could not be reached ($($R.Reason)). Do not report a total or a burn-down."
}

# G7 -- an unexpected error is an unreadable backlog, never a crash and never a pass.
$resolved = $null
try {
  $resolved = Resolve-Verdict
} catch {
  $resolved = [pscustomobject]@{
    Verdict = 'unreadable'; Reason = 'internal-error'; Detail = $_.Exception.Message
    Open = $null; DefaultListOpen = $null; Lists = @(); ListsTool = $null
    ListsToolAvailable = $false; DefaultListOnly = $false; DefaultListOnlySource = ''
    Advertised = @(); ElapsedMs = 0
  }
}

# G6 -- THE VERDICT IS RESOLVED ONCE, HERE, BEFORE THE OUTPUT-FORMAT BRANCH (GH #347).
# `-Json` and the human table are two renderings of this one object; neither may decide
# anything. Identical data must never yield opposite answers depending on how it was asked.
$exitCode = 0
if ($resolved.Verdict -ne 'complete') { $exitCode = 2 }

$result = [pscustomobject]@{
  schema      = 'oa-google-tasks/2'
  readAtUtc   = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  verdict     = $resolved.Verdict
  open        = $resolved.Open
  # The count that WAS measured, in its own field. `open` is the claim about the BACKLOG and
  # stays null unless the whole backlog was read; this one is scoped by its own name.
  defaultListOpen    = $resolved.DefaultListOpen
  reason      = $resolved.Reason
  detail      = $resolved.Detail
  account     = $Account
  server      = $Server
  pageSize    = $PageSize
  maxPages    = $MaxPages
  listsRead   = @($resolved.Lists).Count
  listsTool   = $resolved.ListsTool
  listsToolAvailable = $resolved.ListsToolAvailable
  defaultListOnly    = $resolved.DefaultListOnly
  defaultListOnlySource = $resolved.DefaultListOnlySource
  toolsAdvertised    = @($resolved.Advertised).Count
  ask         = ($exitCode -ne 0)
  wrapUp      = (Get-WrapUp $resolved)
  budgetMs    = $BudgetMs
  lists       = @($resolved.Lists)
  exitCode    = $exitCode
}

if ($Json) {
  $result | ConvertTo-Json -Depth 6
} else {
  Write-Host "[gtasks] prober  : $ProberCommand $proberPath (budget $([int]($BudgetMs/1000))s per call)"
  Write-Host "[gtasks] request : max_results=$PageSize show_completed=false maxPages=$MaxPages"
  Write-Host "[gtasks] tools   : $($result.toolsAdvertised) advertised; lists tool = $(if ($result.listsTool) { $result.listsTool } else { 'NONE (this server cannot enumerate task lists)' })"
  if ($result.defaultListOnly) {
    Write-Host "[gtasks] scope   : default list only, per $($result.defaultListOnlySource)"
  }
  foreach ($r in @($result.lists)) {
    $tail = $r.detail
    if ($r.verdict -eq 'complete') { $tail = "$($r.open) open of $($r.returned) returned in $($r.pages) page(s)" }
    elseif ($r.reason) { $tail = "$($r.reason): $($r.detail)" }
    Write-Host ("[gtasks] {0}  {1}  {2}" -f "$($r.id)".PadRight(20), "$($r.verdict)".ToUpperInvariant().PadRight(11), $tail)
  }
  Write-Host '[gtasks]'
  Write-Host "[gtasks] $($result.wrapUp)"
  if ($result.ask) {
    Write-Host '[gtasks] ASK: a backlog nobody read to the end is not a small backlog. Say so in the wrap-up.'
  }
}

# ONE exit, reading the ONE verdict. Do not branch this on the output format.
exit $result.exitCode
