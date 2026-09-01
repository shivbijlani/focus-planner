<#
  split-user-settings.ps1 -- take the agent's append-only notes OUT of the per-run read path,
  so `user-settings.md` goes back to being a settings file the agent can actually read.

  WHY THIS EXISTS (GH #262, measured 2026-08-29 and again 2026-08-31)
  -------------------------------------------------------------------
  SKILL.md tells the agent to read `user-settings.md` at the start of EVERY run. That file has
  become an append-only hazards/lessons log:

      2026-08-23  28 KB      2026-08-27  616 -> 736 KB      2026-08-29  933 -> 940 KB
      2026-08-26  477 KB     2026-08-28  884 KB             2026-08-31  946 KB

  Measured on run 30a97ad9 (2026-08-29): 49 model round-trips, input tokens avg 239,624, and the
  settings file alone was ~232,543 tokens -- i.e. **~97% of the context window on every single
  call**, before the run did any work. That run sat in `running` for ~9 hours and never finished,
  which froze the */30 schedule.

  It has now crossed a second threshold. On 2026-08-31 the agent's own file reader REFUSED the
  file outright -- "File too large to read at once (946.0 KB)" -- so PHASE 0 could not read its
  own configuration and had to reconstruct the settings table from greps. The file that
  configures the agent is now too large for the agent to read.

  WHAT IT DOES
  ------------
  Splits the file in place into two, losslessly:

    user-settings.md   the SETTINGS -- paths, accounts, allow-lists, preferences, browser slots.
                       Small enough to read every run. This is the per-run read path.
    agent-lore.md      EVERYTHING ELSE -- the dated run-learnings, postmortems and hazard essays,
                       verbatim and in original order, with an index. NOT auto-loaded; the agent
                       greps it on demand.

  Two reductions, in order:
    A. SECTION ARCHIVE. Any `## ` section that is not on the keep-list moves to the lore file.
       The keep-list is small and explicit (below) rather than inferred, because "has a settings
       table" is not the same question as "is operative" -- `## Preferences` and
       `## Browser slots` carry no table and are both load-bearing.
    B. CELL TRIM. Inside the KEPT sections, a `| Setting | Value |` row whose value cell has grown
       past -MaxCellChars keeps its operative head and relocates the tail to the lore file under
       an anchor, leaving an explicit pointer in the cell. Nothing is deleted -- one grep away.

  The index left behind is what makes A safe. The archived headings in this corpus state their own
  rule ("STOP -- RELIABILITY IS ALWAYS HIGH PRIORITY", "STOP -- Keep turns short"), so listing the
  headings preserves nearly all of the behavioural signal at ~1% of the bytes, and dated run
  learnings collapse to a count plus a date range.

  WHY NOT JUST DELETE THE OLD NOTES
  ---------------------------------
  Because every one of them was written after something went wrong, and the agent still cites
  them. The problem was never that the notes exist -- it is that they were on the critical path.
  This moves them off it; it does not judge them.

  GUARDS (each must be load-bearing; see mutcheck-split-settings.ps1)
    g1 LOSSLESS OR NOTHING. Before writing, reassemble the original from the pieces and require a
       byte-exact match, and require every relocated cell tail to appear verbatim in the lore
       text. Any mismatch aborts with NO file written. A "split" that silently drops a settings
       value would hand the agent a wrong path or a wrong allow-list and look perfectly healthy
       doing it -- worse than the bloat it is fixing.
    g2 BACK UP FIRST. The source is the user's own OneDrive file and the only copy of its
       history. The backup is taken before the first byte is written, so a crash mid-write is
       recoverable.
    g3 UTF-8 IN, UTF-8 OUT, EXPLICITLY. These files are UTF-8 with no BOM and Windows PowerShell
       5.1 decodes them as the ANSI codepage. A read-modify-write through the default decoder
       re-encodes the mojibake permanently, silently, exit 0 -- that is how 593 lines of
       task-448.md were destroyed on 2026-08-27. Never `Get-Content -Raw` here.
    g4 IDEMPOTENT. Re-running appends only sections that are not already in the lore file, and a
       second immediate run is a no-op. This runs unattended; a script that duplicates its own
       output on every run is a second growth problem wearing the fix's clothes.
    g5 KEEP THE ROW SHAPE. A trimmed cell must still be a valid table row with the same cell
       count, and the cut may not land inside an escaped pipe. `src/config/userSettingsForm.js`
       edits this file by splicing value cells by offset, so a malformed row does not degrade the
       web app's settings editor -- it corrupts the file the next time the user saves it.
    g6 VERIFY THE BYTES ON DISK, THEN ROLL BACK. After writing, re-read both outputs and count
       aligned `C3 A2` / `C3 B0` byte pairs -- the fingerprint of UTF-8 text that was decoded as
       ANSI and re-encoded. If the outputs carry MORE than the source did, restore the backup and
       fail. This caught a real defect in this very script: Windows PowerShell 5.1 reads a BOM-less
       .ps1 as the ANSI codepage, so the non-ASCII literals in the script's OWN source (an ellipsis,
       an arrow, an emoji) were mojibake before they were ever written, and the first run introduced
       94 corrupt sequences while every in-memory check passed. The script's emitted text is now
       ASCII-only so the host's decoder cannot matter, and g6 is the standing proof of that -- it
       compares against the source as a control rather than asserting zero, because legitimate
       `C3 A2` pairs do occur (the source has 10).

  USAGE
    -WhatIf         report what would move; write nothing.
    -Json           machine-readable summary on stdout.
    -MaxCellChars   cell budget before a tail is relocated (default 600; 0 disables stage B).

  EXIT CODES
    0  split applied (or already split / nothing to do)
    1  refused -- a guard failed; nothing was written
