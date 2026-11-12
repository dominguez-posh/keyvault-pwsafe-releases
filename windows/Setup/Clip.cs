// Keevault-Update.exe --clipboard: puts the UTF-8 text from stdin on the clipboard together with the markers that
// keep it out of the clipboard history (Win+V), the cloud clipboard and clipboard monitors, then reads it back –
// exit code 0 only when the text is really there. The app relies on this instead of Electron's clipboard.readText(),
// which returns nothing on some machines (2026-11-01: copy reported "clipboard not available" although it worked).
//
// Keevault-Update.exe --clipboard-clear: clears the clipboard if it still holds the UTF-8 text from stdin (the
// app's "clear after N seconds"); something copied since stays. Exit code 0 cleared, 1 different text, 2 busy.
//
// Exit code 2 (both modes): another program held the clipboard for the whole wait (OpenClipboard failed for ~5 s).
// Exit code 4 (--clipboard): written, but another program held the clipboard while reading it back – the text is most
// likely there, so the app treats it as copied and starts its clear timer (#526: with 2 the secret stayed uncleared).

using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Keevault.Setup
{
    internal static class Clip
    {
        [DllImport("user32.dll", SetLastError = true)] private static extern bool OpenClipboard(IntPtr owner);
        [DllImport("user32.dll", SetLastError = true)] private static extern bool CloseClipboard();
        [DllImport("user32.dll", SetLastError = true)] private static extern bool EmptyClipboard();
        [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetClipboardData(uint format, IntPtr data);
        [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr GetClipboardData(uint format);
        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern uint RegisterClipboardFormat(string name);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GlobalLock(IntPtr mem);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GlobalUnlock(IntPtr mem);

        private const uint CF_UNICODETEXT = 13;

        private static IntPtr Global(byte[] data)
        {
            var mem = GlobalAlloc(0x0002, (UIntPtr)data.Length); // GMEM_MOVEABLE
            var p = GlobalLock(mem);
            Marshal.Copy(data, 0, p, data.Length);
            GlobalUnlock(mem);
            return mem;
        }

        private static string ReadStdin()
        {
            using (var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false))) return stdin.ReadToEnd();
        }

        /// <summary>Longest wait for the clipboard. Same value in desktop/autotype.js (SetSecretClipboard).</summary>
        internal const int OpenWaitMs = 5000;

        /// <summary>Exit code: written, the read-back found the clipboard held (desktop/main/typing.js CLIPBOARD_UNVERIFIED).</summary>
        private const int WrittenUnverified = 4;

        /// <summary>
        /// Opens the clipboard. Windows has one clipboard for the whole session, and clipboard monitors, the clipboard
        /// history and its sync open it after every change: tried again for up to ~5 s with growing pauses (25 ms
        /// doubling up to 250 ms) – 1 s was too short on a busy machine (#526). False: another program held it.
        /// </summary>
        private static bool Open()
        {
            var watch = Stopwatch.StartNew();
            for (var pause = 25; ; pause = Math.Min(pause * 2, 250))
            {
                if (OpenClipboard(IntPtr.Zero)) return true;
                if (watch.ElapsedMilliseconds >= OpenWaitMs) return false;
                Thread.Sleep(pause);
            }
        }

        /// <summary>Text on the open clipboard (CF_UNICODETEXT), null if there is none.</summary>
        private static string CurrentText()
        {
            var handle = GetClipboardData(CF_UNICODETEXT);
            if (handle == IntPtr.Zero) return null;
            var p = GlobalLock(handle);
            if (p == IntPtr.Zero) return null;
            try { return Marshal.PtrToStringUni(p); }
            finally { GlobalUnlock(handle); }
        }

        public static int Run()
        {
            var text = ReadStdin();
            if (!Open()) return 2;
            try
            {
                EmptyClipboard();
                SetClipboardData(CF_UNICODETEXT, Global(Encoding.Unicode.GetBytes(text + "\0")));
                var no = BitConverter.GetBytes(0);
                SetClipboardData(RegisterClipboardFormat("ExcludeClipboardContentFromMonitorProcessing"), Global(new byte[] { 0 }));
                SetClipboardData(RegisterClipboardFormat("CanIncludeInClipboardHistory"), Global(no));
                SetClipboardData(RegisterClipboardFormat("CanUploadToCloudClipboard"), Global(no));
            }
            finally
            {
                CloseClipboard();
            }
            // Read back: only a text that really arrived counts as copied.
            if (!Open()) return WrittenUnverified;
            try { return CurrentText() == text ? 0 : 3; }
            finally { CloseClipboard(); }
        }

        public static int ClearIfEquals()
        {
            var text = ReadStdin();
            if (!Open()) return 2;
            try
            {
                if (CurrentText() != text) return 1;
                EmptyClipboard();
                return 0;
            }
            finally
            {
                CloseClipboard();
            }
        }
    }
}
