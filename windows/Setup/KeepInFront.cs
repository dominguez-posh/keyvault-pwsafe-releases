// The visible update window stays in front (#335): Windows often refuses the foreground to a process whose starter
// (the old app) is just quitting, and the old app's window could cover it. The window takes the foreground actively
// (attached to the input of the window in front) and is put back on top every second without taking the focus –
// typing in another program is not interrupted.

using System;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Threading;

namespace Keevault.Setup
{
    internal static class KeepInFront
    {
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);
        [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint attach, uint to, bool on);
        [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);

        private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        private const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOACTIVATE = 0x10, SWP_SHOWWINDOW = 0x40;

        /// <summary>Takes the foreground for the window (once – e.g. when it appears and once the old app is gone).</summary>
        public static bool Bring(Window window)
        {
            var hwnd = new WindowInteropHelper(window).Handle;
            if (hwnd == IntPtr.Zero) return false;
            var front = GetForegroundWindow();
            if (front == hwnd) return true;
            var frontThread = front == IntPtr.Zero ? 0 : GetWindowThreadProcessId(front, IntPtr.Zero);
            var own = GetCurrentThreadId();
            var attached = frontThread != 0 && frontThread != own && AttachThreadInput(own, frontThread, true);
            try
            {
                BringWindowToTop(hwnd);
                SetForegroundWindow(hwnd);
                window.Activate();
            }
            finally
            {
                if (attached) AttachThreadInput(own, frontThread, false);
            }
            KeepOnTop(hwnd);
            return GetForegroundWindow() == hwnd;
        }

        private static void KeepOnTop(IntPtr hwnd) =>
            SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE | SWP_SHOWWINDOW);

        /// <summary>Puts the window back on top every second (without the focus) until it closes.</summary>
        public static void Hold(Window window)
        {
            var timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
            timer.Tick += (s, e) =>
            {
                var hwnd = new WindowInteropHelper(window).Handle;
                if (hwnd != IntPtr.Zero && window.IsVisible) KeepOnTop(hwnd);
            };
            window.Closed += (s, e) => timer.Stop();
            timer.Start();
        }
    }
}