#>

[CmdletBinding()]
param(
  [string] $SettingsPath,
  [string] $LorePath,
  [int]    $MaxCellChars = 600,
  [switch] $Json,
  [switch] $WhatIf
)

$ErrorActionPreference = 'Stop'
$enc = New-Object Text.UTF8Encoding($false)

# ---------------------------------------------------------------- keep-list --
# Explicit, ordered, and matched against the heading text. Everything not matched
# here is archived. Kept deliberately short: a long keep-list is how the per-run
# read path grew in the first place.
$KeepPatterns = @(
  '^Settings$',
  '^Telegram\b',
  '^Preferences$',
  '^Browser slots\b'
)

$LORE_MARKER   = '<!-- overnight-agent: archived operational notes; see user-settings.md -->'
$POINTER_TOKEN = 'full notes: agent-lore.md#'
$POINTER_START = '<!-- oa-lore-index:start -->'
$POINTER_END   = '<!-- oa-lore-index:end -->'

function Resolve-SettingsPath {
  if ($SettingsPath) { return $SettingsPath }
  if ($env:OVERNIGHT_AGENT_SETTINGS -and (Test-Path $env:OVERNIGHT_AGENT_SETTINGS)) {
    return $env:OVERNIGHT_AGENT_SETTINGS
  }
  foreach ($root in @($env:OneDrive, $env:OneDriveConsumer, $env:OneDriveCommercial)) {
    if ($root) {
      $p = Join-Path $root 'Apps\Focus Planner\user-settings.md'
      if (Test-Path $p) { return $p }
    }
  }
  $p = Join-Path $env:LOCALAPPDATA 'overnight-agent\user-settings.md'
  if (Test-Path $p) { return $p }
  throw 'Could not resolve user-settings.md; pass -SettingsPath.'
}

function Read-Utf8([string]$Path) {
  # g3: explicit decoder. Never Get-Content -Raw.
  return [IO.File]::ReadAllText($Path, $enc)
}

function Write-Utf8([string]$Path, [string]$Text) {
  [IO.File]::WriteAllText($Path, $Text, $enc)
}

function Get-Sections([string[]]$Lines) {
  # Split into (preamble, then one entry per `## ` heading). Returns objects carrying
  # the ORIGINAL line span so the source can be reassembled byte-exactly for g1.
  $out = @()
  $cur = $null; $start = 0
  for ($i = 0; $i -lt $Lines.Count; $i++) {
    if ($Lines[$i] -match '^##\s+(.*)$') {
      $out += [pscustomobject]@{ Heading = $cur; Start = $start; End = $i - 1 }
      $cur = $Matches[1].Trim(); $start = $i
    }
  }
  $out += [pscustomobject]@{ Heading = $cur; Start = $start; End = $Lines.Count - 1 }
  return $out
}

