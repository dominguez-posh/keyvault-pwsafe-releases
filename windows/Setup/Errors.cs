// Errors of the setup/update window: each has a code (KV-S…), an explanation in plain words and a link to its section
// in the knowledge base (website/kb/installation-und-updates.md, en/install-and-update.md – anchors {#kv-s…}).
// Plus the update log and the processes started from the installation folder (they keep its files open).

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

namespace Keevault.Setup
{
    internal sealed class SetupError
    {
        public string Code { get; }
        public string Message { get; }

        private SetupError(string code, string message)
        {
            Code = code;
            Message = message;
        }

        /// <summary>Knowledge base section for this error (German or English page, same anchor).</summary>
        public string HelpUrl => (Text.German ? "https://keevault.de/wissen/installation-und-updates.html#" : "https://keevault.de/en/knowledge/install-and-update.html#") + Code.ToLowerInvariant();

        /// <summary>Exit code of the NSIS setup (electron-builder: 1 = cancelled, 2 = old version could not be removed).</summary>
        public static SetupError FromExitCode(int code)
        {
            switch (code)
            {
                case 1: return new SetupError("KV-S1", Text.T("Das Setup wurde vor dem Ende abgebrochen. Versuche es erneut."));
                case 2: return new SetupError("KV-S2", Text.T("Die alte Version ließ sich nicht ersetzen – Dateien von Keevault waren noch geöffnet. Schließe Keevault ganz (auch im Infobereich) und versuche es erneut."));
                default: return new SetupError("KV-S3", Text.T("Das Setup wurde mit Code {0} beendet.", code));
            }
        }

        public static SetupError PayloadMissing() =>
            new SetupError("KV-S4", Text.T("Das Installationspaket fehlt in dieser Datei. Bitte Keevault-Setup.exe erneut von keevault.de laden."));

        public static SetupError UpdateFileMissing() =>
            new SetupError("KV-S5", Text.T("Die heruntergeladene Update-Datei fehlt – vermutlich hat ein Virenscanner sie entfernt. Keevault lädt das Update beim nächsten Start erneut."));

        public static SetupError OldInstallStays() =>
            new SetupError("KV-S8", Text.T("Die alte Installation für alle Benutzer wurde nicht entfernt – die Abfrage wurde abgebrochen oder es fehlen Administratorrechte. Erneut versuchen oder die alte Installation unter Einstellungen → Apps entfernen."));

        public static SetupError FromException(Exception e)
        {
            var win32 = e as Win32Exception;
            // 5 = access denied, 1260 = blocked by group policy (AppLocker / Software Restriction), 225 = virus found.
            if (e is UnauthorizedAccessException || win32?.NativeErrorCode == 5 || win32?.NativeErrorCode == 1260 || win32?.NativeErrorCode == 225)
                return new SetupError("KV-S6", Text.T("Windows hat das Setup blockiert – meist eine Sicherheitssoftware oder eine Richtlinie (z. B. AppLocker). Details: {0}", e.Message));
            if (e is FileNotFoundException || e is DirectoryNotFoundException || win32?.NativeErrorCode == 2)
                return UpdateFileMissing();
            // 0x80070070 / 0x80070027: disk full.
            if (e is IOException && ((uint)e.HResult == 0x80070070 || (uint)e.HResult == 0x80070027))
                return new SetupError("KV-S7", Text.T("Auf dem Laufwerk ist nicht genug Platz frei. Gib etwas Speicher frei und versuche es erneut."));
            return new SetupError("KV-S9", Text.T("Unerwarteter Fehler: {0}", e.Message));
        }
    }

    /// <summary>Short log of the last updates (%LOCALAPPDATA%\keyvault-pwsafe-updater\update.log), for support.</summary>
    internal static class UpdateLog
    {
        public static readonly string FilePath = System.IO.Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "keyvault-pwsafe-updater", "update.log");

        public static void Write(string line)
        {
            try
            {
                Directory.CreateDirectory(System.IO.Path.GetDirectoryName(FilePath));
                // Keep it small: only the last 200 lines.
                var lines = File.Exists(FilePath) ? File.ReadAllLines(FilePath).ToList() : new List<string>();
                lines.Add($"{DateTime.Now:yyyy-MM-dd HH:mm:ss}  {line}");
                File.WriteAllLines(FilePath, lines.Skip(Math.Max(0, lines.Count - 200)));
            }
            catch { /* logging must never break the update */ }
        }
    }

    /// <summary>Processes running from the installation folder (app, browser connection, passkey provider).</summary>
    internal static class InstallProcesses
    {
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder name, ref int size);

        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr handle);

        private const uint QueryLimitedInformation = 0x1000;

        private static string ImagePath(int pid)
        {
            var handle = OpenProcess(QueryLimitedInformation, false, pid);
            if (handle == IntPtr.Zero) return null;
            try
            {
                var size = 1024;
                var name = new StringBuilder(size);
                return QueryFullProcessImageName(handle, 0, name, ref size) ? name.ToString() : null;
            }
            finally
            {
                CloseHandle(handle);
            }
        }

        public static List<Process> Find(string dir)
        {
            var prefix = System.IO.Path.GetFullPath(dir).TrimEnd('\\') + "\\";
            var own = Process.GetCurrentProcess().Id;
            var found = new List<Process>();
            foreach (var p in Process.GetProcesses())
            {
                if (p.Id == own) { p.Dispose(); continue; }
                var image = ImagePath(p.Id);
                if (image != null && image.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) found.Add(p);
                else p.Dispose();
            }
            return found;
        }

        /// <summary>
        /// Waits until nothing runs from the folder any more; after <paramref name="wait"/> the rest is ended (these are
        /// Keevault's own processes – the browser reconnects to the new version by itself). Returns what is left over.
        /// </summary>
        public static async Task<List<string>> Release(string dir, TimeSpan wait)
        {
            if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) return new List<string>();
            var until = DateTime.Now + wait;
            while (DateTime.Now < until)
            {
                var running = Find(dir);
                var none = running.Count == 0;
                running.ForEach((p) => p.Dispose());
                if (none) return new List<string>();
                await Task.Delay(500);
            }
            foreach (var p in Find(dir))
            {
                using (p)
                {
                    try
                    {
                        UpdateLog.Write($"ending {p.ProcessName} ({p.Id}), still running from the installation folder");
                        p.Kill();
                        p.WaitForExit(5000);
                    }
                    catch (Exception e)
                    {
                        UpdateLog.Write($"could not end {p.ProcessName} ({p.Id}): {e.Message}");
                    }
                }
            }
            var left = Find(dir);
            var names = left.Select((p) => $"{p.ProcessName}.exe").Distinct().ToList();
            left.ForEach((p) => p.Dispose());
            return names;
        }
    }
}
