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
$script = Join-Path $env:LOCALAPPDATA 'overnight-agent\write-turn.ps1'
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
