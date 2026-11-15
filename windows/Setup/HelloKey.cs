// #537: Windows Hello as key material for the app's master password – KeyCredentialManager, a TPM-bound RSA key of the
// Windows Hello container. The app derives a key from the signature (desktop/unlock-keys.js); Hello is no yes/no here.
//
//   --hello-key-status                {"supported":bool,"remote":bool} – shows nothing.
//   --hello-key-create <name> <hwnd>  challenge (base64) on stdin; creates the key (Windows Hello asks), signs the challenge
//                                     and reads the attestation: {"status":N,"publicKey":b64,"signature":b64,
//                                     "attestation":{"status":N,"chain":b64,"blob":b64}}.
//   --hello-key-sign <name> <hwnd>    challenge (base64) on stdin; {"status":N,"signature":b64} (Windows Hello asks).
//   --hello-key-delete <name>         {"status":N}.
//
// status: KeyCredentialStatus (0 success, 2 not found, 3 cancelled, …). The app checks everything itself (signature as
// RSASSA-PKCS1-v1_5/SHA-256 with the public key, attestation); nothing here decides. Interface ids and method order come
// from Windows.Security.winmd (test/hello-key-537.test.js recomputes the parameterized ones). No WinRT projection in
// .NET Framework 4.8: the calls go through the activation factory and the interfaces' tables directly, as in Hello.cs.

