<#
  mutcheck-pr-closing-keyword.ps1 -- guards the "a shipped PR does not close its issue" check (#428).

  WHAT THIS GUARDS
  ----------------
  The operating contract says a merged PR must NOT close its issue: the issue staying open is
  how Shiv knows something is waiting for his review. `pr-closing-keyword.mjs` enforces that.

  This guard exists because the enforcement is a GRAMMAR, and a grammar fails silently. Every
  arm below removes one clause and proves a specific fixture stops being caught. Without that,
  someone "simplifies" a regex, the job still reports green on ordinary PRs, and the next
  disclaimer-shaped closing reference merges unnoticed -- which is exactly how #441 closed.

  The two directions are BOTH load-bearing and are both mutated:
    * too narrow -> a real closing reference merges (arms B, C, I, K)
    * too wide   -> the job fires on ordinary prose and gets disabled (arms H, D, E, G)

  WHAT IS ASSERTED (baseline fixtures)
  ------------------------------------
    A1   `Closes #422`                                   -> FLAG   (the plain case)
    A2   `Refs #422` / `Part of #422`                    -> clean  (the sanctioned wording)
    A3   `Closes #422` inside a ~~~ fence                -> clean
    A3b  `Closes #422` inside a ``` fence                -> clean
    A4   `> Closes #422` in a blockquote                 -> clean
    A5   `does not close [issue #441](.../issues/441)`   -> FLAG   (the live #441 regression)
    A6   `Closes #422` + the opt-out label               -> clean
    A7   ``Closes #422`` inside inline code              -> clean
    A8   `Fixes https://github.com/o/r/issues/422`       -> FLAG
    A9   `Resolves owner/repo#422`                       -> FLAG
    A10  ordinary prose ("this closes the loop")         -> clean
    A11  `closed GH-422`                                 -> FLAG
    A12  GitHub reports a closer the grammar missed      -> FLAG as drift
    A13  a lone ``` run mid-prose must not re-pair the   -> clean
         backticks of a later, well-formed code span

  A5 and A12 are the reason this file is not decorative. A5 is a real merged PR: the sentence
  written to PROMISE no auto-close was itself the closing reference, because GitHub resolves a
  keyword followed by a markdown link by its href. A12 asserts the guard notices when GitHub's
  parser and this grammar disagree, instead of trusting the grammar it just failed with.

  MUTATION ARMS
  -------------
    B_dropCloseKeyword   drop close/closes/closed        -> A1  must fail
    C_dropMdLink         drop the markdown-link ref form -> A5  must fail
    D_dropFenceMask      stop masking ``` fences         -> A3  must fail
    E_dropQuoteMask      stop masking blockquotes        -> A4  must fail
    F_dropOptOut         ignore the opt-out label        -> A6  must fail
    G_dropInlineMask     stop masking inline code        -> A7  must fail
    H_widenKeywords      treat `refs` as closing         -> A2  must fail
    I_dropUrlForm        drop the bare issue-URL form    -> A8  must fail
    J_dropDrift          never report drift              -> A12 must fail
    K_dropCrossForm      drop owner/repo#N               -> A9  must fail

  Every arm mutates a COPY in a temp dir; the live tree is never written.

    powershell -File mutcheck-pr-closing-keyword.ps1 [-CheckerPath <file>] [-BaselineOnly]
#>
[CmdletBinding()]
param(
  [string]$CheckerPath,
  [switch]$BaselineOnly
)

$ErrorActionPreference = 'Stop'

function Read-Utf8([string]$p) { [IO.File]::ReadAllText($p, (New-Object Text.UTF8Encoding($false))) }
function Write-Utf8([string]$p, [string]$t) { [IO.File]::WriteAllText($p, $t, (New-Object Text.UTF8Encoding($false))) }

if (-not $CheckerPath) { $CheckerPath = Join-Path $PSScriptRoot 'pr-closing-keyword.mjs' }
if (-not (Test-Path $CheckerPath)) { throw "pr-closing-keyword.mjs not found (pass -CheckerPath)." }
$CheckerPath = (Resolve-Path $CheckerPath).Path

# --- the fixtures ------------------------------------------------------------------------------
# Authored here as one JSON document so the harness and this file cannot drift apart.
$fixtures = @'
[
  { "id": "A1",  "expect": "flag",  "body": "Some work.\n\nCloses #422." },
  { "id": "A2",  "expect": "clean", "body": "Some work.\n\nRefs #422. Part of #422." },
  { "id": "A3",  "expect": "clean", "body": "Doc:\n\n~~~text\nCloses #422\n~~~\n" },
  { "id": "A3b", "expect": "clean", "body": "Doc:\n\n```text\nCloses #422\n```\n" },
  { "id": "A4",  "expect": "clean", "body": "As noted:\n\n> Closes #422\n" },
  { "id": "A5",  "expect": "flag",  "body": "**This does not close [issue #441](https://github.com/shivbijlani/focus-planner/issues/441)** on merge." },
  { "id": "A6",  "expect": "clean", "body": "Closes #422.", "labels": ["allow-auto-close"] },
  { "id": "A7",  "expect": "clean", "body": "A merged PR auto-closes its issue via `Closes #422`, which is the habit." },
  { "id": "A8",  "expect": "flag",  "body": "Fixes https://github.com/shivbijlani/focus-planner/issues/422" },
  { "id": "A9",  "expect": "flag",  "body": "Resolves shivbijlani/focus-planner#422" },
  { "id": "A10", "expect": "clean", "body": "This closes the loop on the design. Fixed a typo. Resolved the ambiguity." },
  { "id": "A11", "expect": "flag",  "body": "closed GH-422" },
  { "id": "A12", "expect": "drift", "body": "No closing keyword anywhere in this body.", "remoteRefs": [999] },
  { "id": "A13", "expect": "clean", "body": "Exempt: fenced blocks (``` and ~~~).\n\nLater: flags `Closes #446` on line 1." }
]
'@

# --- the harness -------------------------------------------------------------------------------
# Imports the (possibly mutated) checker and prints one verdict per fixture.
$harness = @'
import { readFileSync } from 'node:fs';
import { evaluate } from './pr-closing-keyword.mjs';

const fixtures = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const out = [];
for (const f of fixtures) {
  let verdict, err = null;
  try {
    const r = evaluate({
      body: f.body,
      labels: f.labels ?? [],
      remote: false,
      remoteRefs: f.remoteRefs ?? null,
    });
    if (f.expect === 'drift') verdict = (!r.ok && r.drift.length > 0) ? 'drift' : (r.ok ? 'clean' : 'flag');
    else verdict = r.ok ? 'clean' : 'flag';
  } catch (e) { verdict = 'error'; err = String(e && e.message || e); }
  out.push({ id: f.id, expect: f.expect, got: verdict, err });
}
process.stdout.write(JSON.stringify(out));
'@

# --- run the fixtures against a given copy of the checker ----------------------------------------
function Invoke-Fixtures {
  param([string]$Dir)
  $fx = Join-Path $Dir 'fixtures.json'
  Write-Utf8 $fx $fixtures
  Write-Utf8 (Join-Path $Dir 'harness.mjs') $harness
  $raw = & node (Join-Path $Dir 'harness.mjs') $fx 2>&1 | Out-String
  try { return ($raw | ConvertFrom-Json) }
  catch { throw "harness did not return JSON (checker may not parse):`n$raw" }
}

function Get-Failures {
  param($Results)
  $bad = @()
  foreach ($r in $Results) { if ($r.got -ne $r.expect) { $bad += "$($r.id): expected $($r.expect), got $($r.got)$(if($r.err){" [$($r.err)]"})" } }
  return $bad
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("mutcheck-prclose-" + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

function New-Sandbox {
  param([string]$Name)
  $d = Join-Path $tmp $Name
  New-Item -ItemType Directory -Path $d -Force | Out-Null
  Copy-Item $CheckerPath (Join-Path $d 'pr-closing-keyword.mjs') -Force
  return $d
}

# --- baseline -------------------------------------------------------------------------------------
Write-Host "[mutcheck-pr-closing-keyword] checker = $CheckerPath"

$arms = @()
try {
  $base = New-Sandbox '_baseline'
  $baseFail = Get-Failures (Invoke-Fixtures -Dir $base)
  if ($baseFail.Count -gt 0) {
    Write-Host ""
    Write-Host "BASELINE FAILED:" -ForegroundColor Red
    $baseFail | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    exit 1
  }
  $n = ($fixtures | ConvertFrom-Json).Count
  Write-Host "[baseline] OK -- all $n fixtures classified correctly (flag / clean / drift)."

  if ($BaselineOnly) { exit 0 }

  # --- mutation arms --------------------------------------------------------------------------
  function Add-Arm {
    param([string]$Name, [string]$Expect, [scriptblock]$Mutate)
    $d = New-Sandbox $Name
    $p = Join-Path $d 'pr-closing-keyword.mjs'
    Write-Utf8 $p (& $Mutate (Read-Utf8 $p))
    $failures = @()
    try { $failures = Get-Failures (Invoke-Fixtures -Dir $d) }
    catch { $failures = @("$Expect`: checker crashed under mutation") }
    $killed = @($failures | Where-Object { $_ -like "$Expect*" }).Count -gt 0
    $script:arms += [pscustomobject]@{ arm = $Name; expect = $Expect; killed = $killed; got = ($failures -join '; ') }
  }

  Add-Arm 'B_dropCloseKeyword' 'A1' { param($t)
    [regex]::Replace($t, "(?m)^\s*'close', 'closes', 'closed',.*// KW:close.*$\r?\n?", '') }

  Add-Arm 'C_dropMdLink' 'A5' { param($t)
    [regex]::Replace($t, '(?m)^.*// REF:mdlink.*$\r?\n?', '') }

  Add-Arm 'D_dropFenceMask' 'A3' { param($t)
    [regex]::Replace($t, '(?m)^.*// MASK:fenced.*$\r?\n?', '') }

  Add-Arm 'E_dropQuoteMask' 'A4' { param($t)
    [regex]::Replace($t, '(?m)^.*// MASK:quote.*$\r?\n?', '') }

  Add-Arm 'F_dropOptOut' 'A6' { param($t)
    # Remove the opt-out early return, keeping the function syntactically whole.
    [regex]::Replace($t, '(?ms)^\s*if \(lower\.includes\(OPT_OUT_LABEL\)\).*?// OPTOUT.*?\n.*?\n\s*\}\r?\n', '') }

  Add-Arm 'G_dropInlineMask' 'A7' { param($t)
    [regex]::Replace($t, '(?m)^.*// MASK:inline.*$\r?\n?', '') }

  Add-Arm 'H_widenKeywords' 'A2' { param($t)
    [regex]::Replace($t, "(// KW:close)", "'refs', 'ref', `$1") }

  Add-Arm 'I_dropUrlForm' 'A8' { param($t)
    [regex]::Replace($t, '(?m)^.*// REF:url.*$\r?\n?', '') }

  Add-Arm 'J_dropDrift' 'A12' { param($t)
    [regex]::Replace($t, '(?m)^(\s*const drift = ).*// DRIFT.*$', '$1[];') }

  Add-Arm 'K_dropCrossForm' 'A9' { param($t)
    [regex]::Replace($t, '(?m)^.*// REF:cross.*$\r?\n?', '') }
}
finally {
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ""
Write-Host "MUTATION ARMS"
$arms | ForEach-Object {
  $mark = if ($_.killed) { 'KILLED ' } else { 'SURVIVED' }
  $col  = if ($_.killed) { 'Green' } else { 'Red' }
  Write-Host ("  [{0}] {1,-20} expected {2}" -f $mark, $_.arm, $_.expect) -ForegroundColor $col
  if (-not $_.killed) { Write-Host "            got: $(if($_.got){$_.got}else{'no fixture changed verdict'})" -ForegroundColor Red }
}

$survived = @($arms | Where-Object { -not $_.killed })
Write-Host ""
if ($survived.Count -gt 0) {
  Write-Host "FAIL: $($survived.Count) mutant(s) survived -- the check is not load-bearing." -ForegroundColor Red
  exit 1
}
Write-Host "PASS: baseline clean and all $($arms.Count) mutants killed." -ForegroundColor Green
exit 0
