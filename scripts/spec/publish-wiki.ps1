<#
  publish-wiki.ps1 -- push docs/spec (or arbitrary markdown) straight to the GitHub
  wiki, with NO pull request and NO review gate.

  WHY THIS EXISTS
  ---------------
  The Spec wiki workflow (.github/workflows/spec-wiki.yml) publishes to the wiki only
  on a weekly cron or a manual dispatch, and only when a WIKI_TOKEN PAT secret is set,
  because Actions' GITHUB_TOKEN cannot push to a `<owner>/<repo>.wiki.git` repository.
  That is the right default for machine-generated regeneration, but it means an ad-hoc
  wiki edit waits up to a week or needs a human to trigger the job.

  A GitHub wiki is a plain git repository with NO pull-request gate: whoever can push
  to it writes it directly. A locally-configured `gh` token that carries the `repo`
  scope (unlike the ephemeral Actions token) can push to the wiki repo. So this script
  is the sanctioned "write to the wiki now, without a PR" path: it clones the wiki with
  that token, syncs the source markdown in, and pushes.

  ONE-TIME PREREQUISITE
  ---------------------
  GitHub does not provision `<owner>/<repo>.wiki.git` until the wiki has at least one
  page, and there is no API to create that first page -- it must be done once in the
  web UI (Wiki tab -> "Create the first page" -> Save). After that this script works
  forever with no further manual step.

  Confirmed empirically (not just from docs): before a first page exists, ALL of
  `ls-remote`, `clone`, and even `push` return an identical `Repository not found`
  (some hosts create a repo on first push -- GitHub's wiki does not), and both `/wiki`
  and `/wiki/_new` redirect to the repo root. So a 404 here is not "push would have
  worked"; the repo simply is not there yet.

  A 404 has TWO causes, though -- an uninitialised wiki AND a token without `repo`
  scope both return the same "Repository not found". This script distinguishes them
  (absent vs unreadable) so a scope problem is not misreported as a setup problem.

  SOURCE-OF-TRUTH NOTE
  --------------------
  docs/spec on `main` is the source the weekly workflow mirrors. If you publish content
  here that is NOT also on main's docs/spec, the next scheduled mirror run reverts it.
  So for durable pages, land the same change in docs/spec on main as well; use this
  script for immediate publication and for pages you accept the pipeline may overwrite.

  USAGE
  -----
    # Mirror the whole spec folder to the wiki (default):
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/spec/publish-wiki.ps1

    # Publish only specific pages, without deleting others:
    ... -File docs/spec/Reliability.md -NoDelete

    # Dry run (show what would change, push nothing):
    ... -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  # owner/repo. Defaults to the `origin` remote of the repo this script lives in.
  [string]$Repo,
  # Directory whose *.md files are mirrored to the wiki root.
  [string]$SourceDir = 'docs/spec',
  # Publish only these specific files instead of the whole SourceDir.
  [string[]]$File,
  # Do not delete wiki pages that are absent from the source (additive publish).
  [switch]$NoDelete,
  # Commit message. A default is generated when omitted.
  [string]$Message
)

$ErrorActionPreference = 'Stop'

function Resolve-Token {
  if ($env:GH_TOKEN)     { return $env:GH_TOKEN.Trim() }
  if ($env:GITHUB_TOKEN) { return $env:GITHUB_TOKEN.Trim() }
  try {
    $t = (& gh auth token 2>$null)
    if ($LASTEXITCODE -eq 0 -and $t) { return $t.Trim() }
  } catch { }
  throw 'No token found. Set GH_TOKEN, or run `gh auth login` (the token needs `repo` scope to push to a wiki).'
}

function Resolve-Repo {
  if ($Repo) { return $Repo }
  # Derive owner/repo from the origin remote of the repo containing this script.
  $scriptRepo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
  $url = (& git -C $scriptRepo remote get-url origin 2>$null)
  if (-not $url) { throw 'Could not read the origin remote. Pass -Repo owner/repo.' }
  if ($url -match 'github\.com[:/]+([^/]+)/(.+?)(?:\.git)?/?$') {
    return "$($Matches[1])/$($Matches[2])"
  }
  throw "Could not parse owner/repo from origin '$url'. Pass -Repo owner/repo."
}

$token   = Resolve-Token
$repoFull = Resolve-Repo
$srcRoot  = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent   # repo root

# Resolve the set of source files to publish.
$sourceFiles = @()
if ($File) {
  foreach ($f in $File) {
    $p = if ([IO.Path]::IsPathRooted($f)) { $f } else { Join-Path $srcRoot $f }
    if (-not (Test-Path $p)) { throw "Source file not found: $p" }
    $sourceFiles += (Get-Item $p)
  }
} else {
  $dir = if ([IO.Path]::IsPathRooted($SourceDir)) { $SourceDir } else { Join-Path $srcRoot $SourceDir }
  if (-not (Test-Path $dir)) { throw "Source dir not found: $dir" }
  # README.md is provenance for humans browsing docs/spec, not a spec page -- verify.mjs
  # deliberately excludes it, so the wiki must too or it gains a stray README page.
  $sourceFiles = @(Get-ChildItem $dir -Filter '*.md' -File | Where-Object { $_.Name -ne 'README.md' })
  if ($sourceFiles.Count -eq 0) { throw "No publishable .md files in $dir (README.md is excluded)." }
}

