<#
  mutcheck-consent-channels.ps1 -- where he can approve (#124 item 4 step 5; spec: Decisions,
  "Where a user can approve").

  WHAT IS PINNED
  --------------
  The agent posts on his catch-up doc AS him, so a doc comment counts as his only when it carries
  no agent signature AND its id is not in the sent-messages ledger write-turn keeps
  (`<OA home>\sent-messages.jsonl`). And each channel's rule lives in agent-gate.md's
  `## Approvals` section (defaults app: editor; google-doc: no-signature + not-in-sent-ledger);
  a channel switched off -- or given a rule this engine cannot enforce -- never approves. The
  gated-dispatch floor (#813) asks the same reader.

    A  his-looking doc comment whose id is in the ledger (google-doc)  -> refused
    B  the same id recorded on ANOTHER channel (teams)                 -> granted
    C  a ledger line that cannot be parsed                             -> refused
    D  app: off, his journal approve                                   -> refused
    E  google-doc: off, his doc comment                                -> refused
    F  google-doc: no-signature (drops the ledger: weaker)             -> refused
    G  [gated] plan, his journal approve, app: off: session -CheckDispatch -> refused
    H  control: defaults, no ledger, his doc comment                   -> granted

  MUTANTS (engine = the -ScriptPath target; doc-consent.mjs is shared by both engines)
    M1 consent ignores the app channel          -> D      M5 the engine never passes the ledger -> A
    M2 consent ignores the google-doc channel   -> E      M6 doc-consent tolerates a bad line   -> C
    M3 an unrecognised rule counts as enabled   -> F      M7 doc-consent ignores the channel    -> B
    M4 the gated floor ignores the channels     -> G

  Hermetic: a flat copy of the engine + doc-consent.mjs + lib-doc-comments.mjs under TEMP.

      pwsh -File mutcheck-consent-channels.ps1 [-ScriptPath <oa-state.ps1|oa-state.mjs>]
#>
[CmdletBinding()]
param([string]$ScriptPath)

$ErrorActionPreference = 'Stop'
$here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $ScriptPath) { $ScriptPath = Join-Path $here 'oa-state.ps1' }
$ScriptPath = (Resolve-Path $ScriptPath).Path
$skill = Split-Path -Parent $ScriptPath
. (Join-Path $skill 'oa-state-target.ps1')
$isNode = Test-OaStateNodeTarget $ScriptPath
$checks = [IO.Path]::GetFullPath((Join-Path $skill '..\..\checks'))
$utf8 = New-Object Text.UTF8Encoding($false)
$root = Join-Path ([IO.Path]::GetTempPath()) ('oa-chan-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $root -Force | Out-Null

function Write-Utf8([string]$p, [string]$s) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $p) | Out-Null
  [IO.File]::WriteAllText($p, $s, $utf8)
}

# A flat engine tree (the OA-home shape: doc-consent.mjs beside the engine), optionally mutated.
function New-EngineTree([string]$name, $mutant) {
  $t = Join-Path $root "tree-$name"
  New-Item -ItemType Directory -Path $t -Force | Out-Null
  Copy-Item -LiteralPath $ScriptPath -Destination $t
  if ($isNode) { Copy-Item -LiteralPath (Join-Path $skill 'oa-state-lib') -Destination $t -Recurse }
  else { Copy-Item -LiteralPath (Join-Path $skill 'settings-value.ps1') -Destination $t -ErrorAction SilentlyContinue }
  Copy-Item -LiteralPath (Join-Path $checks 'doc-consent.mjs') -Destination $t
  Copy-Item -LiteralPath (Join-Path $checks 'lib-doc-comments.mjs') -Destination $t
  if ($mutant) {
    $files = @(Get-ChildItem -LiteralPath $t -Recurse -File | Where-Object { $_.Extension -in '.ps1', '.mjs' })
    $find = $mutant.find
    $hits = @($files | Where-Object { [IO.File]::ReadAllText($_.FullName).Contains($find) })
    if ($hits.Count -eq 0) { $find = $find.Replace("`n", "`r`n"); $hits = @($files | Where-Object { [IO.File]::ReadAllText($_.FullName).Contains($find) }) }
    if ($hits.Count -ne 1) { throw "mutant $($mutant.n): anchor found in $($hits.Count) files -> $($mutant.find)" }
    $text = [IO.File]::ReadAllText($hits[0].FullName)
    if (([regex]::Matches($text, [regex]::Escape($find))).Count -ne 1) { throw "mutant $($mutant.n): anchor is not unique in $($hits[0].Name)" }
    $bom = [IO.File]::ReadAllBytes($hits[0].FullName)[0] -eq 0xEF
    [IO.File]::WriteAllText($hits[0].FullName, $text.Replace($find, $mutant.repl.Replace("`n", $(if ($find.Contains("`r`n")) { "`r`n" } else { "`n" }))), (New-Object Text.UTF8Encoding($bom)))
  }
  return (Join-Path $t (Split-Path -Leaf $ScriptPath))
}

