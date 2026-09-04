<#
  resolve-ids.ps1 -- make the `titled-id-links` preference mechanical instead of aspirational.

  WHY THIS EXISTS
  ---------------
  Shiv's fourth catch-up-doc preference is that every ID in a document is a link carrying the
  underlying resource's TITLE:

      "Obviously I don't have the meaning of IDs memorized."

  That preference regresses structurally rather than carelessly. During a run the agent has every
  id loaded in context, so a page dense with bare `#423` / `#468` reads as perfectly clear to the
  process that wrote it, and is unreadable to the person it was written for. The author never
  feels the friction, so a prose rule saying "remember to add titles" is exactly the fix that does
  not work. This is a lookup instead.

  WHAT IT DOES
  ------------
  Scans a draft for ID references and resolves each one to its title:

    * `task #468`          -> the planner board row for 468
    * `issue #441` / `PR #439` -> `gh` in the target repo
    * a BARE `#441`        -> AMBIGUOUS. Planner task ids and GitHub numbers share one namespace
                              and many already collide, so both readings look right. Reported,
                              never guessed.

  Already-linked ids (`[#441](...)`, or a `#441` inside a markdown link target) are left alone,
  so the script is idempotent and safe to re-run on a partly-fixed draft.

  A title that cannot be resolved is REPORTED, never invented -- an id annotated with a guessed
  title is worse than a bare one, because it reads as verified.

  USAGE
    powershell -File resolve-ids.ps1 -Path <draft.md>            # report only (default)
    powershell -File resolve-ids.ps1 -Path <draft.md> -Apply     # rewrite in place
    powershell -File resolve-ids.ps1 -Path <draft.md> -Json      # machine-readable report

  EXIT CODES
    0  every id in the draft is resolved (or the draft has none)
    1  a usage/IO error
    2  at least one id is unresolved or ambiguous -- the draft is NOT ready to publish
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$PlannerBoard,
  [string]$CompletedBoard,
  [string]$Repo = 'shivbijlani/focus-planner',
  [switch]$Apply,
  [switch]$Json
)

$ErrorActionPreference = 'Stop'

function Read-Utf8([string]$p) { [IO.File]::ReadAllText($p, (New-Object Text.UTF8Encoding($false))) }
function Write-Utf8([string]$p, [string]$s) { [IO.File]::WriteAllText($p, $s, (New-Object Text.UTF8Encoding($false))) }

if (-not (Test-Path $Path)) { Write-Error "draft not found: $Path"; exit 1 }

# --- resolve the planner board ------------------------------------------------------------
# Default to the canonical planner folder, the same one user-settings.md points at. A missing
# board is not fatal: task ids simply become unresolved and are reported as such, which is the
# fail-loud direction. Silently reporting "no task ids found" would be the #346 shape.
if (-not $PlannerBoard) {
  $od = $env:OneDrive; if (-not $od) { $od = $env:OneDriveConsumer }; if (-not $od) { $od = $env:OneDriveCommercial }
  if ($od) { $PlannerBoard = Join-Path $od 'Apps\Focus Planner\planner.md' }
}
if (-not $CompletedBoard -and $PlannerBoard) {
  $CompletedBoard = Join-Path (Split-Path $PlannerBoard) 'planner-completed.md'
}

# Task ids live on BOTH boards. A completed task keeps its id in prose long after its row moves,
# so reading only the live board would report a real, resolvable id as unresolved.
$taskTitles = @{}
foreach ($board in @($PlannerBoard, $CompletedBoard)) {
  if ($board -and (Test-Path $board)) {
    foreach ($line in (Get-Content -LiteralPath $board)) {
      # | ID | icon | Task | ... -- take the first two cells only; titles may contain pipes-free text
      $m = [regex]::Match($line, '^\s*\|\s*(\d{1,6})\s*\|[^|]*\|\s*([^|]+?)\s*\|')
      if ($m.Success) {
        $id = $m.Groups[1].Value
        if (-not $taskTitles.ContainsKey($id)) { $taskTitles[$id] = $m.Groups[2].Value.Trim() }
      }
    }
  }
}

# --- gh lookup, memoised ------------------------------------------------------------------
$ghCache = @{}
function Get-GhTitle([string]$num) {
  if ($ghCache.ContainsKey($num)) { return $ghCache[$num] }
  $title = $null
  try {
    $raw = & gh issue view $num --repo $Repo --json title,url,state 2>$null
    if ($LASTEXITCODE -eq 0 -and $raw) {
      $o = $raw | ConvertFrom-Json
      $title = [pscustomobject]@{ title = $o.title; url = $o.url; state = $o.state }
    }
  } catch { $title = $null }
  $ghCache[$num] = $title
  return $title
}

$text = Read-Utf8 $Path

# --- mask the regions an id must NOT be rewritten inside -----------------------------------
# Fenced code, inline code and existing markdown links are all places where a rewrite would
# corrupt the document rather than improve it. Mask them to spaces so offsets are preserved and
# the scan simply never sees them.
$masked = [Text.StringBuilder]::new($text)
function Mask-Region([string]$pattern, [Text.StringBuilder]$sb, [string]$src) {
  foreach ($m in [regex]::Matches($src, $pattern, 'Singleline')) {
    for ($i = $m.Index; $i -lt $m.Index + $m.Length; $i++) { $sb[$i] = ' ' }
  }
}
$src = $text
Mask-Region '```.*?```'      $masked $src   # fenced code
Mask-Region '`[^`\r\n]*`'    $masked $src   # inline code
Mask-Region '\[[^\]]*\]\([^)]*\)' $masked $src   # existing markdown links
$scan = $masked.ToString()

