// #505: the browser's native messaging host as a small relay instead of Keevault.exe running host.cjs as Node (the large
// Electron exe took 0.2 to 15 s to start). Same protocol and the same checks as host.cjs (desktop/bridge.js):
//   browser (stdin/stdout, 4-byte length + JSON) <-> app (named pipe, one JSON object per line).
// - The origin comes from the browser's command line (chrome-extension://<id>/ or a Firefox gecko ID) and is written
//   into every "hello"; whatever the extension put there itself is replaced. The app checks it (approvedBrowsers, #466).
// - "launch" starts the app (--launch, --launch-arg) and is answered here.
// - App not running: "offline" event, requests are answered with AppOffline at once, the pipe is tried again every 1.5 s;
//   "online" once it is reachable. Requests before the first answer of the pipe wait for it (like host.cjs "unknown").
// - New (#505, security): the process at the other end of the pipe must be the app (GetNamedPipeServerProcessId, image
//   path = --server; #511: also this user's SID and this session). Another process holding the pipe name gets nothing
//   and counts as "app not running". The pipe is opened with impersonation level Identification (#511).
// Started by the browser directly (the app enters this exe in the Chrome/Edge manifest; no cmd.exe, about 110 ms less):
// the arguments are only what the browser passes (chrome-extension://<id>/, --parent-window), the options come from
// %APPDATA%\KeyVault PwSafe\native-host\relay.txt (written by the app, lines "pipe=", "server=", "launch=", "launch-arg=").
// Also: --native-host --pipe <name> --server <app exe> --launch <exe> [--launch-arg <a>]… (tests, manual start).
// No JSON on the way to "online": the serializer is loaded beside the pipe. Messages pass unchanged except "hello".

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

namespace Keevault.Setup
{
    internal static class NativeHost
    {
        private const int RetryMs = 1500;
        private const int MaxMessage = 64 * 1024 * 1024;
        private static readonly byte[] Online = Encoding.ASCII.GetBytes("{\"event\":\"online\"}");
        private static readonly byte[] Offline = Encoding.ASCII.GetBytes("{\"event\":\"offline\"}");

        private static readonly object Gate = new object();
        private static readonly List<byte[]> Waiting = new List<byte[]>(); // lines for the pipe, held until it answers
        private static readonly List<object> WaitingIds = new List<object>();
        private static Stream stdout;
        private static NamedPipeClientStream socket;
        private static string state = "unknown";
        private static string pipeName;
        private static string server;
        private static string origin = "";
        private static string launchCmd;
        private static readonly List<string> launchArgs = new List<string>();

