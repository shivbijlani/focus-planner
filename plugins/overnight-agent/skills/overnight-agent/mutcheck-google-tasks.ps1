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
    K  every tool name SENT is a     -> THE #554 ARM. The fixture records what it was asked for
       tool name ADVERTISED             and answers only to what it advertises, so an invented
                                        tool name is visible to CI instead of only to 5am.
    L  no list-enumeration tool      -> @default is STILL read: partial, open NULL,
       (the live google-workspace)      defaultListOpen 70, listsRead 1, exit 2.
    L2 partial vs unreadable vs      -> all three verdicts differ. A capability gap, a dead
       complete                         server and a finished read must not share a word.
    L3 lists tool advertised but     -> same capability fact, one layer later: partial, not a
       answering "Unknown tool"         transport error.
    M  -DefaultListOnly              -> the SAME read becomes complete: 70 open, exit 0.
    N  the user-settings.md row      -> ditto, durably.
    O  a payload in NEITHER shape    -> still UNREADABLE. The prose reader must never turn
                                        "I did not understand" into "the backlog is empty".

  MUTATIONS (each must be killed by a NAMED arm, and must not disturb the others)
    M1 the truncation gate disabled   -> killed by E, E2, H
    M2 nextPageToken not followed     -> killed by D
    M3 a partial sum reported as the
       total instead of null          -> killed by E, H, L, L3, O
    M4 the -Json path picks its own
       exit code                      -> killed by C, E, F, G, L, L3, O
    M5 only the first task list read  -> killed by I
    M6 show_completed omitted         -> killed by J
    M7 CONTROL: a comment-only edit   -> kills NOTHING. Without this arm, a suite that fails
                                         on any edit at all would look identical to one that
                                         tests behaviour.
    M8 a tool sent without checking
       the server advertises it       -> killed by K ONLY (#553 verbatim; every behavioural
                                         arm stays green, which is why it shipped)
    M9 "Unknown tool" read as a
       transport error                -> killed by L3
    M10 a degraded read reported as
        complete                      -> killed by L, L2, L3
    M11 -DefaultListOnly / the row
        ignored                       -> killed by M, N
    M12 only the switch honoured, not
        the durable settings row      -> killed by N
    M13 the live PROSE shape not
        understood                    -> killed by L, L2, L3, M, N
    M14 an unrecognised payload read
        as an empty backlog           -> killed by O

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
// Scenario comes from OA_FIXTURE. Emits exactly the shape mcp-probe.mjs emits:
//   `list`  -> one JSON array of advertised tool NAMES
//   `calls` -> one array, element i being { result } or { error } for step i.
//
// The fixture models the ACTUAL Google Tasks semantics that caused #524:
//   * max_results caps the page, and the cap is silent - no flag, no warning;
//   * when show_completed is not explicitly false, COMPLETED tasks share the page budget
//     (11 of the 20 slots in the live 2026-09-05 read), and they sort first;
//   * a server may or may not hand back a nextPageToken.
// ...and the one that caused #554:
//   * a server answers ONLY to the tools it advertises, and a name it has never heard of
//     comes back as { isError: true, content: [{ text: "Unknown tool: 'x'" }] } -- which is
//     a CAPABILITY fact, not a transport failure. The live google-workspace server
//     advertises list_tasks, get_task, manage_task and NO list-enumeration tool at all.
// Every tool name the subject sends is appended to OA_FIXTURE_LOG, so the guard can assert
// that the subject never invents one. That assertion is the whole of #554.
import { appendFileSync } from 'node:fs';

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
  // THE SHAPE THE LIVE SERVER RETURNS (measured 2026-09-06). google-workspace's list_tasks
  // answers in PROSE, not JSON -- and #553 never found that out because it died one call
  // earlier on a tool name that did not exist. The scenarios modelled on the live server use
  // this; the #524 scenarios keep the JSON envelope, so both shapes stay covered.
  const prose = (listId, email, items) => {
    const body = items.map((t) =>
      `- ${t.title} (ID: ${t.id})\n  Status: ${t.status}\n  Updated: 2026-09-01T00:00:00.000Z\n`).join('\n');
    const text = `Tasks in list ${listId} for ${email}:\n${body}`;
    return { result: { content: [{ type: 'text', text }], structuredContent: { result: text } } };
  };
  const unknownTool = (name) => ({
    result: { content: [{ type: 'text', text: `Unknown tool: '${name}'` }], isError: true },
  });
  const mk = (n, prefix, status) =>
    Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i + 1}`, title: `${prefix} task ${i + 1}`, status }));

  // A server that CAN enumerate lists, and the live one that cannot.
  const WITH_LISTS = ['list_task_lists', 'list_tasks', 'get_task', 'manage_task'];
  const NO_LISTS = ['list_tasks', 'get_task', 'manage_task'];

  // scenario -> { tools, lists, open per list, completed per list, paging, phantom }
  // `phantom` = advertised but not answered to (a server that lies about its own surface).
  const SPEC = {
    'small':        { tools: WITH_LISTS, lists: [['@default', 'My Tasks']], open: { '@default': 9 },  done: {}, paged: false },
    'tokenless-35': { tools: WITH_LISTS, lists: [['@default', 'My Tasks']], open: { '@default': 35 }, done: {}, paged: false },
    'paged-35':     { tools: WITH_LISTS, lists: [['@default', 'My Tasks']], open: { '@default': 35 }, done: {}, paged: true },
    'two-lists':    { tools: WITH_LISTS, lists: [['@default', 'My Tasks'], ['work', 'Work']],
                      open: { '@default': 9, 'work': 12 }, done: {}, paged: false },
    'budget-waste': { tools: WITH_LISTS, lists: [['@default', 'My Tasks']], open: { '@default': 35 },
                      done: { '@default': 80 }, paged: false },
    // THE LIVE SERVER, 2026-09-06: no list-enumeration tool exists, @default holds 70 open,
    // and the answer comes back as PROSE rather than JSON.
    'no-lists-tool': { tools: NO_LISTS, shape: 'prose', lists: [['@default', 'My Tasks']], open: { '@default': 70 }, done: {}, paged: false },
    // Advertised, but answers "Unknown tool" anyway. Same capability fact, one layer later.
    'phantom-lists-tool': { tools: WITH_LISTS, phantom: ['list_task_lists'], shape: 'prose',
                      lists: [['@default', 'My Tasks']], open: { '@default': 70 }, done: {}, paged: false },
    // A payload in NEITHER shape. "I did not understand" must never become "nothing here".
    'gibberish':    { tools: NO_LISTS, shape: 'gibberish', lists: [['@default', 'My Tasks']],
                      open: { '@default': 70 }, done: {}, paged: false },
  };
  const spec = SPEC[scenario] || SPEC['small'];
  const advertised = spec.tools;
  const phantom = spec.phantom || [];

  if (action === 'list') {
    console.log(JSON.stringify(advertised, null, 2));
  } else {
    const out = steps.map((s) => {
      // Record what was ASKED FOR, before deciding whether it exists. A guard that only saw
      // successful calls could not tell an invented tool name from a missing one.
      if (process.env.OA_FIXTURE_LOG) {
        try { appendFileSync(process.env.OA_FIXTURE_LOG, String(s.name) + '\n'); } catch { /* ignore */ }
      }
      if (!advertised.includes(s.name) || phantom.includes(s.name)) return unknownTool(s.name);

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
        if (spec.shape === 'gibberish') {
          return { result: { content: [{ type: 'text', text: 'I could not work out what you meant by that.' }] } };
        }
        if (spec.shape === 'prose') {
          return prose(listId, a.user_google_email || 'someone@example.invalid', slice);
        }
        const body = { items: slice };
        if (spec.paged && start + maxResults < pool.length) body.nextPageToken = String(start + maxResults);
        return wrap(body);
      }
      return unknownTool(s.name);
    });
    console.log(JSON.stringify(out, null, 2));
  }
}
'@
$fixturePath = Join-Path $tmp 'fixture-prober.mjs'
[IO.File]::WriteAllText($fixturePath, $fixtureJs, (New-Object Text.UTF8Encoding($false)))

# ---------------------------------------------------------------- runner
function Get-AdvertisedForScenario {
  param([string]$Scenario)
  # Asked of the FIXTURE, never hard-coded here: a second copy of the tool list in this file
  # could drift from the one the subject is actually talking to, and then the guard would be
  # asserting against a server that does not exist -- which is #554's own defect wearing a
  # test's clothes.
  # 'dead' never answers and 'hang' never exits, so neither can be asked; there is nothing to
  # prove about tool names when no tool list was ever obtainable.
  if ($Scenario -eq 'dead' -or $Scenario -eq 'hang') { return $null }
  if ($script:AdvCache.ContainsKey($Scenario)) { return $script:AdvCache[$Scenario] }

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $node.Source
  $psi.Arguments = (@($fixturePath, 'google-workspace', 'list') | ForEach-Object { '"' + $_ + '"' }) -join ' '
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.EnvironmentVariables['OA_FIXTURE'] = $Scenario
  $out = $null
  try {
    $p = [System.Diagnostics.Process]::Start($psi)
    $t = $p.StandardOutput.ReadToEndAsync()
    if (-not $p.WaitForExit(15000)) { try { $p.Kill() } catch { } }
    if ($t.Wait(3000)) { $out = @((ConvertFrom-Json $t.Result)) }
  } catch { $out = $null }
  $script:AdvCache[$Scenario] = $out
  return $out
}
$script:AdvCache = @{}

function Invoke-Subject {
  param(
    [string]$ScriptPath,
    [string]$Scenario,
    [int]$PageSize = 100,
    [switch]$AsJson,
    [int]$TimeoutSec = 20,
    [int]$OuterKillMs = 60000,
    [string[]]$ExtraArgs = @(),
    [string]$SettingsPath
  )

  # G11's settings row is resolved from several places, one of which is the author's real
  # `%USERPROFILE%\OneDrive\Apps\Focus Planner\user-settings.md`. Every arm therefore names a
  # settings file EXPLICITLY -- a nonexistent one unless the arm is testing the row -- so no
  # result here can depend on how the machine running the check happens to be configured.
  if (-not $SettingsPath) { $SettingsPath = (Join-Path $tmp 'no-such-user-settings.md') }

  # G8's evidence: every tool name the subject asks for is recorded, whether or not the
  # server has it, so an INVENTED name is visible to the guard instead of only to production.
  $callLog = Join-Path $tmp ("calls-" + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.txt')

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $psHost
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath,
               '-Account', 'agent@example.invalid',
               '-ProberCommand', $node.Source, '-ProberScript', $fixturePath,
               '-PageSize', "$PageSize", '-TimeoutSec', "$TimeoutSec",
               '-UserSettings', $SettingsPath)
  $argList += @($ExtraArgs)
  if ($AsJson) { $argList += '-Json' }
  $psi.Arguments = (($argList | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' ')
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.EnvironmentVariables['OA_FIXTURE'] = $Scenario
  $psi.EnvironmentVariables['OA_FIXTURE_LOG'] = $callLog
  $psi.WorkingDirectory = $tmp

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

  # G8 -- THE ARM #553 NEEDED. Every name the subject asked for, checked against what this
  # server says it has. A mock answers to any name, so without this the guard can only ever
  # prove the subject's REASONING, never that it is talking to a real surface.
  $asked = @()
  if (Test-Path -LiteralPath $callLog) {
    $asked = @([IO.File]::ReadAllLines($callLog) | Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_.Trim() } | Sort-Object -Unique)
  }
  $advertised = Get-AdvertisedForScenario -Scenario $Scenario
  $unadvertised = @()
  if ($null -ne $advertised) {
    $unadvertised = @($asked | Where-Object { $advertised -notcontains $_ })
  }

  return [pscustomobject]@{
    ExitCode = $code; StdOut = $stdout; Json = $json; Killed = $killed; ElapsedMs = $sw.ElapsedMilliseconds
    Asked = $asked; Unadvertised = $unadvertised
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

  # ---- #554 ----------------------------------------------------------------------------
  # L. THE LIVE SERVER. google-workspace exposes list_tasks / get_task / manage_task and no
  # list-enumeration tool at all. The collector must READ @default anyway rather than dying,
  # and must not claim a total it cannot have.
  $l = Invoke-Subject -ScriptPath $ScriptPath -Scenario 'no-lists-tool' -PageSize 100 -AsJson
  $res['L'] = ($l.Json -and $l.Json.verdict -eq 'partial' -and $l.Json.reason -eq 'lists-tool-unavailable' -and
               $null -eq $l.Json.open -and [int]$l.Json.defaultListOpen -eq 70 -and
               [int]$l.Json.listsRead -eq 1 -and $l.ExitCode -eq 2)

  # L2. `partial` is its OWN verdict. #554 happened because a capability gap and a transport
  # failure shared one word; a degraded read must be confusable with neither neighbour.
  $res['L2'] = ($l.Json -and $l.Json.verdict -ne 'unreadable' -and $l.Json.verdict -ne 'complete' -and
                $c.Json -and $l.Json.verdict -ne $c.Json.verdict -and
                $a.Json -and $l.Json.verdict -ne $a.Json.verdict)

  # L3. Advertised but not answered to. An "Unknown tool" reply is the same CAPABILITY fact
  # as an absent one -- not a transport error, which is what #553 read it as.
  $l3 = Invoke-Subject -ScriptPath $ScriptPath -Scenario 'phantom-lists-tool' -PageSize 100 -AsJson
  $res['L3'] = ($l3.Json -and $l3.Json.verdict -eq 'partial' -and $l3.Json.reason -eq 'lists-tool-unavailable' -and
                $null -eq $l3.Json.open -and [int]$l3.Json.defaultListOpen -eq 70 -and $l3.ExitCode -eq 2)

  # M. THE ONE-TIME ANSWER, as a switch. Once the user says the default list IS the backlog,
  # the same read becomes genuinely complete: a real total, exit 0. A permanent exit 2 that
  # nobody can clear is alarm fatigue, and alarm fatigue is how a real truncation is ignored.
  $m = Invoke-Subject -ScriptPath $ScriptPath -Scenario 'no-lists-tool' -PageSize 100 -AsJson -ExtraArgs @('-DefaultListOnly')
  $res['M'] = ($m.Json -and $m.Json.verdict -eq 'complete' -and [int]$m.Json.open -eq 70 -and $m.ExitCode -eq 0)

  # N. The same answer, as the user-settings.md row, which is where a durable one belongs.
  $settings = Join-Path $tmp ('settings-' + [guid]::NewGuid().ToString('N').Substring(0, 6) + '.md')
  [IO.File]::WriteAllText($settings, "# user settings`r`n`r`n| Setting | Value |`r`n| --- | --- |`r`n| Google Tasks lists | ``default only`` |`r`n", (New-Object Text.UTF8Encoding($false)))
  $n = Invoke-Subject -ScriptPath $ScriptPath -Scenario 'no-lists-tool' -PageSize 100 -AsJson -SettingsPath $settings
  $res['N'] = ($n.Json -and $n.Json.verdict -eq 'complete' -and [int]$n.Json.open -eq 70 -and $n.ExitCode -eq 0)

  # O. A payload in NEITHER shape must stay UNREADABLE. The prose reader added for #554 is the
  # easiest place in this file to turn "I did not understand" into "the backlog is empty", and
  # that substitution IS the bug class the whole file exists to prevent.
  $o = Invoke-Subject -ScriptPath $ScriptPath -Scenario 'gibberish' -PageSize 100 -AsJson
  $res['O'] = ($o.Json -and $o.Json.verdict -eq 'unreadable' -and $o.Json.reason -eq 'unparsable' -and
               $null -eq $o.Json.open -and $null -eq $o.Json.defaultListOpen -and $o.ExitCode -eq 2)

  # K. THE ARM THAT WOULD HAVE CAUGHT #553. Across every scenario above, the subject may only
  # send tool names the server advertises. A mock answers to anything, so a suite that never
  # compares the names it was asked for against the names that exist cannot see an invented
  # tool -- which is precisely how `list_task_lists` shipped, went green and never once ran.
  $reads = @($a, $b, $d, $e, $i, $j, $l, $l3, $m, $n, $o)
  $bogus = @()
  foreach ($r in $reads) { if ($r) { $bogus += @($r.Unadvertised) } }
  $bogus = @($bogus | Sort-Object -Unique)
  if ($bogus.Count -gt 0) { Write-Host ("       tool names sent but NOT advertised: " + ($bogus -join ', ')) -ForegroundColor DarkYellow }
  $res['K'] = ($bogus.Count -eq 0 -and @($a.Asked).Count -gt 0)

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
    K = 'every tool name the collector sends is one the server ADVERTISES (the #553 arm)'
    L = 'no list-enumeration tool: @default is still read - partial, open NULL, defaultListOpen 70, exit 2'
    L2 = '"partial" is distinct from BOTH "unreadable" and "complete" (the #554 confusion)'
    L3 = 'a lists tool that answers "Unknown tool" is a capability fact, not a transport error'
    M = '-DefaultListOnly turns the same read into a COMPLETE one: 70 open, exit 0'
    N = 'the user-settings.md row "Google Tasks lists = default only" does the same'
    O = 'a payload in neither JSON nor the live prose shape stays UNREADABLE, never an empty backlog'
  }

  Write-Host ''
  Write-Host $Label
  foreach ($k in @('A', 'B', 'C', 'D', 'E', 'E2', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'L2', 'L3', 'M', 'N', 'O')) {
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

$allArms = @('A', 'B', 'C', 'D', 'E', 'E2', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'L2', 'L3', 'M', 'N', 'O')
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
if ($m1) { Test-Arms -ScriptPath $m1 -Label 'M1 truncation gate disabled (must be killed by E, E2, H)' -Expect @('A', 'B', 'C', 'D', 'F', 'G', 'I', 'J', 'K', 'L', 'L2', 'L3', 'M', 'N', 'O') | Out-Null }

# M2 -- stop following nextPageToken. The first page becomes the answer even when the
# server explicitly said there was more.
$m2 = New-Mutant -Name 'M2-no-paging' -Needle 'if ($token) { continue }' -Replacement 'if ($token) { $token = $null }'
if ($m2) { Test-Arms -ScriptPath $m2 -Label 'M2 nextPageToken not followed (must be killed by D)' -Expect @('A', 'B', 'C', 'E', 'E2', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'L2', 'L3', 'M', 'N', 'O') | Out-Null }

# M3 -- report the partial sum as the total. This is the most dangerous single line in the
# subject: the number is plausible, checkable and wrong, and it rebuilds the exact ambiguity
# one layer up, in the collector's own output.
$m3 = New-Mutant -Name 'M3-partial-sum' -Needle "if (`$worst -eq 'complete') { `$total = `$running }" -Replacement '$total = $running'
if ($m3) { Test-Arms -ScriptPath $m3 -Label 'M3 a partial sum reported as the total (must be killed by E, H, L, L3, O)' -Expect @('A', 'B', 'C', 'D', 'E2', 'F', 'G', 'I', 'J', 'K', 'L2', 'M', 'N') | Out-Null }

