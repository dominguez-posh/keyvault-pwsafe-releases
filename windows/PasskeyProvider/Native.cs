using System.Runtime.InteropServices;

namespace KvPwSafe.PasskeyProvider;

/// <summary>Win32 / webauthn.dll plugin APIs (see https://github.com/microsoft/webauthn, webauthnplugin.h).</summary>
internal static class Native
{
    public const uint CLSCTX_LOCAL_SERVER = 4;
    public const uint REGCLS_MULTIPLEUSE = 1;
    public const int S_OK = 0;
    public const int E_NOINTERFACE = unchecked((int)0x80004002);
    public const int E_FAIL = unchecked((int)0x80004005);
    public const int CLASS_E_NOAGGREGATION = unchecked((int)0x80040110);
    public const int NTE_BAD_SIGNATURE = unchecked((int)0x80090006);
    public const int NTE_USER_CANCELLED = unchecked((int)0x80090036);
    public const int NTE_NOT_FOUND = unchecked((int)0x80090011);
    public const int HRESULT_NOT_READY = unchecked((int)0x80070015);

    [DllImport("ole32.dll")]
    public static extern int CoRegisterClassObject(ref Guid clsid, [MarshalAs(UnmanagedType.IUnknown)] object obj, uint context, uint flags, out uint cookie);

    [DllImport("ole32.dll")]
    public static extern int CoRevokeClassObject(uint cookie);

    [DllImport("ole32.dll")]
    public static extern IntPtr CoTaskMemAlloc(nuint size);

    [DllImport("user32.dll")]
    public static extern bool AllowSetForegroundWindow(int processId);

    public const int ASFW_ANY = -1;

    [DllImport("webauthn.dll")]
    public static extern int WebAuthNPluginGetAuthenticatorState(ref Guid clsid, out int state);

    [DllImport("webauthn.dll")]
    public static extern int WebAuthNPluginAddAuthenticator(IntPtr options, out IntPtr response);

    [DllImport("webauthn.dll")]
    public static extern void WebAuthNPluginFreeAddAuthenticatorResponse(IntPtr response);

    [DllImport("webauthn.dll")]
    public static extern int WebAuthNPluginRemoveAuthenticator(ref Guid clsid);

    [DllImport("webauthn.dll")]
    public static extern int WebAuthNPluginAuthenticatorAddCredentials(ref Guid clsid, uint count, IntPtr details);

    [DllImport("webauthn.dll")]
    public static extern int WebAuthNPluginAuthenticatorRemoveAllCredentials(ref Guid clsid);

    [DllImport("webauthn.dll")]
    public static extern int WebAuthNPluginGetOperationSigningPublicKey(ref Guid clsid, out uint cb, out IntPtr pb);

    [DllImport("webauthn.dll")]
    public static extern void WebAuthNPluginFreePublicKeyResponse(IntPtr pb);
}

/// <summary>Unmanaged memory that is freed in one go.</summary>
internal sealed class Arena : IDisposable
{
    private readonly List<IntPtr> _blocks = new();

    public unsafe IntPtr Zeroed(int size)
    {
        var p = Marshal.AllocHGlobal(size);
        new Span<byte>((void*)p, size).Clear();
        _blocks.Add(p);
        return p;
    }

    public IntPtr Bytes(byte[] data)
    {
        var p = Zeroed(Math.Max(1, data.Length));
        Marshal.Copy(data, 0, p, data.Length);
        return p;
    }

    public IntPtr String(string? s)
    {
        if (s is null) return IntPtr.Zero;
        var p = Marshal.StringToHGlobalUni(s);
        _blocks.Add(p);
        return p;
    }

    public void Dispose()
    {
        foreach (var p in _blocks) Marshal.FreeHGlobal(p);
        _blocks.Clear();
    }
}
