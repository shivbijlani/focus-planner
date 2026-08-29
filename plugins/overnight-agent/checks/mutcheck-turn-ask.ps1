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
  $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $script -BodyFile $f -Validate -Json 2>&1 | Out-String
  $code = $LASTEXITCODE
  $j = $out | ConvertFrom-Json
  Check $c.n ($j.hasAsk -eq $c.want) ("hasAsk=$($j.hasAsk) want=$($c.want)")
  Check "  ...and exit code is unaffected (0)" ($code -eq 0) "exit=$code"
  Remove-Item $f -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "$pass passed, $fail failed"
exit ($(if ($fail) { 1 } else { 0 }))