# M4 -- let the -Json path decide its own exit code. #347's defect exactly: identical data,
# opposite answers, decided by how the caller asked.
$m4 = New-Mutant -Name 'M4-json-exit' -Needle 'exit $result.exitCode' -Replacement 'if ($Json) { exit 0 } else { exit $result.exitCode }'
if ($m4) { Test-Arms -ScriptPath $m4 -Label 'M4 -Json path picks its own exit code (must be killed by C, E, F, G, L, L3, O)' -Expect @('A', 'B', 'D', 'E2', 'H', 'I', 'J', 'K', 'L2', 'M', 'N') | Out-Null }

# M5 -- read only the first task list. "@default" is not the backlog, and a second list is
# invisible in exactly the way a second page is.
$m5 = New-Mutant -Name 'M5-first-list-only' -Needle 'foreach ($l in $listRows) {' -Replacement 'foreach ($l in @($listRows | Select-Object -First 1)) {'
if ($m5) { Test-Arms -ScriptPath $m5 -Label 'M5 only the first task list is read (must be killed by I)' -Expect @('A', 'B', 'C', 'D', 'E', 'E2', 'F', 'G', 'H', 'J', 'K', 'L', 'L2', 'L3', 'M', 'N', 'O') | Out-Null }

# M6 -- omit show_completed. Completed tasks then share the page budget, which is how a 43%
# shortfall in TASKS became a 74% shortfall in OPEN tasks in the live read.
$m6 = New-Mutant -Name 'M6-show-completed' -Needle "    `$taskArgs['show_completed'] = `$false" -Replacement '    # show_completed omitted (mutant)'
if ($m6) { Test-Arms -ScriptPath $m6 -Label 'M6 show_completed omitted (must be killed by J)' -Expect @('A', 'B', 'C', 'D', 'E', 'E2', 'F', 'G', 'H', 'I', 'K', 'L', 'L2', 'L3', 'M', 'N', 'O') | Out-Null }

