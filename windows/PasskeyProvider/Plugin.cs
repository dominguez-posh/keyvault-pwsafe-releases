using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json.Nodes;

namespace KvPwSafe.PasskeyProvider;

// pluginauthenticator.idl: interface IPluginAuthenticator : IUnknown
[ComVisible(true)]
[Guid("d26bcf6f-b54c-43ff-9f06-d5bf148625f7")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPluginAuthenticator
{
    [PreserveSig] int MakeCredential(IntPtr request, IntPtr response);
    [PreserveSig] int GetAssertion(IntPtr request, IntPtr response);
    [PreserveSig] int CancelOperation(IntPtr request);
    [PreserveSig] int GetLockStatus(out int lockStatus);
}

[ComImport]
[Guid("00000001-0000-0000-C000-000000000046")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IClassFactory
{
    [PreserveSig] int CreateInstance(IntPtr outer, ref Guid riid, out IntPtr obj);
    [PreserveSig] int LockServer([MarshalAs(UnmanagedType.Bool)] bool fLock);
}

[ComVisible(true)]
public sealed class PluginFactory : IClassFactory
{
    private static readonly Guid IUnknown = new("00000000-0000-0000-C000-000000000046");

    public int CreateInstance(IntPtr outer, ref Guid riid, out IntPtr obj)
    {
        obj = IntPtr.Zero;
        if (outer != IntPtr.Zero) return Native.CLASS_E_NOAGGREGATION;
        var plugin = new Plugin();
        if (riid == typeof(IPluginAuthenticator).GUID) obj = Marshal.GetComInterfaceForObject(plugin, typeof(IPluginAuthenticator));
        else if (riid == IUnknown) obj = Marshal.GetIUnknownForObject(plugin);
        else return Native.E_NOINTERFACE;
        return Native.S_OK;
    }

    public int LockServer(bool fLock) => Native.S_OK;
}

/// <summary>Passkey operations from Windows: verify the platform signature, then let the desktop app decide.</summary>
[ComVisible(true)]
public sealed class Plugin : IPluginAuthenticator
{
    // WEBAUTHN_PLUGIN_OPERATION_REQUEST (x64): HWND 0, GUID 8, DWORD cbSig 24, PBYTE pbSig 32, type 40, DWORD cbReq 44, PBYTE pbReq 48
    private sealed record Request(IntPtr Hwnd, Guid TransactionId, byte[] Signature, byte[] Encoded);

    private static Request Read(IntPtr p)
    {
        var hwnd = Marshal.ReadIntPtr(p, 0);
        var guid = new byte[16];
        Marshal.Copy(p + 8, guid, 0, 16);
        var cbSig = Marshal.ReadInt32(p, 24);
        var sig = new byte[cbSig];
        if (cbSig > 0) Marshal.Copy(Marshal.ReadIntPtr(p, 32), sig, 0, cbSig);
        var cbReq = Marshal.ReadInt32(p, 44);
        var req = new byte[cbReq];
        if (cbReq > 0) Marshal.Copy(Marshal.ReadIntPtr(p, 48), req, 0, cbReq);
        return new Request(hwnd, new Guid(guid), sig, req);
    }

    /// <summary>Requests must be signed by Windows with the key handed out at registration (SHA-256, RSA-PSS or ECDSA).</summary>
    internal static bool VerifyPlatformSignature(byte[] data, byte[] signature)
    {
        var clsid = Provider.Clsid;
        if (Native.WebAuthNPluginGetOperationSigningPublicKey(ref clsid, out var cb, out var pb) != 0 || pb == IntPtr.Zero) return false;
        var blob = new byte[cb];
        Marshal.Copy(pb, blob, 0, (int)cb);
        Native.WebAuthNPluginFreePublicKeyResponse(pb);
        var hash = SHA256.HashData(data);
        try
        {
            using var key = CngKey.Import(blob, CngKeyBlobFormat.GenericPublicBlob);
            if (key.AlgorithmGroup == CngAlgorithmGroup.Rsa)
            {
                using var rsa = new RSACng(key);
                return rsa.VerifyHash(hash, signature, HashAlgorithmName.SHA256, RSASignaturePadding.Pss);
            }
            using var ec = new ECDsaCng(key);
            return ec.VerifyHash(hash, signature);
        }
        catch (CryptographicException e)
        {
            Log.Write($"signature check failed: {e.Message}");
            return false;
        }
    }

    private static int Operation(string cmd, IntPtr request, IntPtr response)
    {
        Program.Activity(+1);
        try
        {
            var r = Read(request);
            if (!VerifyPlatformSignature(r.Encoded, r.Signature))
            {
                Log.Write($"{cmd}: request not signed by Windows, rejected");
                return Native.NTE_BAD_SIGNATURE;
            }
            // Let the desktop app bring its confirmation window to the front.
            Native.AllowSetForegroundWindow(Native.ASFW_ANY);
            var result = Desktop.Request(cmd, new JsonObject
            {
                ["request"] = Convert.ToBase64String(r.Encoded),
                ["transactionId"] = r.TransactionId.ToString(),
                ["hwnd"] = r.Hwnd.ToInt64(),
            }, TimeSpan.FromMinutes(5), start: true).GetAwaiter().GetResult();
            var bytes = Convert.FromBase64String(result?["response"]?.GetValue<string>() ?? throw new InvalidDataException("no response"));
            var buffer = Native.CoTaskMemAlloc((nuint)bytes.Length);
            Marshal.Copy(bytes, 0, buffer, bytes.Length);
            // WEBAUTHN_PLUGIN_OPERATION_RESPONSE: DWORD cbEncodedResponse 0, PBYTE pbEncodedResponse 8
            Marshal.WriteInt32(response, 0, bytes.Length);
            Marshal.WriteIntPtr(response, 8, buffer);
            return Native.S_OK;
        }
        catch (DesktopException e)
        {
            Log.Write($"{cmd}: {e.Name} {e.Message}");
            return e.Name switch
            {
                "Cancelled" => Native.NTE_USER_CANCELLED,
                "NotFound" => Native.NTE_NOT_FOUND,
                "NotRunning" => Native.HRESULT_NOT_READY,
                "Excluded" => unchecked((int)0x8009000F), // NTE_EXISTS
                _ => Native.E_FAIL,
            };
        }
        catch (Exception e)
        {
            Log.Write($"{cmd}: {e}");
            return Native.E_FAIL;
        }
        finally
        {
            Program.Activity(-1);
        }
    }

    public int MakeCredential(IntPtr request, IntPtr response) => Operation("win:makeCredential", request, response);

    public int GetAssertion(IntPtr request, IntPtr response) => Operation("win:getAssertion", request, response);

    public int CancelOperation(IntPtr request)
    {
        try
        {
            // WEBAUTHN_PLUGIN_CANCEL_OPERATION_REQUEST: GUID 0, DWORD cbSig 16, PBYTE pbSig 24
            var guid = new byte[16];
            Marshal.Copy(request, guid, 0, 16);
            Desktop.Request("win:cancel", new JsonObject { ["transactionId"] = new Guid(guid).ToString() }, TimeSpan.FromSeconds(5), start: false)
                .GetAwaiter().GetResult();
        }
        catch (Exception e)
        {
            Log.Write($"cancel: {e.Message}");
        }
        return Native.S_OK;
    }

    public int GetLockStatus(out int lockStatus)
    {
        lockStatus = 0; // PluginLocked
        try
        {
            var r = Desktop.Request("win:status", null, TimeSpan.FromSeconds(3), start: false).GetAwaiter().GetResult();
            if (r?["unlocked"]?.GetValue<bool>() == true) lockStatus = 1; // PluginUnlocked
        }
        catch (Exception e)
        {
            Log.Write($"lock status: {e.Message}");
        }
        return Native.S_OK;
    }
}
