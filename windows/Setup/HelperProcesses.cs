// #351: which Keevault processes from the installation folder never end by themselves. The browser's connection
// (native messaging host: Keevault.exe running native-host\host.cjs) lives as long as the extension keeps its port
// open and keeps waiting for the app; an AI agent's connection (mcp\keevault-mcp.cjs) lives as long as the agent.
// Waiting for them only cost the update its full 20 seconds. Their command line identifies them and goes into the log.
// No dependencies beyond the BCL, so the test compiles this file on its own.

using System;
using System.Runtime.InteropServices;

namespace Keevault.Setup
{
    internal static class HelperProcesses
    {
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr handle);

        [DllImport("ntdll.dll")]
        private static extern int NtQueryInformationProcess(IntPtr process, int infoClass, IntPtr info, int length, out int returned);

        private const uint QueryLimitedInformation = 0x1000;
        private const int ProcessCommandLineInformation = 60; // Windows 8.1 and later

        /// <summary>The command line of a process, or null if it can't be read.</summary>
        public static string CommandLine(int pid)
        {
            var handle = OpenProcess(QueryLimitedInformation, false, pid);
            if (handle == IntPtr.Zero) return null;
            var buffer = IntPtr.Zero;
            try
            {
                NtQueryInformationProcess(handle, ProcessCommandLineInformation, IntPtr.Zero, 0, out var size);
                if (size <= 0 || size > 1 << 20) return null;
                buffer = Marshal.AllocHGlobal(size);
                if (NtQueryInformationProcess(handle, ProcessCommandLineInformation, buffer, size, out _) != 0) return null;
                // UNICODE_STRING: Length (bytes), MaximumLength, then the pointer (aligned to its size).
                var length = Marshal.ReadInt16(buffer);
                var text = Marshal.ReadIntPtr(buffer, IntPtr.Size);
                return length > 0 && text != IntPtr.Zero ? Marshal.PtrToStringUni(text, length / 2) : "";
            }
            catch
            {
                return null;
            }
            finally
            {
                if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
                CloseHandle(handle);
            }
        }

        /// <summary>A connection for the browser or an AI agent: it does not end when the app ends, so nobody waits for it.</summary>
        public static bool IsHelper(string commandLine)
        {
            if (string.IsNullOrEmpty(commandLine)) return false;
            var c = commandLine.Replace('/', '\\');
            return c.IndexOf("\\native-host\\host.cjs", StringComparison.OrdinalIgnoreCase) >= 0
                || c.IndexOf(" --native-host", StringComparison.OrdinalIgnoreCase) >= 0 // #505: the relay (Keevault-Update.exe)
                || c.IndexOf(" chrome-extension:", StringComparison.OrdinalIgnoreCase) >= 0 // #505: the relay as the browser starts it
                || c.IndexOf("\\mcp\\keevault-mcp.cjs", StringComparison.OrdinalIgnoreCase) >= 0;
        }
    }
}
