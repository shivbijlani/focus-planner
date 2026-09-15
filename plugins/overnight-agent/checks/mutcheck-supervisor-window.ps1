[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$subject = Join-Path $PSScriptRoot 'oa-supervisor-lifecycle.ps1'
$source = [IO.File]::ReadAllText($subject)
$now = ([datetime]'2026-09-15T12:00:00Z').ToUniversalTime()
$config = @{ preventiveStartHours=12; preventiveDeadlineHours=24; quietSeconds=30; evidenceMaxAgeSeconds=300; pollSeconds=60 }
$activity = @{ state='IDLE'; measuredUtc=$now.ToString('o') }
$tests = @(
  @{ name='before A'; age=11.99; state='IDLE'; quiet=31; expected='before-window' },
  @{ name='A measuring'; age=12; state='IDLE'; quiet=29; expected='measuring-quiet' },
  @{ name='A quiet'; age=12; state='IDLE'; quiet=30; expected='preventive-quiet' },
  @{ name='early busy veto'; age=23.99; state='BUSY'; quiet=31; expected='wait-activity' },
  @{ name='early unknown veto'; age=23.99; state='UNKNOWN'; quiet=31; expected='wait-activity' },
  @{ name='exact B busy'; age=24; state='BUSY'; quiet=31; expected='deadline-forced' },
  @{ name='exact B unknown'; age=24; state='UNKNOWN'; quiet=31; expected='deadline-forced' },
  @{ name='past B after sleep'; age=25; state='BUSY'; quiet=0; expected='deadline-forced' }
)
function Run-PolicyCases([string]$Text) {
  $module = New-Module -ScriptBlock ([scriptblock]::Create($Text))
  $failed = @()
  foreach ($t in $tests) {
    $cycle = @{ startedUtc=$now.AddHours(-$t.age).ToString('o') }
    $a = @{ state=$t.state; measuredUtc=$activity.measuredUtc }
    $got = & $module { param($c,$s,$a,$n,$q) Get-RestartDecision $c $s $a $n $q } $config $cycle $a $now ($now.AddSeconds(-$t.quiet).ToString('o'))
    if ($got -ne $t.expected) { $failed += $t.name }
  }
  return ,$failed
}
$baseline = Run-PolicyCases $source
if ($baseline.Count) { throw "baseline failed: $baseline" }
$mutations = @(
  @{ name='early activity veto'; find='if ($Activity.state -ne ''IDLE'')'; replace='if ($false)'; expected=@('early busy veto','early unknown veto') },
  @{ name='hard deadline'; find='if ($age -ge $Config.preventiveDeadlineHours)'; replace='if ($false)'; expected=@('exact B busy','exact B unknown','past B after sleep') }
)
foreach ($m in $mutations) {
  if (-not $source.Contains($m.find)) { throw "missing mutation anchor: $($m.name)" }
  $failures = Run-PolicyCases ($source.Replace($m.find, $m.replace))
  if (Compare-Object @($failures | Sort-Object) @($m.expected | Sort-Object)) { throw "mutation $($m.name) broke unexpected fixtures: $failures" }
  Write-Host "PASS mutation $($m.name): independently killed by $($failures -join ', ')"
}
. $subject
$offsetJson = ConvertFrom-SupervisorJson '{"startedUtc":"2026-09-14T05:00:10-07:00","quietSince":"2026-09-15T04:59:50-07:00"}'
if ($offsetJson.startedUtc -isnot [string]) { throw 'JSON converted the offset-bearing timestamp to a DateTime before policy parsing' }
$offsetState = @{ cycle=@{startedUtc=$offsetJson.startedUtc}; quietSince=$offsetJson.quietSince }
$offsetNext = Get-NextSupervisorCheck $config $offsetState $now
if ((ConvertTo-SupervisorUtc $offsetNext) -ne $now.AddSeconds(10)) { throw "non-UTC timestamp shifted the deadline: $offsetNext" }
Write-Host 'PASS -07:00 JSON timestamps remain strings and schedule exactly 10 seconds later in UTC'
$cycle = @{startedUtc=$now.AddHours(-23.999).ToString('o')}
$state = @{cycle=$cycle}
$next = Get-NextSupervisorCheck $config $state $now
if ((ConvertTo-SupervisorUtc $next) -ne (ConvertTo-SupervisorUtc $cycle.startedUtc).AddHours(24)) { throw 'poll crossed hard deadline' }
$activity.measuredUtc=$now.AddSeconds(-301).ToString('o')
if ((Get-RestartDecision $config $cycle $activity $now $now.AddSeconds(-31).ToString('o')) -ne 'wait-stale-evidence') { throw 'stale snapshot was idle' }
Write-Host "PASS $($tests.Count) fake-clock policy boundaries, deadline scheduling and stale evidence"