        /// <summary>Options as host.cmd passes them; returns an error text or null.</summary>
        public static string Configure(string[] argv)
        {
            for (int i = 0; i < argv.Length - 1; i++)
            {
                switch (argv[i])
                {
                    case "--pipe": pipeName = argv[++i]; break;
                    case "--server": server = argv[++i]; break;
                    case "--launch": launchCmd = argv[++i]; break;
                    case "--launch-arg": launchArgs.Add(argv[++i]); break;
                }
            }
            if (pipeName == null) ReadOptions(OptionsPath());
            if (pipeName != null && pipeName.StartsWith(@"\\.\pipe\", StringComparison.OrdinalIgnoreCase)) pipeName = pipeName.Substring(9);
            origin = Origin(argv);
            return string.IsNullOrEmpty(pipeName) ? "--pipe missing" : string.IsNullOrEmpty(server) ? "--server missing" : null;
        }

        /// <summary>Is this start the browser's (its origin argument), or the explicit switch?</summary>
        public static bool Wanted(string[] argv) => argv.Length > 0 && (argv[0] == "--native-host" || argv[0].StartsWith("chrome-extension://", StringComparison.Ordinal));

        /// <summary>The options file of the installed app (its profile folder is pinned, boot.js); KV_RELAY_OPTIONS for tests.</summary>
        public static string OptionsPath() => Environment.GetEnvironmentVariable("KV_RELAY_OPTIONS")
            ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "KeyVault PwSafe", "native-host", "relay.txt");

        private static void ReadOptions(string file)
        {
            string[] lines;
            try { lines = File.ReadAllLines(file, Encoding.UTF8); }
            catch { return; }
            foreach (var l in lines)
            {
                var eq = l.IndexOf('=');
                if (eq <= 0) continue;
                var value = l.Substring(eq + 1);
                switch (l.Substring(0, eq))
                {
                    case "pipe": pipeName = value; break;
                    case "server": server = value; break;
                    case "launch": launchCmd = value; break;
                    case "launch-arg": launchArgs.Add(value); break;
                }
            }
        }

        public static int Run(string[] argv)
        {
            var error = Configure(argv);
            if (error != null)
            {
                Console.Error.WriteLine($"Keevault native host: {error}");
                return 1;
            }
            stdout = Console.OpenStandardOutput();
            new Thread(ConnectLoop) { IsBackground = true, Name = "pipe" }.Start();
            // #513: an update asks this relay to quit (UpdateWait.Signal) – it ends by itself instead of being ended; the
            // browser starts the new one on its next connect.
            var started = DateTime.UtcNow;
            var signal = UpdateWait.SignalFile();
            new Thread(() => { while (true) { Thread.Sleep(1000); if (UpdateWait.Signalled(signal, started)) Environment.Exit(0); } }) { IsBackground = true, Name = "update" }.Start();
            // The serializer (60-110 ms to load and compile) is warmed up beside the pipe, not when the first click comes.
            new Thread(() => Json.Serializer.Serialize(Json.Serializer.Deserialize<Dictionary<string, object>>("{\"a\":[1,\"b\"]}"))) { IsBackground = true, Priority = ThreadPriority.BelowNormal }.Start();
            ReadBrowser(Console.OpenStandardInput());
            return 0;
        }

        /// <summary>The caller as the browser names it: chrome-extension://<id>/ or a Firefox gecko ID (like host.cjs).</summary>
        public static string Origin(string[] argv)
        {
            return argv.FirstOrDefault((a) => a.StartsWith("chrome-extension://", StringComparison.Ordinal))
                ?? argv.FirstOrDefault((a) => Regex.IsMatch(a, @"^[\w.-]+@[\w.-]+$"))
                ?? "";
        }

        // ------------------------------------------------------------------------------------------------- browser side

        private static void ReadBrowser(Stream input)
        {
            var len = new byte[4];
            while (true)
            {
                if (!ReadExactly(input, len, 4)) break;
                var n = BitConverter.ToInt32(len, 0);
                if (n < 0 || n > MaxMessage) break;
                var body = new byte[n];
                if (!ReadExactly(input, body, n)) break;
                try { Forward(body); }
                catch { /* not a JSON object: dropped, like a broken line in host.cjs */ }
            }
            Environment.Exit(0);
        }

        private static bool ReadExactly(Stream s, byte[] buf, int n)
        {
            var off = 0;
            while (off < n)
            {
                var r = s.Read(buf, off, n - off);
                if (r <= 0) return false;
                off += r;
            }
            return true;
        }

        private static void SendRaw(byte[] json)
        {
            lock (stdout)
            {
                stdout.Write(BitConverter.GetBytes(json.Length), 0, 4);
                stdout.Write(json, 0, json.Length);
                stdout.Flush();
            }
        }

        private static void Reply(object id, bool ok, object result, string errorName = null, string errorMessage = null)
        {
            var msg = new Dictionary<string, object> { ["id"] = id, ["ok"] = ok };
            if (ok) msg["result"] = result;
            else msg["error"] = new Dictionary<string, object> { ["name"] = errorName, ["message"] = errorMessage };
            SendRaw(Encoding.UTF8.GetBytes(Json.Serializer.Serialize(msg)));
        }

        private static void OfflineReply(object id) => Reply(id, false, null, "AppOffline", "Keevault is not running");

        private static void Forward(byte[] body)
        {
            var msg = Json.Serializer.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(body));
            if (msg == null) return;
            msg.TryGetValue("cmd", out var cmd);
            msg.TryGetValue("id", out var id);
            if ("launch".Equals(cmd))
            {
                try
                {
                    Launch();
                    Reply(id, true, true);
                }
                catch (Exception e)
                {
                    Reply(id, false, null, "Error", e.Message);
                }
                return;
            }
            byte[] line;
            if ("hello".Equals(cmd) || Array.IndexOf(body, (byte)'\n') >= 0)
            {
                if ("hello".Equals(cmd)) msg["origin"] = origin;
                line = Encoding.UTF8.GetBytes(Json.Serializer.Serialize(msg) + "\n");
            }
            else
            {
                // Everything else exactly as the browser sent it (compact JSON: one line).
                line = new byte[body.Length + 1];
                Buffer.BlockCopy(body, 0, line, 0, body.Length);
                line[body.Length] = (byte)'\n';
            }
            lock (Gate)
            {
                if (socket != null) WritePipe(socket, line);
                else if (state == "unknown")
                {
                    Waiting.Add(line);
                    WaitingIds.Add(id);
                }
                else OfflineReply(id);
            }
        }