$turn = "## $([char]::ConvertFromUtf32(0x1F319)) Overnight Agent - 2020-03-01`n`n<!-- from: overnight-agent -->`n<!-- oa-ask: {ask} -->`n{body}`n<!-- /overnight-agent turn-end -->`n"
$hisApprove = "`n## 2020-03-02`n`n<!-- from: me -->`napprove`n"
$dump = "Found 1 comments in document DOC123:`n`nComment ID: AAAA1`nAuthor: Shiv Bijlani`nCreated: 2026-09-09T15:33:45.386Z`nContent: Yes approved`n"
function Get-Approvals([string[]]$lines) {
  "## Do not gate (reversible)`n- Reading files`n`n## Always ask (safety floor)`n- Spending money`n`n## Approvals`n" + (($lines | ForEach-Object { "- $_" }) -join "`n") + "`n"
}
function Get-SentRow([string]$channel, [string]$id) {
  '{"v":1,"at":"2026-09-09T08:00:00-07:00","channel":"' + $channel + '","message_id":"' + $id + '","task_id":"960","by":"s","host":"h"}'
}

$arms = [ordered]@{
  A = @{ reply = ''; gate = ''; ledger = (Get-SentRow 'google-doc' 'AAAA1'); doc = $true; expect = $false }
  B = @{ reply = ''; gate = ''; ledger = (Get-SentRow 'teams' 'AAAA1'); doc = $true; expect = $true }
  C = @{ reply = ''; gate = ''; ledger = (Get-SentRow 'teams' 'T1') + "`n{not json"; doc = $true; expect = $false }
  D = @{ reply = $hisApprove; gate = (Get-Approvals @('app: off')); ledger = $null; doc = $false; expect = $false }
  E = @{ reply = ''; gate = (Get-Approvals @('google-doc: off')); ledger = $null; doc = $true; expect = $false }
  F = @{ reply = ''; gate = (Get-Approvals @('google-doc: no-signature')); ledger = $null; doc = $true; expect = $false }
  G = @{ gated = $true; reply = $hisApprove; gate = (Get-Approvals @('app: off')); ledger = $null; doc = $false; expect = $false }
  H = @{ reply = ''; gate = ''; ledger = $null; doc = $true; expect = $true }
}

