<#
  mutcheck-doc-consent.ps1 -- proves the doc consent channel is load-bearing AND bounded (GH #442).

  WHAT IS BEING GUARDED, AND WHY IT NEEDS A MUTATION CHECK RATHER THAN A TEST

  This is the one change in this repo that makes a gate WIDER. Everything else here refuses
  more than it used to; this lets a Google Doc comment authorise an irreversible action. So the
  arms below are not about the happy path -- that is one line. They are about the boundary:

    1. it must be INERT unless asked for      (no -DocComments, nothing changes)
    2. the FLOOR must still outrank it        (a doc comment cannot unlock send-to-many)
    3. the invariant must still bite          (one agent comment on the doc and it refuses)
    4. every failure must REFUSE              (missing file, unparsed dump, missing script)
    5. the journal must keep precedence       (an existing approval keeps its own provenance)

  Arms 2 and 4 are the ones that matter. A gate that fails open is worse than no gate, because
  the run proceeds believing it was authorised -- and #227's whole thesis is that consent must
  never be INFERRED from an absence. An absent answer here is an absence.

  HERMETIC. Synthetic journal, gate file and state dir under TEMP; the REAL oa-state.ps1 and the
  REAL doc-consent.mjs are the subjects. No live store, no network, no Google.

  Usage: pwsh -File mutcheck-doc-consent.ps1 [-ScriptPath <oa-state.ps1>]
  Exit 0 = every arm agreed. Exit 1 = the channel is not bounded the way it claims.
#>
[CmdletBinding()]
param([string]$ScriptPath)

$ErrorActionPreference = 'Stop'
if (-not $ScriptPath) { $ScriptPath = Join-Path $PSScriptRoot 'oa-state.ps1' }
if (-not (Test-Path $ScriptPath)) { throw "oa-state.ps1 not found at $ScriptPath" }

$script:PsExe = if ($PSVersionTable.PSEdition -eq 'Core') { (Get-Process -Id $PID).Path } else { 'powershell' }
$utf8 = New-Object Text.UTF8Encoding($false)
$MOON = [char]::ConvertFromUtf32(0x1F319)

$root = Join-Path ([IO.Path]::GetTempPath()) ("oa-dc-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$J = Join-Path $root 'journal'; New-Item -ItemType Directory -Path $J -Force | Out-Null
$S = Join-Path $root 'state';   New-Item -ItemType Directory -Path $S -Force | Out-Null

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

# A journal bound to DOC123 whose own trailing content carries NO approval, so any consent
# observed in these arms can only have come from the doc channel.
$journal = @"
# Task 999: fixture
<!-- doc-meta docId=DOC123 docUrl=https://docs.google.com/document/d/DOC123/edit -->

## 2026-09-09

<!-- from: me -->
framing only, nothing approved here

<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## $MOON Overnight Agent -- 2026-09-09 10:00 PT

<!-- from: overnight-agent -->
<!-- oa-ask: offer -->

**Status:** working.

<!-- /overnight-agent turn-end -->
"@
[IO.File]::WriteAllText((Join-Path $J 'task-999.md'), $journal, $utf8)

$gate = @"
## Do not gate these (reversible)
- Opening a pull request

## Always ask (safety floor)
- Sending email to many people
- Anything that can cause permanent data loss
"@
$gatePath = Join-Path $root 'agent-gate.md'
[IO.File]::WriteAllText($gatePath, $gate, $utf8)

function Dump([string]$name, [string]$text) {
  $p = Join-Path $root $name
  [IO.File]::WriteAllText($p, $text, $utf8)
  return $p
}

# His approval, in the exact shape `list_document_comments` returns.
$approved = Dump 'approved.txt' @"
Found 1 comments in document DOC123:

Comment ID: AAAA1
Author: Shiv Bijlani
Created: 2026-09-09T15:33:45.386Z
Quoted text: Pending
Content: Yes approved
"@

# The same document, plus one comment carrying the agent's real provenance marker.
$breached = Dump 'breached.txt' @"
Found 2 comments in document DOC123:

Comment ID: AAAA1
Author: Shiv Bijlani
Created: 2026-09-09T15:33:45.386Z
Content: Yes approved

Comment ID: AAAA3
Author: Shiv Bijlani
Created: 2026-09-10T10:00:00.000Z
Content: noted and filed.

-- overnight-agent [oa-comment:v1]
"@

$silent = Dump 'silent.txt' @"
Found 1 comments in document DOC123:

Comment ID: AAAA9
Author: Shiv Bijlani
Created: 2026-09-09T15:33:45.386Z
Content: what is the state of this
"@

function Consent([string[]]$Extra) {
  $argv = @($ScriptPath, 'consent', '-Id', '999', '-JournalDir', $J, '-StateDir', $S, '-GatePath', $gatePath) + $Extra
  $out = (& $script:PsExe -NoProfile -ExecutionPolicy Bypass -File @argv 2>&1 | Out-String)
  $json = $null
  try { $json = $out | ConvertFrom-Json } catch { }
  return [pscustomobject]@{ raw = $out.Trim(); json = $json }
}
function Detail($r) {
  $o = ($r.raw -replace '\s+', ' ')
  if ($o.Length -gt 260) { $o = $o.Substring(0, 260) + '...' }
  return $o
}

Write-Host ''
Write-Host 'BOUNDARY -- the channel must be inert unless explicitly asked for'

$a = Consent @()
Assert ($a.json -and -not $a.json.consent_ok) 'INERT' 'without -DocComments the verdict is unchanged and false' (Detail $a)
Assert ($a.json -and -not ($a.json.PSObject.Properties.Name -contains 'doc_consent_ok')) 'INERT2' 'and the doc fields are absent entirely, not merely false' (Detail $a)

# Pairs with INERT: the SAME journal and the SAME approval file must grant when asked.
$b = Consent @('-DocComments', $approved)
Assert ($b.json -and $b.json.consent_ok -and $b.json.reason -eq 'doc-comment-affirmative') 'GRANT' 'with -DocComments his approval is honoured (INERT pairs)' (Detail $b)
Assert ($b.json -and $b.json.reason -ne 'human-authored-affirmative') 'PROVENANCE' 'and the reason names the CHANNEL, so a log can tell doc from journal' (Detail $b)

Write-Host ''
Write-Host 'FLOOR -- the safety floor must outrank a doc approval'

$c = Consent @('-DocComments', $approved, '-Action', 'send_email_many')
Assert ($c.json -and -not $c.json.consent_ok -and $c.json.reason -eq 'gate-floor-blocks') 'FLOOR' 'a floor action stays denied even with his approval on the doc' (Detail $c)

# Pairs with FLOOR, so it cannot pass merely because the action name was unknown.
$c2 = Consent @('-DocComments', $approved, '-Action', 'open_pr')
Assert ($c2.json -and $c2.json.consent_ok) 'FLOOR2' 'a non-floor action is still allowed (FLOOR is not blanket denial)' (Detail $c2)

Write-Host ''
Write-Host 'INVARIANT -- one agent comment on the page and the channel closes itself'

$d = Consent @('-DocComments', $breached)
Assert ($d.json -and -not $d.json.consent_ok) 'INVARIANT' 'an agent-stamped comment revokes the channel, approval notwithstanding' (Detail $d)
Assert ($d.json -and $d.json.doc_consent_reason -eq 'agent-commented-after-rule') 'INVARIANT2' 'and it reports the breach, not a generic refusal' (Detail $d)

Write-Host ''
Write-Host 'FAIL CLOSED -- an absent answer is never a yes'

$e = Consent @('-DocComments', (Join-Path $root 'no-such-file.txt'))
Assert ($e.json -and -not $e.json.consent_ok -and $e.json.doc_consent_reason -eq 'doc-comments-file-missing') 'MISSING' 'a missing dump refuses and says which failure it was' (Detail $e)

$f = Consent @('-DocComments', $silent)
Assert ($f.json -and -not $f.json.consent_ok) 'SILENT' 'comments with no affirmative grant nothing' (Detail $f)

# The script itself made unreachable. If consent survived this, something other than
# doc-consent.mjs was producing the grant -- i.e. the bridge would be decorative.
$moved = Join-Path $root 'doc-consent-moved.mjs'
$real = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $ScriptPath) '..\..\checks\doc-consent.mjs'))
Copy-Item $real $moved -Force
Rename-Item $real ($real + '.disabled') -Force
try {
  $g = Consent @('-DocComments', $approved)
  Assert ($g.json -and -not $g.json.consent_ok -and $g.json.doc_consent_reason -eq 'doc-consent-script-missing') 'NOSCRIPT' 'with the bridge removed the grant vanishes (it is load-bearing)' (Detail $g)
}
finally {
  Rename-Item ($real + '.disabled') $real -Force
}