        /// <summary>Starts the app through the shell: nothing of this process (its stdio handles) is inherited.</summary>
        private static void Launch()
        {
            if (string.IsNullOrEmpty(launchCmd)) throw new InvalidOperationException("no launch command");
            var args = string.Join(" ", launchArgs.Select(Quote));
            Process.Start(new ProcessStartInfo(launchCmd, args) { UseShellExecute = true })?.Dispose();
        }

        private static string Quote(string a) => a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0 ? a : "\"" + a.Replace("\"", "\\\"") + "\"";

        // ---------------------------------------------------------------------------------------------------- app side

        private static void WritePipe(NamedPipeClientStream s, byte[] line)
        {
            try
            {
                s.Write(line, 0, line.Length);
                s.Flush();
            }
            catch { /* the reader notices the loss */ }
        }

        private static void ConnectLoop()
        {
            while (true)
            {
                // Identification (#511 review): the server may learn who connects, never act as this user.
                var s = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous, TokenImpersonationLevel.Identification);
                var ok = false;
                try
                {
                    s.Connect(200);
                    var refusal = Refusal(PeerOf(s.SafePipeHandle.DangerousGetHandle()), server, OwnSid(), OwnSession());
                    ok = refusal == null;
                    if (!ok) Console.Error.WriteLine($"Keevault native host: the pipe is not served by the Keevault app ({refusal}) – ignored");
                }
                catch { /* not there (yet) */ }
                if (ok)
                {
                    lock (Gate)
                    {
                        socket = s;
                        state = "online";
                        SendRaw(Online);
                        foreach (var line in Waiting) WritePipe(s, line);
                        Waiting.Clear();
                        WaitingIds.Clear();
                    }
                    ReadPipe(s);
                }
                s.Dispose();
                lock (Gate)
                {
                    if (socket == s) socket = null;
                    if (state != "offline")
                    {
                        state = "offline";
                        SendRaw(Offline);
                        foreach (var id in WaitingIds) OfflineReply(id);
                        Waiting.Clear();
                        WaitingIds.Clear();
                    }
                }
                Thread.Sleep(RetryMs);
            }
        }

        /// <summary>Lines from the app go to the browser as they are (the app writes one JSON object per line).</summary>
        private static void ReadPipe(Stream s)
        {
            var buf = new byte[65536];
            var line = new MemoryStream();
            try
            {
                int r;
                while ((r = s.Read(buf, 0, buf.Length)) > 0)
                {
                    var start = 0;
                    for (var i = 0; i < r; i++)
                    {
                        if (buf[i] != (byte)'\n') continue;
                        line.Write(buf, start, i - start);
                        if (line.Length > 0) SendRaw(line.ToArray());
                        line.SetLength(0);
                        start = i + 1;
                    }
                    line.Write(buf, start, r - start);
                }
            }
            catch { /* lost */ }
        }

