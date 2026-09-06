<#
  mutcheck-google-tasks.ps1 -- prove that collect-google-tasks.ps1 can tell a backlog it
  only PARTLY READ from a backlog that is genuinely small, and that each guard doing so is
  load-bearing rather than decorative.

  WHY THIS EXISTS (GH #524)
  -------------------------
  PHASE 2 step 2 collects open Google Tasks as planner candidates. Its old implementation
  was a bare `list_tasks {task_list_id:'@default'}`, and the Google Tasks API caps a page
  at 20 by default. So a run that could only see the first page reported exactly what a
  run that saw everything and found little would report, and 26 of 35 open tasks vanished
  with no error anywhere -- worse, they vanished as a BURN-DOWN: "he cleared his backlog".

  THE HARD PART IS THAT BOTH SHAPES LOOK IDENTICAL. Arms B and E below are the two rows of
  the issue's own table: the SAME account, the SAME list, the SAME 35 tasks, one argument
  apart. They must produce OPPOSITE verdicts. If a paged read and a complete read ever
  agree, this defect is back.

    | call                                                        | returned | open |
    | list_tasks {task_list_id:'@default'}                        |       20 |    9 |
    | list_tasks {..., max_results:100, show_completed:false}     |       35 |   35 |

  ARMS
    A  short backlog, complete       -> complete, open 9, exit 0
    B  35 open, page size 100        -> complete, open 35, exit 0
    C  MCP absent/dead               -> unreadable, open NULL, exit 2, wrap-up says NOT READ
    D  35 open, page size 20, the    -> complete, open 35, in 2 PAGES. The token is followed,
       server DOES page                 not counted as an end.
    E  35 open, page size 20, the    -> TRUNCATED. THE DEFECT ARM: a full page with no way to
       server does NOT page             continue is presumed truncated, open NULL, exit 2.
    E2 B vs E                        -> the two reads of the SAME 35 tasks must DISAGREE.
    F  the MCP hangs                 -> unreadable within the budget. Cannot hang a run.
    G  -Json vs human                -> same verdict and the SAME EXIT CODE (#347's rule).
    H  a read that did not complete  -> never reports a NUMBER for `open`. Null, or the
                                        ambiguity is simply rebuilt one layer up.
    I  two task lists                -> BOTH are read; the total is 9+12, listsRead is 2.
                                        "@default" is not the backlog.
    J  35 open + 80 completed        -> show_completed:false keeps the completed items out of
                                        the page budget. Without it the same call truncates.

  MUTATIONS (each must be killed by a NAMED arm, and must not disturb the others)
    M1 the truncation gate disabled   -> killed by E, E2, H
    M2 nextPageToken not followed     -> killed by D
    M3 a partial sum reported as the
       total instead of null          -> killed by E, H
    M4 the -Json path picks its own
       exit code                      -> killed by C, E, F, G
    M5 only the first task list read  -> killed by I
    M6 show_completed omitted         -> killed by J
    M7 CONTROL: a comment-only edit   -> kills NOTHING. Without this arm, a suite that fails
                                         on any edit at all would look identical to one that
                                         tests behaviour.

  Usage: powershell -NoProfile -ExecutionPolicy Bypass -File mutcheck-google-tasks.ps1
  Exit:  0 every assertion holds - 1 a guard is not doing what it claims.
#>
[CmdletBinding()]
param([string]$Target)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# Resolve the script under test by SEARCH and PRINT what was measured (#251): a guard that
# is absent and a guard that is passing look identical from the outside. The $PSScriptRoot
# form is deliberate -- sync-oa-home.ps1's rule 5 reads exactly that shape to work out
# which subject must be deployed alongside this guard.
$candidates = @(
  $Target,
  (Join-Path $PSScriptRoot 'collect-google-tasks.ps1'),
  (Join-Path $here 'collect-google-tasks.ps1'),
  (Join-Path $here 'skills/overnight-agent/collect-google-tasks.ps1'),
  (Join-Path $here '../skills/overnight-agent/collect-google-tasks.ps1')
) | Where-Object { $_ }
if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'overnight-agent/collect-google-tasks.ps1') }

$script:Subject = $null
foreach ($c in $candidates) { if (Test-Path -LiteralPath $c) { $script:Subject = (Resolve-Path -LiteralPath $c).Path; break } }
if (-not $script:Subject) { Write-Host 'FAIL - collect-google-tasks.ps1 not found' -ForegroundColor Red; exit 1 }

# The fixtures are node scripts standing in for mcp-probe.mjs, so the real spawn, quoting,
# budget, parse, paging and verdict path all execute. Refusing to run without node is
# deliberate: a check that self-skips reports green while asserting nothing, which is the
# defect class this whole suite exists to catch.
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

