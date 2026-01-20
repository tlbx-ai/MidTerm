using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;
using Ai.Tlbx.MidTerm.Common.Logging;

namespace Ai.Tlbx.MidTerm.Services;

[SupportedOSPlatform("macos")]
public sealed class MacOsSecretStorage : ISecretStorage
{
    private const string ServiceName = "ai.tlbx.midterm";
    private const int ErrSecSuccess = 0;
    private const int ErrSecItemNotFound = -25300;
    private const int ErrSecDuplicateItem = -25299;

    // macOS uses Keychain which is queried on-demand, no "load" phase
    // Individual operation failures are logged in each method
    public bool LoadFailed => false;
    public string? LoadError => null;

    public string? GetSecret(string key)
    {
        var status = SecKeychainFindGenericPassword(
            IntPtr.Zero,
            (uint)ServiceName.Length,
            ServiceName,
            (uint)key.Length,
            key,
            out var passwordLength,
            out var passwordData,
            out var itemRef);

        if (status == ErrSecItemNotFound)
        {
            return null;
        }

        if (status != ErrSecSuccess)
        {
            Log.Error(() => $"Keychain read failed for '{key}' with status {status}");
            return null;
        }

        try
        {
            var password = new byte[passwordLength];
            Marshal.Copy(passwordData, password, 0, (int)passwordLength);
            return Encoding.UTF8.GetString(password);
        }
        finally
        {
            SecKeychainItemFreeContent(IntPtr.Zero, passwordData);
            if (itemRef != IntPtr.Zero)
            {
                CFRelease(itemRef);
            }
        }
    }

    public void SetSecret(string key, string value)
    {
        var passwordBytes = Encoding.UTF8.GetBytes(value);

        var status = SecKeychainAddGenericPassword(
            IntPtr.Zero,
            (uint)ServiceName.Length,
            ServiceName,
            (uint)key.Length,
            key,
            (uint)passwordBytes.Length,
            passwordBytes,
            out var itemRef);

        if (status == ErrSecDuplicateItem)
        {
            // Item exists, find and update it
            status = SecKeychainFindGenericPassword(
                IntPtr.Zero,
                (uint)ServiceName.Length,
                ServiceName,
                (uint)key.Length,
                key,
                out _,
                out _,
                out itemRef);

            if (status == ErrSecSuccess)
            {
                status = SecKeychainItemModifyContent(itemRef, IntPtr.Zero, (uint)passwordBytes.Length, passwordBytes);
                CFRelease(itemRef);
            }
        }
        else if (status == ErrSecSuccess && itemRef != IntPtr.Zero)
        {
            CFRelease(itemRef);
        }

        if (status != ErrSecSuccess)
        {
            Log.Error(() => $"Keychain write failed for '{key}' with status {status}");
            throw new InvalidOperationException($"Failed to store secret in Keychain: status {status}");
        }
    }

    public void DeleteSecret(string key)
    {
        var status = SecKeychainFindGenericPassword(
            IntPtr.Zero,
            (uint)ServiceName.Length,
            ServiceName,
            (uint)key.Length,
            key,
            out _,
            out _,
            out var itemRef);

        if (status == ErrSecItemNotFound)
        {
            return;
        }

        if (status != ErrSecSuccess)
        {
            Log.Error(() => $"Keychain find failed for delete '{key}' with status {status}");
            return;
        }

        status = SecKeychainItemDelete(itemRef);
        CFRelease(itemRef);

        if (status != ErrSecSuccess)
        {
            Log.Error(() => $"Keychain delete failed for '{key}' with status {status}");
        }
    }

    [DllImport("/System/Library/Frameworks/Security.framework/Security")]
    private static extern int SecKeychainAddGenericPassword(
        IntPtr keychain,
        uint serviceNameLength,
        [MarshalAs(UnmanagedType.LPStr)] string serviceName,
        uint accountNameLength,
        [MarshalAs(UnmanagedType.LPStr)] string accountName,
        uint passwordLength,
        byte[] passwordData,
        out IntPtr itemRef);

    [DllImport("/System/Library/Frameworks/Security.framework/Security")]
    private static extern int SecKeychainFindGenericPassword(
        IntPtr keychainOrArray,
        uint serviceNameLength,
        [MarshalAs(UnmanagedType.LPStr)] string serviceName,
        uint accountNameLength,
        [MarshalAs(UnmanagedType.LPStr)] string accountName,
        out uint passwordLength,
        out IntPtr passwordData,
        out IntPtr itemRef);

    [DllImport("/System/Library/Frameworks/Security.framework/Security")]
    private static extern int SecKeychainItemModifyContent(
        IntPtr itemRef,
        IntPtr attrList,
        uint length,
        byte[] data);

    [DllImport("/System/Library/Frameworks/Security.framework/Security")]
    private static extern int SecKeychainItemDelete(IntPtr itemRef);

    [DllImport("/System/Library/Frameworks/Security.framework/Security")]
    private static extern int SecKeychainItemFreeContent(IntPtr attrList, IntPtr data);

    [DllImport("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")]
    private static extern void CFRelease(IntPtr cf);
}
