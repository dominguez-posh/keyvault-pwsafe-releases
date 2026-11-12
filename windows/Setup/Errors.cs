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

        /// <summary>The setup ended "successfully" but program or app package are missing (e.g. removed by a virus scanner).</summary>
        public static SetupError Incomplete() =>
            new SetupError("KV-S10", Text.T("Die Installation ist unvollständig – Programmdateien fehlen danach (meist hat eine Sicherheitssoftware sie entfernt oder das Setup beendet)."));

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
        // KV_UPDATE_LOG: tests write their own log instead of the user's (#513).
        public static readonly string FilePath = Environment.GetEnvironmentVariable("KV_UPDATE_LOG") ?? System.IO.Path.Combine(
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
        /// Keevault's own processes – the browser reconnects to the new version by itself). The browser's and the agents'
        /// connections never end by themselves (#351): asked to quit by UpdateWait.Signal, they get
        /// <paramref name="helperGrace"/> for it and are ended then. Processes that have ended already are not counted
        /// (#513: listed while someone holds a handle, but they hold no file). <paramref name="waiting"/> hears what still
        /// runs after each round. Returns the kinds still running (UpdateWait.Kind), empty when nothing is left.
        /// </summary>
        public static async Task<List<string>> Release(string dir, TimeSpan wait, TimeSpan helperGrace = default, Action<List<string>> waiting = null)
        {
            if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) return new List<string>();
            var start = DateTime.Now;
            var until = start + wait;
            var ended = new HashSet<int>(); // each one once: a second end of an exiting process is only refused (#513)
            while (DateTime.Now < until)
            {
                var running = new List<string>();
                foreach (var p in Live(dir))
                {
                    using (p)
                    {
                        var commandLine = HelperProcesses.CommandLine(p.Id);
                        if (HelperProcesses.IsHelper(commandLine) && DateTime.Now - start >= helperGrace && ended.Add(p.Id)) End(p, commandLine, "a connection for the browser or an AI agent");
                        running.Add(UpdateWait.Kind(commandLine));
                    }
                }
                if (running.Count == 0) return running;
                waiting?.Invoke(running);
                await Task.Delay(500);
            }
            foreach (var p in Live(dir))
            {
                using (p)
                {
                    if (ended.Add(p.Id)) End(p, HelperProcesses.CommandLine(p.Id), "still running from the installation folder");
                }
            }
            for (var i = 0; i < 6; i++)
            {
                var still = Live(dir);
                still.ForEach((p) => p.Dispose());
                if (still.Count == 0) break;
                await Task.Delay(500);
            }
            var left = Live(dir);
            var kinds = left.Select((p) => UpdateWait.Kind(HelperProcesses.CommandLine(p.Id))).ToList();
            left.ForEach((p) => p.Dispose());
            return kinds;
        }

        /// <summary>The processes from the folder that still run (#513: ended ones may still be listed).</summary>
        private static List<Process> Live(string dir)
        {
            var live = new List<Process>();
            foreach (var p in Find(dir))
            {
                if (UpdateWait.Ended(p.Id)) p.Dispose();
                else live.Add(p);
            }
            return live;
        }

        /// <summary>
        /// Ends one process without waiting for it (the caller's loop waits); the log names it with its command line
        /// (#351: which ones they were).
        /// </summary>
        private static void End(Process p, string commandLine, string why)
        {
            UpdateLog.Write($"ending {NameOf(p)} ({p.Id}), {why}: {commandLine ?? "(command line not readable)"}");
            try
            {
                p.Kill();
            }
            catch (Win32Exception e) when (e.NativeErrorCode == 5)
            {
                // #513: what update.log showed as "Zugriff verweigert" – Windows refuses to end a process that is exiting.
                UpdateLog.Write($"{NameOf(p)} ({p.Id}) is exiting already{(UpdateWait.Ended(p.Id) ? " and has ended" : ", waiting for it")}");
            }
            catch (Exception e)
            {
                UpdateLog.Write($"could not end {NameOf(p)} ({p.Id}): {e.Message}");
            }
        }

        private static string NameOf(Process p)
        {
            try { return p.ProcessName; } catch { return "process"; }
        }
    }
}
