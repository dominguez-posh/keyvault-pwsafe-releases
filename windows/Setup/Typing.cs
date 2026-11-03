// Keevault-Update.exe --type: types the UTF-8 text from stdin into the focused window via SendInput (Unicode, layout
// independent) – auto-type like KeePass. The app uses it instead of its PowerShell helper, which App Control
// (Constrained Language Mode: no Add-Type) or endpoint protection may block.

using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Keevault.Setup
{
    internal static class Typing
    {
        [StructLayout(LayoutKind.Sequential)] private struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)] private struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Explicit)] private struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
        [StructLayout(LayoutKind.Sequential)] private struct INPUT { public uint type; public UNION u; }
        [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, INPUT[] inputs, int size);
        [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

        private static string ForegroundTitle()
        {
            var sb = new StringBuilder(256);
            GetWindowText(GetForegroundWindow(), sb, sb.Capacity);
            return sb.ToString();
        }

        /// <summary>Waits up to 30 s until the window in front has one of the titles ("A|B"); false if it never comes.</summary>
        private static bool WaitForWindow(string titles)
        {
            var wanted = titles.Split('|');
            for (var i = 0; i < 300; i++)
            {
                var title = ForegroundTitle();
                foreach (var w in wanted) if (w.Length > 0 && title.IndexOf(w, StringComparison.OrdinalIgnoreCase) >= 0) return true;
                Thread.Sleep(100);
            }
            return false;
        }

        private const uint KEYUP = 2, UNICODE = 4;

        private static bool Key(ushort vk, ushort scan, uint flags)
        {
            var input = new INPUT[1];
            input[0].type = 1;
            input[0].u.ki.wVk = vk;
            input[0].u.ki.wScan = scan;
            input[0].u.ki.dwFlags = flags;
            return SendInput(1, input, Marshal.SizeOf(typeof(INPUT))) == 1;
        }

        public static int Run(string waitWindow = null)
        {
            string text;
            using (var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false))) text = stdin.ReadToEnd();
            // Typed only into the expected window (e.g. "Windows-Sicherheit"); it never came: nothing typed, exit code 4.
            if (!string.IsNullOrEmpty(waitWindow))
            {
                if (!WaitForWindow(waitWindow)) return 4;
                Thread.Sleep(400); // the dialog puts the focus into its password field
                if (!WaitForWindow(waitWindow)) return 4;
            }
            // Wait until Ctrl/Shift/Alt/Win of the shortcut are released – otherwise characters would become shortcuts.
            for (var i = 0; i < 300; i++)
            {
                var held = false;
                foreach (var vk in new[] { 0x10, 0x11, 0x12, 0x5B, 0x5C }) if ((GetAsyncKeyState(vk) & 0x8000) != 0) held = true;
                if (!held) break;
                Thread.Sleep(10);
            }
            var ok = true;
            foreach (var c in text)
            {
                if (c == '\r') continue;
                if (c == '\n') ok &= Key(0x0D, 0, 0) & Key(0x0D, 0, KEYUP);
                else if (c == '\t') ok &= Key(0x09, 0, 0) & Key(0x09, 0, KEYUP);
                else ok &= Key(0, c, UNICODE) & Key(0, c, UNICODE | KEYUP);
                Thread.Sleep(6);
            }
            // SendInput refused (e.g. the focused window runs elevated – UIPI): exit code 3.
            return ok ? 0 : 3;
        }
    }
}