# --- find the ids --------------------------------------------------------------------------
# A qualifier immediately before the # decides the namespace. Without one the reference is
# genuinely ambiguous and is reported rather than guessed.
$pattern = '(?<qual>\b(?:task|issue|PR|pr|run)\s+)?#(?<num>\d{1,6})\b'
$findings = @()
foreach ($m in [regex]::Matches($scan, $pattern)) {
  $num  = $m.Groups['num'].Value
  $qual = $m.Groups['qual'].Value.Trim().ToLowerInvariant()
  $kind = if ($qual) { $qual } else { 'ambiguous' }

  # IDEMPOTENCE: a reference this script already annotated is followed by ` ("<title>")`.
  # Without this check a second -Apply appends the title again, and the tool never converges on
  # its own output -- the same class of defect as a formatter that is not a fixed point.
  $tail = $text.Substring([Math]::Min($m.Index + $m.Length, $text.Length))
  if ($tail -match '^\s*\("') { continue }

  $title = $null; $url = $null; $status = 'unresolved'
  switch ($kind) {
    'task' {
      if ($taskTitles.ContainsKey($num)) { $title = $taskTitles[$num]; $status = 'resolved' }
    }
    'ambiguous' { $status = 'ambiguous' }
    default {
      $gh = Get-GhTitle $num
      if ($gh) { $title = $gh.title; $url = $gh.url; $status = 'resolved' }
    }
  }

  $findings += [pscustomobject]@{
    index = $m.Index; length = $m.Length; match = $m.Value
    kind = $kind; number = $num; title = $title; url = $url; status = $status
  }
}

$resolved   = @($findings | Where-Object { $_.status -eq 'resolved' })
$ambiguous  = @($findings | Where-Object { $_.status -eq 'ambiguous' })
$unresolved = @($findings | Where-Object { $_.status -eq 'unresolved' })

# --- apply ---------------------------------------------------------------------------------
# Rewrite only what was RESOLVED, back-to-front so earlier offsets stay valid. Ambiguous and
# unresolved ids are deliberately left untouched: the whole point is that a guessed title is
# worse than a bare id.
$rewrote = 0
if ($Apply -and $resolved.Count -gt 0) {
  $out = $text
  foreach ($f in ($resolved | Sort-Object index -Descending)) {
    # `PR` is an initialism and reads wrong lower-cased; the rest are ordinary words.
    $kindLabel = if ($f.kind -eq 'pr') { 'PR' } else { $f.kind }
    $label = "$kindLabel #$($f.number)"
    # A title may itself contain `#NNN` (e.g. "...stamped it (#436)"). Injected verbatim, that
    # would read as a NEW bare reference on the next scan -- so the tool's own output would fail
    # its own check and never converge. The id inside a quoted title is part of the title string,
    # not a reference the reader must follow, so drop the `#` and keep the number.
    $safeTitle = [regex]::Replace($f.title, '#(?=\d)', '')
    $repl  = if ($f.url) { "[$label]($($f.url)) (`"$safeTitle`")" } else { "$label (`"$safeTitle`")" }
    $out = $out.Substring(0, $f.index) + $repl + $out.Substring($f.index + $f.length)
    $rewrote++
  }
  Write-Utf8 $Path $out
}

# --- report ---------------------------------------------------------------------------------
$report = [pscustomobject]@{
  path = (Resolve-Path $Path).Path
  board = $PlannerBoard
  boardRows = $taskTitles.Count
  total = $findings.Count
  resolved = $resolved.Count
  ambiguous = $ambiguous.Count
  unresolved = $unresolved.Count
  applied = [bool]$Apply
  rewrote = $rewrote
  findings = $findings | Select-Object kind, number, status, title, url
}

if ($Json) {
  $report | ConvertTo-Json -Depth 5
} else {
  Write-Host "[resolve-ids] $($report.path)"
  Write-Host "[resolve-ids] board = $PlannerBoard ($($taskTitles.Count) rows)"
  Write-Host "[resolve-ids] $($report.total) id(s): $($report.resolved) resolved, $($report.ambiguous) ambiguous, $($report.unresolved) unresolved."
  foreach ($f in $findings) {
    $mark = switch ($f.status) { 'resolved' { 'ok  ' } 'ambiguous' { 'AMB ' } default { 'MISS' } }
    $t = if ($f.title) { " -- $($f.title)" } else { '' }
    Write-Host "  [$mark] $($f.kind) #$($f.number)$t"
  }
  if ($ambiguous.Count -gt 0) {
    Write-Host ""
    Write-Host "AMBIGUOUS: a bare '#N' could be a planner task or a GitHub number -- they share one"
    Write-Host "namespace. Qualify each one ('task #N', 'issue #N', 'PR #N') and re-run."
  }
  if ($Apply) { Write-Host "[resolve-ids] rewrote $rewrote reference(s) in place." }
}

if ($ambiguous.Count -gt 0 -or $unresolved.Count -gt 0) { exit 2 }
exit 0
