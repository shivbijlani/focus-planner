<#
  mutcheck-inbox-check.ps1 -- prove that check-agent-inbox.ps1 can tell an inbox it
  COULD NOT READ from an inbox that is genuinely empty, and that each guard doing so
  is load-bearing rather than decorative.

  WHY THIS EXISTS (GH #346)
  -------------------------
  PHASE 0 mandates an inbox check. Its old implementation was a bare search, and a
  search on an unhealthy email client returns `[]` -- the same bytes a healthy client
  returns for an empty mailbox. So a run that could not look reported exactly what a
  run that looked and found nothing reported, and emailed instructions were dropped
  with no error anywhere.

  THE HARD PART IS THAT BOTH SHAPES LOOK IDENTICAL. Scenarios `disconnected-but-alive`
  and `silent` below send the SAME search payload -- `[]` -- and differ only in whether
  the health probe passed. A check that reads them the same way is the bug. Every arm
  here exists to hold those two apart.

  The scenarios are taken from a live reproduction on 2026-09-02 ~12:52 PT:
    1. email_list_accounts  -> the agent account with "connected": false
    2. email_search unread  -> []
    3. email_test_account   -> {"success":true,"folderCount":10}
  (1)+(2) invite the conclusion "client down, result meaningless"; (3) proves the server
  was reachable all along. So `connected` is not the signal -- which is why arm D exists.

  ARMS
    A  healthy + empty        -> checked, unread 0, exit 0
    B  healthy + 2 unread     -> checked, unread 2, exit 0
    C  MCP absent/dead        -> unreadable, unread NULL, exit 2, wrap-up says NOT CHECKED
    D  connected:false but a  -> checked (the live 2026-09-02 shape). The advertised flag
       passing probe             must not be able to raise a false alarm on its own.
    E  probe fails, search    -> unreadable. THE DEFECT ARM: byte-identical `[]` to arm A,
       still returns []          opposite verdict. If this ever reads `checked`, #346 is back.
    F  the MCP hangs          -> unreadable within the budget. Bounded, cannot hang a run.
    G  -Json vs human         -> same verdict and the SAME EXIT CODE (#347's rule).
    H  unreadable JSON        -> never contains "unread": 0. Null, or the ambiguity is
                                 simply rebuilt one layer up.
    I  two accounts, no       -> unreadable/ambiguous-account. Ambiguity is not emptiness.
       selector

  MUTATIONS (each must be killed by a NAMED arm, and must not disturb the others)
    M1 health gate disabled        -> killed by E, E2
    M2 the call budget unbounded   -> killed by F
    M3 unreadable reports unread 0 -> killed by C, H
    M4 the -Json path picks its
       own exit code               -> killed by C, E, F, G, I
    M5 CONTROL: a comment-only edit -> kills NOTHING. Without this arm, a suite that
       fails on any edit at all would look identical to one that tests behaviour.

  Usage: powershell -NoProfile -ExecutionPolicy Bypass -File mutcheck-inbox-check.ps1
  Exit:  0 every assertion holds - 1 a guard is not doing what it claims.
#>
[CmdletBinding()]
param([string]$Target)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# Resolve the script under test by SEARCH and PRINT what was measured (#251): a guard
# that is absent and a guard that is passing look identical from the outside.
$candidates = @(
  $Target,
  (Join-Path $here 'check-agent-inbox.ps1'),
  (Join-Path $here 'skills/overnight-agent/check-agent-inbox.ps1'),
  (Join-Path $here '../skills/overnight-agent/check-agent-inbox.ps1')
) | Where-Object { $_ }
if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'overnight-agent/check-agent-inbox.ps1') }

$script:Subject = $null
foreach ($c in $candidates) { if (Test-Path -LiteralPath $c) { $script:Subject = (Resolve-Path -LiteralPath $c).Path; break } }
if (-not $script:Subject) { Write-Host 'FAIL - check-agent-inbox.ps1 not found' -ForegroundColor Red; exit 1 }

# The fixtures are node scripts standing in for mcp-probe.mjs, so the real spawn, quoting,
# budget, parse and verdict path all execute. Refusing to run without node is deliberate:
# a check that self-skips reports green while asserting nothing, which is the defect class
# this whole suite exists to catch.
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { Write-Host 'FAIL - node is required to run the prober fixtures' -ForegroundColor Red; exit 1 }

$psHost = $null
try { $psHost = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName } catch { }
if (-not $psHost) {
  $hostCmd = Get-Command pwsh -ErrorAction SilentlyContinue
  if (-not $hostCmd) { $hostCmd = Get-Command powershell -ErrorAction SilentlyContinue }
  if ($hostCmd) { $psHost = $hostCmd.Source }
}
if (-not $psHost) { Write-Host 'FAIL - no PowerShell host found to run the subject' -ForegroundColor Red; exit 1 }