Write-Host "[mutcheck-gtasks] subject = $script:Subject"
Write-Host "[mutcheck-gtasks] host    = $psHost"
Write-Host "[mutcheck-gtasks] node    = $($node.Source)"

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("oa-gtasks-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

# ---------------------------------------------------------------- fixtures
$fixtureJs = @'
// Stands in for mcp-probe.mjs. argv: <server> <action> <stepsJson>
// Scenario comes from OA_FIXTURE. Emits exactly the shape mcp-probe.mjs `calls` emits:
// one array, element i being { result } or { error } for step i.
//
// The fixture models the ACTUAL Google Tasks semantics that caused #524:
//   * max_results caps the page, and the cap is silent - no flag, no warning;
//   * when show_completed is not explicitly false, COMPLETED tasks share the page budget
//     (11 of the 20 slots in the live 2026-09-05 read), and they sort first;
//   * a server may or may not hand back a nextPageToken.
const scenario = process.env.OA_FIXTURE || 'small';
const action = process.argv[3];
const steps = action === 'calls' ? JSON.parse(process.argv[4] || '[]') : [];

if (scenario === 'dead') {
  process.stderr.write('PROBE FAILED: failed to connect to MCP server "google-workspace": initialize handshake did not complete\n');
  process.exit(1);
}
if (scenario === 'hang') {
  setInterval(() => {}, 1000);   // never exits; the caller's budget must end this
} else {
  const wrap = (obj) => ({ result: { content: [{ type: 'text', text: JSON.stringify(obj) }] } });
  const mk = (n, prefix, status) =>
    Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i + 1}`, title: `${prefix} task ${i + 1}`, status }));

  // scenario -> { lists, open per list, completed per list, paging }
  const SPEC = {
    'small':        { lists: [['@default', 'My Tasks']], open: { '@default': 9 },  done: {}, paged: false },
    'tokenless-35': { lists: [['@default', 'My Tasks']], open: { '@default': 35 }, done: {}, paged: false },
    'paged-35':     { lists: [['@default', 'My Tasks']], open: { '@default': 35 }, done: {}, paged: true },
    'two-lists':    { lists: [['@default', 'My Tasks'], ['work', 'Work']],
                      open: { '@default': 9, 'work': 12 }, done: {}, paged: false },
    'budget-waste': { lists: [['@default', 'My Tasks']], open: { '@default': 35 },
                      done: { '@default': 80 }, paged: false },
  };
  const spec = SPEC[scenario] || SPEC['small'];

  const out = steps.map((s) => {
    const a = s.arguments || {};
    if (s.name === 'list_task_lists') {
      return wrap({ items: spec.lists.map(([id, title]) => ({ id, title })) });
    }
    if (s.name === 'list_tasks') {
      const listId = a.task_list_id;
      if (!(listId in spec.open)) return { error: { code: -32602, message: 'unknown task list ' + listId } };

      // THE DEFAULT THAT CAUSED #524. A caller that names no page size gets 20.
      const maxResults = Number.isFinite(Number(a.max_results)) && Number(a.max_results) > 0
        ? Number(a.max_results) : 20;

      const openItems = mk(spec.open[listId] || 0, 'open-' + listId, 'needsAction');
      const doneItems = mk(spec.done[listId] || 0, 'done-' + listId, 'completed');
      // show_completed must be EXPLICITLY false to keep completed items off the page.
      const pool = a.show_completed === false ? openItems : doneItems.concat(openItems);

      const start = a.page_token ? Number(a.page_token) : 0;
      const slice = pool.slice(start, start + maxResults);
      const body = { items: slice };
      if (spec.paged && start + maxResults < pool.length) body.nextPageToken = String(start + maxResults);
      return wrap(body);
    }
    return { error: { code: -32601, message: 'unknown tool ' + s.name } };
  });
  console.log(JSON.stringify(out, null, 2));
}
'@
$fixturePath = Join-Path $tmp 'fixture-prober.mjs'
[IO.File]::WriteAllText($fixturePath, $fixtureJs, (New-Object Text.UTF8Encoding($false)))

# ---------------------------------------------------------------- runner
function Invoke-Subject {
  param(
    [string]$ScriptPath,
    [string]$Scenario,
    [int]$PageSize = 100,
    [switch]$AsJson,
    [int]$TimeoutSec = 20,
    [int]$OuterKillMs = 60000
  )

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $psHost
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath,
               '-Account', 'agent@example.invalid',
               '-ProberCommand', $node.Source, '-ProberScript', $fixturePath,
               '-PageSize', "$PageSize", '-TimeoutSec', "$TimeoutSec")
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

  # The mutcheck bounds the SUBJECT too, because a mutant that removes the subject's own
  # bound would otherwise hang this check forever. `Killed` is the signal that the subject
  # failed to bound itself.
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

# ---------------------------------------------------------------- arms
function Test-Arms {
  param([string]$ScriptPath, [string]$Label, [string[]]$Expect)
  # $Expect names the arms that must PASS. Any arm not listed is expected to FAIL, which is
  # how a mutation is proven to be killed by a SPECIFIC arm rather than by "something went
  # red somewhere".
  $res = @{}

  $a = Invoke-Subject -ScriptPath $ScriptPath -Scenario 'small' -PageSize 100 -AsJson
  $res['A'] = ($a.Json -and $a.Json.verdict -eq 'complete' -and [int]$a.Json.open -eq 9 -and $a.ExitCode -eq 0)

  $b = Invoke-Subject -ScriptPath $ScriptPath -Scenario 'tokenless-35' -PageSize 100 -AsJson
  $res['B'] = ($b.Json -and $b.Json.verdict -eq 'complete' -and [int]$b.Json.open -eq 35 -and $b.ExitCode -eq 0)

  $c = Invoke-Subject -ScriptPath $ScriptPath -Scenario 'dead' -PageSize 100 -AsJson
  $res['C'] = ($c.Json -and $c.Json.verdict -eq 'unreadable' -and $null -eq $c.Json.open -and
               $c.ExitCode -eq 2 -and $c.Json.ask -eq $true -and $c.Json.wrapUp -clike '*NOT READ*')

  $d = Invoke-Subject -ScriptPath $ScriptPath -Scenario 'paged-35' -PageSize 20 -AsJson
  $dPages = 0
  if ($d.Json) { $dPages = [int](@($d.Json.lists)[0].pages) }
  $res['D'] = ($d.Json -and $d.Json.verdict -eq 'complete' -and [int]$d.Json.open -eq 35 -and
               $d.ExitCode -eq 0 -and $dPages -eq 2)

  $e = Invoke-Subject -ScriptPath $ScriptPath -Scenario 'tokenless-35' -PageSize 20 -AsJson
  $res['E'] = ($e.Json -and $e.Json.verdict -eq 'truncated' -and $null -eq $e.Json.open -and
               $e.ExitCode -eq 2 -and $e.Json.wrapUp -clike '*UNKNOWN*')

  # The issue's own table, stated as the assertion: the SAME 35 tasks read two ways must
  # not agree. This is the pairing #524 asks for.
  $res['E2'] = ($b.Json -and $e.Json -and $b.Json.verdict -ne $e.Json.verdict)

  $f = Invoke-Subject -ScriptPath $ScriptPath -Scenario 'hang' -PageSize 100 -AsJson -TimeoutSec 4 -OuterKillMs 45000
  $res['F'] = ((-not $f.Killed) -and $f.Json -and $f.Json.verdict -eq 'unreadable' -and $f.ExitCode -eq 2)

  $gJson = Invoke-Subject -ScriptPath $ScriptPath -Scenario 'dead' -PageSize 100 -AsJson
  $gHuman = Invoke-Subject -ScriptPath $ScriptPath -Scenario 'dead' -PageSize 100
  $res['G'] = ($gJson.ExitCode -eq $gHuman.ExitCode -and $gHuman.StdOut -clike '*NOT READ*')

  # Both incomplete shapes are inspected: neither may put a NUMBER next to "open".
  $res['H'] = (($c.StdOut -notmatch '"open"\s*:\s*\d') -and ($e.StdOut -notmatch '"open"\s*:\s*\d'))

  $i = Invoke-Subject -ScriptPath $ScriptPath -Scenario 'two-lists' -PageSize 100 -AsJson
  $res['I'] = ($i.Json -and $i.Json.verdict -eq 'complete' -and [int]$i.Json.listsRead -eq 2 -and
               [int]$i.Json.open -eq 21 -and $i.ExitCode -eq 0)

  $j = Invoke-Subject -ScriptPath $ScriptPath -Scenario 'budget-waste' -PageSize 100 -AsJson
  $res['J'] = ($j.Json -and $j.Json.verdict -eq 'complete' -and [int]$j.Json.open -eq 35 -and $j.ExitCode -eq 0)

  $detail = @{
    A = 'a genuinely short backlog reads as complete, 9 open, exit 0'
    B = '35 open at page size 100 reads as complete, 35 open, exit 0'
    C = 'a dead MCP reads as unreadable, open NULL, exit 2, wrap-up says NOT READ'
    D = 'a server that pages is FOLLOWED: 35 open in 2 pages of 20, complete, exit 0'
    E = 'a full page with no nextPageToken reads as TRUNCATED, open NULL, exit 2 (the #524 defect arm)'
    E2 = 'the SAME 35 tasks read paged vs complete produce DIFFERENT verdicts'
    F = 'a hanging MCP is bounded by the subject itself and reads as unreadable'
    G = '-Json and the human path return the SAME exit code (#347)'
    H = 'an incomplete read never puts a number next to "open"'
    I = 'every task list is read: listsRead 2, total 9+12=21'
    J = 'show_completed:false keeps 80 completed tasks out of the page budget'
  }

  Write-Host ''
  Write-Host $Label
  foreach ($k in @('A', 'B', 'C', 'D', 'E', 'E2', 'F', 'G', 'H', 'I', 'J')) {
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

$allArms = @('A', 'B', 'C', 'D', 'E', 'E2', 'F', 'G', 'H', 'I', 'J')
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

# M1 -- remove the truncation gate. A full page then reads as the end of the list, which is
# #524 verbatim: 20 come back, 20 is what there is, 9 open becomes a burn-down.
$m1 = New-Mutant -Name 'M1-truncation-gate' -Needle 'if ($page.Count -ge $PageSize) {' -Replacement 'if ($false) {'
if ($m1) { Test-Arms -ScriptPath $m1 -Label 'M1 truncation gate disabled (must be killed by E, E2, H)' -Expect @('A', 'B', 'C', 'D', 'F', 'G', 'I', 'J') | Out-Null }

# M2 -- stop following nextPageToken. The first page becomes the answer even when the
# server explicitly said there was more.
$m2 = New-Mutant -Name 'M2-no-paging' -Needle 'if ($token) { continue }' -Replacement 'if ($token) { $token = $null }'
if ($m2) { Test-Arms -ScriptPath $m2 -Label 'M2 nextPageToken not followed (must be killed by D)' -Expect @('A', 'B', 'C', 'E', 'E2', 'F', 'G', 'H', 'I', 'J') | Out-Null }

# M3 -- report the partial sum as the total. This is the most dangerous single line in the
# subject: the number is plausible, checkable and wrong, and it rebuilds the exact ambiguity
# one layer up, in the collector's own output.
$m3 = New-Mutant -Name 'M3-partial-sum' -Needle "if (`$worst -eq 'complete') { `$total = `$running }" -Replacement '$total = $running'
if ($m3) { Test-Arms -ScriptPath $m3 -Label 'M3 a partial sum reported as the total (must be killed by E, H)' -Expect @('A', 'B', 'C', 'D', 'E2', 'F', 'G', 'I', 'J') | Out-Null }