function Get-Span([string[]]$Lines, [int]$Start, [int]$End) {
  # PowerShell's range operator counts DOWN when End < Start, so `$lines[0..-1]` silently
  # returns two elements (the first and the last line) instead of none. An empty section --
  # produced whenever a `## ` heading is the very first line of the file -- therefore
  # duplicates content and breaks g1's reassembly. Return a real empty array instead.
  if ($End -lt $Start) { return @() }
  return $Lines[$Start..$End]
}

function Test-Keep($Heading) {
  # NB: do NOT type this parameter as [string]. PowerShell coerces $null to the empty string
  # on binding, so `$null -eq $Heading` never fires and the PREAMBLE -- the only section with
  # no heading, and the one holding the file's own explanation of what it is -- gets archived.
  # That is exactly what happened on the first live-shaped run: the split "succeeded", every
  # guard passed, and the settings file came back starting at `## Settings` with its header
  # prose moved to the lore file.
  if ([string]::IsNullOrWhiteSpace($Heading)) { return $true }   # preamble always stays
  foreach ($p in $KeepPatterns) { if ($Heading -match $p) { return $true } }
  return $false
}

function New-Anchor([string]$Text) {
  $a = $Text.ToLowerInvariant() -replace '[^a-z0-9]+', '-'
  return ($a.Trim('-'))
}

