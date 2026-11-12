// Windows Hello for the app's window lock (#512): Keevault-Update.exe --hello-status | --hello-verify <hwnd>.
//
//   --hello-status            prints {"availability":N} – UserConsentVerifier.CheckAvailabilityAsync (0 = available);
//                             shows nothing. Also checks the interface ids this file uses ("iids":true).
//   --hello-verify <hwnd>     the message on stdin (UTF-8, no command line); asks Windows Hello (face, fingerprint or the
//                             Windows Hello PIN) over the app window and prints {"result":N} –
//                             UserConsentVerificationResult (0 = verified).
//
// The app reads the result itself (desktop/main/window-hello.js); the window never reports it. No WinRT projection in
// .NET Framework 4.8: the calls go through the activation factory and the interfaces' tables directly.

using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Keevault.Setup
{
    internal static class Hello
    {
        private const string ClassName = "Windows.Security.Credentials.UI.UserConsentVerifier";
        private static Guid IidStatics = new Guid("AF4F3F91-564C-4DDC-B8B5-973447627C65"); // IUserConsentVerifierStatics
        private static Guid IidInterop = new Guid("39E050C3-4E74-441A-8DC0-B81104DF949C"); // IUserConsentVerifierInterop
        private static Guid IidAsyncInfo = new Guid("00000036-0000-0000-C000-000000000046"); // IAsyncInfo
        // IAsyncOperation<UserConsentVerificationResult> and IAsyncOperation<UserConsentVerifierAvailability>: the
        // parameterized ids of WinRT (test/window-hello-512.test.js computes them again).
        private static Guid IidOpResult = new Guid("fd596ffd-2318-558f-9dbe-d21df43764a5");
        private static Guid IidOpAvailability = new Guid("ddd384f3-d818-5d83-ab4b-32119c28587c");

        [DllImport("combase.dll")]
        private static extern int RoInitialize(int initType);

        [DllImport("combase.dll")]
        private static extern int RoGetActivationFactory(IntPtr activatableClassId, ref Guid iid, out IntPtr factory);

        [DllImport("combase.dll", CharSet = CharSet.Unicode)]
        private static extern int WindowsCreateString(string source, int length, out IntPtr hstring);

        [DllImport("combase.dll")]
        private static extern int WindowsDeleteString(IntPtr hstring);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int CheckAvailabilityFn(IntPtr self, out IntPtr operation);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int RequestForWindowFn(IntPtr self, IntPtr hwnd, IntPtr message, ref Guid riid, out IntPtr operation);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int GetIntFn(IntPtr self, out int value);

        public static int Status()
        {
            return OnMta(() =>
            {
                var factory = Factory(IidStatics);
                try
                {
                    Check(Slot<CheckAvailabilityFn>(factory, 6)(factory, out var op));
                    try
                    {
                        // The parameterized id must match the operation Windows hands out (same rule as for the result).
                        var iids = Supports(op, IidOpAvailability);
                        var availability = Await(op, TimeSpan.FromSeconds(10));
                        return "{\"availability\":" + availability + ",\"iids\":" + (iids ? "true" : "false") + "}";
                    }
                    finally { Marshal.Release(op); }
                }
                finally { Marshal.Release(factory); }
            });
        }

        public static int Verify(string hwndText)
        {
            long hwnd;
            if (!long.TryParse(hwndText ?? "", out hwnd) || hwnd == 0) return Fail("no window");
            string message;
            using (var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false))) message = stdin.ReadToEnd();
            if (message.Length == 0 || message.Length > 300) message = "Keevault";
            return OnMta(() =>
            {
                var factory = Factory(IidInterop);
                IntPtr text = IntPtr.Zero;
                try
                {
                    Check(WindowsCreateString(message, message.Length, out text));
                    var riid = IidOpResult;
                    Check(Slot<RequestForWindowFn>(factory, 6)(factory, new IntPtr(hwnd), text, ref riid, out var op));
                    try { return "{\"result\":" + Await(op, TimeSpan.FromMinutes(3)) + "}"; }
                    finally { Marshal.Release(op); }
                }
                finally
                {
                    if (text != IntPtr.Zero) WindowsDeleteString(text);
                    Marshal.Release(factory);
                }
            });
        }

        /** Runs the WinRT calls on a thread of their own (multithreaded apartment); prints the JSON line. */
        private static int OnMta(Func<string> work)
        {
            string json = null;
            Exception error = null;
            var thread = new Thread(() =>
            {
                RoInitialize(1); // RO_INIT_MULTITHREADED; already initialized is fine
                try { json = work(); }
                catch (Exception e) { error = e; }
            });
            thread.SetApartmentState(ApartmentState.MTA);
            thread.Start();
            thread.Join();
            if (error != null) return Fail(error.Message);
            Console.Out.Write(json);
            Console.Out.Flush();
            return 0;
        }

        private static int Fail(string reason)
        {
            Console.Out.Write("{\"error\":\"" + (reason ?? "").Replace("\\", "\\\\").Replace("\"", "'") + "\"}");
            Console.Out.Flush();
            return 1;
        }

        private static IntPtr Factory(Guid iid)
        {
            Check(WindowsCreateString(ClassName, ClassName.Length, out var name));
            try
            {
                Check(RoGetActivationFactory(name, ref iid, out var factory));
                return factory;
            }
            finally { WindowsDeleteString(name); }
        }

        /** Waits for an IAsyncOperation<enum> and returns its result (status 1 = completed). */
        private static int Await(IntPtr operation, TimeSpan limit)
        {
            var iid = IidAsyncInfo;
            Check(Marshal.QueryInterface(operation, ref iid, out var info));
            try
            {
                var until = DateTime.UtcNow + limit;
                int status;
                while (true)
                {
                    Check(Slot<GetIntFn>(info, 7)(info, out status)); // IAsyncInfo.get_Status
                    if (status != 0) break;
                    if (DateTime.UtcNow > until) throw new TimeoutException("Windows Hello did not answer");
                    Thread.Sleep(50);
                }
                if (status != 1) throw new InvalidOperationException("Windows Hello status " + status);
                Check(Slot<GetIntFn>(operation, 8)(operation, out var result)); // IAsyncOperation<T>.GetResults
                return result;
            }
            finally { Marshal.Release(info); }
        }

        private static bool Supports(IntPtr unknown, Guid iid)
        {
            if (Marshal.QueryInterface(unknown, ref iid, out var p) != 0) return false;
            Marshal.Release(p);
            return true;
        }

        private static T Slot<T>(IntPtr self, int index) where T : class
        {
            var table = Marshal.ReadIntPtr(self);
            return Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(table, index * IntPtr.Size), typeof(T)) as T;
        }

        private static void Check(int hr)
        {
            if (hr < 0) throw new COMException("HRESULT 0x" + hr.ToString("X8"), hr);
        }
    }
}
