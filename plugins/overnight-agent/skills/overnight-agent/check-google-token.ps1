<#
.SYNOPSIS
  Health-check for the Google Workspace MCP OAuth token.

.DESCRIPTION
  Actively tests whether the stored *refresh_token* still works by asking
  Google's token endpoint for a fresh access token. This is the real signal
  for "do I need to re-auth?" — the short-lived access token auto-refreshes,
  but the refresh token in a *testing-mode* OAuth app expires after ~7 days,
  which silently breaks every Google Workspace tool until you re-consent.

  It does NOT write the new access token back to disk (the MCP manages its own
  file); it only tests validity and reports a result as a single JSON line.

.OUTPUTS
  One compact JSON line, plus an exit code:
    exit 0  status=ok       refresh token valid
    exit 2  status=expired  refresh token expired/revoked -> RE-AUTH NEEDED
    exit 3  status=error     transient/unknown error (do not false-alarm)
    exit 4  status=missing   credential file not found
#>
[CmdletBinding()]
param(
  [string]$CredPath = "C:\Users\shiv\.google_workspace_mcp\credentials\shiv@bijlanis.com.json"
)

$ErrorActionPreference = 'Stop'

function Out-Result([hashtable]$o) {
  ([ordered]@{} + $o) | ConvertTo-Json -Compress
}

$now = (Get-Date).ToString('o')

if (-not (Test-Path $CredPath)) {
  Out-Result @{ status = 'missing'; email = $null; message = "Credential file not found: $CredPath"; checked_at = $now }
  exit 4
}

try {
  $cred = Get-Content $CredPath -Raw | ConvertFrom-Json
} catch {
  Out-Result @{ status = 'error'; message = "Failed to parse credential JSON: $($_.Exception.Message)"; checked_at = $now }
  exit 3
}

$email    = [IO.Path]::GetFileNameWithoutExtension($CredPath)
$tokenUri = if ($cred.token_uri) { $cred.token_uri } else { 'https://oauth2.googleapis.com/token' }

if (-not $cred.refresh_token) {
  Out-Result @{ status = 'expired'; email = $email; reason = 'no_refresh_token'; message = 'No refresh_token present; re-auth required.'; checked_at = $now }
  exit 2
}

$body = @{
  client_id     = $cred.client_id
  client_secret = $cred.client_secret
  refresh_token = $cred.refresh_token
  grant_type    = 'refresh_token'
}

try {
  $resp = Invoke-RestMethod -Method Post -Uri $tokenUri -Body $body -ContentType 'application/x-www-form-urlencoded' -TimeoutSec 30
  Out-Result @{ status = 'ok'; email = $email; expires_in = $resp.expires_in; message = 'Refresh token valid; Google issued a fresh access token.'; checked_at = $now }
  exit 0
} catch {
  # Prefer the response body (PS 7 puts it in ErrorDetails.Message; fall back to the raw stream on 5.1)
  $detail = $null
  if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $detail = $_.ErrorDetails.Message }
  if (-not $detail) {
    try {
      $r = $_.Exception.Response
      if ($r) {
        $reader = New-Object IO.StreamReader($r.GetResponseStream())
        $detail = $reader.ReadToEnd()
      }
    } catch {}
  }
  if (-not $detail) { $detail = $_.Exception.Message }

  $errCode = $null
  try { $errCode = ($detail | ConvertFrom-Json).error } catch {}

  if ($errCode -eq 'invalid_grant') {
    Out-Result @{ status = 'expired'; email = $email; reason = $errCode; message = 'Refresh token expired or revoked; re-authentication required.'; detail = $detail; checked_at = $now }
    exit 2
  } else {
    Out-Result @{ status = 'error'; email = $email; reason = $errCode; message = "Token check failed (not a definitive expiry): $detail"; checked_at = $now }
    exit 3
  }
}
