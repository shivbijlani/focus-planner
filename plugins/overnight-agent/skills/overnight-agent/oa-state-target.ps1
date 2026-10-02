<#
  oa-state-target.ps1 -- lets a mutation check drive EITHER implementation of the state engine:
  oa-state.ps1 (PowerShell) or oa-state.mjs (the Node port, item 4). Dot-source it from the
  directory of the target, so the helper always travels with the engine it describes:

      . (Join-Path (Split-Path -Parent $Target) 'oa-state-target.ps1')
      $cmd = Get-OaStateCommand $Target            # @{ Exe = ...; Prefix = @(...) }
      $out = & $cmd.Exe @($cmd.Prefix + @('scan', '-Compact', '-StateDir', $sd))
      $m   = New-OaStateMutant $Target 'M3' $find $replace $root   # a mutated COPY to run instead

  A Node target is a bundle (oa-state.mjs + oa-state-lib/), so a mutant copies the whole bundle
  and applies the edit in the ONE file that contains the anchor. An anchor found in no file, or in
  more than one, is an error: a mutant that silently mutated nothing would make its arm look
  load-bearing when it is not.
#>

function Test-OaStateNodeTarget([string]$Target) { return ($Target -like '*.mjs') }

function Get-OaStateCommand([string]$Target) {
  if (Test-OaStateNodeTarget $Target) {
    $node = (Get-Command node -ErrorAction Stop).Source
    return @{ Exe = $node; Prefix = @($Target) }
  }
  # The host that actually exists: Windows PowerShell when the check runs under it (the laptop's
  # run-sweeps), the running pwsh otherwise (CI).
  $psHost = if ($PSVersionTable.PSEdition -eq 'Core') { (Get-Process -Id $PID).Path } else { 'powershell' }
  return @{ Exe = $psHost; Prefix = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Target) }
}

function New-OaStateMutant([string]$Target, [string]$Name, [string]$Find, [string]$Replace, [string]$Root) {
  $utf8 = New-Object Text.UTF8Encoding($false)
  New-Item -ItemType Directory -Path $Root -Force | Out-Null
  if (-not (Test-OaStateNodeTarget $Target)) {
    $src = [IO.File]::ReadAllText($Target, $utf8)
    if (-not $src.Contains($Find)) { throw "mutant $Name : anchor not found in $Target -> $Find" }
    $dst = Join-Path $Root ("mutant-$Name-" + [IO.Path]::GetFileName($Target))
    [IO.File]::WriteAllText($dst, $src.Replace($Find, $Replace), $utf8)
    return $dst
  }
  $skill = Split-Path -Parent $Target
  $bundle = Join-Path $Root "mutant-$Name"
  if (Test-Path -LiteralPath $bundle) { Remove-Item -LiteralPath $bundle -Recurse -Force }
  New-Item -ItemType Directory -Path $bundle -Force | Out-Null
  Copy-Item -LiteralPath $Target -Destination $bundle
  Copy-Item -LiteralPath (Join-Path $skill 'oa-state-lib') -Destination $bundle -Recurse
  $files = @(Get-ChildItem -LiteralPath $bundle -Recurse -File -Filter '*.mjs')
  $hits = @($files | Where-Object { [IO.File]::ReadAllText($_.FullName, $utf8).Contains($Find) })
  if ($hits.Count -eq 0) { throw "mutant $Name : anchor not found in the Node bundle -> $Find" }
  if ($hits.Count -gt 1) { throw "mutant $Name : anchor is ambiguous ($($hits.Name -join ', ')) -> $Find" }
  $text = [IO.File]::ReadAllText($hits[0].FullName, $utf8)
  [IO.File]::WriteAllText($hits[0].FullName, $text.Replace($Find, $Replace), $utf8)
  return (Join-Path $bundle ([IO.Path]::GetFileName($Target)))
}
