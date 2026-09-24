<#
  mutcheck-mirror-token-retry.ps1 -- proves the PHASE 3 token fetch is resilient (GH #613).

  WHAT HAPPENED

  On 2026-09-07 the Telegram mirror died with an error naming nothing:

      One or more errors occurred.
      MIRROR_EXIT=1

  A second invocation printed NO OUTPUT AT ALL and exited -2146233082. The cause was the
  credential-vault read: `telegram-secret.ps1 get` calls `Add-Type -TypeDefinition`, which
  JIT-compiles C# and needs a burst of COMMITTED memory, and the box was at its commit limit
  (20.0 / 20.0 GB). Ten minutes later the identical call succeeded on attempt 1.

  THREE DEFECTS, and each fails on its own, so each is an arm:

    RETRY      a transient allocation failure cost a whole phase that would have worked
               seconds later
    UNWRAP     "One or more errors occurred." is an AggregateException's stringification. It
               hides every inner message, so diagnosing it meant hand-running an inner script
               the wrapper calls -- the #346 class, where a failure is indistinguishable from
               any other failure
    BANNER     the fetch ran BEFORE the phase banner, so the failing run produced no output
               at all and a reader had nothing to anchor on

  WHY THE FAILURE ARM MATTERS AS MUCH AS THE RECOVERY ARM. A retry that swallowed a genuine,
  permanent vault failure would be worse than the bug: the phase would look healthy while
  posting nothing. So the suite asserts BOTH that a flaky read recovers AND that a truly
  broken one still fails loudly, with a named cause and a non-zero exit.

  HERMETIC. Stub vault, synthetic settings and a stub bridge under TEMP, driving the REAL
  run-telegram-mirror.ps1 with -WhatIf so no Telegram call is ever made and no live
  credential is read.

  Exit 0 = every arm agreed.
#>
[CmdletBinding()]
param([string]$ScriptPath)

$ErrorActionPreference = 'Stop'
if (-not $ScriptPath) { $ScriptPath = Join-Path $PSScriptRoot 'run-telegram-mirror.ps1' }
if (-not (Test-Path $ScriptPath)) { throw "run-telegram-mirror.ps1 not found at $ScriptPath" }

$script:PsExe = if ($PSVersionTable.PSEdition -eq 'Core') { (Get-Process -Id $PID).Path } else { 'powershell' }
$utf8 = New-Object Text.UTF8Encoding($false)

$root = Join-Path ([IO.Path]::GetTempPath()) ("oa-613-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $root -Force | Out-Null

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

$settings = Join-Path $root 'settings.md'
[IO.File]::WriteAllText($settings, "| Approval digest (General thread) | ``off`` as of now |`n", $utf8)
$bridge = Join-Path $root 'bridge.js'
[IO.File]::WriteAllText($bridge, "console.log('stub bridge');", $utf8)
$counter = Join-Path $root 'attempts.txt'

# The exact exception shape the live failure produced: an AggregateException wrapping an
# OutOfMemoryException. Written as a real throw rather than a printed string, so the arms
# exercise the unwrapping rather than a fixture that merely looks like it.
$throwLines = @(
  '$inner = New-Object System.OutOfMemoryException ''Insufficient memory to continue the execution of the program.''',
  'throw (New-Object System.AggregateException ''One or more errors occurred.'', $inner)'
)

$alwaysFail = Join-Path $root 'vault-always-fail.ps1'
[IO.File]::WriteAllText($alwaysFail, (@('param([string]$Cmd)') + $throwLines) -join "`n", $utf8)

# Fails once, then succeeds -- the measured real-world shape.
$flaky = Join-Path $root 'vault-flaky.ps1'
[IO.File]::WriteAllText($flaky, (@(
  'param([string]$Cmd)',
  "`$marker = '$counter'",
  '$n = if (Test-Path $marker) { [int](Get-Content $marker -Raw) } else { 0 }',
  '$n++',
  'Set-Content -Path $marker -Value $n',
  'if ($n -lt 2) {'
) + $throwLines + @(
  '}',
  "'0123456789:AAstubtokenvalue-nota-real-credential'"
)) -join "`n", $utf8)

# Returns nothing at all. Not an exception, and not success either.
$empty = Join-Path $root 'vault-empty.ps1'
[IO.File]::WriteAllText($empty, "param([string]`$Cmd)`n", $utf8)

function Mirror([string]$vault) {
  Remove-Item $counter -ErrorAction SilentlyContinue
  # stdout and stderr are captured to FILES rather than through the pipeline. A failing arm
  # here is EXPECTED to throw, and letting PowerShell surface a child process's stderr as a
  # NativeCommandError turns the harness's own output into the error it is trying to assert
  # about -- which is noise indistinguishable from the harness itself breaking.
  $so = Join-Path $root ('out-' + [guid]::NewGuid().ToString('N').Substring(0, 6) + '.txt')
  $se = "$so.err"
  $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath,
            '-SecretToolPath', $vault, '-SettingsPath', $settings,
            '-BridgePath', $bridge, '-WhatIf')
  $p = Start-Process -FilePath $script:PsExe -ArgumentList $argv -NoNewWindow -Wait -PassThru `
                     -RedirectStandardOutput $so -RedirectStandardError $se
  $out = ''
  foreach ($f in @($so, $se)) {
    if (Test-Path $f) { $out += (Get-Content $f -Raw -ErrorAction SilentlyContinue) }
  }
  return [pscustomobject]@{ out = "$out".Trim(); code = $p.ExitCode }
}
function D($r) {
  $o = ($r.out -replace '\s+', ' ')
  if ($o.Length -gt 300) { $o = $o.Substring(0, 300) + '...' }
  return "exit=$($r.code) :: $o"
}

Write-Host ''
Write-Host 'RETRY -- a transient failure must not cost the phase'

$f = Mirror $flaky
Assert ($f.code -eq 0) 'RETRY' 'a vault that fails once then succeeds lets the phase proceed' (D $f)
Assert ($f.out -match 'attempt 1 failed') 'RETRY2' 'and the transient failure is still reported, not hidden' (D $f)
$used = if (Test-Path $counter) { [int](Get-Content $counter -Raw) } else { 0 }
Assert ($used -eq 2) 'RETRY3' 'it recovered on attempt 2 -- so the retry ran and was not vacuous' "attempts=$used"

Write-Host ''
Write-Host 'UNWRAP -- the message must name the real cause'

$a = Mirror $alwaysFail
Assert ($a.out -match 'Insufficient memory') 'UNWRAP' 'the inner exception is surfaced, not the AggregateException wrapper' (D $a)
Assert ($a.out -match 'token fetch') 'STEP' 'and the failing STEP is named, so a reader knows where to look' (D $a)
Assert ($a.out -match [regex]::Escape($alwaysFail)) 'WHICH' 'and which vault it tried, so the path is not a guess' (D $a)

Write-Host ''
Write-Host 'LOUD -- a permanent failure must still fail, or the retry is worse than the bug'

Assert ($a.code -ne 0) 'LOUD' 'three failed attempts exit non-zero rather than proceeding silently' (D $a)
$e = Mirror $empty
Assert ($e.code -ne 0) 'EMPTY' 'a vault returning no token is a failure, not an empty success' (D $e)

Write-Host ''
Write-Host 'BANNER -- the failing run must still say which phase died'

# The second live invocation printed NOTHING: the fetch ran before the banner, so there was
# not even a phase name to anchor on. Paired against the success case so it cannot pass just
# because the banner is printed everywhere unconditionally.
Assert ($a.out -match '\[mirror\] digest=') 'BANNER' 'the phase banner appears even when the token fetch dies' (D $a)
Assert ($f.out -match '\[mirror\] digest=') 'BANNER2' 'and on the recovering run too (BANNER is not vacuous)' (D $f)

Write-Host ''
if ($script:fail -gt 0) {
  Write-Host ("FAILED: {0} arm(s) disagreed, {1} passed." -f $script:fail, $script:pass) -ForegroundColor Red
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  exit 1
}
Write-Host ("OK: {0} arms agreed. Transient recovers, permanent fails loudly, and both name the phase." -f $script:pass) -ForegroundColor Green
Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
exit 0
