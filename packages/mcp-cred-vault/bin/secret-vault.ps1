<#
  secret-vault.ps1 — generalized secure storage for MCP / agent secrets.

  Stores each secret in the WINDOWS CREDENTIAL MANAGER (the OS credential vault),
  encrypted at rest with the current user's DPAPI key. Each value is:
    - never written to disk as plaintext,
    - decryptable only by THIS Windows user on THIS machine,
    - not visible in the process environment, command line, or registry.

  This is the secure alternative to a plaintext file or a user env var (a user
  env var lives in the registry as plaintext and leaks into every child process
  — NOT encrypted, so we deliberately avoid it).

  TARGET NAMING
    Pass a full target ("overnight-agent:telegram-bot-token") OR a short name
    ("telegram-bot-token") which is auto-prefixed with -Prefix (default
    "overnight-agent:"). Set -Prefix '' to disable auto-prefixing.

  USAGE (run with: powershell -NoProfile -ExecutionPolicy Bypass -File secret-vault.ps1 <cmd> ...)
    set   -Target <name> -Token "<value>"   Store/replace a secret in the vault.
    get   -Target <name>                     Print the secret to stdout (for a launcher at runtime).
    test  -Target <name>                     Say whether a secret is stored (does NOT print it).
    clear -Target <name>                     Delete the secret from the vault.
    list  [-Prefix overnight-agent:]         List all stored <prefix>* target names.

  Only `get` ever prints a secret value (to stdout, by design, so the compiled
  launcher can read it). set/test/clear/list never echo the value.

  EXAMPLES
    secret-vault.ps1 set  -Target telegram-bot-token -Token "123:ABC"
    secret-vault.ps1 get  -Target telegram-bot-token
    secret-vault.ps1 test -Target telegram-bot-token
    secret-vault.ps1 list
    secret-vault.ps1 list -Prefix "myapp:"
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('set', 'get', 'test', 'clear', 'list')]
  [string]$Command = 'test',

  [string]$Target,

  [string]$Token,

  [string]$Prefix = 'overnight-agent:'
)

$ErrorActionPreference = 'Stop'

function Resolve-Target([string]$t) {
  if ([string]::IsNullOrWhiteSpace($t)) {
    throw "This command requires -Target (a short name like 'telegram-bot-token' or a full '<prefix>...' target)."
  }
  if ($t -like '*:*') { return $t }
  if ([string]::IsNullOrEmpty($Prefix)) { return $t }
  return $Prefix + $t
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace McpCredVault {
  public enum CRED_TYPE : uint { GENERIC = 1 }
  public enum CRED_PERSIST : uint { LOCAL_MACHINE = 2 }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  public static class Native {
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredWrite(ref CREDENTIAL userCredential, uint flags);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredRead(string target, CRED_TYPE type, uint flags, out IntPtr credential);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool CredDelete(string target, CRED_TYPE type, uint flags);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern void CredFree(IntPtr cred);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredEnumerate(string filter, uint flags, out uint count, out IntPtr credentials);
  }
}
'@

function Set-Secret([string]$target, [string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) { throw "No token provided. Use: set -Target <name> -Token '<value>'" }
  # Store as UTF-16LE (Unicode) bytes so the C# launcher's Marshal.PtrToStringUni
  # (blobSize/2 chars) reads it back exactly.
  $bytes = [System.Text.Encoding]::Unicode.GetBytes($value)
  $blob = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
  try {
    [System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
    $cred = New-Object McpCredVault.CREDENTIAL
    $cred.Type = [uint32][McpCredVault.CRED_TYPE]::GENERIC
    $cred.TargetName = $target
    $cred.CredentialBlobSize = [uint32]$bytes.Length
    $cred.CredentialBlob = $blob
    $cred.Persist = [uint32][McpCredVault.CRED_PERSIST]::LOCAL_MACHINE
    $cred.UserName = 'mcp-cred-vault'
    $cred.Comment = 'MCP credential vault secret. DPAPI-encrypted by Credential Manager.'
    if (-not [McpCredVault.Native]::CredWrite([ref]$cred, 0)) {
      throw "CredWrite failed (Win32 error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
    }
  } finally {
    [System.Runtime.InteropServices.Marshal]::FreeHGlobal($blob)
  }
}

function Get-Secret([string]$target) {
  $ptr = [IntPtr]::Zero
  if (-not [McpCredVault.Native]::CredRead($target, [McpCredVault.CRED_TYPE]::GENERIC, 0, [ref]$ptr)) {
    return $null
  }
  try {
    $cred = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][McpCredVault.CREDENTIAL])
    if ($cred.CredentialBlobSize -eq 0) { return '' }
    $bytes = New-Object byte[] $cred.CredentialBlobSize
    [System.Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $cred.CredentialBlobSize)
    return [System.Text.Encoding]::Unicode.GetString($bytes)
  } finally {
    [McpCredVault.Native]::CredFree($ptr)
  }
}

function Clear-Secret([string]$target) {
  if (-not [McpCredVault.Native]::CredDelete($target, [McpCredVault.CRED_TYPE]::GENERIC, 0)) {
    $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($err -eq 1168) { return $false }  # ERROR_NOT_FOUND
    throw "CredDelete failed (Win32 error $err)"
  }
  return $true
}

function Get-Targets([string]$filterPrefix) {
  $filter = if ([string]::IsNullOrEmpty($filterPrefix)) { '*' } else { "$filterPrefix*" }
  $count = 0
  $ptr = [IntPtr]::Zero
  if (-not [McpCredVault.Native]::CredEnumerate($filter, 0, [ref]$count, [ref]$ptr)) {
    $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($err -eq 1168) { return @() }  # ERROR_NOT_FOUND
    throw "CredEnumerate failed (Win32 error $err)"
  }
  try {
    $names = @()
    $sz = [System.Runtime.InteropServices.Marshal]::SizeOf([type][IntPtr])
    for ($i = 0; $i -lt $count; $i++) {
      $entryPtr = [System.Runtime.InteropServices.Marshal]::ReadIntPtr($ptr, $i * $sz)
      $cred = [System.Runtime.InteropServices.Marshal]::PtrToStructure($entryPtr, [type][McpCredVault.CREDENTIAL])
      $names += $cred.TargetName
    }
    return $names
  } finally {
    [McpCredVault.Native]::CredFree($ptr)
  }
}

switch ($Command) {
  'set' {
    $t = Resolve-Target $Target
    Set-Secret $t $Token
    Write-Output "stored: '$t' is in the Windows Credential Manager vault (encrypted)."
  }
  'get' {
    $t = Resolve-Target $Target
    $v = Get-Secret $t
    if ($null -eq $v) { Write-Error "no secret stored for '$t'"; exit 2 } else { Write-Output $v }
  }
  'test' {
    $t = Resolve-Target $Target
    $v = Get-Secret $t
    if ($null -eq $v) { Write-Output "no secret stored for '$t'" } else { Write-Output "secret stored for '$t' (length $($v.Length))" }
  }
  'clear' {
    $t = Resolve-Target $Target
    if (Clear-Secret $t) { Write-Output "cleared '$t'" } else { Write-Output "nothing to clear for '$t'" }
  }
  'list' {
    $names = Get-Targets $Prefix
    if ($names.Count -eq 0) { Write-Output "(no secrets stored under prefix '$Prefix')" }
    else { $names | Sort-Object | ForEach-Object { Write-Output $_ } }
  }
}
