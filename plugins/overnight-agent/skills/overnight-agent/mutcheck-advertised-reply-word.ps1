<#
  mutcheck-advertised-reply-word.ps1 -- an offered reply word must be one the gate reads (GH #491).

  THE DEFECT

  A journal turn can advertise any reply word it likes. The consent reader accepts a fixed
  list. Nothing checked that the word we ADVERTISE is a word the reader ACCEPTS, so an ask
  could be born unanswerable.

  The failure is silent in BOTH directions, which is what makes it expensive: Shiv replies,
  the reader returns `human-spoke-but-no-affirmative`, and that is byte-identical to him
  declining. He has no way to tell that the word he was offered was never wired to anything.

  Measured across 239 journals: 48 newest turns advertised a reply token and 33 of them
  advertised at least one word the reader rejects. A live instance from this repo's own
  agent: "reply **prune** and I'll remove 2,951 old session folders" -- `prune` does not
  match the regex, so the action could never have been authorised by the word offered for it.

  WHY THE EXISTING GUARD MISSED IT. `mutcheck-consent-vocab-drift.ps1` pins SKILL.md's
  documented vocabulary against the reader. That is the DOCUMENTATION, not the output. A turn
  inventing `prune`, `confirm`, `delete` or `apply` passed every guard, because no guard read
  the asks we actually send. That is #301's class surviving #301's own fix.

  WHAT THE ARMS GUARD, AND IN WHICH DIRECTION

  The risk in adding this guard is not the unanswerable ask it catches -- it is refusing
  turns that are fine, because an author who hits a wrong refusal reaches for
  -DisableGuard and the surface goes unguarded while still appearing guarded. So most arms
  below assert that it stays QUIET: on accepted words, on bold emphasis that is not an offer,
  and on fenced examples.

  The vocabulary copy is pinned too. write-turn.ps1 holds its own copy of the reader's regex,
  and a copy that drifts blesses words the reader will reject -- reintroducing the defect
  through the guard meant to prevent it.

  Exit 0 = every arm agreed.
#>
[CmdletBinding()]
param([string]$WriteTurnPath, [string]$OaStatePath)

$ErrorActionPreference = 'Stop'
if (-not $WriteTurnPath) { $WriteTurnPath = Join-Path $PSScriptRoot 'write-turn.ps1' }
if (-not $OaStatePath)   { $OaStatePath   = Join-Path $PSScriptRoot 'oa-state.ps1' }
if (-not (Test-Path $WriteTurnPath)) { throw "write-turn.ps1 not found at $WriteTurnPath" }

$script:PsExe = if ($PSVersionTable.PSEdition -eq 'Core') { (Get-Process -Id $PID).Path } else { 'powershell' }
$utf8 = New-Object Text.UTF8Encoding($true)
$MOON = [char]::ConvertFromUtf32(0x1F319)
$root = Join-Path ([IO.Path]::GetTempPath()) ("oa-491-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $root -Force | Out-Null

# write-turn.ps1 resolves its home from %LOCALAPPDATA% unless WRITE_TURN_OA_HOME overrides it.
# Leaving this unset does NOT fail the same way on both hosts, which is the whole hazard: on
# Windows it silently resolves to the developer's REAL overnight-agent home -- the harness passes
# while touching live state -- and on Linux $env:LOCALAPPDATA is null, so Join-Path throws
# "Cannot bind argument to parameter 'Path' because it is null" and every arm that invokes
# write-turn fails for a reason that has nothing to do with the guard under test. This harness hit
# exactly that: 21/21 locally, 19 arms failing in CI on the null bind. Point it at the sandbox.
$env:WRITE_TURN_OA_HOME = Join-Path $root 'oa-home'
New-Item -ItemType Directory -Path $env:WRITE_TURN_OA_HOME -Force | Out-Null

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

function Turn([string]$askLine) {
  return "## $MOON Overnight Agent -- 2026-09-25 03:00 PT`n`n<!-- from: overnight-agent -->`n`n**Status:** working.`n`n$askLine`n"
}
function Check([string]$askLine, [string[]]$extra = @()) {
  $p = Join-Path $root ("t-" + [guid]::NewGuid().ToString('N').Substring(0, 6) + '.md')
  [IO.File]::WriteAllText($p, (Turn $askLine), $utf8)
  $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $WriteTurnPath,
            '-BodyFile', $p, '-Ask', 'blocking', '-Validate') + $extra
  $so = "$p.out"; $se = "$p.err"
  $proc = Start-Process -FilePath $script:PsExe -ArgumentList $argv -NoNewWindow -Wait -PassThru `
                        -RedirectStandardOutput $so -RedirectStandardError $se
  $out = ''
  foreach ($f in @($so, $se)) { if (Test-Path $f) { $out += (Get-Content $f -Raw -ErrorAction SilentlyContinue) } }
  return [pscustomobject]@{ out = "$out"; code = $proc.ExitCode }
}
function D($r) {
  $o = ($r.out -replace '\s+', ' ')
  if ($o.Length -gt 220) { $o = $o.Substring(0, 220) + '...' }
  return "exit=$($r.code) :: $o"
}

Write-Host ''
Write-Host 'REFUSES -- an unanswerable ask must not be written'

# The live instance from this repo's own agent.
$prune = Check '**Needs from you:** reply **prune** and I''ll remove 2,951 old session folders.'
Assert ($prune.code -eq 2 -and $prune.out -match 'G16') 'LIVE-CASE' 'the measured "reply **prune**" ask is refused' (D $prune)
Assert ($prune.out -match 'prune') 'NAMES-IT' 'and the refusal quotes the offending word, not just "a problem"' (D $prune)

foreach ($w in @('confirm', 'delete', 'apply', 'ship')) {
  $r = Check "**Needs from you:** reply ``$w`` to continue."
  Assert ($r.code -eq 2) 'REJECTED' "an ask offering ``$w`` is refused" (D $r)
}

# `yes please` is DELIBERATELY not in that list, and the reason is worth recording. It reads
# like an invented token, but the reader matches `yes` inside it -- so replying it genuinely
# works, and refusing it would be a wrong refusal on a turn that is fine. The guard asks the
# reader rather than judging the phrase, which is the whole point: the arm below asserts the
# behaviour the READER has, not the one the phrase looks like it should have.
$yesPlease = Check '**Needs from you:** reply **yes please** when ready.'
Assert ($yesPlease.code -eq 0) 'SUBSTRING' 'a phrase containing an accepted word is allowed, because the reader accepts it' (D $yesPlease)

Write-Host ''
Write-Host 'QUIET -- the guard must not refuse turns that are fine'

# Every word the reader actually accepts. If any of these refused, authors would hit a wrong
# refusal on an ordinary turn and switch the guard off.
foreach ($w in @('approve', 'approved', 'yes', 'go ahead', 'lgtm', 'ship it', 'do it', 'proceed')) {
  $r = Check "**Needs from you:** reply **$w** and I'll continue."
  Assert ($r.code -eq 0) 'ACCEPTED' "an ask offering **$w** is allowed" (D $r)
}
$mergeN = Check '**Needs from you:** reply `merge 198` when you are happy.'
Assert ($mergeN.code -eq 0) 'MERGE-N' 'the command-shaped affirmative `merge <N>` is allowed' (D $mergeN)

# Bold emphasis that is not an offer. A guard firing on every bold phrase would be switched
# off within a week, and the surface would be unguarded while appearing guarded.
$emphasis = Check '**Next:** I will **prune** the old folders once the check lands.'
Assert ($emphasis.code -eq 0) 'EMPHASIS' 'bold text that is not an offered reply does not fire' (D $emphasis)

# A fenced quotation is an example -- the same exemption every other guard here grants, and
# the reason this file can document itself without refusing itself.
$fenced = Check ("**Next:** see the example below.`n`n``````" + "`n**Needs from you:** reply **prune**`n" + '``````')
Assert ($fenced.code -eq 0) 'FENCED' 'an offered word inside a fenced example is inert' (D $fenced)

Write-Host ''
Write-Host 'ESCAPE -- the documented hatch works'

$hatch = Check '**Needs from you:** reply **prune** and I''ll remove the folders.' @('-DisableGuard', 'G16')
Assert ($hatch.code -eq 0) 'HATCH' '-DisableGuard G16 clears the refusal (so the refusal was G16, not another guard)' (D $hatch)

Write-Host ''
Write-Host 'VOCABULARY -- the copy must not drift from the reader'

# write-turn.ps1 holds its own copy of the reader's regex. A copy that drifts blesses a word
# the reader rejects, reintroducing THIS defect through the guard built to prevent it.
if (Test-Path $OaStatePath) {
  $reOf = {
    param([string]$path)
    $m = [regex]::Match([IO.File]::ReadAllText($path), '(?m)^\s*\$script:ConsentAffirmRe\s*=\s*''([^'']+)''')
    if ($m.Success) { return $m.Groups[1].Value } else { return $null }
  }
  $reader = & $reOf $OaStatePath
  $writer = & $reOf $WriteTurnPath
  Assert ($null -ne $reader -and $null -ne $writer) 'BOTH-PRESENT' 'both the reader and the writer declare the vocabulary' ''
  Assert ($reader -eq $writer) 'IN-STEP' 'and the two patterns are character-for-character identical' `
    $(if ($reader -ne $writer) { "reader=$reader`n        writer=$writer" } else { '' })
}
else {
  Write-Host '  SKIP  IN-STEP  -- oa-state.ps1 not beside this script; vocabulary drift unverified'
}

Write-Host ''
Write-Host 'HERMETIC -- the arms above must have run against the sandbox, not a real home'

# Without this the harness is host-dependent in the worst way: green on Windows because it
# quietly used the developer's live overnight-agent home, red on Linux because $env:LOCALAPPDATA
# is null. Both readings are wrong, and only one of them is visible. So pin the contract the
# sandbox depends on -- write-turn must still honour the override -- and prove the child process
# actually landed in TEMP rather than somewhere real.
$homeLine = [regex]::Match([IO.File]::ReadAllText($WriteTurnPath), '(?m)^\s*\$OA_HOME\s*=.*$').Value
Assert ($homeLine -match 'WRITE_TURN_OA_HOME') 'OVERRIDE-HONOURED' `
  'write-turn still resolves its home from WRITE_TURN_OA_HOME' "OA_HOME line: $homeLine"
Assert ($env:WRITE_TURN_OA_HOME -and $env:WRITE_TURN_OA_HOME.StartsWith($root)) 'SANDBOXED' `
  'and this run pointed that home inside its own TEMP root' "home=$env:WRITE_TURN_OA_HOME root=$root"

Write-Host ''
if ($script:fail -gt 0) {
  Write-Host ("FAILED: {0} arm(s) disagreed, {1} passed." -f $script:fail, $script:pass) -ForegroundColor Red
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  exit 1
}
Write-Host ("OK: {0} arms agreed. Unanswerable asks refuse; ordinary turns stay quiet." -f $script:pass) -ForegroundColor Green
Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
exit 0