# M4 -- let the -Json path decide its own exit code. #347's defect exactly: identical data,
# opposite answers, decided by how the caller asked.
$m4 = New-Mutant -Name 'M4-json-exit' -Needle 'exit $result.exitCode' -Replacement 'if ($Json) { exit 0 } else { exit $result.exitCode }'
if ($m4) { Test-Arms -ScriptPath $m4 -Label 'M4 -Json path picks its own exit code (must be killed by C, E, F, G)' -Expect @('A', 'B', 'D', 'E2', 'H', 'I', 'J') | Out-Null }

# M5 -- read only the first task list. "@default" is not the backlog, and a second list is
# invisible in exactly the way a second page is.
$m5 = New-Mutant -Name 'M5-first-list-only' -Needle 'foreach ($l in $listRows) {' -Replacement 'foreach ($l in @($listRows | Select-Object -First 1)) {'
if ($m5) { Test-Arms -ScriptPath $m5 -Label 'M5 only the first task list is read (must be killed by I)' -Expect @('A', 'B', 'C', 'D', 'E', 'E2', 'F', 'G', 'H', 'J') | Out-Null }

# M6 -- omit show_completed. Completed tasks then share the page budget, which is how a 43%
# shortfall in TASKS became a 74% shortfall in OPEN tasks in the live read.
$m6 = New-Mutant -Name 'M6-show-completed' -Needle "    `$taskArgs['show_completed'] = `$false" -Replacement '    # show_completed omitted (mutant)'
if ($m6) { Test-Arms -ScriptPath $m6 -Label 'M6 show_completed omitted (must be killed by J)' -Expect @('A', 'B', 'C', 'D', 'E', 'E2', 'F', 'G', 'H', 'I') | Out-Null }

# M7 -- CONTROL. A comment-only edit must kill nothing. Without this, a suite that goes red
# on any edit at all would be indistinguishable from one that tests behaviour.
$m7 = New-Mutant -Name 'M7-control' -Needle '# ONE exit, reading the ONE verdict.' -Replacement '# ONE exit, reading the ONE verdict. (control mutation - semantically inert)'
if ($m7) { Test-Arms -ScriptPath $m7 -Label 'M7 CONTROL: comment-only edit (must kill NOTHING)' -Expect $allArms | Out-Null }

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
if ($script:failures.Count -eq 0) {
  Write-Host 'PASS - a truncated Google Tasks read is distinguishable from a small backlog, and every guard is load-bearing.' -ForegroundColor Green
  exit 0
}
Write-Host "FAIL - $($script:failures.Count) assertion(s)" -ForegroundColor Red
$script:failures | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
exit 1
