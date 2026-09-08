<#
  mutcheck-dispatch-stamp.ps1 -- prove a run cannot obtain dispatch authority without the wake
  being recorded (GH #532).

  WHY THIS EXISTS
  ---------------
  `session.last_woken_at` was maintained by NOTHING except a sentence of prose in SKILL.md PHASE 1
  ("stamp -SessionWoken once it responds"). Two guards read it, and a run that skipped the
  sentence broke both -- in OPPOSITE directions:

    * the one-turn-per-wake guard read the stale stamp as authoritative and refused EVERY author,
      so the wake recorded nothing at all;
    * `Test-SessionHoldsCapacity` read its staleness as "nobody is working this", parked the row
      and offered its slot away while the session holding it was mid-flight.

  Measured 2026-09-07 on task #468: stamp written 19:43, a fresh run re-dispatched at 21:55, the
  turn guard refused at 22:00 naming a turn two hours and one run old, and the capacity view did
  not count the live session until the stamp was written BY HAND at 22:59.

  Neither symptom is repairable where the field is READ. The turn guard only had to stop trusting
  a stamp too old to be about the current wake (shipped). The capacity park needs the field to be
  TRUE, not merely trusted -- "nobody is working this" is a claim about the world -- and teaching
  it to read staleness as activity re-opens #487 and un-parks exactly what #500 exists to park.
  World O of `mutcheck-parked-capacity` already pins that as deliberate.

  So the repair is on the WRITE side, and this check pins its shape.

  THE TRAP THIS CHECK EXISTS TO KILL
  ----------------------------------
  The cheap implementation stamps on BIND: a caller passing -SessionId is plainly not inspecting,
  and that path already writes. It is wrong, because BINDING IS NOT WAKING -- a run can bind a
  session and then fail to wake it, and a stamp written there records a wake that never happened.

  Note the direction. Every symptom above is the stamp being ABSENT, and both are LOUD: the guard
  refuses and says so, the park over-offers and surfaces as contention. A stamp PRESENT when it
  should be absent is the #514 direction and is SILENT -- a second turn reaches the page and
  nothing reports it. Closing a loud failure by opening a quiet one is not a fix, which is why
  arm A3 exists and why mutant D must die.

  It runs the REAL oa-state.ps1 against an isolated -StateDir, so live state is never touched.

  ARMS
    A1  a plain `session -Id N` read is an INSPECTION
          -> dispatch_authorised: false, and last_woken_at is byte-identical afterwards (#514)
    A2  `session -Id N -ForDispatch` is a DISPATCH
          -> dispatch_authorised: true, and last_woken_at advances in the same call
    A3  binding a session does NOT stamp it
          -> a bind followed by no wake never leaves a fresh last_woken_at

  MUTANTS (each must break exactly the arm named)
    B_alwaysAuthorised  authority granted to every read, asked for or not     -> A1
    C_neverStamp        -ForDispatch answers but does not record the wake     -> A2
    D_stampOnBind       the cheap fix: bind writes the wake stamp             -> A3
#>
[CmdletBinding()]
param([string]$ScriptPath)

$ErrorActionPreference = 'Stop'

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

# Same candidate list as the sibling mutchecks so the three cannot drift: in the repo the subject
# is a directory away, in the OA home every skill and check is flattened into one directory.
if (-not $ScriptPath) {
  $candidates = @(
    (Join-Path $Here '..\skills\overnight-agent\oa-state.ps1'),
    (Join-Path $Here 'oa-state.ps1'),
    (Join-Path $env:LOCALAPPDATA 'overnight-agent\oa-state.ps1'),
    "$env:USERPROFILE\.copilot\installed-plugins\focus-planner\overnight-agent\skills\overnight-agent\oa-state.ps1"
  )
  foreach ($c in $candidates) { if (Test-Path $c) { $ScriptPath = (Resolve-Path $c).Path; break } }
}
$Subject = $ScriptPath
if (-not $Subject -or -not (Test-Path $Subject)) { throw "subject not found: $Subject" }

# Normalised to LF before any mutation: the working tree is CRLF on Windows, so patterns written
# against LF would match nothing and every mutant would "survive" for a reason unrelated to the
# subject. A mutation that fails to apply is reported as a failure, never counted as a kill.
$Source = (Get-Content -Raw $Subject) -replace "`r`n", "`n"

$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("mutcheck-dispatch-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $Tmp -Force | Out-Null

function New-Subject {
  param([string]$Name, [scriptblock]$Mutate)
  $src = $Source
  if ($Mutate) {
    $next = & $Mutate $src
    if ($next -eq $src) { throw "mutation $Name did not change the source" }
    $src = $next
  }
  $dir = Join-Path $Tmp $Name
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $path = Join-Path $dir 'oa-state.ps1'
  [IO.File]::WriteAllText($path, $src, (New-Object Text.UTF8Encoding $false))
  return $path
}

# A store holding one task with a live binding and a wake stamp that is OLD but present -- the
# measured shape of the bug. An empty stamp would let a mutant pass for the wrong reason.
$StaleStamp = '2026-09-07T19:43:00-07:00'

function New-Store {
  param([string]$Bound = 'yes')
  $dir = Join-Path $Tmp ("state-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $state = [ordered]@{
    id      = '999'
    status  = 'in-progress'
    version = 0
    # `updated` is not decoration: the wake branch writes it, and a store without it makes the
    # subject throw before it ever reaches the stamp. A harness whose store is thinner than the
    # real one measures the harness.
    updated = '2026-09-07T19:43:00-07:00'
  }
  if ($Bound -eq 'yes') {
    $state['session'] = [ordered]@{
      session_id       = 'aa358d1c-4c54-40cb-8809-619bd9bda3d7'
      kind             = 'code'
      project          = 'p'
      workspace        = ''
      workspace_type   = 'folder'
      created_at       = '2026-09-06T22:47:48-07:00'
      last_woken_at    = $StaleStamp
      state            = 'live'
      prior_session_id = ''
      replaced_at      = ''
    }
  }
  $state | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $dir 'task-999.json') -Encoding utf8
  return $dir
}

function Read-Stamp {
  param([string]$StateDir)
  $p = Join-Path $StateDir 'task-999.json'
  if (-not (Test-Path $p)) { return '<no-state>' }
  # Read the stamp out of the RAW text, not out of ConvertFrom-Json. PowerShell's JSON reader
  # coerces an ISO-8601 string into [datetime] and renders it back as '09/07/2026 19:43:00', so an
  # untouched field compares unequal to the value that was written and every arm fails against a
  # subject that did nothing wrong. This check asserts byte-identity, so it has to read bytes.
  $raw = Get-Content -Raw $p
  $m = [regex]::Match($raw, '"last_woken_at"\s*:\s*"([^"]*)"')
  if ($m.Success) { return $m.Groups[1].Value }
  if ($raw -notmatch '"session"') { return '<no-session>' }
  return '<no-stamp>'
}

function Invoke-Session {
  param([string]$SubjectPath, [string]$StateDir, [string[]]$Extra = @())
  $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $SubjectPath, 'session', '-Id', '999', '-StateDir', $StateDir) + $Extra
  $out = & pwsh @argv 2>&1
  $text = ($out | Out-String)
  try { return ($text | ConvertFrom-Json) } catch { return $null }
}

function Test-Arms {
  param([string]$SubjectPath)
  $f = @()

  # A1 -- a plain read is an inspection: no authority, and the stamp is untouched.
  $d1 = New-Store
  $r1 = Invoke-Session -SubjectPath $SubjectPath -StateDir $d1
  $s1 = Read-Stamp $d1
  if (-not $r1) {
    $f += 'A1: a plain read produced no parseable verdict'
  } else {
    $auth1 = $r1.PSObject.Properties['dispatch_authorised'] -and $r1.dispatch_authorised
    if ($auth1) { $f += 'A1: a plain read reported dispatch_authorised true -- authority nobody asked for' }
  }
  if ($s1 -ne $StaleStamp) { $f += "A1: a plain read moved last_woken_at to '$s1' -- an inspection that stamps is #514" }

  # A2 -- a declared dispatch is authorised AND records the wake in the same call.
  $d2 = New-Store
  $r2 = Invoke-Session -SubjectPath $SubjectPath -StateDir $d2 -Extra @('-ForDispatch')
  $s2 = Read-Stamp $d2
  if (-not $r2) {
    $f += 'A2: -ForDispatch produced no parseable verdict'
  } else {
    $auth2 = $r2.PSObject.Properties['dispatch_authorised'] -and $r2.dispatch_authorised
    if (-not $auth2) { $f += 'A2: -ForDispatch did not report dispatch_authorised' }
  }
  if ($s2 -eq $StaleStamp) { $f += 'A2: -ForDispatch answered but left last_woken_at stale -- the verdict and the stamp are still two events' }
  elseif ($s2 -eq '<no-session>' -or $s2 -eq '<no-state>') { $f += "A2: -ForDispatch destroyed the binding ($s2)" }

  # A3 -- binding is not waking. A run binds a session and may then fail to wake it, so a bind
  # must never leave a stamp that says a wake happened. The assertion is deliberately about the
  # VALUE being fresh rather than about equality: a first bind legitimately clears the field to
  # '', and the harmful version is specifically a bind that writes NOW.
  #
  # The task starts UNBOUND on purpose. Binding a second session over a live one is refused for
  # capacity (concurrency 1) before it writes anything, so that scenario would report "clean" for
  # a reason that has nothing to do with stamping -- a mutant surviving because the code under it
  # never ran.
  $d3 = New-Store -Bound 'no'
  $ws3 = Join-Path $Tmp ('ws-a3-' + [guid]::NewGuid().ToString('N').Substring(0, 6))
  New-Item -ItemType Directory -Path $ws3 -Force | Out-Null
  $null = Invoke-Session -SubjectPath $SubjectPath -StateDir $d3 -Extra @(
    '-SessionId', 'ffffffff-1111-2222-3333-444444444444', '-SessionKind', 'code',
    '-SessionProject', 'p', '-SessionWorkspace', $ws3, '-WorkspaceType', 'worktree')
  $s3 = Read-Stamp $d3
  $fresh3 = $false
  if ($s3 -and $s3 -notmatch '^<') {
    try { $fresh3 = ([datetime]::Parse($s3)).ToUniversalTime() -gt (Get-Date).ToUniversalTime().AddMinutes(-10) } catch { $fresh3 = $false }
  }
  if ($s3 -eq '<no-session>' -or $s3 -eq '<no-state>') { $f += "A3: the bind did not happen ($s3) -- the arm proves nothing" }
  elseif ($fresh3) { $f += "A3: binding stamped last_woken_at '$s3' -- binding is not waking, and a wake recorded that never happened is the silent failure" }

  return $f
}

Write-Host ''
Write-Host 'mutcheck-dispatch-stamp -- GH #532 dispatch authority cannot be obtained unstamped'
Write-Host ''

$baseSubject = New-Subject -Name 'baseline' -Mutate $null
$baseline = Test-Arms -SubjectPath $baseSubject
if ($baseline.Count) {
  foreach ($x in $baseline) { Write-Host "  FAIL  baseline  $x" -ForegroundColor Red }
} else {
  Write-Host '  [baseline] OK -- plain read inspects, -ForDispatch stamps, bind does not'
}

$mutants = @(
  # The verdict authorises everything, so a run that never declared a dispatch is told it may
  # dispatch -- exactly the ambiguity the field exists to remove.
  @{ Name = 'B_alwaysAuthorised'; Expect = 'A1'; Mutate = {
      param($s) $s.Replace('dispatch_authorised = [bool]$ForDispatch', 'dispatch_authorised = $true') } }
  # -ForDispatch answers the question but does not record the wake: the verdict and the stamp go
  # back to being two events joined by nothing.
  @{ Name = 'C_neverStamp'; Expect = 'A2'; Mutate = {
      param($s) $s.Replace('if ($SessionWoken -or $ForDispatch) {', 'if ($SessionWoken) {') } }
  # THE TRAP. Stamp on bind: cheap, plausible, and it records wakes that never happened.
  @{ Name = 'D_stampOnBind'; Expect = 'A3'; Mutate = {
      param($s) $s.Replace(
        "-LastWokenAt `$(if (`$sess -and `"`$(`$sess.session_id)`" -eq `$SessionId) { `$sess.last_woken_at } else { '' }) ``",
        "-LastWokenAt (Now-Iso) ``") } }
)

Write-Host ''
Write-Host 'MUTATION ARMS'
$survived = @()
foreach ($m in $mutants) {
  try {
    $p = New-Subject -Name $m.Name -Mutate $m.Mutate
  } catch {
    Write-Host ("  [ERROR  ] {0,-20} {1}" -f $m.Name, $_.Exception.Message) -ForegroundColor Red
    $survived += $m.Name
    continue
  }
  $fails = Test-Arms -SubjectPath $p
  $killed = @($fails | Where-Object { $_ -like "$($m.Expect)*" }).Count -gt 0
  if ($killed) {
    Write-Host ("  [KILLED ] {0,-20} expected {1}" -f $m.Name, $m.Expect)
  } else {
    Write-Host ("  [SURVIVED] {0,-20} expected {1} -- got: {2}" -f $m.Name, $m.Expect, ($fails -join '; ')) -ForegroundColor Red
    $survived += $m.Name
  }
}

Write-Host ''
if ($baseline.Count -or $survived.Count) {
  Write-Host "FAIL: $($baseline.Count) baseline failure(s), $($survived.Count) mutant(s) survived." -ForegroundColor Red
  exit 1
}
Write-Host "PASS: baseline clean and all $($mutants.Count) mutants killed." -ForegroundColor Green
exit 0