using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Keevault.Setup
{
    internal static class HelloKey
    {
        private const string ManagerClass = "Windows.Security.Credentials.KeyCredentialManager";
        private const string BufferClass = "Windows.Security.Cryptography.CryptographicBuffer";
        private static Guid IidManagerStatics = new Guid("6aac468b-0ef1-4ce0-8290-4106da6a63b5"); // IKeyCredentialManagerStatics
        private static Guid IidBufferStatics = new Guid("320b7e22-3cb0-4cdf-8663-1d28910065eb"); // ICryptographicBufferStatics
        private static Guid IidRetrieval = new Guid("58cd7703-8d87-4249-9b58-f6598cc9644e"); // IKeyCredentialRetrievalResult
        private static Guid IidCredential = new Guid("9585ef8d-457b-4847-b11a-fa960bbdb138"); // IKeyCredential
        private static Guid IidOperation = new Guid("f53786c1-5261-4cdd-976d-cc909ac71620"); // IKeyCredentialOperationResult
        private static Guid IidAttestation = new Guid("78aab3a1-a3c1-4103-b6cc-472c44171cbb"); // IKeyCredentialAttestationResult
        private static Guid IidAsyncInfo = new Guid("00000036-0000-0000-C000-000000000046"); // IAsyncInfo
        // IAsyncOperation<bool>, <KeyCredentialRetrievalResult>, <KeyCredentialOperationResult>, <KeyCredentialAttestationResult>
        private static Guid IidOpBool = new Guid("cdb5efb3-5788-509d-9be1-71ccb8a3362a");
        private static Guid IidOpRetrieval = new Guid("89d0ad1e-bd4c-55b4-810e-bddd4cec7a2a");
        private static Guid IidOpOperation = new Guid("6576e5b3-9535-50d6-98f6-c67d6aaca2c5");
        private static Guid IidOpAttestation = new Guid("b83d29e9-f4e4-5aa4-92d5-b262cb40c622");

        [DllImport("combase.dll")] private static extern int RoInitialize(int initType);
        [DllImport("combase.dll")] private static extern int RoGetActivationFactory(IntPtr activatableClassId, ref Guid iid, out IntPtr factory);
        [DllImport("combase.dll", CharSet = CharSet.Unicode)] private static extern int WindowsCreateString(string source, int length, out IntPtr hstring);
        [DllImport("combase.dll")] private static extern int WindowsDeleteString(IntPtr hstring);
        [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr FindWindow(string className, string title);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
        [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint attach, uint attachTo, bool on);

        // Live test 14.11.2026: KeyCredentialManager has no variant with an owner window (unlike UserConsentVerifier in
        // Hello.cs), and its Windows Hello dialog opened behind the Keevault window every time. After each request that
        // asks (create, sign) the dialog is looked for a short while and brought to the front – the security dialog of
        // CredentialUIBroker.exe, found by its window class, never any other window.
        private const string DialogClass = "Credential Dialog Xaml Host";
        private const string DialogProcess = "CredentialUIBroker";
        private static readonly TimeSpan DialogSearch = TimeSpan.FromSeconds(3);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int NoArgOpFn(IntPtr self, out IntPtr op);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int CreateFn(IntPtr self, IntPtr name, int option, out IntPtr op);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int NameOpFn(IntPtr self, IntPtr name, out IntPtr op);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int GetPtrFn(IntPtr self, out IntPtr value);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int GetIntFn(IntPtr self, out int value);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int SignFn(IntPtr self, IntPtr data, out IntPtr op);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int FromBytesFn(IntPtr self, int length, byte[] value, out IntPtr buffer);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int ToBytesFn(IntPtr self, IntPtr buffer, out int length, out IntPtr value);

        private const int SM_REMOTESESSION = 0x1000;
        private const int ReplaceExisting = 0;

        public static int Status()
        {
            return OnMta(() =>
            {
                var manager = Factory(ManagerClass, IidManagerStatics);
                try
                {
                    Check(Slot<NoArgOpFn>(manager, 6)(manager, out var op)); // IsSupportedAsync
                    int supported;
                    try { supported = AwaitInt(op, IidOpBool, TimeSpan.FromSeconds(10)); }
                    finally { Marshal.Release(op); }
                    var remote = GetSystemMetrics(SM_REMOTESESSION) != 0;
                    return "{\"supported\":" + ((supported & 0xFF) != 0 ? "true" : "false") + ",\"remote\":" + (remote ? "true" : "false") + "}";
                }
                finally { Marshal.Release(manager); }
            });
        }

        public static int Create(string name, string hwndText)
        {
            if (!ValidName(name)) return Fail("bad name");
            var challenge = ReadChallenge();
            if (challenge == null) return Fail("no challenge");
            Front(hwndText);
            return OnMta(() =>
            {
                var manager = Factory(ManagerClass, IidManagerStatics);
                IntPtr hname = IntPtr.Zero;
                try
                {
                    Check(WindowsCreateString(name, name.Length, out hname));
                    Check(Slot<CreateFn>(manager, 8)(manager, hname, ReplaceExisting, out var op)); // RequestCreateAsync
                    DialogToFront();
                    var credential = Retrieve(op, out var status);
                    if (credential == IntPtr.Zero) return "{\"status\":" + status + "}";
                    try
                    {
                        Check(Slot<GetPtrFn>(credential, 7)(credential, out var pub)); // RetrievePublicKey (SubjectPublicKeyInfo)
                        var publicKey = Bytes(pub);
                        var signature = Sign(credential, challenge, out var signStatus);
                        if (signature == null) return "{\"status\":" + signStatus + "}";
                        var attestation = Attest(credential);
                        return "{\"status\":0,\"publicKey\":\"" + Convert.ToBase64String(publicKey) + "\",\"signature\":\"" + Convert.ToBase64String(signature)
                            + "\",\"attestation\":" + attestation + "}";
                    }
                    finally { Marshal.Release(credential); }
                }
                finally
                {
                    if (hname != IntPtr.Zero) WindowsDeleteString(hname);
                    Marshal.Release(manager);
                }
            });
        }

        public static int SignWith(string name, string hwndText)
        {
            if (!ValidName(name)) return Fail("bad name");
            var challenge = ReadChallenge();
            if (challenge == null) return Fail("no challenge");
            Front(hwndText);
            return OnMta(() =>
            {
                var credential = Open(name, out var status);
                if (credential == IntPtr.Zero) return "{\"status\":" + status + "}";
                try
                {
                    var signature = Sign(credential, challenge, out var signStatus);
                    return signature == null ? "{\"status\":" + signStatus + "}" : "{\"status\":0,\"signature\":\"" + Convert.ToBase64String(signature) + "\"}";
                }
                finally { Marshal.Release(credential); }
            });
        }

        public static int Delete(string name)
        {
            if (!ValidName(name)) return Fail("bad name");
            return OnMta(() =>
            {
                var manager = Factory(ManagerClass, IidManagerStatics);
                IntPtr hname = IntPtr.Zero;
                try
                {
                    Check(WindowsCreateString(name, name.Length, out hname));
                    Check(Slot<NameOpFn>(manager, 10)(manager, hname, out var action)); // DeleteAsync (IAsyncAction)
                    try { Await(action, TimeSpan.FromSeconds(30)); }
                    finally { Marshal.Release(action); }
                    return "{\"status\":0}";
                }
                finally
                {
                    if (hname != IntPtr.Zero) WindowsDeleteString(hname);
                    Marshal.Release(manager);
                }
            });
        }

        /** Names the app makes: Keevault-<random>; nothing else reaches Windows. */
        private static bool ValidName(string name)
        {
            if (string.IsNullOrEmpty(name) || name.Length > 64 || !name.StartsWith("Keevault-", StringComparison.Ordinal)) return false;
            foreach (var c in name) if (!(char.IsLetterOrDigit(c) || c == '-' || c == '_')) return false;
            return true;
        }

        private static byte[] ReadChallenge()
        {
            string text;
            using (var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false))) text = stdin.ReadToEnd().Trim();
            try
            {
                var bytes = Convert.FromBase64String(text);
                return bytes.Length >= 16 && bytes.Length <= 256 ? bytes : null;
            }
            catch (FormatException) { return null; }
        }

        /** The app window in front, so that the Windows Hello dialog opens over it. */
        private static void Front(string hwndText)
        {
            if (long.TryParse(hwndText ?? "", out var hwnd) && hwnd != 0) SetForegroundWindow(new IntPtr(hwnd));
        }

        /**
         * For DialogSearch, every 75 ms on a background thread: the Windows Hello dialog (window class and process checked)
         * brought to the front; done as soon as it is the foreground window. Nothing found: nothing changes.
         */
        private static void DialogToFront()
        {
            var thread = new Thread(() =>
            {
                var until = DateTime.UtcNow + DialogSearch;
                while (DateTime.UtcNow < until)
                {
                    var dialog = FindWindow(DialogClass, null);
                    if (dialog != IntPtr.Zero && IsWindowVisible(dialog) && IsBroker(dialog))
                    {
                        if (GetForegroundWindow() == dialog) return;
                        Raise(dialog);
                    }
                    Thread.Sleep(75);
                }
            }) { IsBackground = true };
            thread.Start();
        }

        private static bool IsBroker(IntPtr window)
        {
            GetWindowThreadProcessId(window, out var pid);
            if (pid == 0) return false;
            try
            {
                using (var p = Process.GetProcessById((int)pid)) return string.Equals(p.ProcessName, DialogProcess, StringComparison.OrdinalIgnoreCase);
            }
            catch (ArgumentException) { return false; } // gone meanwhile
            catch (InvalidOperationException) { return false; }
        }

        /** SetForegroundWindow; refused by the foreground lock, then once more with this thread's input attached to the foreground's. */
        private static void Raise(IntPtr dialog)
        {
            if (SetForegroundWindow(dialog))
            {
                BringWindowToTop(dialog);
                return;
            }
            var foreground = GetForegroundWindow();
            var target = foreground == IntPtr.Zero ? 0u : GetWindowThreadProcessId(foreground, out _);
            var me = GetCurrentThreadId();
            if (target == 0 || target == me || !AttachThreadInput(me, target, true)) return;
            try
            {
                SetForegroundWindow(dialog);
                BringWindowToTop(dialog);
            }
            finally { AttachThreadInput(me, target, false); }
        }

        private static IntPtr Open(string name, out int status)
        {
            var manager = Factory(ManagerClass, IidManagerStatics);
            IntPtr hname = IntPtr.Zero;
            try
            {
                Check(WindowsCreateString(name, name.Length, out hname));
                Check(Slot<NameOpFn>(manager, 9)(manager, hname, out var op)); // OpenAsync
                return Retrieve(op, out status);
            }
            finally
            {
                if (hname != IntPtr.Zero) WindowsDeleteString(hname);
                Marshal.Release(manager);
            }
        }

        /** IAsyncOperation<KeyCredentialRetrievalResult> → IKeyCredential (or zero with the status). */
        private static IntPtr Retrieve(IntPtr op, out int status)
        {
            try
            {
                var result = AwaitPtr(op, IidOpRetrieval, TimeSpan.FromMinutes(3));
                try
                {
                    var iid = IidRetrieval;
                    Check(Marshal.QueryInterface(result, ref iid, out var r));
                    try
                    {
                        Check(Slot<GetIntFn>(r, 7)(r, out status)); // get_Status
                        if (status != 0) return IntPtr.Zero;
                        Check(Slot<GetPtrFn>(r, 6)(r, out var credential)); // get_Credential
                        var ci = IidCredential;
                        Check(Marshal.QueryInterface(credential, ref ci, out var typed));
                        Marshal.Release(credential);
                        return typed;
                    }
                    finally { Marshal.Release(r); }
                }
                finally { Marshal.Release(result); }
            }
            finally { Marshal.Release(op); }
        }

        private static byte[] Sign(IntPtr credential, byte[] data, out int status)
        {
            var buffer = FromBytes(data);
            try
            {
                Check(Slot<SignFn>(credential, 9)(credential, buffer, out var op)); // RequestSignAsync
                DialogToFront();
                try
                {
                    var result = AwaitPtr(op, IidOpOperation, TimeSpan.FromMinutes(3));
                    try
                    {
                        var iid = IidOperation;
                        Check(Marshal.QueryInterface(result, ref iid, out var r));
                        try
                        {
                            Check(Slot<GetIntFn>(r, 7)(r, out status)); // get_Status
                            if (status != 0) return null;
                            Check(Slot<GetPtrFn>(r, 6)(r, out var signed)); // get_Result (IBuffer)
                            return Bytes(signed);
                        }
                        finally { Marshal.Release(r); }
                    }
                    finally { Marshal.Release(result); }
                }
                finally { Marshal.Release(op); }
            }
            finally { Marshal.Release(buffer); }
        }

        /** {"status":N,"chain":b64,"blob":b64} – the TPM attestation of the key; the app decides what it accepts. */
        private static string Attest(IntPtr credential)
        {
            try
            {
                Check(Slot<NoArgOpFn>(credential, 10)(credential, out var op)); // GetAttestationAsync
                try
                {
                    var result = AwaitPtr(op, IidOpAttestation, TimeSpan.FromMinutes(1));
                    try
                    {
                        var iid = IidAttestation;
                        Check(Marshal.QueryInterface(result, ref iid, out var r));
                        try
                        {
                            Check(Slot<GetIntFn>(r, 8)(r, out var status)); // get_Status
                            if (status != 0) return "{\"status\":" + status + "}";
                            Check(Slot<GetPtrFn>(r, 6)(r, out var chain)); // get_CertificateChainBuffer
                            Check(Slot<GetPtrFn>(r, 7)(r, out var blob)); // get_AttestationBuffer
                            return "{\"status\":0,\"chain\":\"" + Convert.ToBase64String(Bytes(chain)) + "\",\"blob\":\"" + Convert.ToBase64String(Bytes(blob)) + "\"}";
                        }
                        finally { Marshal.Release(r); }
                    }
                    finally { Marshal.Release(result); }
                }
                finally { Marshal.Release(op); }
            }
            catch (Exception) { return "{\"status\":1}"; }
        }

        private static IntPtr FromBytes(byte[] data)
        {
            var statics = Factory(BufferClass, IidBufferStatics);
            try
            {
                Check(Slot<FromBytesFn>(statics, 9)(statics, data.Length, data, out var buffer)); // CreateFromByteArray
                return buffer;
            }
            finally { Marshal.Release(statics); }
        }

        /** IBuffer → bytes (CopyToByteArray); releases the buffer. */
        private static byte[] Bytes(IntPtr buffer)
        {
            var statics = Factory(BufferClass, IidBufferStatics);
            try
            {
                Check(Slot<ToBytesFn>(statics, 10)(statics, buffer, out var length, out var value)); // CopyToByteArray
                try
                {
                    var bytes = new byte[length];
                    if (length > 0) Marshal.Copy(value, bytes, 0, length);
                    return bytes;
                }
                finally { if (value != IntPtr.Zero) Marshal.FreeCoTaskMem(value); }
            }
            finally
            {
                Marshal.Release(statics);
                Marshal.Release(buffer);
            }
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

        private static IntPtr Factory(string className, Guid iid)
        {
            Check(WindowsCreateString(className, className.Length, out var name));
            try
            {
                Check(RoGetActivationFactory(name, ref iid, out var factory));
                return factory;
            }
            finally { WindowsDeleteString(name); }
        }

        /** Waits for an IAsyncInfo to complete (status 1); throws on error, cancel or timeout. */
        private static void Await(IntPtr operation, TimeSpan limit)
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
            }
            finally { Marshal.Release(info); }
        }

        private static int AwaitInt(IntPtr operation, Guid iid, TimeSpan limit)
        {
            Check(Marshal.QueryInterface(operation, ref iid, out var typed));
            try
            {
                Await(typed, limit);
                Check(Slot<GetIntFn>(typed, 8)(typed, out var result)); // IAsyncOperation<T>.GetResults
                return result;
            }
            finally { Marshal.Release(typed); }
        }

        private static IntPtr AwaitPtr(IntPtr operation, Guid iid, TimeSpan limit)
        {
            Check(Marshal.QueryInterface(operation, ref iid, out var typed));
            try
            {
                Await(typed, limit);
                Check(Slot<GetPtrFn>(typed, 8)(typed, out var result)); // IAsyncOperation<T>.GetResults
                return result;
            }
            finally { Marshal.Release(typed); }
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
