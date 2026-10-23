using System.Diagnostics;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace KvPwSafe.PasskeyProvider;

/// <summary>
/// Connection to the Keevault desktop app over its named pipe (newline-delimited JSON, same protocol as the
/// browser bridge). The desktop app holds the keys and asks the user for confirmation.
/// </summary>
internal static class Desktop
{
    public const string RegistryKey = @"Software\KeyVault PwSafe";

    private static string PipeName => "kvpwsafe-" + Regex.Replace(Environment.UserName, @"[^\w.-]", "_");

    /// <summary>Sends one command; starts the desktop app if it is not running (when allowed).</summary>
    public static async Task<JsonNode?> Request(string cmd, JsonObject? args, TimeSpan timeout, bool start, CancellationToken cancel = default)
    {
        using var pipe = await Connect(start, cancel);
        using var reader = new StreamReader(pipe, new UTF8Encoding(false), false, 4096, leaveOpen: true);
        using var writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, leaveOpen: true) { AutoFlush = true, NewLine = "\n" };

        await Send(writer, reader, "hello", new JsonObject { ["origin"] = "windows-provider" }, TimeSpan.FromSeconds(10), cancel);
        return await Send(writer, reader, cmd, args ?? new JsonObject(), timeout, cancel);
    }

    private static int _seq;

    private static async Task<JsonNode?> Send(StreamWriter writer, StreamReader reader, string cmd, JsonObject args, TimeSpan timeout, CancellationToken cancel)
    {
        var id = Interlocked.Increment(ref _seq);
        args["id"] = id;
        args["cmd"] = cmd;
        await writer.WriteLineAsync(args.ToJsonString());
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancel);
        cts.CancelAfter(timeout);
        while (true)
        {
            var line = await reader.ReadLineAsync(cts.Token) ?? throw new IOException("Desktop app closed the connection");
            var msg = JsonNode.Parse(line)?.AsObject();
            if (msg is null || msg["event"] is not null || msg["id"]?.GetValue<int>() != id) continue;
            if (msg["ok"]?.GetValue<bool>() == true) return msg["result"];
            var name = msg["error"]?["name"]?.GetValue<string>() ?? "Error";
            throw new DesktopException(name, msg["error"]?["message"]?.GetValue<string>() ?? "Error");
        }
    }

    private static async Task<NamedPipeClientStream> Connect(bool start, CancellationToken cancel)
    {
        var started = false;
        var deadline = DateTime.UtcNow.AddSeconds(start ? 30 : 2);
        while (true)
        {
            var pipe = new NamedPipeClientStream(".", PipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
            try
            {
                await pipe.ConnectAsync(1000, cancel);
                return pipe;
            }
            catch (TimeoutException)
            {
                pipe.Dispose();
            }
            if (DateTime.UtcNow > deadline) throw new DesktopException("NotRunning", "Keevault is not running");
            if (start && !started)
            {
                started = true;
                StartDesktop();
            }
        }
    }

    /// <summary>Command line of the desktop app, stored by the app itself (dev and installed builds differ).</summary>
    private static void StartDesktop()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RegistryKey);
        var file = key?.GetValue("DesktopExecutable") as string;
        var args = key?.GetValue("DesktopArguments") as string ?? "";
        if (string.IsNullOrEmpty(file) || !File.Exists(file)) return;
        var info = new ProcessStartInfo(file, args) { UseShellExecute = false };
        info.Environment.Remove("ELECTRON_RUN_AS_NODE");
        Process.Start(info);
    }
}

internal sealed class DesktopException(string name, string message) : Exception(message)
{
    public string Name { get; } = name;
}

internal static class Log
{
    private static readonly string File = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "KeyVault PwSafe", "passkey-provider.log");

    public static void Write(string message)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(File)!);
            var info = new FileInfo(File);
            if (info.Exists && info.Length > 512 * 1024) info.Delete();
            System.IO.File.AppendAllText(File, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {message}{Environment.NewLine}");
        }
        catch
        {
            // Logging must never break an operation.
        }
    }
}

internal static class Json
{
    public static readonly JsonSerializerOptions Options = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
}
