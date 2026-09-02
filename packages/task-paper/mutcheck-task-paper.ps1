# Mutation check for the task-paper package.
#
# A test that passes both with and without the behaviour it names is not a guard. Each
# mutation below removes ONE deliberate decision; the suite must go red for each, and the
# report names which test caught it.
#
# FILES ARE HANDLED AS BYTES, NEVER AS PowerShell STRINGS.
# The first version of this harness used `Get-Content -Raw` / `Set-Content -Encoding UTF8`
# to save and restore each source. Under Windows PowerShell 5.1 that is a lossy round
# trip: `Get-Content` on a BOM-less UTF-8 file decodes it as the ANSI code page, so every
# multi-byte character comes back as mojibake, and `Set-Content` then writes that mojibake
# back as real UTF-8 -- double-encoding the file and adding a BOM. It corrupted four
# sources on its first run (a literal moon emoji in a comment became three Latin letters),
# and because the mutations only ever touch ASCII anchors the tests still passed; only
# eslint's no-irregular-whitespace rule caught it. A harness that silently damages the
# code it is verifying is worse than no harness, so the original bytes are now captured
# up front and restored verbatim.
$ErrorActionPreference = 'Stop'

$src  = Join-Path $PSScriptRoot 'src'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path (Join-Path $root 'package.json'))) { $root = 'V:\repos\focus-planner' }

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Read-SourceText([string]$Path) {
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    $bytes = $bytes[3..($bytes.Length - 1)]
  }
  [System.Text.Encoding]::UTF8.GetString($bytes)
}
function Write-SourceText([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllBytes($Path, $Utf8NoBom.GetBytes($Text))
}

$mutations = @(
  @{ name = 'M1 fence-blind turn splitter'; file = 'paper.js'
     from = 'if (!mask[i] && AGENT_TURN_HEADING_RE.test(entry.line))'
     to   = 'if (AGENT_TURN_HEADING_RE.test(entry.line))' }
  @{ name = 'M2 fence-blind section splitter'; file = 'paper.js'
     from = 'const m = mask[i] ? null : line.match('
     to   = 'const m = line.match(' }
  @{ name = 'M3 body keeps the Run log'; file = 'paper.js'
     from = 'const APPENDIX_SECTION_RE = /^(?:run\s*log|honest\s+note|corrections?|what\s+i\s+got\s+wrong)\b/i'
     to   = 'const APPENDIX_SECTION_RE = /^__never_matches__$/i' }
  @{ name = 'M4 oldest turn treated as current'; file = 'paper.js'
     from = 'const currentTurn = agentTurns.length ? agentTurns[agentTurns.length - 1] : null'
     to   = 'const currentTurn = agentTurns.length ? agentTurns[0] : null' }
  @{ name = 'M5 sentinel rule left on user message'; file = 'paper.js'
     from = 'const body = stripTrailingRule(g.lines).join(''\n'')'
     to   = 'const body = trimBlank(g.lines).join(''\n'')' }
  @{ name = 'M6 non-deterministic output (clock in page)'; file = 'render.js'
     from = '<footer class="paper-foot">'
     to   = '<footer class="paper-foot">' + [char]39 + ' + new Date().toISOString() + ' + [char]39 }
  @{ name = 'M7 unsafe URLs become links'; file = 'markdown.js'
     from = 'return SAFE_SCHEME_RE.test(String(url || '''').trim())'
     to   = 'return true' }
  @{ name = 'M8 no HTML escaping'; file = 'markdown.js'
     from = '  masked = escapeHtml(masked)'
     to   = '  masked = masked' }
  @{ name = 'M9 emphasis rules run over code spans'; file = 'markdown.js'
     from = 'let masked = src.replace(/(`+)([\s\S]*?)\1/g, (_m, _t, code) => {'
     to   = 'let masked = src.replace(/(`+)(x^)\1/g, (_m, _t, code) => {' }
  @{ name = 'M10 every section collapsed (answer hidden)'; file = 'render.js'
     from = 'details(section.heading || `Section ${n + 1}`, body, { open: n < 2 })'
     to   = 'details(section.heading || `Section ${n + 1}`, body, { open: false })' }
  @{ name = 'M11 page dated from last date header, not the turn'; file = 'render.js'
     from = '  const stated = paper.statusLine && /\b(\d{4}-\d{2}-\d{2})\b/.exec(paper.statusLine)'
     to   = '  const stated = null' }
  @{ name = 'M12 rewrites an unchanged paper every run'; file = 'generate.js'
     from = '  if (existing === html) {'
     to   = '  if (false) {' }
)

# Capture pristine bytes up front so a restore can never depend on a decode.
$pristine = @{}
foreach ($f in ($mutations.file | Sort-Object -Unique)) {
  $pristine[$f] = [System.IO.File]::ReadAllBytes((Join-Path $src $f))
}

$results = @()
try {
  foreach ($m in $mutations) {
    $path = Join-Path $src $m.file
    $orig = Read-SourceText $path
    if (-not $orig.Contains($m.from)) {
      $results += [pscustomobject]@{ Mutation = $m.name; Killed = 'ANCHOR-MISSING'; By = '' }
      continue
    }
    try {
      Write-SourceText $path $orig.Replace($m.from, $m.to)
      Push-Location $root
      # vitest writes progress to stderr; with ErrorActionPreference=Stop that alone
      # would abort the harness on a perfectly normal run.
      $prev = $ErrorActionPreference
      $ErrorActionPreference = 'Continue'
      $out = & npx vitest run packages/task-paper --reporter=verbose 2>&1 | Out-String
      $code = $LASTEXITCODE
      $ErrorActionPreference = $prev
      Pop-Location

      # Match vitest's failure glyph by codepoint: this file is UTF-8 and may be read
      # under a different code page, which would corrupt a literal glyph.
      $hits = [regex]::Matches($out, '(?m)^\s*[x\u00D7]\s+(.+?)(?:\s+\d+ms)?\s*$')
      $results += [pscustomobject]@{
        Mutation = $m.name
        Killed   = if ($code -ne 0) { 'yes' } else { 'NO -- NOT GUARDED' }
        By       = if ($code -ne 0 -and $hits.Count -gt 0) {
                     ($hits[0].Groups[1].Value -replace '\s+', ' ').Trim()
                   } else { '' }
      }
    } finally {
      [System.IO.File]::WriteAllBytes($path, $pristine[$m.file])
    }
  }
} finally {
  # Belt and braces: restore everything, even on Ctrl-C or an unexpected throw.
  foreach ($f in $pristine.Keys) {
    [System.IO.File]::WriteAllBytes((Join-Path $src $f), $pristine[$f])
  }
}

$results | Format-Table -AutoSize -Wrap | Out-String -Width 200
$killed = ($results | Where-Object { $_.Killed -eq 'yes' }).Count
"KILLED $killed / $($results.Count)"
if ($killed -ne $results.Count) { exit 1 }