function Split-TableRow([string]$Line) {
  # Cell boundaries are UNESCAPED pipes; `\|` is a literal inside a cell. Mirrors
  # splitTableRow() in src/config/userSettingsForm.js so the two agree on shape (g5).
  $pipes = @()
  for ($i = 0; $i -lt $Line.Length; $i++) {
    if ($Line[$i] -eq '|' -and ($i -eq 0 -or $Line[$i - 1] -ne '\')) { $pipes += $i }
  }
  if ($pipes.Count -lt 2) { return $null }
  $cells = @()
  for ($p = 0; $p -lt $pipes.Count - 1; $p++) {
    $s = $pipes[$p] + 1; $e = $pipes[$p + 1]
    $cells += [pscustomobject]@{ Start = $s; End = $e; Text = $Line.Substring($s, $e - $s) }
  }
  return $cells
}

function Find-CutPoint([string]$Text, [int]$Budget) {
  # Cut on a sentence/clause boundary at or before $Budget, never inside an escaped
  # pipe and never mid-word. Returns -1 when no safe cut exists (leave the cell alone).
  if ($Text.Length -le $Budget) { return -1 }
  $best = -1
  # Prefer the end of a sentence; fall back to a clause break, then whitespace.
  foreach ($pattern in @('(?<=[.!?])\s', '(?<=[;:])\s', '\s')) {
    $m = [regex]::Matches($Text.Substring(0, $Budget), $pattern)
    if ($m.Count -gt 0) { $best = $m[$m.Count - 1].Index + $m[$m.Count - 1].Length; break }
  }
  if ($best -le 0) { return -1 }
  # g5: never leave a dangling backslash that would turn the next `|` into an escape.
  while ($best -gt 0 -and $Text[$best - 1] -eq '\') { $best-- }
  if ($best -le 0) { return -1 }
  return $best
}

# ------------------------------------------------------------------- run ----

$settings = Resolve-SettingsPath
if (-not $LorePath) { $LorePath = Join-Path (Split-Path -Parent $settings) 'agent-lore.md' }

$original = Read-Utf8 $settings
$nl       = if ($original -match "`r`n") { "`r`n" } else { "`n" }

# The index block below is agent-generated and regenerated on every run. Strip it BEFORE parsing,
# or it parses as an ordinary `## ` section, fails the keep-list, and gets archived -- so each run
# moves the previous index into the lore file and appends a fresh one. That is not merely untidy:
# it makes the script a slow growth engine on the very file it exists to shrink, which is the bug
# it was written to fix wearing the fix's clothes. Stripping first makes the split a fixed point.
$body = [regex]::Replace($original,
  [regex]::Escape($POINTER_START) + '.*?' + [regex]::Escape($POINTER_END),
  '', 'Singleline').TrimEnd()

$lines    = $body -split "`r?`n"

$sections = Get-Sections $lines
$keep = @(); $archive = @()
foreach ($s in $sections) { if (Test-Keep $s.Heading) { $keep += $s } else { $archive += $s } }

# --- g1, part 1: the pieces must reassemble into the source, byte for byte ------
$reassembled = (($sections | Sort-Object Start | ForEach-Object { Get-Span $lines $_.Start $_.End }) -join $nl)
if ($reassembled -ne ($lines -join $nl)) {
  Write-Error 'REFUSED (g1): section split does not reassemble to the source. Nothing written.'
  exit 1
}

$existingLore = if (Test-Path $LorePath) { Read-Utf8 $LorePath } else { '' }

# ---- stage A: move non-keep sections out ------------------------------------
$loreChunks = @()
$moved      = @()
foreach ($s in $archive) {
  $text = ((Get-Span $lines $s.Start $s.End) -join $nl).TrimEnd()
  if ($text.Length -eq 0) { continue }
  # g4: idempotent -- never append a section the lore file already holds.
  if ($existingLore.Contains($text)) { continue }
  $loreChunks += $text
  $moved += [pscustomobject]@{ Heading = $s.Heading; Chars = $text.Length }
}

# ---- stage B: relocate oversized value cells in the KEPT sections ------------
$keptLines = New-Object System.Collections.Generic.List[string]
$trimmed   = @()
foreach ($s in ($keep | Sort-Object Start)) {
  $inTable = $false
  for ($i = $s.Start; $i -le $s.End; $i++) {
    $line = $lines[$i]
    $emit = $line

    if ($MaxCellChars -gt 0 -and $line.TrimStart().StartsWith('|')) {
      $cells = Split-TableRow $line
      if ($cells -and $cells.Count -ge 2) {
        $label = $cells[0].Text.Trim()
        $val   = $cells[1].Text.Trim()
        if ($label.ToLowerInvariant() -eq 'setting' -and $val.ToLowerInvariant() -eq 'value') {
          $inTable = $true
        }
        elseif ($inTable -and $val -notmatch '^:?-{3,}:?$' -and $val.Length -gt $MaxCellChars -and
                -not $val.Contains($POINTER_TOKEN)) {
          # g4: a cell that already carries a pointer has been trimmed. Re-trimming it is not a
          # no-op -- the pointer itself costs ~90 chars, so a head sized exactly to the budget
          # comes back OVER budget and the cell gets cut again on every run, shedding a little
          # more operative text each time. Skipping on the marker makes the trim a fixed point.
          $cut = Find-CutPoint $val $MaxCellChars
          if ($cut -gt 0) {
            $head   = $val.Substring(0, $cut).TrimEnd()
            $tail   = $val.Substring($cut).Trim()
            $anchor = New-Anchor "$($s.Heading) $label"
            $ptr    = "$head ... **[full notes: agent-lore.md#$anchor]($([IO.Path]::GetFileName($LorePath))#$anchor)**"
            # Splice ONLY the value cell, preserving every other byte of the row (g5).
            $emit = $line.Substring(0, $cells[1].Start) + ' ' + $ptr + ' ' + $line.Substring($cells[1].End)
            $trimmed += [pscustomobject]@{ Section = $s.Heading; Label = $label; Moved = $tail.Length; Anchor = $anchor; Tail = $tail }
          }
        }
      }
    } else { $inTable = $false }

    $keptLines.Add($emit)
  }
}

# Tails become their own lore sections, so the pointer anchors resolve.
foreach ($t in $trimmed) {
  $chunk = "## $($t.Anchor)$nl$nl*Relocated from ``user-settings.md`` -> **$($t.Section)** -> ``$($t.Label)``.*$nl$nl$($t.Tail)"
  if (-not $existingLore.Contains($t.Tail)) { $loreChunks += $chunk }
}

# ---- assemble the lore file BEFORE the index, because the index is derived from it ----
$loreOut = $existingLore
if ($loreChunks.Count -gt 0) {
  if (-not $loreOut) {
    $loreOut = @(
      '# Overnight Agent - operational lore (archive)'
      ''
      $LORE_MARKER
      ''
      'Moved out of `user-settings.md` so it stops consuming the per-run context window (GH #262).'
      'Everything here is **verbatim** and in original order. This file is **not** read at run'
      'start - grep it on demand.'
      ''
    ) -join $nl
  }
  $loreOut = $loreOut.TrimEnd() + $nl + $nl + (($loreChunks) -join ($nl + $nl)) + $nl
}

# ---- build the index the kept file carries in place of the archived prose ----
# Built from what the LORE FILE actually contains, not from what moved on THIS run. Deriving it
# from `$moved` looks right on the first run and then silently empties on the second, because a
# re-run correctly moves nothing -- so the index, which is the only thing standing in for 135
# archived sections, would erase itself the moment the script became idempotent.
$loreHeadings = @()
$loreLines = $loreOut -split "`r?`n"
for ($i = 0; $i -lt $loreLines.Count; $i++) {
  if ($loreLines[$i] -match '^##\s+(.*)$') {
    $h = $Matches[1].Trim()
    # Stage-B cell tails are already pointed at from their own table row; they are not rules.
    $isTail = $false
    for ($k = $i + 1; $k -lt [Math]::Min($i + 4, $loreLines.Count); $k++) {
      if ($loreLines[$k] -match '^\*Relocated from') { $isTail = $true; break }
    }
    if (-not $isTail) { $loreHeadings += $h }
  }
}
$rules   = @($loreHeadings | Where-Object { $_ -notmatch '^(?:\d{4}-\d{2}-\d{2}\s+)?[Rr]un learnings' })
$history = @($loreHeadings | Where-Object { $_ -match     '^(?:\d{4}-\d{2}-\d{2}\s+)?[Rr]un learnings' })

$idx = New-Object System.Collections.Generic.List[string]
$idx.Add($POINTER_START)
$idx.Add('')
$idx.Add('## Operational notes live in `agent-lore.md`')
$idx.Add('')
$idx.Add('This file is the **per-run read path** and is kept small on purpose (GH #262: at 946 KB it was')
$idx.Add('~97% of the model context on every call, and then grew past the point the agent could read it')
$idx.Add('at all). The accumulated hazard essays and dated run-learnings were moved **verbatim** to')
$idx.Add('`agent-lore.md` in the same folder. Nothing was deleted.')
$idx.Add('')
$idx.Add('**Read `agent-lore.md` on demand, never at run start** - grep it for the heading you need.')
$idx.Add('')
if ($rules.Count -gt 0) {
  $idx.Add("### Standing rules moved to the lore file ($($rules.Count))")
  $idx.Add('')
  $idx.Add('These headings state their own rule, which is why the index is a usable substitute for the')
  $idx.Add('body. Open the lore file when one of them is relevant.')
  $idx.Add('')
  foreach ($r in $rules) {
    $h = $r
    if ($h.Length -gt 150) { $h = $h.Substring(0, 150) + '...' }
    $idx.Add("- $h")
  }
  $idx.Add('')
}
if ($history.Count -gt 0) {
  $dates = $history | ForEach-Object { if ($_ -match '(\d{4}-\d{2}-\d{2})') { $Matches[1] } } | Sort-Object -Unique
  $idx.Add("### Dated run learnings moved to the lore file ($($history.Count) entries)")
  $idx.Add('')
  if ($dates.Count -gt 0) {
    $idx.Add("Covering **$($dates[0]) to $($dates[-1])**. Chronological postmortems; consult only when")
    $idx.Add('chasing a specific past incident.')
  }
  $idx.Add('')
}
$idx.Add($POINTER_END)

# Drop any previous index block so re-runs replace rather than stack (g4).
$kept = ($keptLines -join $nl)
$kept = $kept.TrimEnd() + $nl + $nl + ($idx -join $nl) + $nl

# ---- g1, part 2: every relocated byte must be present in the lore output -----
$violations = @()
foreach ($m in $loreChunks) { if (-not $loreOut.Contains($m)) { $violations += 'archived chunk missing from lore output' } }
foreach ($t in $trimmed)    { if (-not $loreOut.Contains($t.Tail)) { $violations += "relocated tail missing: $($t.Label)" } }
foreach ($s in ($keep | Sort-Object Start)) {
  # Every KEPT section heading must survive into the kept file.
  if ($s.Heading -and -not $kept.Contains($s.Heading)) { $violations += "kept heading vanished: $($s.Heading)" }
}
# The preamble has no heading, so the loop above cannot see it -- and it is precisely what a
# null-vs-empty-string slip archives by accident. Assert it directly: whatever the source opened
# with must still open the kept file.
$preamble = $sections | Where-Object { [string]::IsNullOrWhiteSpace($_.Heading) } | Select-Object -First 1
if ($preamble) {
  $preText = ((Get-Span $lines $preamble.Start $preamble.End) -join $nl).Trim()
  if ($preText -and -not $kept.TrimStart().StartsWith($preText.Split("`n")[0].Trim())) {
    $violations += 'preamble did not survive into the kept file'
  }
}
if ($violations.Count -gt 0) {
  Write-Error ("REFUSED (g1): " + ($violations -join '; ') + ". Nothing written.")
  exit 1
}

$summary = [ordered]@{
  settingsPath   = $settings
  lorePath       = $LorePath
  beforeChars    = $original.Length
  afterChars     = $kept.Length
  loreChars      = $loreOut.Length
  sectionsMoved  = $moved.Count
  cellsTrimmed   = $trimmed.Count
  rulesIndexed   = $rules.Count
  historyIndexed = $history.Count
  reductionPct   = if ($original.Length -gt 0) { [math]::Round(100 - (100 * $kept.Length / $original.Length), 1) } else { 0 }
  whatIf         = [bool]$WhatIf
  backup         = $null
}

function Count-MojibakePairs([string]$Path) {
  # g6: aligned byte comparison, never a hex-string regex. A byte pair is 2 hex chars, so a
  # naive hex scan also matches at odd offsets straddling two unrelated bytes and reports
  # phantom hits (measured: 2-6 false positives per file, including on untouched controls).
  $b = [IO.File]::ReadAllBytes($Path)
  $n = 0
  for ($i = 0; $i -lt $b.Length - 1; $i++) {
    if ($b[$i] -eq 0xC3 -and ($b[$i + 1] -eq 0xA2 -or $b[$i + 1] -eq 0xB0)) { $n++ }
  }
  return $n
}

# g4: a run that changes neither file must not write at all. Comparing the OUTPUT to the source
# (rather than counting what moved) is what makes this a true fixed point: it stays a no-op even
# if some future classification change makes `moved`/`trimmed` non-zero without altering bytes.
# This script is on the PHASE 0 path every 30 minutes against a OneDrive-synced file, so a
# "harmless" rewrite is a sync event and a backup file, forever.
$changed = ($kept -ne $original) -or ($loreOut -ne $existingLore)
$summary.noOp = -not $changed

if (-not $WhatIf -and $changed) {
  # g2: back up before the first write.
  $bak = "$settings.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Write-Utf8 $bak $original
  $summary.backup = $bak
  $loreBak = $null
  $preLorePairs = 0
  if (Test-Path $LorePath) {
    $loreBak = Read-Utf8 $LorePath
    # g6's baseline is BOTH outputs as they stand, not the settings file alone. On a re-run the
    # settings file has already shed its non-ASCII prose into the lore file, so comparing
    # settings-before against settings+lore-after counts every legitimate pair in the lore file
    # as newly introduced and refuses a perfectly good no-op.
    $preLorePairs = Count-MojibakePairs $LorePath
  }

  Write-Utf8 $LorePath $loreOut
  Write-Utf8 $settings $kept

  # g6: the artefact on disk is the thing that matters, not the in-memory strings.
  $srcPairs = (Count-MojibakePairs $bak) + $preLorePairs
  $outPairs = (Count-MojibakePairs $settings) + (Count-MojibakePairs $LorePath)
  $summary.mojibakeSource = $srcPairs
  $summary.mojibakeOutput = $outPairs
  if ($outPairs -gt $srcPairs) {
    Write-Utf8 $settings $original
    if ($null -ne $loreBak) { Write-Utf8 $LorePath $loreBak } else { Remove-Item $LorePath -Force -EA SilentlyContinue }
    Write-Error ("REFUSED (g6): writing introduced $($outPairs - $srcPairs) mojibake byte pairs " +
                 "(source $srcPairs, output $outPairs). Rolled back; original restored.")
    exit 1
  }
}

if ($Json) { $summary | ConvertTo-Json -Depth 4 }
else {
  Write-Host "[split-settings] $($summary.settingsPath)"
  Write-Host "[split-settings] before $([math]::Round($summary.beforeChars/1kb)) KB -> after $([math]::Round($summary.afterChars/1kb)) KB  (-$($summary.reductionPct)%)"
  Write-Host "[split-settings] lore   $([math]::Round($summary.loreChars/1kb)) KB at $($summary.lorePath)"
  Write-Host "[split-settings] sections moved $($summary.sectionsMoved), cells trimmed $($summary.cellsTrimmed)"
  if ($summary.backup) { Write-Host "[split-settings] backup $($summary.backup)" }
  if ($WhatIf) { Write-Host '[split-settings] -WhatIf: nothing written.' }
}
exit 0
