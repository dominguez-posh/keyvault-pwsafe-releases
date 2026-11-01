// Keevault-Update.exe --clipboard: puts the UTF-8 text from stdin on the clipboard together with the markers that
// keep it out of the clipboard history (Win+V), the cloud clipboard and clipboard monitors, then reads it back –
// exit code 0 only when the text is really there. The app relies on this instead of Electron's clipboard.readText(),
// which returns nothing on some machines (2026-11-01: copy reported "clipboard not available" although it worked).
//
// Keevault-Update.exe --clipboard-clear: clears the clipboard if it still holds the UTF-8 text from stdin (the
// app's "clear after N seconds"); something copied since stays. Exit code 0 cleared, 1 different text, 2 busy.

using System;
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

        private static bool Open()
        {
            var open = false;
            for (var i = 0; i < 40 && !(open = OpenClipboard(IntPtr.Zero)); i++) Thread.Sleep(25);
            return open;
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
            if (!Open()) return 2;
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
