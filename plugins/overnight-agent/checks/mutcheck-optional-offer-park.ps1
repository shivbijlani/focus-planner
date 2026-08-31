<#
  mutcheck-optional-offer-park.ps1 -- mutation check for the "optional offer" false-park fix.

  A turn that opens `**Needs from you:** nothing` and then OFFERS something optional was being
  counted as an open ask. That parks the task (`awaiting_reply`), and a parked row is not
  workable -- so a turn whose own first word says "nothing" removed itself from the run.

  Measured on the live board 2026-08-31 00:30 PT: 21 of 83 open board asks opened with a
  dismissive, one of them #448, the ONLY row in Today. With Deferred correctly held behind
  Today, that single false park left 0 of 238 rows eligible: the run had no permitted work
  anywhere on the board and reported a clean pass while doing nothing.

  Runs the REAL oa-state.ps1 against a synthetic, isolated journal folder (-JournalDir /
  -StateDir), so live state is never touched.

  Run it against BOTH the pre-fix and post-fix scripts. The fix is only load-bearing if the
  pre-fix script FAILS the offer cases and PASSES every control -- that is what proves the
  change fixes a real bug instead of restating behaviour that already worked.

    powershell -File mutcheck-optional-offer-park.ps1 -ScriptPath <path-to-oa-state.ps1> [-ExpectPreFix]
#>
[CmdletBinding()]
param(
  [string]$ScriptPath,
  [switch]$ExpectPreFix
)

$ErrorActionPreference = 'Stop'

if (-not $ScriptPath) {
  # Default to the installed skill's oa-state.ps1 when run by hand; run-sweeps.ps1 passes
  # -ScriptPath explicitly so the nightly sweep guards the PRODUCTION copy, not the repo's.
  $candidates = @(
    (Join-Path $PSScriptRoot '..\skills\overnight-agent\oa-state.ps1'),
    (Join-Path $env:LOCALAPPDATA 'overnight-agent\oa-state.ps1'),
    "$env:USERPROFILE\.copilot\installed-plugins\focus-planner\overnight-agent\skills\overnight-agent\oa-state.ps1"
  )
  foreach ($c in $candidates) { if (Test-Path $c) { $ScriptPath = (Resolve-Path $c).Path; break } }
}
if (-not $ScriptPath -or -not (Test-Path $ScriptPath)) { throw "oa-state.ps1 not found (pass -ScriptPath)" }
$ScriptPath = (Resolve-Path $ScriptPath).Path

# A journal whose newest agent turn is IN-PROGRESS and carries one `Needs from you:` value.
# `{ASK}` is substituted per case. The provenance stamp is required (G7), and the turn-end
# marker keeps the trailing region empty so `awaiting_reply` is decided purely by the ask.
$Template = @'
# Task {ID}: synthetic

User notes at the top.

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## Overnight Agent

**Status:** In-progress - plan v1 - 2026-08-31

<!-- from: overnight-agent -->

Did some work this run.

**Needs from you:** {ASK}

<!-- /overnight-agent turn-end -->
'@

# id -> @{ ask; expectOpen; control; label }
#
# `control` cases must behave IDENTICALLY on the pre-fix and post-fix scripts. They are what
# prove the change is specific to the offer shape and did not loosen ask detection generally --
# without them a mutant that simply returned $false everywhere would pass.
$Cases = @(
  @{ id = '901'; control = $false; expectOpen = $false
     label = 'dismissive + explicitly optional offer (the live #448 shape)'
     ask   = 'nothing. Both items above are optional; say the word on either and I''ll pick it up.' }

  @{ id = '902'; control = $false; expectOpen = $false
     label = 'dismissive + "if you want" offer'
     ask   = 'nothing to start. If you want it faster, reply `rerun` and I will.' }

  @{ id = '903'; control = $false; expectOpen = $false
     label = 'dismissive + curly-apostrophe "when you re ready"'
     ask   = ('nothing to unblock it. Two calls when you' + [char]0x2019 + 're ready.') }

  @{ id = '904'; control = $true;  expectOpen = $true
     label = 'CONTROL dismissive + a REAL ask must still park'
     ask   = 'none - but tell me which of the two invoices you want cancelled.' }

  @{ id = '905'; control = $true;  expectOpen = $true
     label = 'CONTROL an ordinary ask is untouched'
     ask   = 'a decision on the Postgres vs SQLite split before I can continue.' }

  @{ id = '906'; control = $true;  expectOpen = $false
     label = 'CONTROL a bare dismissive is still not an ask'
     ask   = 'nothing.' }

  @{ id = '907'; control = $true;  expectOpen = $true
     label = 'CONTROL "optional" in a NON-dismissive ask still parks'
     ask   = 'pick one of the optional add-ons before I order.' }
)

$root     = Join-Path ([IO.Path]::GetTempPath()) ("oa-offer-" + [Guid]::NewGuid().ToString('N').Substring(0, 10))
$journals = Join-Path $root 'journal'
$state    = Join-Path $root 'state'
New-Item -ItemType Directory -Force -Path $journals, $state | Out-Null

$utf8 = New-Object System.Text.UTF8Encoding($false)
try {
  foreach ($c in $Cases) {
    $body = $Template.Replace('{ID}', $c.id).Replace('{ASK}', $c.ask)
    [IO.File]::WriteAllText((Join-Path $journals "task-$($c.id).md"), $body, $utf8)
  }

  $raw = & powershell -NoProfile -ExecutionPolicy Bypass -File $ScriptPath scan `
           -JournalDir $journals -StateDir $state 2>&1
  $text = ($raw | Out-String)
  if ($LASTEXITCODE -ne 0) { throw "scan failed (exit $LASTEXITCODE):`n$text" }

  $rows = $text | ConvertFrom-Json
  $byId = @{}
  foreach ($r in $rows) { $byId["$($r.id)"] = $r }

  $pass = 0; $fail = 0; $controlFail = 0
  foreach ($c in $Cases) {
    $r = $byId[$c.id]
    if ($null -eq $r) { Write-Host "  MISSING  #$($c.id)  $($c.label)"; $fail++; continue }
    $got = [bool]$r.has_open_ask
    $tag = if ($c.control) { 'CONTROL' } else { 'FIX    ' }
    if ($got -eq $c.expectOpen) {
      Write-Host ("  ok      {0} #{1}  {2}" -f $tag, $c.id, $c.label)
      $pass++
    } else {
      Write-Host ("  FAIL    {0} #{1}  expected has_open_ask={2}, got {3}  -- {4}" -f `
                  $tag, $c.id, $c.expectOpen, $got, $c.label)
      $fail++
      if ($c.control) { $controlFail++ }
    }
  }

  Write-Host ''
  Write-Host ("[mutcheck-optional-offer-park] {0} passed, {1} failed (of {2})" -f $pass, $fail, $Cases.Count)

  if ($ExpectPreFix) {
    # Against the PRE-FIX script the three offer cases must fail and every control must pass.
    if ($controlFail -gt 0) {
      Write-Host "PRE-FIX: a CONTROL failed -- the cases do not isolate the bug." ; exit 1
    }
    if ($fail -eq 0) {
      Write-Host "PRE-FIX: everything passed -- the fix is NOT load-bearing." ; exit 1
    }
    Write-Host "PRE-FIX: $fail offer case(s) failed and all controls passed -- bug reproduced."
    exit 0
  }

  if ($fail -gt 0) { exit 1 }
  exit 0
}
finally {
  Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}