function Get-ArmVerdict([string]$engine, [string]$tag, [string]$k, $arm) {
  $sx = Join-Path $root "$tag-$k"
  $id = '960'
  $body = if ($arm.gated) { "**Status:** Proposed`n`n### Proposed plan (v1)`n1. [gated] Order the Bosch 300, `$899 charged to the card on file.`n`n**Needs from you:** approve?`n" } else { "**Status:** working.`n" }
  $t = $turn.Replace('{ask}', $(if ($arm.gated) { 'blocking' } else { 'offer' })).Replace('{body}', $body)
  Write-Utf8 (Join-Path $sx "data\journal\task-$id.md") ("# Task ${id}: channels`n<!-- doc-meta docId=DOC123 docUrl=https://docs.google.com/document/d/DOC123/edit -->`n`nnotes`n`n---`n<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->`n`n" + $t + $arm.reply)
  Write-Utf8 (Join-Path $sx 'data\planner.md') "## Today`n`n| ID | Task |`n|---|---|`n| $id | t |`n"
  foreach ($f in 'planner-completed.md', 'user-settings.md') { Write-Utf8 (Join-Path $sx "data\$f") '' }
  Write-Utf8 (Join-Path $sx 'data\snooze.json') '{}'
  Write-Utf8 (Join-Path $sx 'data\agent-gate.md') $arm.gate
  Write-Utf8 (Join-Path $sx 'input\comments.txt') $dump
  $oaHome = Join-Path $sx 'home'
  New-Item -ItemType Directory -Path $oaHome -Force | Out-Null
  if ($null -ne $arm.ledger) { Write-Utf8 (Join-Path $oaHome 'sent-messages.jsonl') ($arm.ledger + "`n") }
  Write-Utf8 (Join-Path $oaHome 'sessions.json') "{`"sessions`":[{`"id`":`"S-$id`",`"activity`":{`"status`":`"idle`"}}]}"
  $state = [ordered]@{ id = $id; status = 'proposed'; status_by = 'agent'; version = 1; plan_id = "t$id-v1"; processed_file_hash = ''
    has_agent_block = $true; seeded = $false; updated = '2020-03-01T12:00:00Z'
    session = [ordered]@{ session_id = "S-$id"; kind = 'chat'; project = 'p'; workspace = ''; workspace_type = 'folder'
      created_at = '2020-03-01T00:00:00Z'; last_woken_at = ''; state = 'live'; prior_session_id = ''; replaced_at = '' } }
  Write-Utf8 (Join-Path $sx "state\task-$id.json") ($state | ConvertTo-Json -Depth 6)
  $common = @('-JournalDir', (Join-Path $sx 'data\journal'), '-StateDir', (Join-Path $sx 'state'),
    '-PlannerBoard', (Join-Path $sx 'data\planner.md'), '-PlannerCompleted', (Join-Path $sx 'data\planner-completed.md'),
    '-SnoozeStore', (Join-Path $sx 'data\snooze.json'), '-GatePath', (Join-Path $sx 'data\agent-gate.md'),
    '-UserSettings', (Join-Path $sx 'data\user-settings.md'), '-SessionStateDir', (Join-Path $oaHome 'session-state'),
    '-McpConfig', (Join-Path $oaHome 'mcp.json'))
  $a = if ($arm.gated) { @('session', '-Id', $id, '-CheckDispatch', '-SessionsStatusFile', (Join-Path $oaHome 'sessions.json')) }
  else { @('consent', '-Id', $id) + $(if ($arm.doc) { @('-DocComments', (Join-Path $sx 'input\comments.txt')) } else { @() }) }
  $cmd = Get-OaStateCommand $engine
  $prevHome = $env:OVERNIGHT_AGENT_HOME; $prevWt = $env:WRITE_TURN_OA_HOME
  $env:OVERNIGHT_AGENT_HOME = $oaHome; $env:WRITE_TURN_OA_HOME = $null
  try { $text = & $cmd.Exe @($cmd.Prefix + $a + $common) 2>&1 | Out-String; $code = $LASTEXITCODE }
  finally { $env:OVERNIGHT_AGENT_HOME = $prevHome; $env:WRITE_TURN_OA_HOME = $prevWt }
  if ($arm.gated) {
    if ($code -eq 0) { return $true }
    if ($text -match 'session_gated_needs_consent') { return $false }
    return "other: exit $code $($text.Trim() -replace '\s+', ' ')"
  }
  try { $j = $text | ConvertFrom-Json } catch { return "unparsable: $($text.Trim() -replace '\s+', ' ')" }
  return [bool]$j.consent_ok
}

