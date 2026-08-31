<#
  mutcheck-write-turn.ps1 -- proves every guard in write-turn.ps1 is load-bearing.

  Two things are being established, and the second is the one that matters:

  1. POSITIVE/NEGATIVE: each guard fires on its own corruption and stays silent on the
     legitimate text that most resembles it. A guard that also fires on clean prose gets
     switched off by whoever is trying to get work done, which is the same as not having
     it.

  2. LOAD-BEARING: disabling one guard must break EXACTLY its own positive case and
     nothing else. This is the check that catches a guard which is really being enforced
     by some other code path, or one that never ran at all. `mutcheck-unstamped-runlog`
     earned this: its baseline failed on CRLF fixtures while the LF-based sweep read 7/7
     green, revealing a fix that silently no-opped on most real files.

  The script is invoked as a CHILD PROCESS per fixture rather than dot-sourced, so what
  is measured is the real script as it will actually run, not a function lifted out of it.

  Usage: powershell -NoProfile -ExecutionPolicy Bypass -File mutcheck-write-turn.ps1
  Exit: 0 all assertions hold - 1 a guard is not doing what it claims.
#>
[CmdletBinding()]
param([switch]$Verbose_, [string]$Target)

$ErrorActionPreference = 'Stop'

# Resolve write-turn.ps1 by SEARCH, not by "beside me" alone (#251).
#
# "Beside me" holds in the two layouts this file legitimately lives in (the skill folder
# and the flat OA home), but it is a positional accident rather than a statement of
# intent: a copy of this script anywhere else threw `not found beside this script` and
# was simply skipped by whichever sweep invoked it -- a guard that is absent and a guard
# that is passing look identical from the outside. The order is explicit and the resolved
# path is printed, so what was measured is auditable.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$candidates = @(
  $Target,
  (Join-Path $here 'write-turn.ps1'),
  (Join-Path $here '..\skills\overnight-agent\write-turn.ps1'),
  (Join-Path $env:LOCALAPPDATA 'overnight-agent\write-turn.ps1')
)
$target = $null
foreach ($c in $candidates) {
  if ($c -and (Test-Path $c)) { $target = (Resolve-Path $c).Path; break }
}
if (-not $target) {
  throw ("write-turn.ps1 not found. Tried:`n  " + (($candidates | Where-Object { $_ }) -join "`n  "))
}
Write-Host "target: $target"