# M7 -- CONTROL. A comment-only edit must kill nothing. Without this, a suite that goes red
# on any edit at all would be indistinguishable from one that tests behaviour.
$m7 = New-Mutant -Name 'M7-control' -Needle '# ONE exit, reading the ONE verdict.' -Replacement '# ONE exit, reading the ONE verdict. (control mutation - semantically inert)'
if ($m7) { Test-Arms -ScriptPath $m7 -Label 'M7 CONTROL: comment-only edit (must kill NOTHING)' -Expect $allArms | Out-Null }

# ---------------------------------------------------------------- #554 mutations
# M8 -- THE #553 MUTATION. Send the lists tool without first checking the server has it.
# On a server that does have it nothing changes, which is exactly why this went unnoticed:
# the defect is invisible everywhere except against the surface that actually exists. Note
# what this must NOT do -- the run still finishes as `partial`, so every behavioural arm
# stays green and ONLY K goes red. That is what makes K load-bearing rather than incidental.
$m8 = New-Mutant -Name 'M8-unadvertised-tool' `
  -Needle 'if ($cand -and ($advertised -contains $cand)) { $listsTool = $cand; break }' `
  -Replacement 'if ($cand) { $listsTool = $cand; break }'
if ($m8) { Test-Arms -ScriptPath $m8 -Label 'M8 a tool name sent without checking the server advertises it (must be killed by K)' -Expect @('A', 'B', 'C', 'D', 'E', 'E2', 'F', 'G', 'H', 'I', 'J', 'L', 'L2', 'L3', 'M', 'N', 'O') | Out-Null }

