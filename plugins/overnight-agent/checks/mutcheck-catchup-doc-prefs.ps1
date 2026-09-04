<#
  mutcheck-catchup-doc-prefs.ps1 -- guards the catch-up doc skill (#441).

  WHAT THIS GUARDS
  ----------------
  #441 asks for Shiv's four catch-up-doc preferences to live in a skill that ships INSIDE the
  repository plugin and is installed by the existing auto-deploy path, rather than being
  re-derived per run from whichever prose the agent happened to read.

  Two things can silently undo that, and neither shows up as a test failure anywhere else:

    1. A preference quietly disappears from the skill (or is left as an empty cell), so it is
       still "documented" but no longer says anything.
    2. The skill moves out of the directory the plugin manifest globs, so it stops being
       discovered and deployed -- the merged-but-not-running failure this repo has already paid
       for twice.

  A comment saying "keep these in sync" is exactly the fix that does not work. This is mechanical.

  WHAT IS ASSERTED (baseline)
  ---------------------------
    A1  the skill file exists under the plugin's globbed skills/ directory
    A2  the plugin manifest actually globs that directory
    A3  the <!-- CATCHUP-DOC-PREFS:BEGIN/END --> block exists and is non-empty
    A4  all four required preference keys are present, each with a NON-EMPTY rule
    A5  the resolver named by the titled-id-links preference exists beside the skill

  Then mutation arms prove each assertion is load-bearing. Every arm mutates a COPY in a temp
  dir; the live tree is never written.

    B_dropKey        remove `titled-id-links`      -> A4 must fail
    C_emptyRule      blank that key's rule cell    -> A4 must fail
    D_dropBlock      remove the whole prefs block  -> A3 must fail
    E_moveOutOfGlob  skill outside skills/         -> A1 must fail
    F_dropResolver   delete resolve-ids.ps1        -> A5 must fail

  If any arm produces NO failure, the check is not actually checking, and this exits non-zero.

    powershell -File mutcheck-catchup-doc-prefs.ps1 [-SkillPath <SKILL.md>] [-BaselineOnly]
#>
[CmdletBinding()]
param(
  [string]$SkillPath,
  [switch]$BaselineOnly
)

$ErrorActionPreference = 'Stop'

$RequiredKeys = @('no-context-reader','no-correction-narration','collapsible-sections','titled-id-links','answer-in-the-document')

function Read-Utf8([string]$p) { [IO.File]::ReadAllText($p, (New-Object Text.UTF8Encoding($false))) }

# Cross-platform path join. A literal 'a\b\c' passed to Join-Path is ONE filename on Linux, not
# three segments, so this guard would fail on the CI runner while passing on the author's box --
# a guard that only runs where the drift happens cannot stop the drift from merging.
function Join-Parts { param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Parts)
  $p = $Parts[0]
  foreach ($x in $Parts[1..($Parts.Length - 1)]) { $p = Join-Path $p $x }
  return $p
}

# --- resolve the skill ----------------------------------------------------------------------
if (-not $SkillPath) {
  $candidates = @(
    (Join-Parts $PSScriptRoot '..' 'skills' 'catchup-doc' 'SKILL.md'),
    (Join-Parts $HOME '.copilot' 'installed-plugins' 'focus-planner' 'overnight-agent' 'skills' 'catchup-doc' 'SKILL.md')
  )
  foreach ($c in $candidates) { if (Test-Path $c) { $SkillPath = (Resolve-Path $c).Path; break } }
}
if (-not $SkillPath -or -not (Test-Path $SkillPath)) {
  throw "catchup-doc SKILL.md not found (pass -SkillPath). Looked under the plugin's skills/ dir."
}
$SkillPath = (Resolve-Path $SkillPath).Path
$PluginRoot = (Resolve-Path (Join-Path (Split-Path (Split-Path $SkillPath)) '..')).Path

