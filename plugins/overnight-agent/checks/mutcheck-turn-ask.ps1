# mutcheck-turn-ask.ps1 -- proves write-turn.ps1's ask detection is load-bearing.
#
# -Target lets a caller name the write-turn.ps1 under test explicitly; when omitted it is
# located by search (see below), so this runs from the repo and from the flat OA home.
[CmdletBinding()]
param([string]$Target)

# Case 1: the EXACT shape that nearly shipped on 2026-08-27 — Reply with a colon.
$bad = @'
## 🌙 Overnight Agent

<!-- from: overnight-agent -->

Here is what I did.

*Reply:* **`merge 198`**
'@

# Case 2: a proper ask the digest can read.
$good = @'
## 🌙 Overnight Agent

<!-- from: overnight-agent -->

**Needs from you:** reply `merge 198`.
'@

# Case 3: the imperative dialect.
$imp = @'
## 🌙 Overnight Agent

<!-- from: overnight-agent -->

Reply `merge 198` and I will land it.
'@

# Case 4: a legitimately informational turn — warns, but must still be writable.
$info = @'
## 🌙 Overnight Agent

<!-- from: overnight-agent -->

Recorded for the archive. Nothing needed.
'@

$enc = New-Object Text.UTF8Encoding($false)

# Resolve write-turn.ps1 by SEARCH, not by one hard-coded home (#251).
#
# This used to point only at the OA home. That is not merely inflexible: run from the
# repo it silently graded the *installed* copy, so a change to the repo's write-turn.ps1
# could be proven green by a check that never opened it. Verifying the wrong artifact is
# the failure class this repo keeps closing, so the order below is explicit and the
# resolved path is printed -- a check that will not say which file it measured cannot be
# audited.
#
# Order: -Target -> beside me (flat OA home) -> the skill folder (repo) -> OA home.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$candidates = @(
  $Target,
  (Join-Path $here 'write-turn.ps1'),
  (Join-Path $here '..\skills\overnight-agent\write-turn.ps1'),
  (Join-Path $env:LOCALAPPDATA 'overnight-agent\write-turn.ps1')
)
$script = $null
foreach ($c in $candidates) {
  if ($c -and (Test-Path $c)) { $script = (Resolve-Path $c).Path; break }
}
if (-not $script) {
  throw ("write-turn.ps1 not found. Tried:`n  " + (($candidates | Where-Object { $_ }) -join "`n  "))
}
Write-Host "target: $script"

$pass = 0; $fail = 0

function Check($name, $cond, $detail) {
  if ($cond) { $script:pass++; Write-Host "  ok   $name" }
  else { $script:fail++; Write-Host "  FAIL $name  <- $detail" }
}