# And it comes back on the identical input, so NOSCRIPT was not passing for some other reason.
$h = Consent @('-DocComments', $approved)
Assert ($h.json -and $h.json.consent_ok) 'RESTORED' 'restoring the bridge restores the grant (NOSCRIPT pairs)' (Detail $h)

Write-Host ''
Write-Host 'PRECEDENCE -- an existing journal approval keeps its own provenance'

$approvedJournal = $journal + @"

<!-- from: me -->
yes go ahead
"@
[IO.File]::WriteAllText((Join-Path $J 'task-999.md'), $approvedJournal, $utf8)
$i = Consent @('-DocComments', $breached)
Assert ($i.json -and $i.json.consent_ok -and $i.json.reason -eq 'human-authored-affirmative') 'JOURNAL-FIRST' 'a journal approval wins and is not relabelled by the doc channel' (Detail $i)

Write-Host ''
if ($script:fail -gt 0) {
  Write-Host ("FAILED: {0} arm(s) disagreed, {1} passed. The doc consent channel is not bounded as claimed." -f $script:fail, $script:pass) -ForegroundColor Red
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  exit 1
}
Write-Host ("OK: {0} arms agreed. The channel grants only when asked, and refuses everything else." -f $script:pass) -ForegroundColor Green
Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
exit 0
