// Remote desktop with an account from the vault (Keevault-Update.exe --rdp, started by the app):
//   stdin: host, port, user name and password, one per line (the password last, it is the rest of the input).
// The account goes into a temporary Windows credential "TERMSRV/<host>" for this logon session, mstsc connects with
// it, and after the connection had time to start the credential is removed again. One saved before for the same
// server is restored, so the user's own saved logins stay as they were. Nothing is written to a file or a command line.

using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Keevault.Setup
{
    internal static class Rdp
    {
        private const int CredTypeDomainPassword = 2;
        private const int CredPersistSession = 1;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct Credential
        {
            public int Flags;
            public int Type;
            public string TargetName;
            public string Comment;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
            public int CredentialBlobSize;
            public IntPtr CredentialBlob;
            public int Persist;
            public int AttributeCount;
            public IntPtr Attributes;
            public string TargetAlias;
            public string UserName;
        }

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CredWrite(ref Credential credential, int flags);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CredRead(string target, int type, int flags, out IntPtr credential);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CredDelete(string target, int type, int flags);

        [DllImport("advapi32.dll")]
        private static extern void CredFree(IntPtr buffer);

        public static int Run()
        {
            string input;
            using (var reader = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8)) input = reader.ReadToEnd();
            var parts = input.Split(new[] { '\n' }, 4);
            if (parts.Length < 4) return 2;
            var host = parts[0].Trim();
            var port = int.TryParse(parts[1].Trim(), out var p) && p > 0 && p < 65536 ? p : 3389;
            var user = parts[2].Trim();
            var password = parts[3].TrimEnd('\r', '\n');
            if (host.Length == 0) return 2;

            var target = "TERMSRV/" + host;
            var saved = Read(target);
            var written = Write(target, user, password);
            var address = port == 3389 ? host : host + ":" + port;
            try
            {
                Process.Start(new ProcessStartInfo("mstsc.exe", "/v:" + address) { UseShellExecute = true });
            }
            catch
            {
                // mstsc missing or blocked: clean up right away
                Thread.Sleep(0);
            }
            // mstsc reads the credential while connecting; give it time (slow VPNs), then put things back.
            if (written) Thread.Sleep(TimeSpan.FromSeconds(45));
            if (saved != null) WriteRaw(saved.Value);
            else if (written) CredDelete(target, CredTypeDomainPassword, 0);
            if (saved != null) Marshal.FreeHGlobal(saved.Value.CredentialBlob);
            return 0;
        }

        private static bool Write(string target, string user, string password)
        {
            if (string.IsNullOrEmpty(user)) return false;
            var blob = Encoding.Unicode.GetBytes(password ?? "");
            var buffer = Marshal.AllocHGlobal(Math.Max(blob.Length, 1));
            try
            {
                Marshal.Copy(blob, 0, buffer, blob.Length);
                var c = new Credential
                {
                    Type = CredTypeDomainPassword,
                    TargetName = target,
                    UserName = user,
                    CredentialBlob = buffer,
                    CredentialBlobSize = blob.Length,
                    Persist = CredPersistSession,
                };
                return CredWrite(ref c, 0);
            }
            finally
            {
                Array.Clear(blob, 0, blob.Length);
                Marshal.FreeHGlobal(buffer);
            }
        }

        /// <summary>Copy of an existing credential for this target (blob in our own memory), or null.</summary>
        private static Credential? Read(string target)
        {
            if (!CredRead(target, CredTypeDomainPassword, 0, out var ptr)) return null;
            try
            {
                var c = (Credential)Marshal.PtrToStructure(ptr, typeof(Credential));
                var copy = Marshal.AllocHGlobal(Math.Max(c.CredentialBlobSize, 1));
                var bytes = new byte[c.CredentialBlobSize];
                if (c.CredentialBlobSize > 0) Marshal.Copy(c.CredentialBlob, bytes, 0, bytes.Length);
                Marshal.Copy(bytes, 0, copy, bytes.Length);
                Array.Clear(bytes, 0, bytes.Length);
                c.CredentialBlob = copy;
                c.Attributes = IntPtr.Zero;
                c.AttributeCount = 0;
                return c;
            }
            finally
            {
                CredFree(ptr);
            }
        }

        private static void WriteRaw(Credential c)
        {
            CredWrite(ref c, 0);
        }
    }
}
