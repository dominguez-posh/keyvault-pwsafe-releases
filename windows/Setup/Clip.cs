// Keevault-Update.exe --clipboard: puts the UTF-8 text from stdin on the clipboard together with the markers that
// keep it out of the clipboard history (Win+V), the cloud clipboard and clipboard monitors. The app uses it when its
// PowerShell helper is blocked (endpoint protection) – a copied password never lands in the history unmarked.

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
        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern uint RegisterClipboardFormat(string name);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GlobalLock(IntPtr mem);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GlobalUnlock(IntPtr mem);

        private static IntPtr Global(byte[] data)
        {
            var mem = GlobalAlloc(0x0002, (UIntPtr)data.Length); // GMEM_MOVEABLE
            var p = GlobalLock(mem);
            Marshal.Copy(data, 0, p, data.Length);
            GlobalUnlock(mem);
            return mem;
        }

        public static int Run()
        {
            string text;
            using (var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false))) text = stdin.ReadToEnd();
            var open = false;
            for (var i = 0; i < 40 && !(open = OpenClipboard(IntPtr.Zero)); i++) Thread.Sleep(25);
            if (!open) return 2;
            try
            {
                EmptyClipboard();
                SetClipboardData(13, Global(Encoding.Unicode.GetBytes(text + "\0"))); // CF_UNICODETEXT
                var no = BitConverter.GetBytes(0);
                SetClipboardData(RegisterClipboardFormat("ExcludeClipboardContentFromMonitorProcessing"), Global(new byte[] { 0 }));
                SetClipboardData(RegisterClipboardFormat("CanIncludeInClipboardHistory"), Global(no));
                SetClipboardData(RegisterClipboardFormat("CanUploadToCloudClipboard"), Global(no));
                return 0;
            }
            finally
            {
                CloseClipboard();
            }
        }
    }
}