# M9 -- read "Unknown tool" as a transport error again. This is #553's actual behaviour:
# a permanent capability fact wearing a retryable failure's costume, so the collector dies
# with listsRead: 0 instead of reading the list it CAN read.
$m9 = New-Mutant -Name 'M9-unknown-is-fatal' `
  -Needle "if (`$step.Reason -eq 'unknown-tool') { `$v = 'unavailable' }" `
  -Replacement '# unknown-tool treated as a transport failure (mutant)'
if ($m9) { Test-Arms -ScriptPath $m9 -Label 'M9 an Unknown-tool reply treated as a transport error (must be killed by L3)' -Expect @('A', 'B', 'C', 'D', 'E', 'E2', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'L2', 'M', 'N', 'O') | Out-Null }

# M10 -- a degraded read reported as a complete one. The single most dangerous line of the
# #554 fix: it would put a REAL-LOOKING TOTAL on a read that could not see how many lists
# there were, which is #524's own defect rebuilt one layer up.
$m10 = New-Mutant -Name 'M10-partial-is-complete' -Needle "    `$worst = 'partial'" -Replacement "    `$worst = 'complete'"
if ($m10) { Test-Arms -ScriptPath $m10 -Label 'M10 a degraded read reported as complete (must be killed by L, L2, L3)' -Expect @('A', 'B', 'C', 'D', 'E', 'E2', 'F', 'G', 'H', 'I', 'J', 'K', 'M', 'N', 'O') | Out-Null }

# M11 -- the user's one-time answer ignored, so the ask can never be cleared. A warning
# nobody can turn off stops being read, and then the truncation it was guarding is invisible.
$m11 = New-Mutant -Name 'M11-answer-ignored' -Needle 'if ($listsLimited -and $defaultOnly.On) {' -Replacement 'if ($false) {'
if ($m11) { Test-Arms -ScriptPath $m11 -Label 'M11 -DefaultListOnly / the settings row ignored (must be killed by M, N)' -Expect @('A', 'B', 'C', 'D', 'E', 'E2', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'L2', 'L3', 'O') | Out-Null }

# M12 -- only the SWITCH is honoured, not the durable settings row. A setting the user has
# to re-type every night is not a setting.
$m12 = New-Mutant -Name 'M12-settings-row-ignored' `
  -Needle 'return [pscustomobject]@{ On = $true; Source = "user-settings.md ''Google Tasks lists = $v''" }' `
  -Replacement "return [pscustomobject]@{ On = `$false; Source = '' }"
if ($m12) { Test-Arms -ScriptPath $m12 -Label 'M12 the user-settings.md row ignored (must be killed by N)' -Expect @('A', 'B', 'C', 'D', 'E', 'E2', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'L2', 'L3', 'M', 'O') | Out-Null }

# M13 -- the prose reader disabled. The live google-workspace server answers list_tasks in
# PROSE; a subject that only understands JSON reads the real backlog as unreadable. This is
# the second wrong assumption #553 was hiding behind the first.
$m13 = New-Mutant -Name 'M13-no-prose-reader' `
  -Needle 'if ($Payload -is [string]) { return ConvertFrom-TaskProse $Payload }' `
  -Replacement 'if ($Payload -is [string]) { return $null }'
if ($m13) { Test-Arms -ScriptPath $m13 -Label 'M13 the live prose shape not understood (must be killed by L, L2, L3, M, N)' -Expect @('A', 'B', 'C', 'D', 'E', 'E2', 'F', 'G', 'H', 'I', 'J', 'K', 'O') | Out-Null }

# M14 -- the prose reader manufactures an empty list out of a payload it did not recognise.
# The single most dangerous line the #554 fix could have added: "I did not understand" would
# become "the backlog is empty", which is #524's substitution wearing a parser's clothes.
$m14 = New-Mutant -Name 'M14-unparsable-becomes-empty' `
  -Needle 'if (-not $isHeader -and -not $isEmpty) { return $null }' `
  -Replacement 'if (-not $isHeader -and -not $isEmpty) { return , @() }'
if ($m14) { Test-Arms -ScriptPath $m14 -Label 'M14 an unrecognised payload read as an empty backlog (must be killed by O)' -Expect @('A', 'B', 'C', 'D', 'E', 'E2', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'L2', 'L3', 'M', 'N') | Out-Null }

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
if ($script:failures.Count -eq 0) {
  Write-Host 'PASS - a truncated Google Tasks read is distinguishable from a small backlog, and every guard is load-bearing.' -ForegroundColor Green
  exit 0
}
Write-Host "FAIL - $($script:failures.Count) assertion(s)" -ForegroundColor Red
$script:failures | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
exit 1
