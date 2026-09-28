<#
  mutcheck-dispatch-stamp.ps1 -- prove a run cannot obtain dispatch authority without the wake
  being recorded (GH #532).

  WHY THIS EXISTS
  ---------------
  `session.last_woken_at` was maintained by a prose-only `-SessionWoken` call. The one-turn-per-wake
  guard read an old stamp as current and refused a fresh author. The direct dispatch path now
  records the wake at its authorization boundary, and this check proves that inspection and
  binding still do not stamp.

  The repair is on the WRITE side, and this check pins its shape.

  THE TRAP THIS CHECK EXISTS TO KILL
  ----------------------------------
  The cheap implementation stamps on BIND: a caller passing -SessionId is plainly not inspecting,
  and that path already writes. It is wrong, because BINDING IS NOT WAKING -- a run can bind a
  session and then fail to wake it, and a stamp written there records a wake that never happened.

  A stamp PRESENT when it should be absent is the #514 direction and is SILENT -- a second turn
  reaches the page and nothing reports it. That is why arm A3 exists and why mutant D must die.

  It runs the REAL oa-state.ps1 against an isolated -StateDir, so live state is never touched.

  ARMS
    A1  a plain `session -Id N` read is an INSPECTION
          -> dispatch_authorised: false, and last_woken_at is byte-identical afterwards (#514)
    A2  -CheckDispatch is unstamped; -ForDispatch records the wake
          -> dispatch_authorised: true, and last_woken_at advances before the send
    A3  binding a session does NOT stamp it
          -> a bind followed by no wake never leaves a fresh last_woken_at
    A4  -ForDispatch requires the exact dispatch_input from scan
    A5  changed fingerprints and user pauses cannot be stamped

  MUTANTS (each must break exactly the arm named)
    B_alwaysAuthorised  authority granted to every read, asked for or not     -> A1
    C_neverStamp        -ForDispatch answers but does not record the wake    -> A2
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
  $journal = Join-Path $dir 'journal'
  New-Item -ItemType Directory -Path $journal | Out-Null
  Set-Content -Path (Join-Path $journal 'task-999.md') -Value '# Task 999: fixture' -Encoding utf8
  Set-Content -Path (Join-Path $dir 'planner.md') -Value "## Today`n`n| ID | Task |`n|---|---|`n| 999 | fixture |" -Encoding utf8
  Set-Content -Path (Join-Path $dir 'completed.md') -Value '' -Encoding utf8
  Set-Content -Path (Join-Path $dir 'snooze.json') -Value '{}' -Encoding utf8
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
  $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $SubjectPath, 'session', '-Id', '999',
    '-StateDir', $StateDir, '-JournalDir', (Join-Path $StateDir 'journal'),
    '-PlannerBoard', (Join-Path $StateDir 'planner.md'), '-PlannerCompleted', (Join-Path $StateDir 'completed.md'),
    '-SnoozeStore', (Join-Path $StateDir 'snooze.json'), '-UserSettings', (Join-Path $StateDir 'absent-settings.md')) + $Extra
  $out = & pwsh @argv 2>&1
  $text = ($out | Out-String)
  $script:LastExitCode = $LASTEXITCODE
  $script:LastSessionOutput = $text
  try { return ($text | ConvertFrom-Json) } catch { return $null }
}

