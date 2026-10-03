<#
  run-mutchecks.ps1 -- every mutation check that drives the state engine, against ONE target.

      pwsh -File run-mutchecks.ps1                       # the Node port (oa-state.mjs)
      pwsh -File run-mutchecks.ps1 -Target ps            # oa-state.ps1
      pwsh -File run-mutchecks.ps1 -Filter 'session'     # a subset (regex on the file name)

  Each check takes the engine through its own parameter (most `-ScriptPath`); this table is the
  one place that knows which. A check fails the run when it exits non-zero. Exit 0 only if every
  selected check passed.
#>
param(
  [ValidateSet('node', 'ps')][string]$Target = 'node',
  [string]$Filter = '.'
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$skill = Join-Path $repo 'plugins\overnight-agent\skills\overnight-agent'
$checks = Join-Path $repo 'plugins\overnight-agent\checks'
$engine = if ($Target -eq 'node') { Join-Path $skill 'oa-state.mjs' } else { Join-Path $skill 'oa-state.ps1' }

# file, the parameter that names the engine
$table = @(
  @('skills', 'mutcheck-above-sentinel-reply.ps1', 'ScriptPath'),
  @('skills', 'mutcheck-advertised-reply-word.ps1', 'OaStatePath'),
  @('skills', 'mutcheck-agent-declared-done.ps1', 'ScriptPath'),
  @('skills', 'mutcheck-awaiting-reply.ps1', 'ScriptPath'),
  @('skills', 'mutcheck-blocked-recheck.ps1', 'ScriptPath'),
  @('skills', 'mutcheck-board-compound-id.ps1', 'ScriptPath'),
  @('skills', 'mutcheck-board-row-no-journal.ps1', 'ScriptPath'),
  @('skills', 'mutcheck-busy-bound-session.ps1', 'ScriptPath'),
  @('skills', 'mutcheck-cadence-rearm.ps1', 'ScriptPath'),
  @('skills', 'mutcheck-dead-session-verdict.ps1', 'ScriptPath'),
  @('skills', 'mutcheck-decision-record.ps1', 'ScriptPath'),
  @('skills', 'mutcheck-declared-ask.ps1', 'ScriptPath'),
  @('skills', 'mutcheck-doc-binding.ps1', 'ScriptPath'),
  @('skills', 'mutcheck-consent-channels.ps1', 'ScriptPath'),
  @('skills', 'mutcheck-coordinator-no-task-work.ps1', 'OaStatePath'),
  @('skills', 'mutcheck-doc-channel-provenance.ps1', 'ScriptPath'),
  @('skills', 'mutcheck-doc-consent.ps1', 'ScriptPath'),
  @('skills', 'mutcheck-gate-edit-ask.ps1', 'OaStatePath'),
  @('skills', 'mutcheck-gate-settings-source.ps1', 'ScriptPath'),
  @('skills', 'mutcheck-gated-dispatch.ps1', 'ScriptPath'),
  @('skills', 'mutcheck-managed-heading.ps1', 'Script'),
  @('skills', 'mutcheck-pacing-concurrency.ps1', 'ScriptPath'),
  @('skills', 'mutcheck-per-task-session.ps1', 'ScriptPath'),
  @('skills', 'mutcheck-phase0-lock-scope.ps1', 'ScriptPath'),
  @('skills', 'mutcheck-plan-dispatch.ps1', 'StateScript'),
  @('skills', 'mutcheck-pointer-turn.ps1', 'Oa'),
  @('skills', 'mutcheck-priority-order.ps1', 'ScriptPath'),
  @('skills', 'mutcheck-reopened-closed.ps1', 'ScriptPath'),
  @('skills', 'mutcheck-scan-perf.ps1', 'ScriptPath'),
  @('skills', 'mutcheck-session-bind-backwards.ps1', 'ScriptPath'),
  @('skills', 'mutcheck-session-pause.ps1', 'ScriptPath'),
  @('skills', 'mutcheck-task-session-role.ps1', 'ScriptPath'),
  @('skills', 'mutcheck-today-served.ps1', 'ScriptPath'),
  @('skills', 'mutcheck-turn-terminator.ps1', 'Script'),
  @('skills', 'mutcheck-user-pause-write.ps1', 'OaStatePath'),
  @('checks', 'mutcheck-agent-gate.ps1', 'ScriptPath'),
  @('checks', 'mutcheck-board-linked.ps1', 'Target'),
  @('checks', 'mutcheck-consent-authorship.ps1', 'ScriptPath'),
  @('checks', 'mutcheck-consent-vocab.ps1', 'ScriptPath'),
  @('checks', 'mutcheck-consent-vocab-drift.ps1', 'ScriptPath'),
  @('checks', 'mutcheck-dispatch-stamp.ps1', 'ScriptPath'),
  @('checks', 'mutcheck-journal-decode.ps1', 'ScriptPath'),
  @('checks', 'mutcheck-journal-extract.ps1', 'Target'),
  @('checks', 'mutcheck-optional-offer-park.ps1', 'ScriptPath'),
  @('checks', 'mutcheck-sibling-reopen.ps1', 'ScriptPath'),
  @('checks', 'mutcheck-unstamped-runlog.ps1', 'ScriptPath'),
  @('checks', 'mutcheck-workspace-verdict.ps1', 'ScriptPath'),
  @('checks', 'mutcheck-critical-tools.mjs', '--target'),
  @('checks', 'mutcheck-journal-encoding.mjs', '--target')
)

$pwsh = (Get-Process -Id $PID).Path
$failed = @()
$ran = 0
foreach ($row in $table) {
  $dir = if ($row[0] -eq 'skills') { $skill } else { $checks }
  $file = Join-Path $dir $row[1]
  if ($row[1] -notmatch $Filter) { continue }
  $ran++
  $start = Get-Date
  Write-Host "::group::$($row[1]) [$Target]"
  if ($row[1] -like '*.mjs') { & node $file $row[2] $engine }
  else { & $pwsh -NoProfile -File $file "-$($row[2])" $engine }
  $code = $LASTEXITCODE
  Write-Host '::endgroup::'
  $secs = [int]((Get-Date) - $start).TotalSeconds
  Write-Host ("{0,-4} {1} [{2}] {3}s" -f $(if ($code -eq 0) { 'ok' } else { 'FAIL' }), $row[1], $Target, $secs)
  if ($code -ne 0) { $failed += "$($row[1]) exit $code" }
}
Write-Host ''
Write-Host "$ran check(s) against $Target; $($failed.Count) failed"
$failed | ForEach-Object { Write-Host "FAILED: $_" }
if ($failed.Count) { exit 1 }