foreach ($c in @(
    @{ n = 'colon-Reply is NOT read as an ask (the near-miss)'; body = $bad;  want = $false },
    @{ n = 'Needs from you IS read as an ask';                  body = $good; want = $true  },
    @{ n = 'imperative Reply `x` IS read as an ask';             body = $imp;  want = $true  },
    @{ n = 'informational turn warns but is still clean';        body = $info; want = $false }
  )) {
  $f = Join-Path $env:TEMP ('wt-' + [guid]::NewGuid().ToString('N') + '.md')
  [IO.File]::WriteAllText($f, $c.body, $enc)
  # `-Ask` is required since #560 declared it mandatory. These four cases predate that and
  # omitted it, so every one of them exited 2 on a G13 refusal and the "exit code is
  # unaffected" assertion had been failing on main -- a red check nobody was reading. The
  # cases are about whether the ask TEXT parses, so declaring one keeps their intent intact.
  $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $script -BodyFile $f -Validate -Json -Ask offer 2>&1 | Out-String
  $code = $LASTEXITCODE
  $j = $out | ConvertFrom-Json
  Check $c.n ($j.hasAsk -eq $c.want) ("hasAsk=$($j.hasAsk) want=$($c.want)")
  Check "  ...and exit code is unaffected (0)" ($code -eq 0) "exit=$code"
  Remove-Item $f -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "-- G14: a question declared not-blocking (#618) --"

# Baseline + negatives share one fixture shape, so a negative that passes because the
# harness never reached the guard is impossible to mistake for a negative that passes
# because the guard correctly declined to fire: the baseline on the same shape must fire.
$g14Hdr = "## 🌙 Overnight Agent`n`n<!-- from: overnight-agent -->`n`nWork happened.`n`n"

# Drawn from the rows #618 actually measured, so a future edit that "simplifies" the rule
# has to argue with real data rather than with an invented example.
$g14Cases = @(
  @{ n = 'BASELINE #472: two direct questions declared `offer` is refused'
     ask = 'offer'; want = $true
     line = '**Needs from you:** one word each, no rush. What is corporate picnic - find a date, or RSVP? And life coaching - book a session?' },
  @{ n = '#476: opens "none." then elaborates -- still a real offer'
     ask = 'offer'; want = $false
     line = '**Needs from you:** none. Two things you may want to action when convenient, neither blocks anything.' },
  @{ n = '#370: opens "nothing blocking" -- still a real offer'
     ask = 'offer'; want = $false
     line = '**Needs from you:** nothing blocking - if Tue + Fri is the wrong pair, say the word.' },
  @{ n = 'the same question declared `blocking` is allowed through'
     ask = 'blocking'; want = $false
     line = '**Needs from you:** which one should I use?' },
  @{ n = 'the `Your call:` dialect is covered too'
     ask = 'offer'; want = $true
     line = '**Your call:** should I use A or B?' },
  @{ n = 'a statement ask declared `offer` stays clean'
     ask = 'offer'; want = $false
     line = '**Needs from you:** nothing blocking, I will proceed with the default.' }
)

function Invoke-G14([string]$Target, [hashtable]$Case) {
  $f = Join-Path $env:TEMP ('wt14-' + [guid]::NewGuid().ToString('N') + '.md')
  [IO.File]::WriteAllText($f, ($g14Hdr + $Case.line + "`n"), $enc)
  try {
    $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $Target -BodyFile $f -Validate -Json -Ask $Case.ask 2>&1 | Out-String
    return [bool]((($out | ConvertFrom-Json).findings | Where-Object { $_.guard -eq 'G14' }) -ne $null)
  } finally { Remove-Item $f -Force -ErrorAction SilentlyContinue }
}

foreach ($c in $g14Cases) {
  $fired = Invoke-G14 -Target $script -Case $c
  Check $c.n ($fired -eq $c.want) "G14 fired=$fired want=$($c.want)"
}

# M-ASK -- proves G14 is load-bearing rather than decorative. Disabling the guard must
# make the baseline stop refusing; if the baseline passes with the guard switched off, the
# assertion above was measuring something else and the whole arm is worthless.
$mutBaseline = $g14Cases[0]
$mutFired = $null
$mf = Join-Path $env:TEMP ('wt14m-' + [guid]::NewGuid().ToString('N') + '.md')
[IO.File]::WriteAllText($mf, ($g14Hdr + $mutBaseline.line + "`n"), $enc)
try {
  $mo = & powershell -NoProfile -ExecutionPolicy Bypass -File $script -BodyFile $mf -Validate -Json -Ask $mutBaseline.ask -DisableGuard G14 2>&1 | Out-String
  $mutFired = [bool]((($mo | ConvertFrom-Json).findings | Where-Object { $_.guard -eq 'G14' }) -ne $null)
} finally { Remove-Item $mf -Force -ErrorAction SilentlyContinue }
Check 'M-ASK: -DisableGuard G14 removes the refusal (guard is load-bearing)' ($mutFired -eq $false) "still fired=$mutFired"

Write-Host ""
Write-Host "$pass passed, $fail failed"
exit ($(if ($fail) { 1 } else { 0 }))
