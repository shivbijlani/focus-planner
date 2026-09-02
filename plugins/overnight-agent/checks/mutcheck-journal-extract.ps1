<#
  mutcheck-journal-extract.ps1 -- prove `oa-state.ps1 extract` (GH #291) is load-bearing.

  WHAT IS UNDER TEST
  ------------------
  SKILL.md used to say "read the linked journal in full". Journals are append-only and nothing
  prunes them, so that instruction's cost grows without bound: measured on the live folder
  2026-09-01, 239 journals / 4.01 MB, with task-400.md alone at 272 KB (~70K tokens). #262 is the
  same defect one file over and it froze the */30 schedule for ~9 hours.

  The fix is a READER, not a rewriter -- the journal is the human source of truth and four
  separate readers key off its exact bytes (reopen hashing, consent attribution, the Telegram
  bridge's markers, the OVERNIGHT-AGENT sentinel). So `extract` makes two promises, and this file
  proves both are enforced by code rather than asserted in a comment:

    VERBATIM   every emitted region is a contiguous substring of the source. Never a summary.
    BOUNDED    total emitted bytes <= the declared ceiling, whatever the input size.

  ...plus the property that makes all of the above safe in the first place:

    READ-ONLY  running it leaves the journal byte-identical.

  ARMS. Each re-introduces a hole and must be caught by a DIFFERENT guard. An arm that stops
  failing means the guard it targets has gone decorative -- which still reports success, and is
  exactly the failure mode this repo has been burned by twice.

    b*  baseline behaviour on an UNMUTATED script (bounded, verbatim, read-only, fixed point,
        and the user's newest message survives the cut)
    m1  Get-BoundedSlice returns everything      -> ceiling breached      (killed by -Verify BOUNDED)
    m2  an emitted region is re-worded           -> not a substring       (killed by -Verify VERBATIM)
    m3  banker's midpoint AND no guard           -> INFINITE LOOP         (killed by the timeout arm)
    m3a banker's midpoint, guard left in place   -> must still terminate  (proves the backstop)
    m4  the user-messages region is dropped      -> newest decision lost  (killed by b3's sentinel)
    m5  Cmd-Extract writes to the journal        -> source mutated        (killed by the read-only arm)

  m3 is the one that matters most and it is not hypothetical: `[int](($lo+$hi)/2)` in PowerShell
  rounds BANKER'S-STYLE, so `[int]((1+2)/2)` is 2, not 1 -- the midpoint can equal `$hi`, `$hi` is
  reassigned to itself, and the search never terminates. It hung `extract -Id 349` for over 100
  seconds with no output and no error during development. A bounded-read tool that hangs is worse
  than the unbounded read it replaces, because a hang is precisely the #262 failure it exists to
  prevent.

  Run:  pwsh -NoProfile -File mutcheck-journal-extract.ps1
  Exit: 0 all mutations killed; 1 a mutation SURVIVED (a guard is not load-bearing).
#>

[CmdletBinding()]
param([string]$Target)

$ErrorActionPreference = 'Stop'
$enc = New-Object Text.UTF8Encoding($false)

# Resolve oa-state.ps1 by SEARCH, not one hard-coded home. Run from the repo this must grade the
# REPO copy; run from the flat OA home it must grade that one. Verifying the wrong artifact is a
# failure class this repo keeps closing, so the resolved path is printed -- a check that will not
# say which file it measured cannot be audited.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$candidates = @(
  $Target,
  (Join-Path $here 'oa-state.ps1'),
  (Join-Path $here '..\skills\overnight-agent\oa-state.ps1'),
  (Join-Path $env:LOCALAPPDATA 'overnight-agent\oa-state.ps1')
)
$script = $null
foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { $script = (Resolve-Path $c).Path; break } }
if (-not $script) { throw ("oa-state.ps1 not found. Tried:`n  " + (($candidates | Where-Object { $_ }) -join "`n  ")) }
Write-Host "target: $script"
$src = [IO.File]::ReadAllText($script, $enc)

$pass = 0; $fail = 0
function Check([string]$name, [bool]$cond, [string]$detail) {
  if ($cond) { $script:pass++; Write-Host "  ok   $name" }
  else { $script:fail++; Write-Host "  FAIL $name  <- $detail" }
}

# --- Fixture ---------------------------------------------------------------------------------
# A journal shaped like the real ones and deliberately far over any sane budget, carrying a
# sentinel in every region so a dropped region is visible rather than merely smaller.
#
# Pure ASCII on purpose. The managed heading is matched by oa-state.ps1 as the ASCII phrase
# `Overnight Agent`, never by the moon glyph, precisely so it survives both decodings -- and this
# harness would itself be corrupted on the way in if it carried a non-ASCII literal without a BOM
# (see ps1-encoding-sweep.mjs).
function New-Fixture {
  param([string]$Dir)
  $nl = "`r`n"
  $filler = ('filler prose that exists only to blow the byte budget. ' * 60)   # ~3.3 KB per copy

  # SHAPED LIKE THE REAL WORST CASE, AND THE FIRST VERSION OF THIS FIXTURE WAS NOT.
  # ------------------------------------------------------------------------------
  # v1 put all its bulk in the MIDDLE agent turns -- the one part of a journal the extract
  # deliberately never reads. Every region was therefore already tiny, so the per-region caps
  # never ran: m1 (unbounded slice) emitted 648 bytes and passed, and m3 (the hang) never even
  # reached Get-Utf8Suffix. Both mutants survived, and a suite in that state proves nothing while
  # reporting 14 green.
  #
  # The real shape, from task-400.md (272 KB) and task-463.md (186 KB): the USER writes short
  # replies, and the AGENT writes enormous turns. So the bulk goes where the extract actually
  # looks -- a long user brief at the top, and a very long newest agent turn -- with the middle
  # history large as well so b8 still proves the middle is skipped.
  $L = @()
  $L += '# Task 999: fixture'
  $L += '<!-- tg-meta chatId=-100123 threadId=7 -->'
  $L += ''
  $L += 'HEAD-SENTINEL the user framing at the very top.'
  $L += '**Linked:** #123'
  $L += ''
  foreach ($i in 1..24) { $L += "head brief paragraph $i. $filler" }   # ~80 KB of HEAD
  $L += 'HEAD-TAIL-SENTINEL the last line the user wrote before the agent replied.'
  $L += ''
  # An OLD short user message, then a large agent history, then a NEWER short user message. The
  # newest user decision is the thing a bounded read must never drop, so it sits AFTER the bulk.
  $L += '## 2026-01-01'
  $L += '<!-- from: me -->'
  $L += 'OLD-USER-SENTINEL the first decision.'
  $L += ''
  foreach ($i in 1..12) {
    $L += "## Overnight Agent -- run $i"
    $L += '<!-- from: overnight-agent -->'
    $L += '**Status:** In-progress'
    $L += "BULK-SENTINEL-$i $filler"
    $L += ''
  }
  $L += '## 2026-06-06'
  $L += '<!-- from: me -->'
  $L += 'NEW-USER-SENTINEL the decision that supersedes the old one.'
  $L += ''
  $L += '## Overnight Agent -- newest'
  $L += '<!-- from: overnight-agent -->'
  $L += '**Status:** In-progress'
  $L += 'TURN-SENTINEL the newest agent turn.'
  foreach ($i in 1..18) { $L += "newest turn paragraph $i. $filler" }   # ~60 KB of NEWEST TURN
  $L += '**Needs from you:** ASK-SENTINEL please confirm.'
  $L += 'TURN-TAIL-SENTINEL the last line of the newest turn.'
  $L += '<!-- /overnight-agent turn-end -->'
  $L += ''
  $L += '## 2026-06-07'
  $L += '<!-- from: me -->'
  $L += 'TRAIL-SENTINEL the unanswered reply.'
  $L += ''
  [IO.File]::WriteAllText((Join-Path $Dir 'task-999.md'), (($L -join $nl) + $nl), $enc)
}

function New-Dir {
  $d = Join-Path ([IO.Path]::GetTempPath()) ('oa291mut-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Path $d | Out-Null
  New-Fixture -Dir $d
  return $d
}

# Run a (possibly mutated) copy of oa-state.ps1 with a WALL CLOCK. m3's whole point is that the
# mutant does not fail, it HANGS -- so a harness without a timeout would hang with it and never
# report. Timeout is treated as a kill, and reported as one.
function Invoke-Extract {
  param([string]$ScriptPath, [string]$Dir, [string[]]$ExtraArgs = @(), [int]$TimeoutSec = 60)
  $args = @('-NoProfile', '-File', $ScriptPath, 'extract', '-Id', '999', '-JournalDir', $Dir) + $ExtraArgs
  $so = Join-Path $Dir ('o-' + [Guid]::NewGuid().ToString('N').Substring(0, 6) + '.txt')
  $se = "$so.err"
  $p = Start-Process -FilePath 'pwsh' -ArgumentList $args -NoNewWindow -PassThru `
       -RedirectStandardOutput $so -RedirectStandardError $se
  if (-not $p.WaitForExit($TimeoutSec * 1000)) {
    try { $p.Kill($true) } catch { }
    return [pscustomobject]@{ TimedOut = $true; Out = ''; Err = ''; Code = -1 }
  }
  return [pscustomobject]@{
    TimedOut = $false
    Out = $(if (Test-Path $so) { [IO.File]::ReadAllText($so) } else { '' })
    Err = $(if (Test-Path $se) { [IO.File]::ReadAllText($se) } else { '' })
    Code = $p.ExitCode
  }
}

function New-Mutant {
  param([hashtable[]]$Edits, [string]$Dir)
  $t = $src
  foreach ($e in $Edits) {
    if ($t.IndexOf($e.Find, [StringComparison]::Ordinal) -lt 0) {
      throw "mutation anchor not found in oa-state.ps1 (the script changed shape): $($e.Find)"
    }
    $t = $t.Replace($e.Find, $e.Replace)
  }
  $m = Join-Path $Dir 'oa-state-mutant.ps1'
  [IO.File]::WriteAllText($m, $t, $enc)
  return $m
}

# =============================================================================================
# BASELINE -- the unmutated script must actually do the job before any mutation means anything.
# =============================================================================================
Write-Host ''
Write-Host 'baseline (unmutated):'
$d0 = New-Dir
$jrnl = Join-Path $d0 'task-999.md'
$before = [IO.File]::ReadAllBytes($jrnl)
$srcKB = [math]::Round($before.Length / 1KB, 1)

$r = Invoke-Extract -ScriptPath $script -Dir $d0
Check 'b0 extract runs and exits 0' (-not $r.TimedOut -and $r.Code -eq 0) "timedOut=$($r.TimedOut) code=$($r.Code) err=$($r.Err)"
$md = $r.Out

$v = Invoke-Extract -ScriptPath $script -Dir $d0 -ExtraArgs @('-Verify')
$vj = $null; try { $vj = $v.Out | ConvertFrom-Json } catch { }
Check 'b1 -Verify reports pass on a real journal' ($null -ne $vj -and $vj.verify -eq 'pass') "out=$($v.Out) err=$($v.Err)"
Check 'b2 emitted bytes are within the declared ceiling' ($null -ne $vj -and $vj.emitted_bytes -le $vj.ceiling_bytes) "emitted=$($vj.emitted_bytes) ceiling=$($vj.ceiling_bytes)"
Check "b2a and the fixture is genuinely oversized ($srcKB KB source)" ($null -ne $vj -and $vj.source_bytes -gt $vj.ceiling_bytes * 2) "source=$($vj.source_bytes) ceiling=$($vj.ceiling_bytes)"

# The regions that must survive a bounded read. NEW-USER-SENTINEL is the load-bearing one: it is
# the user's LATEST decision and it sits below ~45 KB of agent history, so any implementation that
# only keeps "the notes at the top" silently loses it.
Check 'b3 the user''s NEWEST message survives the cut' ($md -match 'NEW-USER-SENTINEL') 'NEW-USER-SENTINEL missing from the extract'
Check 'b4 the newest agent turn survives' ($md -match 'TURN-SENTINEL') 'TURN-SENTINEL missing'
Check 'b5 the open ask survives' ($md -match 'ASK-SENTINEL') 'ASK-SENTINEL missing'
Check 'b6 the unanswered trailing reply survives' ($md -match 'TRAIL-SENTINEL') 'TRAIL-SENTINEL missing'
Check 'b7 the user''s top-of-file framing survives' ($md -match 'HEAD-SENTINEL') 'HEAD-SENTINEL missing'
# Head+tail elision: BOTH ends of an over-budget region must survive, and the cut must be stated.
# Keeping only the head would lose the latest state; keeping only the tail would lose the user's
# decisions. Neither failure changes the byte count, so only a sentinel at each end can see it.
Check 'b7a the END of an over-budget head also survives (head+tail elision)' ($md -match 'HEAD-TAIL-SENTINEL') 'HEAD-TAIL-SENTINEL missing -- only the head of the region was kept'
Check 'b7b the END of an over-budget turn also survives' ($md -match 'TURN-TAIL-SENTINEL') 'TURN-TAIL-SENTINEL missing'
Check 'b7c every elision states its size (never silent)' ($md -match 'KB elided') 'no elision marker printed even though regions were cut'
# ...and the bulk must NOT. A "bounded" read that still emits every historical turn is not bounded.
$bulkSeen = ([regex]::Matches($md, 'BULK-SENTINEL-\d+')).Count
Check 'b8 the bulk agent history is NOT emitted in full' ($bulkSeen -lt 12) "saw $bulkSeen of 12 bulk sentinels"

# READ-ONLY. This is the property that lets a journal -- the human source of truth, hashed by the
# reopen gate and attributed by the consent gate -- be touched at all.
$after = [IO.File]::ReadAllBytes($jrnl)
$same = ($before.Length -eq $after.Length) -and (-not (Compare-Object $before $after -SyncWindow 0))
Check 'b9 the journal is byte-identical after extracting (READ-ONLY)' $same "before=$($before.Length)B after=$($after.Length)B"

# FIXED POINT. Same input, same output -- so it is safe on a */30 cadence.
$r2 = Invoke-Extract -ScriptPath $script -Dir $d0
Check 'b10 running it twice yields identical output (fixed point)' ($r2.Out -eq $md) 'second run differed'

Remove-Item $d0 -Recurse -Force -ErrorAction SilentlyContinue

# =============================================================================================
# MUTATIONS
# =============================================================================================
Write-Host ''
Write-Host 'mutations (each must be KILLED):'

# --- m1: bounding removed. -----------------------------------------------------------------
# Get-BoundedSlice hands back the whole region, so the extract emits the entire journal. The
# BOUNDED half of -Verify must catch it. This is the defect itself, re-introduced.
$d = New-Dir
$m1 = New-Mutant -Dir $d -Edits @(@{
  Find = '  $full = Get-Utf8ByteCount $text
  if ($maxBytes -le 0) {'
  Replace = '  $full = Get-Utf8ByteCount $text
  if ($true) { return [pscustomobject]@{ Head = $text; Tail = ''''; FullBytes = $full; ElidedBytes = 0; Truncated = $false } }
  if ($maxBytes -le 0) {'
})
$o = Invoke-Extract -ScriptPath $m1 -Dir $d -ExtraArgs @('-Verify')
$oj = $null; try { $oj = $o.Out | ConvertFrom-Json } catch { }
Check 'm1 unbounded slice is killed by -Verify (ceiling breached)' `
  (-not $o.TimedOut -and $o.Code -ne 0 -and $null -ne $oj -and $oj.verify -eq 'fail') `
  "code=$($o.Code) verify=$($oj.verify) emitted=$($oj.emitted_bytes) ceiling=$($oj.ceiling_bytes)"
Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue

# --- m2: verbatim broken. -------------------------------------------------------------------
# The emitted head is re-worded. A summary of the user's own words is the one thing this tool
# must never produce, so the VERBATIM half of -Verify must catch it.
$d = New-Dir
$m2 = New-Mutant -Dir $d -Edits @(@{
  Find = '  $headEnd = [Math]::Min((Get-JournalHeadIndex $content), $content.Length)
  $head = $content.Substring(0, $headEnd)'
  Replace = '  $headEnd = [Math]::Min((Get-JournalHeadIndex $content), $content.Length)
  $head = ($content.Substring(0, $headEnd) -replace ''SENTINEL'', ''PARAPHRASED'')'
})
$o = Invoke-Extract -ScriptPath $m2 -Dir $d -ExtraArgs @('-Verify')
$oj = $null; try { $oj = $o.Out | ConvertFrom-Json } catch { }
Check 'm2 paraphrased region is killed by -Verify (not a substring)' `
  (-not $o.TimedOut -and $o.Code -ne 0 -and $null -ne $oj -and $oj.verify -eq 'fail') `
  "code=$($o.Code) verify=$($oj.verify) problems=$($oj.problems -join '; ')"
Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue

# --- m3 / m3a: the hang, and the backstop that contains it. ----------------------------------
# `[int](($lo + $hi) / 2)` rounds BANKER'S-STYLE, so the midpoint can equal $hi, $hi is reassigned
# to itself, and Get-Utf8Suffix spins forever. It hung `extract -Id 349` for over 100 seconds
# during development with no output and no error.
#
# There are TWO defences and they are tested separately, because the first run of this file
# discovered they are not the same defence: with only the arithmetic reverted the mutant did NOT
# hang -- the iteration guard caught it. That is the guard doing its job, but an arm that cannot
# distinguish "the arithmetic is right" from "the guard saved us" grades neither.
#
#   m3   arithmetic reverted AND the guard removed  -> must HANG (proves the bug is real)
#   m3a  arithmetic reverted, guard left in place   -> must STILL TERMINATE (proves the backstop)
$mid_ok = '    $mid = [int][Math]::Floor(($lo + $hi) / 2.0)
    if ($mid -ge $hi) { $mid = $hi - 1 }
    if ($mid -lt $lo) { $mid = $lo }'
$mid_bad = '    $mid = [int](($lo + $hi) / 2)'
$guardLine = '    if (++$guard -gt 64) { break }'

$d = New-Dir
$m3 = New-Mutant -Dir $d -Edits @(
  @{ Find = $mid_ok;    Replace = $mid_bad },
  @{ Find = $guardLine; Replace = '    # guard removed by mutation' }
)
$o = Invoke-Extract -ScriptPath $m3 -Dir $d -TimeoutSec 25
Check 'm3 banker''s-rounding midpoint with no guard is killed (it HANGS)' `
  ($o.TimedOut -or $o.Code -ne 0) "timedOut=$($o.TimedOut) code=$($o.Code) -- the infinite loop did not occur, so the arithmetic fix is not load-bearing"
Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue

$d = New-Dir
$m3a = New-Mutant -Dir $d -Edits @(@{ Find = $mid_ok; Replace = $mid_bad })
$o = Invoke-Extract -ScriptPath $m3a -Dir $d -TimeoutSec 45
Check 'm3a the iteration guard contains the same bug (terminates instead of hanging)' `
  (-not $o.TimedOut) 'the guard did not stop the loop, so the backstop is not load-bearing'
Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue

# --- m4: the user's later messages dropped. --------------------------------------------------
# Reverts the extract to "the notes at the top" only. -Verify still passes -- the output is
# bounded and verbatim, it is just MISSING the user's latest decision. That is the point of a
# behavioural sentinel: a correctness hole that both mechanical guards are blind to.
$d = New-Dir
$m4 = New-Mutant -Dir $d -Edits @(@{
  Find = '  $userMsgs = @(Get-JournalUserMessages $content)'
  Replace = '  $userMsgs = @()'
})
$o = Invoke-Extract -ScriptPath $m4 -Dir $d
Check 'm4 dropping the user-messages region is killed (newest decision lost)' `
  (-not $o.TimedOut -and ($o.Out -notmatch 'NEW-USER-SENTINEL')) `
  'the mutant still emitted NEW-USER-SENTINEL, so b3 is not load-bearing'
Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue

# --- m5: it writes. --------------------------------------------------------------------------
# Cmd-Extract appends to the journal it was asked to read. Nothing about the OUTPUT changes, so
# only the byte-comparison arm can see it. This proves b9 is a real check and not a comment --
# and b9 is the arm standing between this tool and the reopen/consent gates.
$d = New-Dir
$j = Join-Path $d 'task-999.md'
$m5 = New-Mutant -Dir $d -Edits @(@{
  Find = '  $content = Read-JournalText $path
  $sourceBytes = Get-Utf8ByteCount $content'
  Replace = '  $content = Read-JournalText $path
  Add-Content -LiteralPath $path -Value "mutant wrote here"
  $sourceBytes = Get-Utf8ByteCount $content'
})
$b5 = [IO.File]::ReadAllBytes($j)
$o = Invoke-Extract -ScriptPath $m5 -Dir $d
$a5 = [IO.File]::ReadAllBytes($j)
$unchanged = ($b5.Length -eq $a5.Length) -and (-not (Compare-Object $b5 $a5 -SyncWindow 0))
Check 'm5 a writing extract is killed by the read-only arm' (-not $unchanged) `
  'the mutant wrote to the journal and the byte comparison did not notice'
Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host "$pass passed, $fail failed"
exit $(if ($fail) { 1 } else { 0 })
