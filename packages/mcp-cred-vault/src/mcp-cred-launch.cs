using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

// mcp-cred-launch.exe
// -------------------------------------------------------------------------
// Reads a secret from the Windows Credential Manager (Generic credential,
// DPAPI-encrypted at rest), injects it into an environment variable, then
// launches the real MCP command with the standard handles INHERITED. Because
// stdin/stdout/stderr are not redirected, the child MCP speaks JSON-RPC over
// stdio transparently, exactly as if Copilot had launched it directly.
//
// Why a compiled native exe (and not a .ps1 wrapper):
//   PowerShell cannot forward raw stdin to a child process, so a script
//   wrapper silently breaks the MCP stdio JSON-RPC protocol. A native exe that
//   inherits the console handles is the only reliable transport.
//
// Security notes:
//   * The secret is NEVER passed on the command line. Only the credential
//     TARGET name and the ENV VAR name are argv. The value is set via the
//     child process environment block.
//   * All diagnostics go to stderr ONLY. stdout must stay clean JSON-RPC.
//
// Usage: mcp-cred-launch.exe <credTarget> <envVar> <realExe> [realArgs...]
// -------------------------------------------------------------------------
class Program {
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredReadW(string target, int type, int flags, out IntPtr credential);
    [DllImport("advapi32.dll")]
    static extern void CredFree(IntPtr cred);

    [StructLayout(LayoutKind.Sequential)]
    struct CREDENTIAL {
        public int Flags; public int Type; public IntPtr TargetName; public IntPtr Comment;
        public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
        public int Persist; public int AttributeCount; public IntPtr Attributes;
        public IntPtr TargetAlias; public IntPtr UserName;
    }

    // Read a Generic (type=1) credential blob as a UTF-16LE string, matching how
    // secret-vault.ps1 stores it (Encoding.Unicode bytes).
    static string ReadCred(string target) {
        IntPtr p;
        if (!CredReadW(target, 1, 0, out p)) return null;
        try {
            var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
            if (c.CredentialBlobSize == 0) return "";
            return Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2);
        } finally { CredFree(p); }
    }

    // Quote a single argument for the Windows command line following the
    // CommandLineToArgvW rules, so args with spaces/quotes survive re-parsing.
    static string Quote(string a) {
        if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return a;
        var sb = new StringBuilder();
        sb.Append('"');
        int bs = 0;
        foreach (char ch in a) {
            if (ch == '\\') { bs++; }
            else if (ch == '"') { sb.Append('\\', bs * 2 + 1); sb.Append('"'); bs = 0; }
            else { sb.Append('\\', bs); sb.Append(ch); bs = 0; }
        }
        sb.Append('\\', bs * 2);
        sb.Append('"');
        return sb.ToString();
    }

    static int Main(string[] args) {
        if (args.Length < 3) {
            Console.Error.WriteLine("mcp-cred-launch: usage: <credTarget> <envVar> <realExe> [realArgs...]");
            Console.Error.WriteLine("  Reads the secret stored under <credTarget> in Windows Credential");
            Console.Error.WriteLine("  Manager, sets it as %<envVar>%, then execs <realExe> [realArgs...]");
            Console.Error.WriteLine("  with inherited stdio (transparent MCP JSON-RPC passthrough).");
            return 64; // EX_USAGE
        }
        string target = args[0];
        string envVar = args[1];
        string exe = args[2];

        string secret = ReadCred(target);
        if (secret == null) {
            Console.Error.WriteLine("mcp-cred-launch: credential target not found: " + target);
            Console.Error.WriteLine("  Store it first, e.g.: secret-vault.ps1 set -Target " + target + " -Token <value>");
            return 66; // EX_NOINPUT
        }

        var psi = new ProcessStartInfo();
        psi.FileName = exe;
        psi.UseShellExecute = false;               // inherit std handles; resolve exe via CreateProcess/PATH
        psi.RedirectStandardInput = false;
        psi.RedirectStandardOutput = false;
        psi.RedirectStandardError = false;
        psi.EnvironmentVariables[envVar] = secret; // secret enters via the env block, never argv

        var sb = new StringBuilder();
        for (int i = 3; i < args.Length; i++) {
            if (sb.Length > 0) sb.Append(' ');
            sb.Append(Quote(args[i]));
        }
        psi.Arguments = sb.ToString();

        try {
            var p = Process.Start(psi);
            p.WaitForExit();
            return p.ExitCode;
        } catch (Exception ex) {
            Console.Error.WriteLine("mcp-cred-launch: failed to start '" + exe + "': " + ex.Message);
            return 69; // EX_UNAVAILABLE
        }
    }
}
