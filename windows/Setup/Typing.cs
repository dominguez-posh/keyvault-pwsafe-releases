// Keevault-Update.exe --type: types the UTF-8 text from stdin into the focused window via SendInput – auto-type like
// KeePass. The app uses it instead of its PowerShell helper, which App Control (Constrained Language Mode: no Add-Type)
// or endpoint protection may block.
// Normal windows get every character as a Unicode packet (layout independent). Remote desktop and VM windows pass on
// scan codes only – Unicode packets never reach e.g. the sign-in screen of the remote computer (#332): there every
// character is pressed as a real key (virtual key + scan code of the window's keyboard layout, with Shift/Ctrl/Alt).
// On stdout: one line "window <program>/<class> remote|unicode" for the app's diagnostics log (never the text).

using System;
using System.Collections.Generic;
using System.Diagnostics;
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
        [DllImport("user32.dll")] private static extern short GetKeyState(int key);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
        [DllImport("user32.dll")] private static extern IntPtr GetKeyboardLayout(uint thread);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern short VkKeyScanEx(char ch, IntPtr layout);
        [DllImport("user32.dll")] private static extern uint MapVirtualKeyEx(uint code, uint mapType, IntPtr layout);

        /// <summary>
        /// Waits up to 30 s until the window in front matches one of "A|B|class:C": a title part, or with "class:" a
        /// window class (Windows' credential dialog has no telling title of its own – #316). False if it never comes.
        /// </summary>
        private static bool WaitForWindow(string wanted)
        {
            var parts = wanted.Split('|');
            for (var i = 0; i < 300; i++)
            {
                var hwnd = GetForegroundWindow();
                var title = new StringBuilder(256);
                var cls = new StringBuilder(256);
                GetWindowText(hwnd, title, title.Capacity);
                GetClassName(hwnd, cls, cls.Capacity);
                foreach (var w in parts)
                {
                    if (w.StartsWith("class:", StringComparison.Ordinal))
                    {
                        if (cls.ToString().IndexOf(w.Substring(6), StringComparison.OrdinalIgnoreCase) >= 0) return true;
                    }
                    else if (w.Length > 0 && title.ToString().IndexOf(w, StringComparison.OrdinalIgnoreCase) >= 0) return true;
                }
                Thread.Sleep(100);
            }
            return false;
        }

        // Remote desktop and VM viewers (program names without .exe, window classes): they forward scan codes.
        private static readonly string[] RemotePrograms =
        {
            "mstsc", "msrdc", "vmconnect", "vmware", "vmplayer", "VirtualBoxVM", "RDCMan", "mRemoteNG", "RoyalTS",
            "RemoteDesktopManager", "vncviewer", "tvnviewer", "wfica32", "CDViewer",
        };
        private static readonly string[] RemoteClasses = { "TscShellContainerClass" };

        /// <summary>Program and class of the window in front, and whether it is a remote desktop or VM window.</summary>
        internal static bool IsRemoteWindow(IntPtr hwnd, out string program, out string cls, out uint thread)
        {
            var sb = new StringBuilder(256);
            GetClassName(hwnd, sb, sb.Capacity);
            cls = sb.ToString();
            thread = GetWindowThreadProcessId(hwnd, out var pid);
            program = "";
            try { program = Process.GetProcessById((int)pid).ProcessName; } catch { /* elevated or gone: class only */ }
            foreach (var p in RemotePrograms) if (string.Equals(p, program, StringComparison.OrdinalIgnoreCase)) return true;
            foreach (var c in RemoteClasses) if (string.Equals(c, cls, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        private const uint KEYUP = 2, UNICODE = 4;
        private const ushort VK_SHIFT = 0xA0, VK_CONTROL = 0xA2, VK_MENU = 0xA4, VK_CAPITAL = 0x14, VK_SPACE = 0x20;

        private static bool Key(ushort vk, ushort scan, uint flags)
        {
            var input = new INPUT[1];
            input[0].type = 1;
            input[0].u.ki.wVk = vk;
            input[0].u.ki.wScan = scan;
            input[0].u.ki.dwFlags = flags;
            return SendInput(1, input, Marshal.SizeOf(typeof(INPUT))) == 1;
        }

        private static bool Press(ushort vk, IntPtr layout)
        {
            var scan = (ushort)MapVirtualKeyEx(vk, 0, layout); // MAPVK_VK_TO_VSC
            return Key(vk, scan, 0) & Key(vk, scan, KEYUP);
        }

        internal struct Stroke { public ushort Vk, Scan; public uint Flags; }

        private static void Add(List<Stroke> plan, ushort vk, IntPtr layout, uint flags) =>
            plan.Add(new Stroke { Vk = vk, Scan = (ushort)MapVirtualKeyEx(vk, 0, layout), Flags = flags }); // MAPVK_VK_TO_VSC

        /// <summary>
        /// One character as real keys of the layout (Shift/Ctrl/Alt around it); a dead key (^, ´, `) is followed by a
        /// space so that it stands alone. Null if the layout has no key for it (then it goes as Unicode).
        /// </summary>
        internal static List<Stroke> PlanChar(char c, IntPtr layout)
        {
            var r = VkKeyScanEx(c, layout);
            if (r == -1) return null;
            var vk = (ushort)(r & 0xFF);
            var mods = (r >> 8) & 0xFF;
            if (vk == 0xFF || (mods & ~7) != 0) return null; // Hankaku and others: Unicode
            var down = new List<ushort>();
            if ((mods & 2) != 0) down.Add(VK_CONTROL);
            if ((mods & 4) != 0) down.Add(VK_MENU);
            if ((mods & 1) != 0) down.Add(VK_SHIFT);
            var plan = new List<Stroke>();
            foreach (var m in down) Add(plan, m, layout, 0);
            Add(plan, vk, layout, 0);
            Add(plan, vk, layout, KEYUP);
            for (var i = down.Count - 1; i >= 0; i--) Add(plan, down[i], layout, KEYUP);
            if ((MapVirtualKeyEx(vk, 2, layout) & 0x80000000) != 0) // MAPVK_VK_TO_CHAR: high bit = dead key
            {
                Add(plan, VK_SPACE, layout, 0);
                Add(plan, VK_SPACE, layout, KEYUP);
            }
            return plan;
        }

        private static bool PressChar(char c, IntPtr layout, out bool ok)
        {
            ok = true;
            var plan = PlanChar(c, layout);
            if (plan == null) return false;
            foreach (var s in plan) ok &= Key(s.Vk, s.Scan, s.Flags);
            return true;
        }

        /// <summary>
        /// --type-selftest: checks the key plan for a fixed sample in this process's keyboard layout (types nothing,
        /// reads nothing): letters without/with Shift, every key released, scan codes set, unknown characters as Unicode.
        /// </summary>
        public static int SelfTest()
        {
            var layout = GetKeyboardLayout(0);
            var errors = new List<string>();
            var a = PlanChar('a', layout);
            if (a == null || a.Count != 2 || a[0].Vk != 0x41 || a[0].Scan == 0 || a[1].Flags != KEYUP) errors.Add("a");
            var upper = PlanChar('A', layout);
            if (upper == null || upper.Count != 4 || upper[0].Vk != VK_SHIFT || upper[1].Vk != 0x41 || upper[3].Vk != VK_SHIFT || upper[3].Flags != KEYUP) errors.Add("A");
            if (PlanChar('漢', layout) != null) errors.Add("unicode");
            foreach (var c in "aZ1!@#$%^&*()_+-=[]{};:'\",.<>/?\\|`~äöüßéèêñ€")
            {
                var plan = PlanChar(c, layout);
                if (plan == null) continue;
                var held = new HashSet<ushort>();
                foreach (var s in plan)
                {
                    if (s.Scan == 0) errors.Add($"scan {(int)c:X4}");
                    if (s.Flags == 0) held.Add(s.Vk); else held.Remove(s.Vk);
                }
                if (held.Count > 0) errors.Add($"held {(int)c:X4}");
            }
            Console.Out.WriteLine(errors.Count == 0 ? $"type-selftest ok (layout {layout.ToInt64() & 0xFFFF:X4})" : "type-selftest FAIL " + string.Join(", ", errors));
            return errors.Count == 0 ? 0 : 1;
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
            var remote = IsRemoteWindow(GetForegroundWindow(), out var program, out var cls, out var thread);
            var layout = GetKeyboardLayout(remote ? thread : 0);
            Console.Out.WriteLine($"window {program}/{cls} {(remote ? "remote" : "unicode")}");
            Console.Out.Flush();
            var ok = true;
            // Caps Lock would turn Shift+A into "a": off while typing, on again afterwards.
            var caps = remote && (GetKeyState(VK_CAPITAL) & 1) != 0;
            if (caps) ok &= Press(VK_CAPITAL, layout);
            try
            {
                foreach (var c in text)
                {
                    if (c == '\r') continue;
                    if (c == '\n') ok &= Key(0x0D, 0x1C, 0) & Key(0x0D, 0x1C, KEYUP);
                    else if (c == '\t') ok &= Key(0x09, 0x0F, 0) & Key(0x09, 0x0F, KEYUP);
                    else if (!remote || !PressChar(c, layout, out var pressed)) ok &= Key(0, c, UNICODE) & Key(0, c, UNICODE | KEYUP);
                    else ok &= pressed;
                    // The remote side needs a little more time per key (its sign-in screen drops keys otherwise).
                    Thread.Sleep(remote ? 20 : 6);
                }
            }
            finally
            {
                if (caps) Press(VK_CAPITAL, layout);
            }
            // SendInput refused (e.g. the focused window runs elevated – UIPI): exit code 3.
            return ok ? 0 : 3;
        }
    }
}