# --- the assertions, as one reusable function so the arms run the REAL check ------------------
function Test-CatchupSkill {
  param([string]$Skill, [string]$Plugin)

  $fail = @()

  # A1 -- the skill sits under a directory named skills/
  $parent = Split-Path $Skill                       # .../skills/catchup-doc
  $skillsDir = Split-Path $parent                   # .../skills
  if (-not (Test-Path $Skill)) {
    $fail += 'A1: SKILL.md does not exist'
  } elseif ((Split-Path $skillsDir -Leaf) -ne 'skills') {
    $fail += "A1: skill is not under a skills/ directory (found '$(Split-Path $skillsDir -Leaf)') so the plugin will not discover or deploy it"
  }

  # A2 -- the manifest globs that directory
  $manifest = Join-Path $Plugin 'plugin.json'
  if (Test-Path $manifest) {
    try {
      $mf = Read-Utf8 $manifest | ConvertFrom-Json
      if (-not $mf.skills) { $fail += 'A2: plugin.json declares no skills glob' }
      elseif ($mf.skills.TrimEnd('/','\') -ne 'skills') {
        $fail += "A2: plugin.json globs '$($mf.skills)', which does not cover the skills/ directory"
      }
    } catch { $fail += 'A2: plugin.json is not parseable' }
  } else {
    $fail += 'A2: plugin.json not found beside the skills directory'
  }

  if (-not (Test-Path $Skill)) { return $fail }
  $text = Read-Utf8 $Skill

  # A3 -- the marker block exists and is non-empty
  $m = [regex]::Match($text, '<!--\s*CATCHUP-DOC-PREFS:BEGIN\s*-->(?<body>.*?)<!--\s*CATCHUP-DOC-PREFS:END\s*-->', 'Singleline')
  if (-not $m.Success) {
    $fail += 'A3: the CATCHUP-DOC-PREFS marker block is missing'
    return $fail
  }
  $body = $m.Groups['body'].Value
  if ([string]::IsNullOrWhiteSpace($body)) { $fail += 'A3: the CATCHUP-DOC-PREFS block is empty'; return $fail }

  # A4 -- every required key present, each with a non-empty rule (the LAST table cell)
  foreach ($key in $RequiredKeys) {
    $row = [regex]::Match($body, "(?m)^\|\s*``$([regex]::Escape($key))``\s*\|(?<rest>.*)$")
    if (-not $row.Success) {
      $fail += "A4: preference '$key' is missing from the block"
      continue
    }
    # rest = | <preference> | <rule> |   -> split and take the rule cell
    $cells = $row.Groups['rest'].Value.TrimEnd() -replace '\|\s*$','' -split '\|'
    $rule = if ($cells.Count -ge 2) { $cells[$cells.Count - 1].Trim() } else { '' }
    if ([string]::IsNullOrWhiteSpace($rule)) {
      $fail += "A4: preference '$key' has an empty rule -- it is listed but says nothing"
    }
  }

  # A5 -- the resolver that makes titled-id-links mechanical actually ships beside the skill
  $resolver = Join-Path (Split-Path $Skill) 'resolve-ids.ps1'
  if (-not (Test-Path $resolver)) {
    $fail += 'A5: resolve-ids.ps1 is missing, so the titled-id-links preference is prose only'
  }

  return $fail
}

# --- baseline ---------------------------------------------------------------------------------
Write-Host "[mutcheck-catchup-doc-prefs] skill  = $SkillPath"
Write-Host "[mutcheck-catchup-doc-prefs] plugin = $PluginRoot"

$baseline = Test-CatchupSkill -Skill $SkillPath -Plugin $PluginRoot
if ($baseline.Count -gt 0) {
  Write-Host ""
  Write-Host "BASELINE FAILED:" -ForegroundColor Red
  $baseline | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
  exit 1
}
Write-Host "[baseline] OK -- all $($RequiredKeys.Count) preferences present with non-empty rules; skill is in the deployed glob."

if ($BaselineOnly) { exit 0 }

# --- mutation arms ------------------------------------------------------------------------------
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("mutcheck-catchup-" + [guid]::NewGuid().ToString('N').Substring(0,8))
$arms = @()

function New-Sandbox {
  param([string]$Name)
  $root = Join-Path $tmp $Name
  $sk   = Join-Parts $root 'plugins' 'overnight-agent' 'skills' 'catchup-doc'
  New-Item -ItemType Directory -Path $sk -Force | Out-Null
  Copy-Item $SkillPath (Join-Path $sk 'SKILL.md') -Force
  $res = Join-Path (Split-Path $SkillPath) 'resolve-ids.ps1'
  if (Test-Path $res) { Copy-Item $res (Join-Path $sk 'resolve-ids.ps1') -Force }
  $mf = Join-Path $PluginRoot 'plugin.json'
  if (Test-Path $mf) { Copy-Item $mf (Join-Parts $root 'plugins' 'overnight-agent' 'plugin.json') -Force }
  return [pscustomobject]@{
    Root   = $root
    Skill  = (Join-Path $sk 'SKILL.md')
    Plugin = (Join-Parts $root 'plugins' 'overnight-agent')
    Dir    = $sk
  }
}
function Add-Arm { param([string]$Name, [string]$Expect, [string[]]$Failures)
  $killed = @($Failures | Where-Object { $_ -like "$Expect*" }).Count -gt 0
  $script:arms += [pscustomobject]@{ arm = $Name; expect = $Expect; killed = $killed; got = ($Failures -join '; ') }
}

try {
  # B -- drop the titled-id-links key entirely
  $s = New-Sandbox 'B_dropKey'
  $t = Read-Utf8 $s.Skill
  $t = [regex]::Replace($t, '(?m)^\|\s*`titled-id-links`.*$\r?\n?', '')
  [IO.File]::WriteAllText($s.Skill, $t, (New-Object Text.UTF8Encoding($false)))
  Add-Arm 'B_dropKey' 'A4' (Test-CatchupSkill -Skill $s.Skill -Plugin $s.Plugin)

  # C -- keep the key, blank its rule
  $s = New-Sandbox 'C_emptyRule'
  $t = Read-Utf8 $s.Skill
  $t = [regex]::Replace($t, '(?m)^(\|\s*`titled-id-links`\s*\|[^|]*\|)[^|]*\|', '$1  |')
  [IO.File]::WriteAllText($s.Skill, $t, (New-Object Text.UTF8Encoding($false)))
  Add-Arm 'C_emptyRule' 'A4' (Test-CatchupSkill -Skill $s.Skill -Plugin $s.Plugin)

  # D -- remove the whole marker block
  $s = New-Sandbox 'D_dropBlock'
  $t = Read-Utf8 $s.Skill
  $t = [regex]::Replace($t, '<!--\s*CATCHUP-DOC-PREFS:BEGIN\s*-->.*?<!--\s*CATCHUP-DOC-PREFS:END\s*-->', '', 'Singleline')
  [IO.File]::WriteAllText($s.Skill, $t, (New-Object Text.UTF8Encoding($false)))
  Add-Arm 'D_dropBlock' 'A3' (Test-CatchupSkill -Skill $s.Skill -Plugin $s.Plugin)

  # E -- move the skill out of the globbed skills/ directory
  $s = New-Sandbox 'E_moveOutOfGlob'
  $outside = Join-Parts $s.Root 'plugins' 'overnight-agent' 'docs' 'catchup-doc'
  New-Item -ItemType Directory -Path $outside -Force | Out-Null
  Copy-Item $s.Skill (Join-Path $outside 'SKILL.md') -Force
  Copy-Item (Join-Path $s.Dir 'resolve-ids.ps1') (Join-Path $outside 'resolve-ids.ps1') -Force
  Add-Arm 'E_moveOutOfGlob' 'A1' (Test-CatchupSkill -Skill (Join-Path $outside 'SKILL.md') -Plugin $s.Plugin)

  # F -- delete the resolver
  $s = New-Sandbox 'F_dropResolver'
  Remove-Item (Join-Path $s.Dir 'resolve-ids.ps1') -Force
  Add-Arm 'F_dropResolver' 'A5' (Test-CatchupSkill -Skill $s.Skill -Plugin $s.Plugin)
}
finally {
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ""
Write-Host "MUTATION ARMS"
$arms | ForEach-Object {
  $mark = if ($_.killed) { 'KILLED ' } else { 'SURVIVED' }
  $col  = if ($_.killed) { 'Green' } else { 'Red' }
  Write-Host ("  [{0}] {1,-16} expected {2}" -f $mark, $_.arm, $_.expect) -ForegroundColor $col
  if (-not $_.killed) { Write-Host "            got: $($_.got)" -ForegroundColor Red }
}

$survived = @($arms | Where-Object { -not $_.killed })
Write-Host ""
if ($survived.Count -gt 0) {
  Write-Host "FAIL: $($survived.Count) mutant(s) survived -- the check is not load-bearing." -ForegroundColor Red
  exit 1
}
Write-Host "PASS: baseline clean and all $($arms.Count) mutants killed." -ForegroundColor Green
exit 0