function Get-DispatchInput {
  param([string]$SubjectPath, [string]$StateDir)
  $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $SubjectPath, 'scan',
    '-StateDir', $StateDir, '-JournalDir', (Join-Path $StateDir 'journal'),
    '-PlannerBoard', (Join-Path $StateDir 'planner.md'),
    '-PlannerCompleted', (Join-Path $StateDir 'completed.md'),
    '-SnoozeStore', (Join-Path $StateDir 'snooze.json'),
    '-UserSettings', (Join-Path $StateDir 'absent-settings.md'))
  $out = & pwsh @argv 2>&1
  if ($LASTEXITCODE -ne 0) { throw "scan failed while preparing the dispatch fingerprint: $out" }
  $rows = (($out | Out-String) | ConvertFrom-Json)
  $row = @($rows | Where-Object { "$($_.id)" -eq '999' }) | Select-Object -First 1
  if (-not $row -or -not $row.dispatch_input) { throw 'scan did not return task 999 dispatch_input' }
  return "$($row.dispatch_input)"
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

  # A2 -- the eligibility check does not stamp; direct dispatch requires a scan hash and stamps
  # only after rechecking the task.
  $d2 = New-Store
  $checked = Invoke-Session -SubjectPath $SubjectPath -StateDir $d2 -Extra @('-CheckDispatch')
  if (-not $checked.dispatch_eligible -or $checked.dispatch_authorised -or (Read-Stamp $d2) -ne $StaleStamp) {
    $f += 'A2: eligibility check was not read-only'
  }
  $hash2 = Get-DispatchInput -SubjectPath $SubjectPath -StateDir $d2
  $r2 = Invoke-Session -SubjectPath $SubjectPath -StateDir $d2 -Extra @('-ForDispatch', '-DispatchInput', $hash2)
  $s2 = Read-Stamp $d2
  if (-not $r2) {
    $f += 'A2: -ForDispatch produced no parseable verdict'
  } else {
    $auth2 = $r2.PSObject.Properties['dispatch_authorised'] -and $r2.dispatch_authorised
    if (-not $auth2) { $f += 'A2: -ForDispatch did not report dispatch_authorised' }
  }
  if ($s2 -eq $StaleStamp) { $f += 'A2: -ForDispatch answered but left last_woken_at stale' }
  elseif ($s2 -eq '<no-session>' -or $s2 -eq '<no-state>') { $f += "A2: -ForDispatch destroyed the binding ($s2)" }

  # A4 -- omitting the scan fingerprint must not turn authorisation into a bypass.
  $d4 = New-Store
  [void](Invoke-Session -SubjectPath $SubjectPath -StateDir $d4 -Extra @('-ForDispatch'))
  $stamp4 = Read-Stamp $d4
  if ($script:LastSessionOutput -notmatch 'session_input_required' -or $stamp4 -ne $StaleStamp) {
    $f += "A4: missing dispatch_input exit=$script:LastExitCode stamp='$stamp4' output='$($script:LastSessionOutput.Trim())'"
  }

  # A5 -- stale input and a human pause are both rejected before stamping.
  $d5 = New-Store
  [void](Invoke-Session -SubjectPath $SubjectPath -StateDir $d5 -Extra @(
    '-ForDispatch', '-DispatchInput', 'stale-dispatch-input'))
  $stamp5 = Read-Stamp $d5
  if ($script:LastSessionOutput -notmatch 'session_input_changed' -or $stamp5 -ne $StaleStamp) {
    $f += "A5: stale dispatch_input exit=$script:LastExitCode stamp='$stamp5' output='$($script:LastSessionOutput.Trim())'"
  }
  $d6 = New-Store
  $statePath = Join-Path $d6 'task-999.json'
  $pausedState = [IO.File]::ReadAllText($statePath).Replace(
    '"status": "in-progress"',
    '"status": "blocked", "status_by": "user", "paused_at": "2026-09-07T19:40:00-07:00"')
  [IO.File]::WriteAllText($statePath, $pausedState, [Text.UTF8Encoding]::new($false))
  $hash6 = Get-DispatchInput -SubjectPath $SubjectPath -StateDir $d6
  [void](Invoke-Session -SubjectPath $SubjectPath -StateDir $d6 -Extra @(
    '-ForDispatch', '-DispatchInput', $hash6))
  $stamp6 = Read-Stamp $d6
  # #734: the refusal is NAMED. It used to arrive as the generic `session_not_dispatchable`,
  # which reads as "the binding needs attention" and invites a caller to repair the binding and
  # dispatch anyway. A pause is not a binding fault, so the token says who stopped this.
  if ($script:LastSessionOutput -notmatch 'session_user_paused' -or $stamp6 -ne $StaleStamp) {
    $f += "A5: user-paused dispatch exit=$script:LastExitCode stamp='$stamp6' output='$($script:LastSessionOutput.Trim())'"
  }

  # A3 -- binding is not waking. A run binds a session and may then fail to wake it, so a bind
  # must never leave a stamp that says a wake happened. The assertion is deliberately about the
  # VALUE being fresh rather than about equality: a first bind legitimately clears the field to
  # '', and the harmful version is specifically a bind that writes NOW.
  #
  # Start unbound so this exercises the bind, not a conflicting-live-binding refusal.
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
  Write-Host '  [baseline] OK -- inspections and checks do not stamp; dispatch does'
}

$mutants = @(
  # The verdict authorises everything, so a run that never declared a dispatch is told it may
  # dispatch -- exactly the ambiguity the field exists to remove.
  @{ Name = 'B_alwaysAuthorised'; Expect = 'A1'; Mutate = {
      param($s) $s.Replace('dispatch_authorised = [bool]$ForDispatch', 'dispatch_authorised = $true') } }
  # -ForDispatch answers the question but does not record the wake: the verdict and the stamp go
  # back to being two events joined by nothing.
  @{ Name = 'C_neverStamp'; Expect = 'A2'; Mutate = {
      param($s) $s.Replace('if ($ForDispatch) {', 'if ($false) {') } }
  # THE TRAP. Stamp on bind: cheap, plausible, and it records wakes that never happened.
  @{ Name = 'D_stampOnBind'; Expect = 'A3'; Mutate = {
      param($s) $s.Replace(
        "-LastWokenAt `$(if (`$sess -and `"`$(`$sess.session_id)`" -eq `$SessionId) { `$sess.last_woken_at } else { '' }) ``",
        "-LastWokenAt (Now-Iso) ``") } }
  @{ Name = 'E_missingDispatchInputAllowed'; Expect = 'A4'; Mutate = {
      param($s) $s.Replace(
        "if (`$ForDispatch -and [string]::IsNullOrWhiteSpace(`$DispatchInput)) {",
        'if ($false) {') } }
  @{ Name = 'F_changedDispatchInputAllowed'; Expect = 'A5'; Mutate = {
      param($s) $s.Replace(
        'if ($DispatchInput -and $DispatchInput -ne $row.dispatch_input) {',
        'if ($false) {') } }
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
