// #513: what the update waits for, and why "Zugriff verweigert" appeared in update.log.
//
// The denial was not missing rights: a process of the same user at medium integrity grants PROCESS_TERMINATE to
// Keevault-Update.exe (checked live on a running Keevault: app, GPU, renderer and browser connection, all in a job object).
// TerminateProcess answers ERROR_ACCESS_DENIED (5) for a process that is already exiting or has exited while someone
// still holds a handle to it, and .NET Framework's Process.Kill() throws exactly that ("Zugriff verweigert") instead
// of checking HasExited. The log shows it: the same PID was ended once without an error and was "denied" on the second
// try, after Process.WaitForExit(5000) had waited the full 5 s each time; the app itself was already quitting.
// So: an ended process holds no file and is not waited for; a second end of an exiting one is no error; the helpers
// (MCP servers, the browser's connection) are asked to quit by a signal file first; and the setup starts only when no
// file in the installation folder is still open.
// No dependencies beyond the BCL, so the test compiles this file on its own.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;

namespace Keevault.Setup
{
    internal static class UpdateWait
    {
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

        [DllImport("kernel32.dll")]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr handle);

        private const uint Synchronize = 0x00100000;
        private const int ErrorInvalidParameter = 87; // no such process

        /// <summary>
        /// The file the helpers watch (desktop/helper-quit.js, NativeHost.cs): written before an update, they quit when it
        /// is newer than their own start. %LOCALAPPDATA%\keyvault-pwsafe-updater\quit-helpers, beside update.log.
        /// </summary>
        public static string SignalFile(string localAppData = null) => Path.Combine(
            localAppData ?? Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "keyvault-pwsafe-updater", "quit-helpers");

        /// <summary>Asks the helpers to quit. False if the file could not be written (they are ended later then).</summary>
        public static bool Signal(string file = null)
        {
            try
            {
                file = file ?? SignalFile();
                Directory.CreateDirectory(Path.GetDirectoryName(file));
                File.WriteAllText(file, DateTime.UtcNow.ToString("o"));
                File.SetLastWriteTimeUtc(file, DateTime.UtcNow);
                return true;
            }
            catch
            {
                return false;
            }
        }

        /// <summary>Whether a signal was written after <paramref name="sinceUtc"/> (the helper's start).</summary>
        public static bool Signalled(string file, DateTime sinceUtc)
        {
            try
            {
                return File.Exists(file) && File.GetLastWriteTimeUtc(file) > sinceUtc;
            }
            catch
            {
                return false;
            }
        }

        /// <summary>
        /// True when the process has ended (or is gone): it may still be listed while another process holds a handle to it,
        /// but it holds no file any more. Unknown (no access) counts as running.
        /// </summary>
        public static bool Ended(int pid)
        {
            var handle = OpenProcess(Synchronize, false, pid);
            if (handle == IntPtr.Zero) return Marshal.GetLastWin32Error() == ErrorInvalidParameter;
            try
            {
                return WaitForSingleObject(handle, 0) == 0;
            }
            finally
            {
                CloseHandle(handle);
            }
        }

        /// <summary>
        /// Whether a file can't be opened for writing because another process has it open (a running exe or DLL is mapped
        /// and refuses it). Missing files and refused rights are no lock.
        /// </summary>
        public static bool Locked(string file)
        {
            try
            {
                using (new FileStream(file, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) return false;
            }
            catch (FileNotFoundException) { return false; }
            catch (DirectoryNotFoundException) { return false; }
            catch (UnauthorizedAccessException) { return false; }
            catch (IOException) { return true; }
        }

        private static readonly string[] Watched = { ".exe", ".dll", ".node", ".asar" };

        /// <summary>The program files in the installation folder still open elsewhere (relative paths, at most <paramref name="max"/>).</summary>
        public static List<string> LockedFiles(string dir, int max = 5)
        {
            var found = new List<string>();
            if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) return found;
            var root = dir.TrimEnd('\\') + "\\";
            IEnumerable<string> files;
            try { files = Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories); }
            catch { return found; }
            foreach (var f in files)
            {
                if (!Watched.Contains(Path.GetExtension(f).ToLowerInvariant())) continue;
                if (!Locked(f)) continue;
                found.Add(f.StartsWith(root, StringComparison.OrdinalIgnoreCase) ? f.Substring(root.Length) : f);
                if (found.Count >= max) break;
            }
            return found;
        }

        /// <summary>
        /// LockedFiles, asked again for up to <paramref name="settle"/>: a process that just ended or a virus scanner may
        /// hold a file for a moment longer. What is still open then.
        /// </summary>
        public static List<string> LockedFilesSettled(string dir, TimeSpan settle)
        {
            var until = DateTime.Now + settle;
            var found = LockedFiles(dir);
            while (found.Count > 0 && DateTime.Now < until)
            {
                System.Threading.Thread.Sleep(500);
                found = LockedFiles(dir);
            }
            return found;
        }

        /// <summary>
        /// What a Keevault process is, from its command line: "mcp" (an AI agent's connection), "browser" (the browser's
        /// connection), "app" (the app and Electron's own child processes) or "other".
        /// </summary>
        public static string Kind(string commandLine)
        {
            if (string.IsNullOrEmpty(commandLine)) return "other";
            var c = commandLine.Replace('/', '\\');
            if (c.IndexOf("\\mcp\\keevault-mcp.cjs", StringComparison.OrdinalIgnoreCase) >= 0) return "mcp";
            if (c.IndexOf("\\native-host\\host.cjs", StringComparison.OrdinalIgnoreCase) >= 0
                || c.IndexOf(" --native-host", StringComparison.OrdinalIgnoreCase) >= 0
                || c.IndexOf(" chrome-extension:", StringComparison.OrdinalIgnoreCase) >= 0) return "browser";
            // The program is everything up to the first ".exe" (paths with spaces may come without quotes).
            var exe = c.TrimStart('"');
            var end = exe.IndexOf(".exe", StringComparison.OrdinalIgnoreCase);
            var image = Path.GetFileName(end >= 0 ? exe.Substring(0, end + 4) : exe);
            return string.Equals(image, "Keevault.exe", StringComparison.OrdinalIgnoreCase) ? "app" : "other";
        }

        /// <summary>"app, mcp ×3": the kinds once each, in a fixed order, with their count.</summary>
        public static string Summary(IEnumerable<string> kinds, Func<string, string> label)
        {
            var order = new[] { "app", "mcp", "browser", "other" };
            return string.Join(", ", kinds.GroupBy((k) => k).OrderBy((g) => Array.IndexOf(order, g.Key) < 0 ? 99 : Array.IndexOf(order, g.Key))
                .Select((g) => label(g.Key) + (g.Count() > 1 && g.Key != "app" ? " ×" + g.Count() : "")));
        }
    }
}
