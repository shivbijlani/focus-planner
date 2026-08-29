<#
  mutcheck-reaper-stillborn.ps1 -- proves the stillborn-host rule in reap-stale-mcp.ps1 is
  load-bearing: that it collects a session host which was never spoken to, and that it CANNOT
  take away a host that is serving someone.

  THE INVARIANT (GH #237)
    A `copilot.exe --server --stdio` host is collectable only when it came up, announced
    readiness, and was never driven:
      - readiness banner is the LAST line it ever logged   -> STILLBORN (collect)
      - it logged anything after the banner                -> SPARE (it was spoken to)
      - it has live children (MCP servers)                 -> SPARE (it was spoken to)
      - log missing / unreadable / empty                   -> SPARE (no evidence)
    Age must never override any of that in either direction. That is criterion 3 of the issue and
    the reason the fix is not "kill old copilot.exe": from the outside, a host waiting on SHIV is
    indistinguishable by age from one waiting on a dead client.

  MEASURED, NOT SIMULATED
    Both stillborn fixtures below are the real 392-byte logs of pids 11664 and 12848, which had
    been resident for 8 HOURS when this check was written and which nothing on the box could
    collect. The "served" fixture is the real log shape of pid 9956 -- the host serving the run
    that wrote this file -- which had already moved past the banner before any user message was
    typed. So the discriminator is verified against a live interactive session, which is the case
    that must never be killed.

  THE MUTANTS
    M1  delete BOTH no-evidence guards    -> must NOT flip (see below)
    M2  last-line becomes ANY-line match  -> T_SERVED must flip (a busy log contains the banner too)
    M3  drop the live-children guard      -> T_TRUNCATED must flip (rotation would kill a live host)
    M4  always return $true               -> every spare case must flip (the rule is total)
    M5  last line becomes FIRST line      -> T_STILLBORN must flip (the index is the rule)
    M6  reader share mode Read, not RW    -> T_LOCKED must flip (see below -- this one is special)

  M1 IS RECORDED AS A SURVIVING MUTANT, ON PURPOSE
    The first draft asserted that deleting the empty/unreadable early-return would flip the
    no-evidence case. It does not: with no readable text the line list is empty and the marker
    match already answers $false. Rather than delete the failing assertion and move on, it is
    inverted into a stronger claim -- that "no evidence -> spare" survives deleting BOTH guards,
    i.e. the fail-safe direction is structural and does not rest on a guard a later edit could
    remove. The guards stay in the script as intent-documentation. This mirrors the call
    mutcheck-reaper-cohort.ps1 made about its own empty-input guard, and it is written down
    because a guard whose mutant survives must be reported as such, not quietly asserted.

  WHY M6 EXISTS, AND WHY IT IS THE MOST IMPORTANT ONE
    Every live copilot.exe holds its own log open for writing. [IO.File]::ReadAllText opens with
    FileShare.Read, which does not permit a concurrent writer, so it throws on EVERY log that
    matters -- measured against both a stillborn host and a busy one. Combined with the fail-safe
    rule (unreadable -> spare), a reader with the wrong share mode does not error out and does not
    look broken: it returns $null for every host, spares every host, and the collector becomes a
    permanent no-op that reports a healthy `hostsKilled: 0`. T_LOCKED holds a real file open with
    write access and proves the share mode is a decision rather than a detail.

  NEVER TOUCHES LIVE STATE
    No process is started, inspected or killed. The only I/O is a temp file this check creates
    and deletes itself.
#>
[CmdletBinding()]
param(
  [string]$ScriptPath
)

$ErrorActionPreference = 'Stop'

if (-not $ScriptPath) {
  $ScriptPath = Join-Path $PSScriptRoot '..\skills\overnight-agent\reap-stale-mcp.ps1'
  if (-not (Test-Path $ScriptPath)) { $ScriptPath = Join-Path $PSScriptRoot 'reap-stale-mcp.ps1' }
}
$ScriptPath = [IO.Path]::GetFullPath($ScriptPath)
if (-not (Test-Path $ScriptPath)) { throw "reap-stale-mcp.ps1 not found at $ScriptPath" }

# Explicit UTF-8 decode. A bare Get-Content -Raw is host-dependent on this project's files.
$src = [IO.File]::ReadAllText($ScriptPath, (New-Object Text.UTF8Encoding($false)))

# Brace-matched extraction, so a nested block inside the function cannot truncate it and leave
# us silently testing a fragment.
function Get-FunctionSource {
  param([string]$Text, [string]$Name)
  $start = $Text.IndexOf("function $Name")
  if ($start -lt 0) { throw "function $Name not found in $ScriptPath" }
  $open = $Text.IndexOf('{', $start)
  if ($open -lt 0) { throw "no opening brace for $Name" }
  $depth = 0
  for ($i = $open; $i -lt $Text.Length; $i++) {
    if ($Text[$i] -eq '{') { $depth++ }
    elseif ($Text[$i] -eq '}') {
      $depth--
      if ($depth -eq 0) { return $Text.Substring($start, $i - $start + 1) }
    }
  }
  throw "unbalanced braces extracting $Name"
}

$fnSrc     = Get-FunctionSource -Text $src -Name 'Test-IsStillbornHost'
$readerSrc = Get-FunctionSource -Text $src -Name 'Read-SessionLogText'

$script:Pass = 0
$script:Fail = 0
function Assert($name, $cond, $detail) {
  if ($cond) { $script:Pass++; Write-Host ("  ok    {0}" -f $name) -ForegroundColor Green }
  else       { $script:Fail++; Write-Host ("  FAIL  {0}  {1}" -f $name, $detail) -ForegroundColor Red }
}

# --- fixtures -------------------------------------------------------------------------------
# T_STILLBORN: the verbatim 392-byte log of pid 11664 (and 12848), 5 lines, complete.
$FX_STILLBORN = @(
  '2026-08-29T00:33:10.307Z [INFO] Shell completions: no supported shell detected, skipping'
  '2026-08-29T00:33:10.308Z [INFO] Starting CLI in server mode (stdio)'
  '2026-08-29T00:33:10.311Z [INFO] Starting CLI in stdio mode (Rust JSON-RPC engine)'
  '2026-08-29T00:33:10.315Z [INFO] CLI server ready (stdio mode, Rust JSON-RPC engine)'
  '2026-08-29T00:33:10.315Z [INFO] Server started, waiting for requests'
) -join "`n"

# T_SERVED: the real shape of pid 9956 -- the live host serving the run that wrote this check.
# Note it CONTAINS the readiness banner; only its position distinguishes it. That is the whole
# point of M2.
$FX_SERVED = @(
  '2026-08-29T08:31:42.700Z [INFO] Shell completions: no supported shell detected, skipping'
  '2026-08-29T08:31:42.702Z [INFO] Starting CLI in server mode (stdio)'
  '2026-08-29T08:31:42.705Z [INFO] Starting CLI in stdio mode (Rust JSON-RPC engine)'
  '2026-08-29T08:31:42.706Z [INFO] CLI server ready (stdio mode, Rust JSON-RPC engine)'
  '2026-08-29T08:31:42.706Z [INFO] Server started, waiting for requests'
  '2026-08-29T08:31:42.707Z [INFO] --- Start of group: configured settings: ---'
  '2026-08-29T08:31:42.707Z [INFO] --- End of group ---'
  '2026-08-29T08:34:14.006Z [INFO] System notification: Shell command completed'
) -join "`n"

# T_SERVED_CRLF: same content, CRLF. The splitter must not leave a trailing \r on the last line,
# which would break the marker match and silently flip a live host to stillborn.
$FX_SERVED_CRLF   = $FX_SERVED -replace "`n", "`r`n"
$FX_STILLBORN_CRLF = $FX_STILLBORN -replace "`n", "`r`n"

# T_TRUNCATED: a host whose log was rotated back to the banner but which HAS live MCP children.
# The log signal alone reads "stillborn"; the children signal is the only thing that saves it.
$FX_TRUNCATED = $FX_STILLBORN

function Invoke-Rule {
  param([string]$FnText, $LogText, [bool]$Kids = $false)
  $sb = [scriptblock]::Create($FnText + "`nTest-IsStillbornHost -LogText `$args[0] -HasLiveChildren ([bool]`$args[1])")
  return [bool](& $sb $LogText $Kids)
}

# Mutants are built with ordinal String.Replace, NOT -replace. The replacements contain `$_`,
# `$lines` and `$ReadyMarker`, and .NET's regex substitution grammar treats `$` as significant --
# an early draft of this file used -replace and silently spliced the entire function body into
# the middle of a Where-Object block, producing a parse error that looked like a bug in the rule
# rather than in the check. A mutation check that cannot build its own mutant proves nothing.
function New-Mutant {
  param([string]$Text, [string]$From, [string]$To)
  if (-not $Text.Contains($From)) { throw "mutation target not found in source: $From" }
  return $Text.Replace($From, $To)
}

Write-Host "`n[baseline] the rule as shipped" -ForegroundColor Cyan
$bStillborn     = Invoke-Rule $fnSrc $FX_STILLBORN
$bStillbornCRLF = Invoke-Rule $fnSrc $FX_STILLBORN_CRLF
$bServed        = Invoke-Rule $fnSrc $FX_SERVED
$bServedCRLF    = Invoke-Rule $fnSrc $FX_SERVED_CRLF
$bEmpty         = Invoke-Rule $fnSrc ''
$bNull          = Invoke-Rule $fnSrc $null
$bTruncated     = Invoke-Rule $fnSrc $FX_TRUNCATED $true

Assert 'T_STILLBORN      never-served host is collectable'      ($bStillborn -eq $true)   "got $bStillborn"
Assert 'T_STILLBORN_CRLF same, CRLF log'                        ($bStillbornCRLF -eq $true) "got $bStillbornCRLF"
Assert 'T_SERVED         a host that was spoken to is SPARED'   ($bServed -eq $false)     "got $bServed"
Assert 'T_SERVED_CRLF    same, CRLF log'                        ($bServedCRLF -eq $false) "got $bServedCRLF"
Assert 'T_EMPTY          empty log is SPARED'                   ($bEmpty -eq $false)      "got $bEmpty"
Assert 'T_UNREADABLE     null (unreadable) log is SPARED'       ($bNull -eq $false)       "got $bNull"
Assert 'T_TRUNCATED      rotated log + live children is SPARED' ($bTruncated -eq $false)  "got $bTruncated"

# --- mutants --------------------------------------------------------------------------------
Write-Host "`n[mutants] each must FLIP the case it protects" -ForegroundColor Cyan

# M1 -- THE NO-EVIDENCE GUARDS ARE INTENT-DOCUMENTATION, AND THIS IS RECORDED, NOT HIDDEN.
#
# The first draft of this check asserted that deleting the empty/unreadable early-return would
# flip T_UNREADABLE. It does not, and the honest result is kept here rather than the assertion
# being quietly dropped. With no readable text the line list is empty, so the marker match at the
# end has nothing to match and already answers $false. Deleting BOTH no-evidence guards is
# therefore behaviour-preserving.
#
# That is worth asserting in the opposite direction, because it is a stronger safety property
# than the guard it replaces: "no evidence -> spare" does not depend on a guard that a later edit
# could remove. It falls out of the marker match itself. The guards stay as a statement of
# intent -- the same call the cohort check made about its own empty-input guard.
$m1 = New-Mutant $fnSrc 'if ([string]::IsNullOrWhiteSpace($LogText)) { return $false }' ''
$m1 = New-Mutant $m1    'if ($lines.Count -eq 0) { return $false }' ''
$m1Null  = Invoke-Rule $m1 $null
$m1Empty = Invoke-Rule $m1 ''
Assert 'M1 no-evidence stays SPARED even with both guards deleted' (($m1Null -eq $false) -and ($m1Empty -eq $false)) "null=$m1Null empty=$m1Empty -- the fail-safe direction is NOT structural after all"

# M2 -- last-line match becomes an ANY-line match.
$m2 = New-Mutant $fnSrc `
  'return ($lines[$lines.Count - 1] -match [regex]::Escape($ReadyMarker))' `
  'return ([bool]@($lines | Where-Object { $_ -match [regex]::Escape($ReadyMarker) }).Count)'
$m2Served = Invoke-Rule $m2 $FX_SERVED
Assert 'M2 LAST-line (not any-line) is load-bearing' ($m2Served -eq $true) "served host still spared under any-line match (got $m2Served)"

# M3 -- drop the live-children guard.
$m3 = New-Mutant $fnSrc 'if ($HasLiveChildren) { return $false }' ''
$m3Trunc = Invoke-Rule $m3 $FX_TRUNCATED $true
Assert 'M3 live-children guard is load-bearing' ($m3Trunc -eq $true) "truncated-log host still spared (got $m3Trunc)"

# M4 -- the rule always says "collect".
$m4 = New-Mutant $fnSrc 'if ([string]::IsNullOrWhiteSpace($LogText)) { return $false }' 'return $true'
$m4Served = Invoke-Rule $m4 $FX_SERVED
Assert 'M4 rule is total (spare cases are decisions)' ($m4Served -eq $true) "got $m4Served"

# M5 -- read the FIRST line instead of the last.
$m5 = New-Mutant $fnSrc '$lines[$lines.Count - 1]' '$lines[0]'
$m5Still = Invoke-Rule $m5 $FX_STILLBORN
Assert 'M5 the line INDEX is the rule' ($m5Still -eq $false) "stillborn host still collected under first-line match (got $m5Still)"

# --- M6: the reader's share mode, against a really-locked file --------------------------------
Write-Host "`n[M6] reader must tolerate a log its owner still holds open for writing" -ForegroundColor Cyan

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("mutcheck-stillborn-{0}.log" -f ([guid]::NewGuid().ToString('N')))
[IO.File]::WriteAllText($tmp, $FX_STILLBORN, (New-Object Text.UTF8Encoding($false)))

# Hold it exactly the way a live copilot.exe holds its own log: open, for WRITING.
$writer = [IO.File]::Open($tmp, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
try {
  # Sanity: the naive reader really does fail here. If this ever stops being true the mutant
  # below proves nothing, so it is asserted rather than assumed.
  $naiveFailed = $false
  try { [void][IO.File]::ReadAllText($tmp) } catch { $naiveFailed = $true }
  Assert 'M6a ReadAllText genuinely fails on a live log' ($naiveFailed -eq $true) 'naive read unexpectedly succeeded; fixture no longer reproduces the hazard'

  $readOk = & ([scriptblock]::Create($readerSrc + "`nRead-SessionLogText -Path `$args[0]")) $tmp
  Assert 'M6b shipped reader reads a locked log' ($null -ne $readOk -and $readOk.Length -gt 0) 'shipped reader returned null on a live log'

  # The mutant: narrow the share mode to Read, which is what ReadAllText does.
  $m6 = New-Mutant $readerSrc '[IO.FileShare]::ReadWrite' '[IO.FileShare]::Read'
  $m6Read = & ([scriptblock]::Create($m6 + "`nRead-SessionLogText -Path `$args[0]")) $tmp
  Assert 'M6 FileShare.ReadWrite is load-bearing' ($null -eq $m6Read) "narrowed share mode still read the file -- the collector would not have been blinded"

  # And the consequence, stated as behaviour rather than as a read: a blinded reader spares
  # everything, which is the silent no-op this whole check exists to prevent.
  $blindVerdict = Invoke-Rule $fnSrc $m6Read
  Assert 'M6 blinded reader would spare a stillborn host' ($blindVerdict -eq $false) "expected the no-evidence path (got $blindVerdict)"
}
finally {
  $writer.Dispose()
  Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
}

Write-Host ""
$summaryColor = 'Green'
if ($script:Fail -gt 0) { $summaryColor = 'Red' }
Write-Host ("[mutcheck-reaper-stillborn] {0} passed, {1} failed" -f $script:Pass, $script:Fail) -ForegroundColor $summaryColor
if ($script:Fail) { exit 1 }
exit 0