        // ------------------------------------------------------------------------------------------- the other end (#505)

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetNamedPipeServerProcessId(IntPtr pipe, out uint processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);

        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder name, ref int size);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetNamedPipeServerSessionId(IntPtr pipe, out uint sessionId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool ProcessIdToSessionId(uint pid, out uint sessionId);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, int length, out int needed);

        private const uint QueryLimitedInformation = 0x1000;
        private const uint TokenQuery = 0x0008;
        private const int TokenUser = 1;

        /// <summary>The process at the other end of a pipe: image path, user SID and session (null where not readable).</summary>
        public sealed class Peer
        {
            public string Path;
            public string Sid;
            public uint? Session;
        }

        public static Peer PeerOf(IntPtr pipe)
        {
            var peer = new Peer();
            if (GetNamedPipeServerProcessId(pipe, out var pid))
            {
                peer.Path = ImagePath(pid);
                peer.Sid = UserSid(pid);
            }
            if (GetNamedPipeServerSessionId(pipe, out var session)) peer.Session = session;
            return peer;
        }

        /// <summary>
        /// Is the process serving the pipe the app this host was registered for? The image path alone does not prove it
        /// (#511 review: the same exe can run other code), so it must also run as this user in this session. → null when
        /// it is the app, else what did not match.
        /// </summary>
        public static string Refusal(Peer peer, string expectedPath, string ownSid, uint? ownSession)
        {
            var wrong = new List<string>();
            if (!SamePath(peer.Path, expectedPath)) wrong.Add("path");
            if (string.IsNullOrEmpty(peer.Sid) || string.IsNullOrEmpty(ownSid) || !string.Equals(peer.Sid, ownSid, StringComparison.OrdinalIgnoreCase)) wrong.Add("user");
            if (peer.Session == null || ownSession == null || peer.Session != ownSession) wrong.Add("session");
            return wrong.Count == 0 ? null : string.Join(", ", wrong);
        }

        public static string OwnSid()
        {
            using (var me = WindowsIdentity.GetCurrent()) return me.User?.Value;
        }

        public static uint? OwnSession() => ProcessIdToSessionId((uint)Process.GetCurrentProcess().Id, out var s) ? s : (uint?)null;

        /// <summary>The user a process runs as (its token's TokenUser), or null.</summary>
        public static string UserSid(uint pid)
        {
            var h = OpenProcess(QueryLimitedInformation, false, pid);
            if (h == IntPtr.Zero) return null;
            try
            {
                if (!OpenProcessToken(h, TokenQuery, out var token)) return null;
                try
                {
                    GetTokenInformation(token, TokenUser, IntPtr.Zero, 0, out var needed);
                    if (needed <= 0) return null;
                    var buf = Marshal.AllocHGlobal(needed);
                    try
                    {
                        if (!GetTokenInformation(token, TokenUser, buf, needed, out needed)) return null;
                        return new SecurityIdentifier(Marshal.ReadIntPtr(buf)).Value; // TOKEN_USER starts with the SID pointer
                    }
                    finally { Marshal.FreeHGlobal(buf); }
                }
                finally { CloseHandle(token); }
            }
            finally { CloseHandle(h); }
        }

        /// <summary>
        /// --pipe-peer &lt;pipe&gt; --server &lt;exe&gt; [--expect-sid &lt;sid&gt;] [--expect-session &lt;n&gt;] (tests, diagnosis): the
        /// relay's check of the other end, printed. The expect options stand in for this user's SID and session.
        /// → 0 when the relay would take the pipe, 2 when it would refuse it.
        /// </summary>
        public static int ShowPeer(string pipe, string expectedPath, string sid, string session)
        {
            try
            {
                var name = pipe.StartsWith(@"\\.\pipe\", StringComparison.OrdinalIgnoreCase) ? pipe.Substring(9) : pipe;
                using (var c = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.None, TokenImpersonationLevel.Identification))
                {
                    c.Connect(2000);
                    var peer = PeerOf(c.SafePipeHandle.DangerousGetHandle());
                    uint? ownSession = session == null ? OwnSession() : uint.TryParse(session, out var n) ? n : (uint?)null;
                    var refusal = Refusal(peer, expectedPath, sid ?? OwnSid(), ownSession);
                    Console.WriteLine($"path={peer.Path}\nsid={peer.Sid}\nsession={peer.Session}\nrefused={refusal ?? ""}");
                    return refusal == null ? 0 : 2;
                }
            }
            catch (Exception e)
            {
                Console.Error.WriteLine($"pipe-peer: {e.GetType().Name}: {e.Message}");
                return 1;
            }
        }

        public static string ImagePath(uint pid)
        {
            var h = OpenProcess(QueryLimitedInformation, false, pid);
            if (h == IntPtr.Zero) return null;
            try
            {
                var size = 1024;
                var sb = new StringBuilder(size);
                return QueryFullProcessImageName(h, 0, sb, ref size) ? sb.ToString(0, size) : null;
            }
            finally { CloseHandle(h); }
        }

        public static bool SamePath(string a, string b)
        {
            if (string.IsNullOrEmpty(a) || string.IsNullOrEmpty(b)) return false;
            try { return string.Equals(Path.GetFullPath(a), Path.GetFullPath(b), StringComparison.OrdinalIgnoreCase); }
            catch { return false; }
        }

        /// <summary>Own class: System.Web.Extensions is loaded only when the first message from the browser arrives.</summary>
        private static class Json
        {
            public static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        }
    }
}
