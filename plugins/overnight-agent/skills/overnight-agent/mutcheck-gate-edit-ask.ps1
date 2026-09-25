<#
  mutcheck-gate-edit-ask.ps1 -- an ask that instructs a gate edit which cannot work (GH #513)

  #491 (G16) is this one level down: it catches a turn advertising a REPLY WORD the consent
  reader rejects. G18 catches a turn advertising a GATE EDIT the consent reader ignores. Same
  shape -- Shiv does exactly what was asked and nothing changes -- but it fails on the
  safety-critical side.

  THE MECHANISM, because the guard is meaningless without it. `Get-GateVerdict` runs the floor
  stage FIRST with `Scoped = $false`, deliberately: repo scope narrows a rule, and narrowing a
  prohibition removes protection. The floor also matches on the ACTION KIND through
  `$script:GateOutcomeKinds`, so a floor rule naming an outcome blocks every action of that kind
  and no allow rule can carve an exception out of it. An ask to "add this allow line and I'll
  proceed" on a floor-blocked action is therefore a promise the gate cannot keep.

  Measured on #513 against the real reader: the exact line task #463 asked for leaves the verdict
  at `gate-floor-blocks`. The only edit that flips it removes the data-loss floor rule -- which is
  not "add one narrow permission", it is "drop your only blanket protection against permanent
  data loss". Shiv had already replied `Done` once on an edit that could not work.

  MOST ARMS PROVE THE GUARD STAYS QUIET. A guard that fires on merely DISCUSSING the gate gets
  disabled within a week, and the surface is then unguarded while appearing guarded. So: an
  ordinary turn, a turn that mentions the gate without instructing an edit, a turn that shows it
  ran the check, and a fenced example all stay silent.

  THE FLOOR ARMS ARE THE POINT OF THE WHOLE THING, and they drive the REAL consent reader through
  `-GatePath` rather than asserting what it would say. They reproduce #513's fixture set,
  including row D -- the compound case whose requested line contributes nothing, which the
  issue's FIRST proposed check passed and should not have.

  Hermetic: synthetic journals, gates and bodies under TEMP driving the REAL write-turn.ps1 and
  oa-state.ps1. No live store, no network; runs under pwsh on Linux.

  Exit 0 = every arm agreed.
#>

[CmdletBinding()]
param([string]$WriteTurnPath, [string]$OaStatePath)

$ErrorActionPreference = 'Stop'
# Resolved in the BODY: $PSScriptRoot is not bound while parameter defaults are evaluated.
if (-not $WriteTurnPath) { $WriteTurnPath = Join-Path $PSScriptRoot 'write-turn.ps1' }
if (-not $OaStatePath)   { $OaStatePath   = Join-Path $PSScriptRoot 'oa-state.ps1' }
if (-not (Test-Path $WriteTurnPath)) { throw "write-turn.ps1 not found at $WriteTurnPath" }

$script:PsExe = if ($PSVersionTable.PSEdition -eq 'Core') { (Get-Process -Id $PID).Path } else { 'powershell' }
$utf8 = New-Object Text.UTF8Encoding($true)
$MOON = [char]::ConvertFromUtf32(0x1F319)

$root = Join-Path ([IO.Path]::GetTempPath()) ("oa-513-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $root -Force | Out-Null

# The lesson the G16 harness learned the hard way: unset, this resolves to the developer's REAL
# overnight-agent home on Windows (green while touching live state) and throws on Linux, where
# $env:LOCALAPPDATA is null.
$env:WRITE_TURN_OA_HOME = Join-Path $root 'oa-home'
New-Item -ItemType Directory -Path $env:WRITE_TURN_OA_HOME -Force | Out-Null
$jdir = Join-Path $root 'journal'
New-Item -ItemType Directory -Path $jdir -Force | Out-Null

$script:pass = 0
$script:fail = 0
function Assert([bool]$ok, [string]$name, [string]$why, [string]$detail = '') {
  if ($ok) { Write-Host "  PASS  $name  -- $why"; $script:pass++ }
  else {
    Write-Host "  FAIL  $name  -- $why" -ForegroundColor Red
    if ($detail) { Write-Host ("        got: " + $detail) -ForegroundColor DarkGray }
    $script:fail++
  }
}

function Check([string]$askBody, [string[]]$extra = @()) {
  $p = Join-Path $root ("b-" + [guid]::NewGuid().ToString('N').Substring(0, 6) + '.md')
  $body = "## $MOON Overnight Agent -- 2026-09-25 14:00 PT`n`n<!-- from: overnight-agent -->`n`n" +
          "**Status:** working.`n`n$askBody`n"
  [IO.File]::WriteAllText($p, $body, $utf8)
  $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $WriteTurnPath,
            '-BodyFile', $p, '-Ask', 'none', '-Validate', '-JournalDir', $jdir) + $extra
  $so = "$p.out"; $se = "$p.err"
  $proc = Start-Process -FilePath $script:PsExe -ArgumentList $argv -NoNewWindow -Wait -PassThru `
                        -RedirectStandardOutput $so -RedirectStandardError $se
  $out = ''
  foreach ($f in @($so, $se)) { if (Test-Path $f) { $out += (Get-Content $f -Raw -ErrorAction SilentlyContinue) } }
  return [pscustomobject]@{ out = "$out"; code = $proc.ExitCode }
}
function D($r) {
  $o = ($r.out -replace '\s+', ' ')
  if ($o.Length -gt 200) { $o = $o.Substring(0, 200) + '...' }
  return "exit=$($r.code) :: $o"
}

Write-Host ''
Write-Host 'REFUSES -- an ask instructing a gate edit that was never verified'

# VERBATIM SHAPE OF THE ASK THAT COST A CYCLE (#463, quoted in #513).
$live = Check ('**Needs from you:** Open **Agent gate** in the planner sidebar and add this to the ' +
  '**Do not gate these (reversible)** list as a fourth bullet. Once that line exists, `consent` ' +
  'returns `gate-allowed` and I run the cleanup without asking again.')
Assert ($live.code -eq 2 -and $live.out -match 'G18') 'LIVE-CASE' `
  'the measured #463 ask is refused' (D $live)
Assert ($live.out -match 'GatePath') 'NAMES-THE-CHECK' `
  'and the refusal names the mechanism that would settle it, not just "verify this"' (D $live)

foreach ($verb in @('add', 'paste', 'append', 'insert')) {
  $r = Check "**Needs from you:** $verb a line to ``agent-gate.md`` under **Do not gate these**."
  Assert ($r.code -eq 2) 'INSTRUCTION' "an ask that says ``$verb`` a gate line is refused" (D $r)
}

Write-Host ''
Write-Host 'QUIET -- everything the guard must NOT refuse'

$r = Check '**Needs from you:** nothing.'
Assert ($r.out -notmatch 'G18') 'ORDINARY' 'a turn that never mentions the gate is untouched' (D $r)

# Discussing the mechanism is how this defect gets explained. Refusing that would make the guard
# unusable in exactly the turns that describe it.
$r = Check ('**Needs from you:** nothing. Noting that `agent-gate.md`''s floor is matched by ' +
  'action kind and cannot be scoped, which is why the earlier ask could never have worked.')
Assert ($r.out -notmatch 'G18') 'DISCUSSION' 'mentioning the gate without instructing an edit is fine' (D $r)

$r = Check ('**Needs from you:** add the line to **Do not gate these**. Verified first: I wrote the ' +
  'proposed gate to a temp file and ran `consent -GatePath <temp>` with and without that line, ' +
  'and the verdicts differ, so the line is what flips it.')
Assert ($r.out -notmatch 'G18') 'VERIFIED' 'an ask that shows it ran the check is allowed through' (D $r)

# #320's rule. A turn DOCUMENTING this guard necessarily quotes the bad ask.
$fenced = "**Needs from you:** nothing.`n`n" + '```' + "`nadd this to Do not gate these`n" + '```' + "`n"
$r = Check $fenced
Assert ($r.out -notmatch 'G18') 'FENCED' 'the same instruction inside a fenced example is inert' (D $r)

Write-Host ''
Write-Host 'ESCAPE -- the documented hatch works'
$r = Check ('**Needs from you:** add this to **Do not gate these**.') @('-DisableGuard', 'G18')
Assert ($r.out -notmatch 'G18') 'HATCH' '-DisableGuard G18 clears the refusal (so the refusal was G18)' (D $r)

Write-Host ''
Write-Host 'THE MECHANISM -- driven through the REAL consent reader, not asserted'

# These arms are why the guard exists. They reproduce #513's fixture set against the real
# oa-state.ps1 via -GatePath, so the claim "the requested edit cannot work" is measured here
# rather than quoted from the issue.
$ALLOW_LINE = 'Deleting agent-authored comments on focus-planner GitHub issues, when a local archive exists.'
$FLOOR_LINE = 'Outcome can result in permanent data loss'
$YOLO = 'focus-planner is in YOLO mode, dont ask just do, Im the only user.'

function New-Gate([switch]$WithFloor, [switch]$WithLine) {
  $p = Join-Path $root ("gate-" + [guid]::NewGuid().ToString('N').Substring(0, 6) + '.md')
  $s = "# Agent gate`n`n## Do not gate these (reversible)`n`n- $YOLO`n"
  if ($WithLine) { $s += "- $ALLOW_LINE`n" }
  $s += "`n## Always ask (safety floor)`n`n"
  if ($WithFloor) { $s += "- $FLOOR_LINE`n" }
  else { $s += "- Sending email to many people at once`n" }
  [IO.File]::WriteAllText($p, $s, $utf8)
  return $p
}

$jp = Join-Path $jdir 'task-960.md'
[IO.File]::WriteAllText($jp, "# Task 960: synthetic`n`nnotes`n", $utf8)

# A SANDBOX STATE DIR, not the real one. `oa-state.ps1` takes a process-wide mutex keyed on the
# RESOLVED StateDir path, so a harness that leaves it defaulted contends with whatever live run
# is in progress and fails with `state_lock_timeout` -- a flaky arm that says nothing about the
# code under test. Keying the lock to a private directory also keeps this run from blocking a
# real one, which matters because CI is not the only place this executes.
$sdir = Join-Path $root 'state'
New-Item -ItemType Directory -Path $sdir -Force | Out-Null

function Verdict([string]$gatePath) {
  $o = (& $script:PsExe -NoProfile -ExecutionPolicy Bypass -File $OaStatePath consent -Id 960 `
        -Action delete_data -Repo focus-planner -GatePath $gatePath -JournalDir $jdir `
        -StateDir $sdir 2>&1 | Out-String)
  try { $j = $o | ConvertFrom-Json } catch { return $null }
  return $j
}

if (Test-Path $OaStatePath) {
  $A = Verdict (New-Gate -WithFloor -WithLine)    # the ask as actually written
  $B = Verdict (New-Gate -WithLine)               # floor removed
  Assert ($null -ne $A -and $null -ne $B) 'READER' 'the real consent reader answered' ''
  if ($A -and $B) {
    Assert ($A.consent_ok -eq $false -and "$($A.reason)" -eq 'gate-floor-blocks') 'ROW-A' `
      'the exact line #463 asked for leaves the verdict floor-blocked' `
      "ok=$($A.consent_ok) reason=$($A.reason)"
    Assert ($B.consent_ok -eq $true) 'ROW-B' `
      'and only removing the floor rule flips it -- a far larger decision than the ask described' `
      "ok=$($B.consent_ok) reason=$($B.reason)"

    # ROW D, and the reason the issue's FIRST proposed check was wrong. Comparing the proposed
    # gate against TODAY'S gate passes a compound ask whose requested line contributes nothing.
    # The correct comparison is the proposed gate WITH the edit against the same gate WITHOUT it.
    $D1 = Verdict (New-Gate -WithLine)   # floor removed + the requested line
    $D2 = Verdict (New-Gate)             # floor removed, line omitted
    Assert ($D1.consent_ok -eq $D2.consent_ok -and "$($D1.gate_rule)" -eq "$($D2.gate_rule)") 'ROW-D' `
      'with the floor gone the requested line contributes NOTHING: same verdict, same deciding rule' `
      "with=$($D1.consent_ok)/$($D1.gate_rule) without=$($D2.consent_ok)/$($D2.gate_rule)"
    Assert ("$($D1.gate_rule)" -match 'YOLO') 'ROW-D-WHO' `
      'and the rule that actually decided was already there, not the one he was asked to add' `
      "rule=$($D1.gate_rule)"
  }
}
else {
  Write-Host '  SKIP  READER  -- oa-state.ps1 not beside this script; the mechanism arms did not run'
}

Write-Host ''
Write-Host 'HERMETIC -- the arms above ran against the sandbox, not a real home'
$homeLine = [regex]::Match([IO.File]::ReadAllText($WriteTurnPath), '(?m)^\s*\$OA_HOME\s*=.*$').Value
Assert ($homeLine -match 'WRITE_TURN_OA_HOME') 'OVERRIDE-HONOURED' `
  'write-turn still resolves its home from WRITE_TURN_OA_HOME' "OA_HOME line: $homeLine"
Assert ($env:WRITE_TURN_OA_HOME -and $env:WRITE_TURN_OA_HOME.StartsWith($root)) 'SANDBOXED' `
  'and this run pointed that home inside its own TEMP root' "home=$env:WRITE_TURN_OA_HOME"

Write-Host ''
if ($script:fail -gt 0) {
  Write-Host ("FAILED: {0} arm(s) disagreed, {1} passed." -f $script:fail, $script:pass) -ForegroundColor Red
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  exit 1
}
Write-Host ("OK: {0} arms agreed. A gate edit is not asked for until it is known to work." -f $script:pass) -ForegroundColor Green
Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
exit 0
