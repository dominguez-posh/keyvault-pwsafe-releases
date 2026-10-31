// Keevault-Update.exe --location <path>: where a vault file (or the folder for a new one) lives, as one JSON line:
//   { "kind": "cloud" | "network" | "local", "provider": "OneDrive", "providerStatus": "idle" | "syncing" | "offline" |
//     "error" | "unknown", "file": true, "inSync": true | false | null, "pinned": true | false | null }
// Cloud folders are found through the Windows Cloud Files API (sync roots of OneDrive, iCloud for Windows, Dropbox and
// other providers that use it); network drives through the drive type or a UNC path. The app uses it for the personal
// vault (must not be local) and to show whether a vault file is synchronised.

using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace Keevault.Setup
{
    internal static class Location
    {
        [DllImport("cldapi.dll", CharSet = CharSet.Unicode)]
        private static extern int CfGetSyncRootInfoByPath(string filePath, int infoClass, IntPtr infoBuffer, uint infoBufferLength, out uint returnedLength);

        [DllImport("cldapi.dll")]
        private static extern int CfGetPlaceholderInfo(IntPtr fileHandle, int infoClass, IntPtr infoBuffer, uint infoBufferLength, out uint returnedLength);

        private const int SyncRootInfoProvider = 2; // CF_SYNC_ROOT_INFO_PROVIDER
        private const int PlaceholderInfoBasic = 0; // CF_PLACEHOLDER_INFO_BASIC

        public static int Run(string path)
        {
            string json;
            try { json = Describe(path); }
            catch (Exception e) { json = "{\"kind\":\"unknown\",\"error\":" + Quote(e.Message) + "}"; }
            Console.Out.Write(json);
            Console.Out.Flush();
            return 0;
        }

        private static string Describe(string path)
        {
            var full = Path.GetFullPath(path);
            var isFile = File.Exists(full);
            var folder = isFile ? Path.GetDirectoryName(full) : full;

            // Cloud sync root (any provider registered with the Cloud Files API).
            string provider = null;
            string status = null;
            var buffer = Marshal.AllocHGlobal(4 + 2 * 256 * 2);
            try
            {
                if (CfGetSyncRootInfoByPath(folder, SyncRootInfoProvider, buffer, (uint)(4 + 2 * 256 * 2), out _) >= 0)
                {
                    var providerStatus = unchecked((uint)Marshal.ReadInt32(buffer));
                    provider = Marshal.PtrToStringUni(IntPtr.Add(buffer, 4));
                    status = StatusName(providerStatus);
                }
            }
            catch (DllNotFoundException) { /* Windows without the Cloud Files API */ }
            catch (EntryPointNotFoundException) { }
            finally { Marshal.FreeHGlobal(buffer); }

            if (provider != null)
            {
                bool? inSync = null, pinned = null;
                if (isFile) PlaceholderState(full, out inSync, out pinned);
                return "{\"kind\":\"cloud\",\"provider\":" + Quote(provider) + ",\"providerStatus\":" + Quote(status) + ",\"file\":" + Bool(isFile)
                    + ",\"inSync\":" + Bool(inSync) + ",\"pinned\":" + Bool(pinned) + "}";
            }

            var network = full.StartsWith(@"\\", StringComparison.Ordinal);
            if (!network)
            {
                try { network = new DriveInfo(Path.GetPathRoot(full)).DriveType == DriveType.Network; }
                catch { /* unknown root */ }
            }
            return "{\"kind\":" + Quote(network ? "network" : "local") + ",\"file\":" + Bool(isFile) + "}";
        }

        /// <summary>In-sync and pin state of a cloud file (placeholder); null when Windows does not report it.</summary>
        private static void PlaceholderState(string file, out bool? inSync, out bool? pinned)
        {
            inSync = null;
            pinned = null;
            var buffer = Marshal.AllocHGlobal(4096); // basic info plus a variable-length file identity
            try
            {
                using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                {
                    if (CfGetPlaceholderInfo(stream.SafeFileHandle.DangerousGetHandle(), PlaceholderInfoBasic, buffer, 4096, out _) < 0) return;
                    var pinState = Marshal.ReadInt32(buffer);          // CF_PIN_STATE: 1 pinned, 2 unpinned, …
                    var syncState = Marshal.ReadInt32(buffer, 4);      // CF_IN_SYNC_STATE: 0 not in sync, 1 in sync
                    inSync = syncState == 1;
                    pinned = pinState == 1;
                }
            }
            catch { /* not a cloud file or not accessible */ }
            finally { Marshal.FreeHGlobal(buffer); }
        }

        // CF_SYNC_PROVIDER_STATUS: 0 disconnected, 0x1 idle, 0x2/0x4/0x8 populating, 0x10/0x20 syncing, 0x40 connectivity
        // lost, 0xC0000001 terminated, 0xC0000002 error. Many providers leave it at 0 – then "unknown".
        private static string StatusName(uint s)
        {
            if (s == 0xC0000002) return "error";
            if (s == 0xC0000001) return "terminated";
            if ((s & 0x40) != 0) return "offline";
            if ((s & 0x3E) != 0) return "syncing";
            if ((s & 0x1) != 0) return "idle";
            return "unknown";
        }

        private static string Bool(bool? b) => b == null ? "null" : b.Value ? "true" : "false";

        private static string Quote(string s)
        {
            if (s == null) return "null";
            var sb = new StringBuilder("\"");
            foreach (var c in s)
            {
                if (c == '"' || c == '\\') sb.Append('\\').Append(c);
                else if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                else sb.Append(c);
            }
            return sb.Append('"').ToString();
        }
    }
}