$MOON = [char]::ConvertFromUtf32(0x1F319)
$tmp  = Join-Path ([IO.Path]::GetTempPath()) ("wt-mut-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

# --- fixtures ------------------------------------------------------------------------
# Each: name, expected guards, the body, and the newline style to write it with. CRLF is
# represented because these journals round-trip through OneDrive and the planner web app,
# and a regex anchored with `$` silently misses `\r` -- the exact bug the 17:00 run found.

$cleanTurn = @'
## MOON Overnight Agent -- 2026-08-27 reply

<!-- from: overnight-agent -->

Short answer: yes, and it is already how the last fix was built.

### What it costs

Roughly $150-275 for the part that is not free, and it does not need a decision today.

### Run log
**2026-08-27 (overnight):**
- Wrote the guard.
- Result: clean.
'@

$fixtures = @(
  @{ name = 'clean';            expect = @();     nl = 'LF';   body = $cleanTurn }
  @{ name = 'clean-crlf';       expect = @();     nl = 'CRLF'; body = $cleanTurn }

  # G1 -- an eaten `$150` leaves the escape stranded against the surviving half.
  @{ name = 'g1-tombstone';     expect = @('G1'); nl = 'LF';   body = @'
## MOON Overnight Agent -- 2026-08-27 reply

<!-- from: overnight-agent -->

The two shortlisted options land around ~\-275 all in.
'@ }
  # G1 negative: a real dollar range must survive untouched. If this fires, the guard is
  # unusable -- prices are ordinary content in these journals.
  @{ name = 'g1-real-price';    expect = @();     nl = 'LF';   body = @'
## MOON Overnight Agent -- 2026-08-27 reply

<!-- from: overnight-agent -->

The two shortlisted options land around ~$150-275 all in, versus $1,035 for two.
'@ }
  # G1 negative, and the case that forced the exemption to exist: a turn that DOCUMENTS
  # the defect must be writable. The #448 turn announcing these guards was refused by
  # them on exactly this line. A tool that cannot write the document explaining itself
  # gets bypassed, and then it is not a guard at all.
  @{ name = 'g1-quoted';        expect = @();     nl = 'LF';   body = @'
## MOON Overnight Agent -- 2026-08-27 reply

<!-- from: overnight-agent -->

Writing a price inside a shell command can drop it and leave `~\-275` behind, and the
sentence around it still reads fine.
'@ }
  # G1 positive, guarding the exemption itself: a fenced block is quotation, but bare
  # prose OUTSIDE it is not, and must still fire.
  @{ name = 'g1-fence-plus-prose'; expect = @('G1'); nl = 'LF'; body = @'
## MOON Overnight Agent -- 2026-08-27 reply

<!-- from: overnight-agent -->

Here is the shape it leaves:

```
~\-275
```

The quote came out at ~\-275 all in.
'@ }

  # G2 -- single-quote escaping survived into the text.
  @{ name = 'g2-apostrophe';    expect = @('G2'); nl = 'LF';   body = @'
## MOON Overnight Agent -- 2026-08-27 reply

<!-- from: overnight-agent -->

I don''t think that''s the right trade here.
'@ }
  @{ name = 'g2-crlf';          expect = @('G2'); nl = 'CRLF'; body = @'
## MOON Overnight Agent -- 2026-08-27 reply

<!-- from: overnight-agent -->

It''s the same defect on a CRLF file.
'@ }
  # G2 negative: the same text quoted as an example must be writable.
  @{ name = 'g2-quoted';        expect = @();     nl = 'LF';   body = @'
## MOON Overnight Agent -- 2026-08-27 reply

<!-- from: overnight-agent -->

Apostrophes get doubled: `don''t` instead of the word you meant.
'@ }

  # G3 -- date-first H2. The bridge anchors on `##` + moon, so this heading is not an
  # anchor and the turn gets cut here. This is the 17:00 failure, reproduced.
  # G3 positives carry a VALID anchor heading as well, so the fixture isolates G3.
  # Without it the body has no moon-anchored H2 at all and legitimately trips G5 too,
  # which would make the fixture assert two defects while claiming to test one.
  @{ name = 'g3-date-first';    expect = @('G3'); nl = 'LF';   body = @'
## MOON Overnight Agent -- 2026-08-27 reply

<!-- from: overnight-agent -->

## 2026-08-27 -- MOON Overnight Agent reply

Body text.
'@ }
  @{ name = 'g3-crlf';          expect = @('G3'); nl = 'CRLF'; body = @'
## MOON Overnight Agent -- 2026-08-27 reply

<!-- from: overnight-agent -->

## 2026-08-27 -- MOON Overnight Agent reply

Body text on a CRLF file.
'@ }
  # G3 negative: H3 is not an anchor and must not be policed.
  @{ name = 'g3-h3-ok';         expect = @();     nl = 'LF';   body = @'
## MOON Overnight Agent -- 2026-08-27 reply

<!-- from: overnight-agent -->

### Run log
- did the thing
'@ }
  # G3 negative: a bad heading QUOTED inside a fence is an example, not a heading.
  # Without this the tool could not document its own rule.
  @{ name = 'g3-fenced-example'; expect = @();    nl = 'LF';   body = @'
## MOON Overnight Agent -- 2026-08-27 reply

<!-- from: overnight-agent -->

This heading shape is the one that truncates the turn:

```
## 2026-08-27 -- MOON Overnight Agent reply
```

Use the moon first instead.
'@ }

  # G4 -- a provenance stamp with no heading above it severs the block.
  # This one genuinely carries BOTH defects and must say so: G4 is defined by there
  # being no heading above the marker, so giving it an anchor to isolate G4 would
  # delete the very condition under test. Asserting both keeps the fixture honest.
  @{ name = 'g4-stray-marker';  expect = @('G4', 'G5'); nl = 'LF';   body = @'
<!-- from: overnight-agent -->

**Status:** Proposed

**Needs from you:** none
'@ }

  # G5 -- a well-formed turn that is missing only its anchor heading. This is the
  # defect that was hit live on 2026-08-27: G1-G4 all read clean and the turn went to
  # disk unanchorable, so the bridge folded it into the previous turn.
  @{ name = 'g5-no-heading';    expect = @('G5'); nl = 'LF';   body = @'
**Status:** In progress -- 2026-08-27

**Context:** read the linked journals.

Prose body with nothing else wrong with it.

**Needs from you:** nothing.
'@ }
  # G5 negative: an H3-only body still has no anchor, so it must fire; but a body whose
  # anchor sits below other prose is fine, because the bridge scans for the heading.
  @{ name = 'g5-anchor-later';  expect = @();     nl = 'LF';   body = @'
Some preamble the turn opens with.

## MOON Overnight Agent -- 2026-08-27 reply

<!-- from: overnight-agent -->

Body text.
'@ }

  # G7 -- a moon-anchored turn with NO provenance stamp under it. This is the shape that
  # broke the CONSENT gate (#272): with no marker of its own, the turn is inherited by
  # whoever spoke last, so on a journal where the user replied above it the agent's own
  # prose is read back as the user's approval. Measured live on #442, where 15,400 chars
  # of agent text containing `approve`/`yes` produced `consent_ok: true`.
  @{ name = 'g7-no-stamp';      expect = @('G7'); nl = 'LF';   body = @'
## MOON Overnight Agent -- 2026-08-27 reply

**Status:** In progress

Body text with no provenance stamp anywhere in it.

**Needs from you:** nothing.
'@ }
  # CRLF, because a marker regex anchored with `$` silently misses `\r` -- the same defect
  # class this file already records for G2/G3.
  @{ name = 'g7-crlf';          expect = @('G7'); nl = 'CRLF'; body = @'
## MOON Overnight Agent -- 2026-08-27 reply

Body text on a CRLF file, still unstamped.
'@ }
  # G7 positive, and the property that makes the guard correct rather than merely present:
  # a stamp belonging to a LATER heading must not satisfy an earlier one. Scanning to
  # end-of-body instead of stopping at the next H2 would let one stamp launder every turn
  # above it.
  @{ name = 'g7-later-stamp';   expect = @('G7'); nl = 'LF';   body = @'
## MOON Overnight Agent -- first turn, unstamped

Body of the first turn.

## MOON Overnight Agent -- second turn, stamped

<!-- from: overnight-agent -->

Body of the second turn.
'@ }
)

# --- helpers -------------------------------------------------------------------------
function Write-Fixture([string]$path, [string]$body, [string]$nl) {
  # Fixtures are authored with MOON as a placeholder so this file stays pure ASCII; the
  # real character is substituted here from its codepoint. Windows PowerShell 5.1
  # mis-decodes non-BMP literals in a BOM-less UTF-8 source file, which would make the
  # fixtures test something other than what they read as.
  $t = $body.Replace('MOON', $MOON)
  $t = if ($nl -eq 'CRLF') { $t -replace "`r?`n", "`r`n" } else { $t -replace "`r`n", "`n" }
  [IO.File]::WriteAllText($path, $t, (New-Object Text.UTF8Encoding($false)))
}

function Invoke-Guarded([string]$bodyPath, [string[]]$disable) {
  $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $target,
            '-BodyFile', $bodyPath, '-Validate', '-Json')
  if ($disable.Count -gt 0) { $args += @('-DisableGuard', ($disable -join ',')) }
  $raw = & powershell @args 2>&1 | Out-String
  try { $o = $raw | ConvertFrom-Json } catch { throw "unparseable output for $bodyPath :`n$raw" }
  return @($o.findings | ForEach-Object { $_.guard } | Sort-Object -Unique)
}

# --- write fixtures ------------------------------------------------------------------
foreach ($f in $fixtures) {
  $f.path = Join-Path $tmp "$($f.name).md"
  Write-Fixture $f.path $f.body $f.nl
}

$failures = @()
$results  = @()

# --- 1. baseline: every fixture must classify exactly as declared --------------------
Write-Host '--- baseline (all guards on) ---'
foreach ($f in $fixtures) {
  $got = Invoke-Guarded $f.path @()
  $exp = @($f.expect | Sort-Object -Unique)
  $ok  = ((($got -join ',')) -eq (($exp -join ',')))
  $results += [pscustomobject]@{ fixture = $f.name; expected = ($exp -join ',');
                                 got = ($got -join ','); ok = $ok }
  if (-not $ok) { $failures += "baseline $($f.name): expected [$($exp -join ',')] got [$($got -join ',')]" }
  Write-Host ("  {0,-16} expect[{1,-4}] got[{2,-4}] {3}" -f $f.name, ($exp -join ','), ($got -join ','), $(if ($ok) { 'ok' } else { 'FAIL' }))
}

if ($failures.Count -gt 0) {
  Write-Host ''
  Write-Host 'BASELINE FAILED - not proceeding to mutation. A wrong baseline makes every' -ForegroundColor Red
  Write-Host 'mutation result meaningless.' -ForegroundColor Red
  $failures | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  exit 1
}

# --- 2. mutation: disabling guard G must change EXACTLY G's own fixtures -------------
Write-Host ''
Write-Host '--- mutation (disable one guard at a time) ---'
foreach ($g in @('G1', 'G2', 'G3', 'G4', 'G5', 'G7')) {
  $ownFixtures = @($fixtures | Where-Object { $_.expect -contains $g })
  if ($ownFixtures.Count -eq 0) { $failures += "no fixture exercises $g"; continue }

  $broke = @(); $collateral = @()
  foreach ($f in $fixtures) {
    $got = Invoke-Guarded $f.path @($g)
    $exp = @($f.expect | Where-Object { $_ -ne $g } | Sort-Object -Unique)
    $changed = ((($got -join ',')) -ne (($f.expect | Sort-Object -Unique) -join ','))
    $mine = ($f.expect -contains $g)
    if ($mine -and $changed) { $broke += $f.name }
    if ((-not $mine) -and $changed) { $collateral += $f.name }
    if ((($got -join ',')) -ne (($exp -join ','))) {
      $failures += "mutation $g on $($f.name): expected [$($exp -join ',')] got [$($got -join ',')]"
    }
  }
  $verdict = if ($broke.Count -eq $ownFixtures.Count -and $collateral.Count -eq 0) { 'LOAD-BEARING' } else { 'SUSPECT' }
  if ($verdict -ne 'LOAD-BEARING') {
    $failures += "$g is not load-bearing: broke [$($broke -join ',')] of [$($ownFixtures.name -join ',')], collateral [$($collateral -join ',')]"
  }
  Write-Host ("  {0} disabled -> broke [{1}] collateral [{2}]  {3}" -f $g, ($broke -join ','), ($collateral -join ','), $verdict)
}

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
if ($failures.Count -eq 0) {
  Write-Host ("PASS - {0} fixtures, 6 guards, each load-bearing." -f $fixtures.Count) -ForegroundColor Green
  exit 0
}
Write-Host 'FAIL' -ForegroundColor Red
$failures | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
exit 1