Write-Host "[mutcheck-inbox] subject = $script:Subject"
Write-Host "[mutcheck-inbox] host    = $psHost"
Write-Host "[mutcheck-inbox] node    = $($node.Source)"

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("oa-inbox-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

# ---------------------------------------------------------------- fixtures
$fixtureJs = @'
// Stands in for mcp-probe.mjs. argv: <server> <action> <stepsJson>
// Scenario comes from OA_FIXTURE. Emits exactly the shape mcp-probe.mjs `calls` emits:
// one array, element i being { result } or { error } for step i.
const scenario = process.env.OA_FIXTURE || 'healthy-empty';
const action = process.argv[3];
const steps = action === 'calls' ? JSON.parse(process.argv[4] || '[]') : [];

if (scenario === 'dead') {
  process.stderr.write('PROBE FAILED: failed to connect to MCP server "email": initialize handshake did not complete\n');
  process.exit(1);
}
if (scenario === 'hang') {
  setInterval(() => {}, 1000);   // never exits; the caller's budget must end this
} else {
  const wrap = (obj) => ({ result: { content: [{ type: 'text', text: JSON.stringify(obj) }] } });

  const connected = scenario !== 'disconnected-but-alive' && scenario !== 'silent';
  const accounts = [{ id: 'acct-1', name: 'Overnight Agent', provider: 'imap', email: 'agent@example.com', connected }];
  if (scenario === 'ambiguous') {
    accounts.push({ id: 'acct-2', name: 'Second', provider: 'imap', email: 'other@example.com', connected: true });
  }

  const unread = scenario === 'healthy-messages'
    ? [{ id: 'm1', subject: 'approve task 243', from: 'shiv@example.com' },
       { id: 'm2', subject: 'new task', from: 'shiv@example.com' }]
    : [];

  const out = steps.map((s) => {
    if (s.name === 'email_list_accounts') return wrap(accounts);
    if (s.name === 'email_test_account') {
      // `silent` is the #346 shape: the probe fails, and the SEARCH BELOW STILL ANSWERS [].
      if (scenario === 'silent') return wrap({ success: false, error: 'IMAP connect failed' });
      return wrap({ success: true, folderCount: 10 });
    }
    if (s.name === 'email_search') return wrap(unread);
    return { error: { code: -32601, message: 'unknown tool ' + s.name } };
  });
  console.log(JSON.stringify(out, null, 2));
}
'@
$fixturePath = Join-Path $tmp 'fixture-prober.mjs'
[IO.File]::WriteAllText($fixturePath, $fixtureJs, (New-Object Text.UTF8Encoding($false)))

$manifestJson = @'
{
  "schema": "oa-run-capabilities/1",
  "capabilities": [
    {
      "id": "email",
      "server": "email",
      "mandatory": true,
      "wrapUpSection": "From your inbox",
      "probe": {
        "kind": "email-inbox",
        "listTool": "email_list_accounts",
        "healthTool": "email_test_account",
        "healthField": "success",
        "searchTool": "email_search",
        "folder": "INBOX",
        "limit": 50
      },
      "accountSelector": ""
    }
  ]
}
'@
$manifestPath = Join-Path $tmp 'run-capabilities.json'
[IO.File]::WriteAllText($manifestPath, $manifestJson, (New-Object Text.UTF8Encoding($false)))

# ---------------------------------------------------------------- runner
function Invoke-Subject {
  param(
    [string]$ScriptPath,
    [string]$Scenario,
    [switch]$AsJson,
    [int]$TimeoutSec = 20,
    [int]$OuterKillMs = 60000
  )

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $psHost
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath,
               '-Manifest', $manifestPath, '-ProberCommand', $node.Source, '-ProberScript', $fixturePath,
               '-TimeoutSec', "$TimeoutSec")
  if ($AsJson) { $argList += '-Json' }
  $psi.Arguments = (($argList | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' ')
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.EnvironmentVariables['OA_FIXTURE'] = $Scenario

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $proc = [System.Diagnostics.Process]::Start($psi)
  $outTask = $proc.StandardOutput.ReadToEndAsync()
  $errTask = $proc.StandardError.ReadToEndAsync()

  # The mutcheck bounds the SUBJECT too, because M2 removes the subject's own bound and
  # an unbounded mutant would otherwise hang this check forever. `Killed` is the signal
  # that the subject failed to bound itself.
  $killed = $false
  if (-not $proc.WaitForExit($OuterKillMs)) {
    $killed = $true
    try { $proc.Kill($true) } catch { try { $proc.Kill() } catch { } }
  }
  try { [System.Threading.Tasks.Task]::WaitAll(@($outTask, $errTask), 5000) | Out-Null } catch { }
  $sw.Stop()

  $stdout = ''
  try { if ($outTask.IsCompleted) { $stdout = $outTask.Result } } catch { }
  $code = -1
  try { if ($proc.HasExited) { $code = $proc.ExitCode } } catch { }

  $json = $null
  if ($AsJson -and -not $killed) { try { $json = $stdout | ConvertFrom-Json } catch { } }

  return [pscustomobject]@{
    ExitCode = $code; StdOut = $stdout; Json = $json; Killed = $killed; ElapsedMs = $sw.ElapsedMilliseconds
  }
}

$script:failures = @()
function Assert {
  param([bool]$Condition, [string]$Message)
  if ($Condition) { Write-Host "  ok   $Message" -ForegroundColor Green }
  else { Write-Host "  FAIL $Message" -ForegroundColor Red; $script:failures += $Message }
}

# ---------------------------------------------------------------- baseline
function Test-Arms {
  param([string]$ScriptPath, [string]$Label, [string[]]$Expect)
  # $Expect names the arms that must PASS. Any arm not listed is expected to FAIL,
  # which is how a mutation is proven to be killed by a SPECIFIC arm rather than
  # by "something went red somewhere".
  $res = @{}

  $a = Invoke-Subject -ScriptPath $ScriptPath -Scenario 'healthy-empty' -AsJson
  $res['A'] = ($a.Json -and $a.Json.verdict -eq 'checked' -and [int]$a.Json.unread -eq 0 -and $a.ExitCode -eq 0)

  $b = Invoke-Subject -ScriptPath $ScriptPath -Scenario 'healthy-messages' -AsJson
  $res['B'] = ($b.Json -and $b.Json.verdict -eq 'checked' -and [int]$b.Json.unread -eq 2 -and $b.ExitCode -eq 0)

  $c = Invoke-Subject -ScriptPath $ScriptPath -Scenario 'dead' -AsJson
  $res['C'] = ($c.Json -and $c.Json.verdict -eq 'unreadable' -and $null -eq $c.Json.unread -and
               $c.ExitCode -eq 2 -and $c.Json.ask -eq $true -and $c.Json.wrapUp -clike '*NOT CHECKED*')

  $d = Invoke-Subject -ScriptPath $ScriptPath -Scenario 'disconnected-but-alive' -AsJson
  $res['D'] = ($d.Json -and $d.Json.verdict -eq 'checked' -and [int]$d.Json.unread -eq 0 -and $d.ExitCode -eq 0)

  $e = Invoke-Subject -ScriptPath $ScriptPath -Scenario 'silent' -AsJson
  $res['E'] = ($e.Json -and $e.Json.verdict -eq 'unreadable' -and $e.ExitCode -eq 2 -and
               $e.Json.wrapUp -clike '*NOT CHECKED*')

  # The two `[]` shapes must not agree. Stated separately so the pairing is the assertion.
  $res['E2'] = ($d.Json -and $e.Json -and $d.Json.verdict -ne $e.Json.verdict)

  $f = Invoke-Subject -ScriptPath $ScriptPath -Scenario 'hang' -AsJson -TimeoutSec 3 -OuterKillMs 45000
  $res['F'] = ((-not $f.Killed) -and $f.Json -and $f.Json.verdict -eq 'unreadable' -and $f.ExitCode -eq 2)

  $gJson = Invoke-Subject -ScriptPath $ScriptPath -Scenario 'dead' -AsJson
  $gHuman = Invoke-Subject -ScriptPath $ScriptPath -Scenario 'dead'
  $res['G'] = ($gJson.ExitCode -eq $gHuman.ExitCode -and $gHuman.StdOut -clike '*NOT CHECKED*')

  $res['H'] = ($c.StdOut -notmatch '"unread"\s*:\s*0')

  $i = Invoke-Subject -ScriptPath $ScriptPath -Scenario 'ambiguous' -AsJson
  $res['I'] = ($i.Json -and $i.Json.verdict -eq 'unreadable' -and $i.Json.reason -eq 'ambiguous-account' -and $i.ExitCode -eq 2)

  $detail = @{
    A = 'healthy + empty reads as checked, 0 unread, exit 0'
    B = 'healthy + 2 unread reads as checked, 2 unread, exit 0'
    C = 'a dead MCP reads as unreadable, unread NULL, exit 2, wrap-up says NOT CHECKED'
    D = 'connected:false with a PASSING probe still reads as checked (the live 2026-09-02 shape)'
    E = 'probe fails while search returns [] reads as UNREADABLE (the #346 defect arm)'
    E2 = 'the two identical [] payloads produce DIFFERENT verdicts'
    F = 'a hanging MCP is bounded by the subject itself and reads as unreadable'
    G = '-Json and the human path return the SAME exit code (#347)'
    H = 'unreadable JSON never reports "unread": 0'
    I = 'two accounts with no selector reads as unreadable/ambiguous-account'
  }

  Write-Host ''
  Write-Host $Label
  foreach ($k in @('A', 'B', 'C', 'D', 'E', 'E2', 'F', 'G', 'H', 'I')) {
    $want = ($Expect -contains $k)
    $got = [bool]$res[$k]
    if ($want) {
      Assert $got ("[$k] " + $detail[$k])
    } else {
      Assert (-not $got) ("[$k] MUST FAIL under this mutant - " + $detail[$k])
    }
  }
  return $res
}

$allArms = @('A', 'B', 'C', 'D', 'E', 'E2', 'F', 'G', 'H', 'I')
Test-Arms -ScriptPath $script:Subject -Label 'BASELINE (all guards present)' -Expect $allArms | Out-Null

# ---------------------------------------------------------------- mutations
$src = [IO.File]::ReadAllText($script:Subject, (New-Object Text.UTF8Encoding($false)))

function New-Mutant {
  param([string]$Name, [string]$Needle, [string]$Replacement)
  $hits = ([regex]::Matches($src, [regex]::Escape($Needle))).Count
  if ($hits -ne 1) {
    Write-Host "  FAIL mutation site for $Name matched $hits times (want exactly 1) - the check is stale." -ForegroundColor Red
    $script:failures += "mutation site $Name matched $hits times"
    return $null
  }
  $path = Join-Path $tmp "mutant-$Name.ps1"
  [IO.File]::WriteAllText($path, $src.Replace($Needle, $Replacement), (New-Object Text.UTF8Encoding($false)))
  return $path
}

# M1 -- remove the health gate. The search still answers []; without the gate that []
# becomes a count, which is #346 verbatim.
$m1 = New-Mutant -Name 'M1-health-gate' -Needle '  if (-not $healthy) {' -Replacement '  if ($false) {'
if ($m1) { Test-Arms -ScriptPath $m1 -Label 'M1 health gate disabled (must be killed by E, E2)' -Expect @('A', 'B', 'C', 'D', 'F', 'G', 'H', 'I') | Out-Null }

# M2 -- unbound the call. The subject can then be hung forever by a hung MCP, and only
# this check's own outer kill ends it.
$m2 = New-Mutant -Name 'M2-unbounded' -Needle '$proc.WaitForExit($Budget)' -Replacement '$proc.WaitForExit([int]::MaxValue)'
if ($m2) { Test-Arms -ScriptPath $m2 -Label 'M2 call budget unbounded (must be killed by F)' -Expect @('A', 'B', 'C', 'D', 'E', 'E2', 'G', 'H', 'I') | Out-Null }

# M3 -- report 0 unread for an inbox nobody could read. This rebuilds the exact ambiguity
# one layer up, in this script's own output.
$m3 = New-Mutant -Name 'M3-unread-zero' `
  -Needle "-Verdict 'unreadable' -Reason `$Reason -Detail `$Detail -Unread `$null -ElapsedMs `$ElapsedMs" `
  -Replacement "-Verdict 'unreadable' -Reason `$Reason -Detail `$Detail -Unread 0 -ElapsedMs `$ElapsedMs"
if ($m3) { Test-Arms -ScriptPath $m3 -Label 'M3 unreadable reports unread 0 (must be killed by C, H)' -Expect @('A', 'B', 'D', 'E', 'E2', 'F', 'G', 'I') | Out-Null }

# M4 -- let the -Json path decide its own exit code. This is #347's defect exactly:
# identical data, opposite answers, decided by how the caller asked.
$m4 = New-Mutant -Name 'M4-json-exit' -Needle 'exit $result.exitCode' -Replacement 'if ($Json) { exit 0 } else { exit $result.exitCode }'
if ($m4) { Test-Arms -ScriptPath $m4 -Label 'M4 -Json path picks its own exit code (must be killed by C, E, F, G, I)' -Expect @('A', 'B', 'D', 'E2', 'H') | Out-Null }

# M5 -- CONTROL. A comment-only edit must kill nothing. Without this, a suite that goes
# red on any edit at all would be indistinguishable from one that tests behaviour.
$m5 = New-Mutant -Name 'M5-control' -Needle '# ONE exit, reading the ONE verdict.' -Replacement '# ONE exit, reading the ONE verdict. (control mutation - semantically inert)'
if ($m5) { Test-Arms -ScriptPath $m5 -Label 'M5 CONTROL: comment-only edit (must kill NOTHING)' -Expect $allArms | Out-Null }

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
if ($script:failures.Count -eq 0) {
  Write-Host 'PASS - an unreadable inbox is distinguishable from an empty one, and every guard is load-bearing.' -ForegroundColor Green
  exit 0
}
Write-Host "FAIL - $($script:failures.Count) assertion(s)" -ForegroundColor Red
$script:failures | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
exit 1