Write-Host "[publish-wiki] repo   : $repoFull"
Write-Host "[publish-wiki] source : $($sourceFiles.Count) file(s)"

$wikiDir = Join-Path ([IO.Path]::GetTempPath()) ("wiki-" + [guid]::NewGuid().ToString('N'))
$remote  = "https://x-access-token:$token@github.com/$repoFull.wiki.git"
$redacted = "https://github.com/$repoFull.wiki.git"

try {
  Write-Host "[publish-wiki] cloning $redacted ..."
  $cloneOut = (& git clone --quiet $remote $wikiDir 2>&1)
  if ($LASTEXITCODE -ne 0) {
    $msg = ($cloneOut | Out-String)
    if ($msg -match 'not found|404') {
      # "Repository not found" has TWO causes: the wiki genuinely does not exist yet,
      # OR this token cannot read the repo at all (missing `repo` scope). Reporting the
      # first when it is really the second sends the user clicking around a wiki UI for a
      # page that is already there. Distinguish absent from unreadable with one call: if
      # `gh repo view` can read the repo, auth is fine and the wiki 404 is genuinely
      # "not initialised"; if it cannot, the 404 is an auth problem.
      $wikiEnabled = $null
      $canRead = $false
      try {
        $wikiEnabled = (& gh repo view $repoFull --json hasWikiEnabled --jq '.hasWikiEnabled' 2>$null)
        if ($LASTEXITCODE -eq 0) { $canRead = $true }
      } catch { }
      if (-not $canRead) {
        throw "Could not read $repoFull with this token, so the wiki 404 is most likely an AUTH " +
              "problem, not a missing wiki. Ensure the token has 'repo' scope (e.g. `gh auth refresh -s repo`) and retry."
      }
      if ("$wikiEnabled" -eq 'False' -or "$wikiEnabled" -eq 'false') {
        throw "The wiki feature is DISABLED for $repoFull. Enable it in the repo Settings, " +
              "then create the first page in the UI."
      }
      throw "The wiki is enabled but NOT INITIALISED. GitHub does not create the wiki git repo " +
            "until a first page is saved in the UI (no API exists for it). Do it once at " +
            "https://github.com/$repoFull/wiki -> Create the first page -> Save, then re-run."
    }
    throw "Clone failed: $msg"
  }

  # Sync source -> wiki root.
  if (-not $NoDelete -and -not $File) {
    # Full mirror: remove wiki .md not present in the source, so a deleted source
    # page disappears rather than lingering with no traceable origin.
    $srcNames = $sourceFiles | ForEach-Object { $_.Name }
    Get-ChildItem $wikiDir -Filter '*.md' -File | Where-Object { $_.Name -notin $srcNames } |
      ForEach-Object {
        Write-Host "  DELETE $($_.Name)"
        if ($PSCmdlet.ShouldProcess($_.Name, 'delete from wiki')) { Remove-Item $_.FullName -Force }
      }
  }
  foreach ($f in $sourceFiles) {
    $dst = Join-Path $wikiDir $f.Name
    $changed = -not (Test-Path $dst) -or `
               ([IO.File]::ReadAllText($f.FullName) -ne [IO.File]::ReadAllText($dst))
    if ($changed) {
      Write-Host "  WRITE  $($f.Name)"
      if ($PSCmdlet.ShouldProcess($f.Name, 'write to wiki')) { Copy-Item $f.FullName $dst -Force }
    }
  }

  Push-Location $wikiDir
  try {
    & git config user.name  'shivbijlani' | Out-Null
    & git config user.email 'shivbijlani@users.noreply.github.com' | Out-Null
    $status = (& git status --porcelain)
    if (-not $status) {
      Write-Host '[publish-wiki] wiki already matches the source - nothing to push.'
      return
    }
    if (-not $Message) {
      $Message = "docs(wiki): publish from $SourceDir ($(Get-Date -Format 'yyyy-MM-dd HH:mm'))"
    }
    if ($PSCmdlet.ShouldProcess($repoFull, 'commit and push to wiki')) {
      & git add -A | Out-Null
      & git commit -m $Message | Out-Null
      $pushOut = (& git push 2>&1)
      if ($LASTEXITCODE -ne 0) { throw "Push failed: $($pushOut | Out-String)" }
      Write-Host "[publish-wiki] pushed to $redacted"
    } else {
      Write-Host '[publish-wiki] WhatIf: would commit and push the changes above.'
    }
  } finally { Pop-Location }
} finally {
  if (Test-Path $wikiDir) { Remove-Item $wikiDir -Recurse -Force -ErrorAction SilentlyContinue }
}