function Test-Arms([string]$engine, [string]$tag, [switch]$Show) {
  $failed = @()
  foreach ($k in $arms.Keys) {
    $v = Get-ArmVerdict $engine $tag $k $arms[$k]
    $ok = ($v -is [bool]) -and $v -eq $arms[$k].expect
    if (-not $ok) { $failed += $k }
    if ($Show) { Write-Host ("  {0} {1}  expected consent {2}, got {3}" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $k, $arms[$k].expect, $v) }
  }
  return , $failed
}

$engineMutants = if ($isNode) {
  @(
    @{ n = 'M1'; kills = 'D'; find = 'const journalOk = !!c.consent_ok && appCh.enabled;'; repl = 'const journalOk = !!c.consent_ok;' },
    @{ n = 'M2'; kills = 'E'; find = 'if (DocComments && !journalOk && docCh.enabled) {'; repl = 'if (DocComments && !journalOk) {' },
    @{ n = 'M3'; kills = 'F'; find = "if (tokens.length === 2 && tokens.includes('no-signature') && tokens.includes('not-in-sent-ledger')) return 'enabled';"; repl = "if (tokens.length > 0) return 'enabled';" },
    @{ n = 'M4'; kills = 'G'; find = 'if (c && c.consent_ok && approvals.app.enabled) return;'; repl = 'if (c && c.consent_ok) return;' },
    @{ n = 'M5'; kills = 'A'; find = 'if (sent && testPath(sent)) ledgers.push(sent);'; repl = 'void sent;' }
  )
} else {
  @(
    @{ n = 'M1'; kills = 'D'; find = '$journalOk = [bool]$c.consent_ok -and $appCh.enabled'; repl = '$journalOk = [bool]$c.consent_ok' },
    @{ n = 'M2'; kills = 'E'; find = 'if ($DocComments -and -not $journalOk -and $docCh.enabled) {'; repl = 'if ($DocComments -and -not $journalOk) {' },
    @{ n = 'M3'; kills = 'F'; find = "if (`$tokens.Count -eq 2 -and `$tokens -contains 'no-signature' -and `$tokens -contains 'not-in-sent-ledger') { return 'enabled' }"; repl = "if (`$tokens.Count -gt 0) { return 'enabled' }" },
    @{ n = 'M4'; kills = 'G'; find = "if (`$c.consent_ok -and `$approvals['app'].enabled) { return }"; repl = 'if ($c.consent_ok) { return }' },
    @{ n = 'M5'; kills = 'A'; find = 'if ($sent -and (Test-Path -LiteralPath $sent)) { $ledgers += $sent }'; repl = '$null = $sent' }
  )
}
$sharedMutants = @(
  @{ n = 'M6'; kills = 'C'; find = "      row = JSON.parse(line)`n    } catch {`n      return { refuse: 'sent-ledger-malformed', ids: [] }`n    }"; repl = "      row = JSON.parse(line)`n    } catch {`n      continue`n    }" },
  @{ n = 'M7'; kills = 'B'; find = "if (row.channel.toLowerCase() === 'google-doc') ids.push(row.message_id)"; repl = 'ids.push(row.message_id)' }
)

$bad = 0
try {
  Write-Host "[mutcheck-consent-channels] target = $ScriptPath"
  Write-Host '[baseline]'
  $base = Test-Arms (New-EngineTree 'baseline' $null) 'baseline' -Show
  if ($base.Count) { Write-Host "FAIL: baseline arms failed: $($base -join ', ')" -ForegroundColor Red; $bad++ }
  foreach ($m in @($engineMutants + $sharedMutants)) {
    $killed = Test-Arms (New-EngineTree $m.n $m) $m.n
    $ok = $killed -contains $m.kills
    Write-Host ("  [{0}] {1} failed {2} (must fail {3})" -f $(if ($ok) { 'KILLED' } else { 'SURVIVED' }), $m.n, $(if ($killed.Count) { $killed -join ',' } else { 'nothing' }), $m.kills)
    if (-not $ok) { $bad++ }
  }
}
finally { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
if ($bad) { Write-Host "FAILED ($bad)" -ForegroundColor Red; exit 1 }
Write-Host 'PASS: every arm holds and every mutant is killed by its arm.'
exit 0
