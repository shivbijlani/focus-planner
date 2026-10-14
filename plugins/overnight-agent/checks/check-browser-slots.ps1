<#
.SYNOPSIS
  Read-only status check: which browser profiles (GH #738 slots) exist and
  whether each is currently in use. Never launches, closes or probes a browser.

.DESCRIPTION
  GH #738 replaced attach-only Playwright MCP slots (`--cdp-endpoint`, one
  shared debug port per identity) with each MCP server launching its OWN
  profile directly (`--browser msedge --user-data-dir <dir>`). There is no
  longer a CDP debug port to probe, a process to launch on demand, or a frozen
  renderer to thaw -- the browser that the MCP server starts is the browser it
  uses, for the lifetime of that one session.

  What is still worth knowing before a task starts browser work:

    * does the profile directory EXIST yet (has anyone signed in to it)?
    * is it currently IN USE (Chromium/Edge only allow one owner of a profile
      directory at a time -- a second launch fails with "profile is already in
      use", proven on 2026-09-28 in test session 905cc615)?

  Both are read-only, local filesystem facts. Detection for "in use" is the
  same signal Chromium itself relies on: a `SingletonLock` file is written
  into the profile directory for as long as some process holds it open, and
  removed on clean exit. This script never removes that file and never
  touches the process that holds it.

  THE SLOT LIST IS NOT IN THIS FILE (GH #180, unchanged by GH #738). It is
  read from the `## Browser slots` table in `user-settings.md` via
  browser-slot-table.ps1, the one parser for that table.

.PARAMETER Json
  Emit a JSON array instead of the human-readable table.

.PARAMETER SettingsPath
  Override the resolved `user-settings.md`. Used by the mutation check so it
  can point at a fixture table without touching live state.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File check-browser-slots.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File check-browser-slots.ps1 -Json

.NOTES
  Exit codes: 0 = the slot table was read and every slot was reported on
  (regardless of whether a profile is signed-in, available or in-use -- being
  in use is normal, not a failure). 2 = the slot table itself could not be
  read, so this preflight cannot answer its own question.
#>
[CmdletBinding()]
param(
    [switch]$Json,
    [string]$SettingsPath
)

$ErrorActionPreference = 'Stop'

# --- locate the ONE slot-table parser --------------------------------------
# A SEARCH for the shared parser, not a second copy of it. The two install
# locations hold different file sets, so the library cannot be assumed to sit
# next to whichever consumer is running.
$slotLib = $null
foreach ($cand in @(
        ([IO.Path]::Combine($PSScriptRoot, 'browser-slot-table.ps1'))
        ([IO.Path]::Combine($PSScriptRoot, '..', '..', 'checks', 'browser-slot-table.ps1'))
        ([IO.Path]::Combine($PSScriptRoot, '..', 'checks', 'browser-slot-table.ps1'))
        $(if ($env:LOCALAPPDATA) { [IO.Path]::Combine($env:LOCALAPPDATA, 'overnight-agent', 'browser-slot-table.ps1') })
        $(if ($env:USERPROFILE) { [IO.Path]::Combine($env:USERPROFILE, '.copilot', 'installed-plugins', 'focus-planner', 'overnight-agent', 'checks', 'browser-slot-table.ps1') })
    )) {
    if ($cand -and (Test-Path -LiteralPath $cand -PathType Leaf)) {
        $slotLib = (Resolve-Path -LiteralPath $cand).Path
        break
    }
}
if (-not $slotLib) {
    Write-Host 'check-browser-slots: browser-slot-table.ps1 not found next to this script, in the OA home, or in installed-plugins.' -ForegroundColor Red
    Write-Host 'Cannot determine which slots exist, and will not guess. Run sync-checks.ps1 -Restore -Confirm.' -ForegroundColor Red
    exit 2
}
. $slotLib

# --- read the table ---------------------------------------------------------
# No baked-in fallback on purpose: a preflight that silently reverts to a stale
# list is how the GH #180 drift stayed invisible.
try {
    $slots = @(Get-BrowserSlotTable -SettingsPath $SettingsPath)
}
catch {
    $msg = $_.Exception.Message
    if ($Json) {
        # -InputObject (not a pipe) so a single-slot result still serializes as
        # a JSON ARRAY. Piping a 1-element collection to ConvertTo-Json unwraps
        # it to a bare object -- a real gotcha every consumer here parses past.
        ConvertTo-Json -InputObject @([pscustomobject]@{
                slot = $null; mcp = $null; port = $null; account = $null
                state = 'error'; healthy = $false
                detail = "slot table unreadable: $msg"
            }) -Depth 4
    }
    else {
        Write-Host 'check-browser-slots: could not read the browser slot table.' -ForegroundColor Red
        Write-Host "  $msg" -ForegroundColor Red
        Write-Host '  The slot list lives in user-settings.md under "## Browser slots".' -ForegroundColor DarkGray
    }
    exit 2
}

# ---------------------------------------------------------------------------
# THE ONLY SIGNAL: does the profile dir exist, and is it locked. Chromium and
# Edge both write a `SingletonLock` file into a profile directory for as long
# as any process holds it open (whether that's a user's shortcut, a signed-in
# MCP session, or a leftover crash) and remove it on clean shutdown. Presence
# of that file -- not a port, not a process list -- is the same signal the
# browser itself uses to refuse a second launch ("profile is already in use",
# proven 2026-09-28 in test session 905cc615). Reading it is inherently
# read-only: nothing here opens, deletes or waits on that file.
# ---------------------------------------------------------------------------
function Get-ProfileUseState {
    param([string]$ProfilePath)

    if (-not $ProfilePath) {
        return [pscustomobject]@{ State = 'unknown'; Healthy = $false; Detail = 'no profile path could be resolved from the table' }
    }
    if (-not (Test-Path -LiteralPath $ProfilePath -PathType Container)) {
        return [pscustomobject]@{
            State = 'not-signed-in'; Healthy = $true
            Detail = "profile dir does not exist yet ($ProfilePath) - needs a one-time sign-in"
        }
    }
    $lock = Join-Path $ProfilePath 'SingletonLock'
    if (Test-Path -LiteralPath $lock) {
        return [pscustomobject]@{
            State = 'in-use'; Healthy = $true
            Detail = 'profile is open (by you, or by a task session) - a second launch would be refused'
        }
    }
    return [pscustomobject]@{ State = 'available'; Healthy = $true; Detail = 'profile exists and is free to launch' }
}

$rows = @(foreach ($slot in $slots) {
    $use = Get-ProfileUseState -ProfilePath $slot.ProfilePath
    [pscustomobject]@{
        slot         = $slot.Slot
        mcp          = $slot.Slot
        port         = $slot.Port
        account      = $slot.Account
        profile_dir  = $slot.ProfileDir
        signed_into  = $slot.SignedInto
        state        = $use.State
        healthy      = $use.Healthy
        detail       = $use.Detail
    }
})

# Nothing here can make the READ itself fail once the table parsed, so the
# only non-zero exit is the "could not read the table" branch above. Being
# in-use, not-signed-in, or unknown is informational, never an escalation --
# a signed-in profile someone has open is the expected, healthy state.
if ($Json) {
    # -InputObject, not a pipe: a table with exactly one slot must still come
    # back as a JSON ARRAY, not an unwrapped bare object.
    ConvertTo-Json -InputObject $rows -Depth 4
    exit 0
}

Write-Host ''
$rows | Format-Table slot, account, profile_dir, state, signed_into -AutoSize | Out-String | Write-Host
exit 0
