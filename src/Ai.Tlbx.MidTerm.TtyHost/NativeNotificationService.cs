using Ai.Tlbx.MidTerm.Common.Protocol;

#if WINDOWS_NATIVE_NOTIFICATIONS
using Microsoft.Win32;
using Windows.Data.Xml.Dom;
using Windows.UI.Notifications;
#endif

namespace Ai.Tlbx.MidTerm.TtyHost;

internal static class NativeNotificationService
{
    private const string AppUserModelId = "ai.tlbx.tlbx";
    private const int MaxTitleLength = 80;
    private const int MaxBodyLength = 512;
    private const int MinimumUrgentWindowsBuild = 22546;

    public static TtyHostNotificationResponse Show(TtyHostNotificationRequest request)
    {
#if WINDOWS_NATIVE_NOTIFICATIONS
        if (!OperatingSystem.IsWindowsVersionAtLeast(10, 0, MinimumUrgentWindowsBuild))
        {
            return Unsupported("Important notifications require Windows 11 build 22546 or later.");
        }

        var title = Normalize(request.Title, MaxTitleLength, "tlbx");
        var body = Normalize(request.Body, MaxBodyLength, string.Empty);
        if (body.Length == 0)
        {
            return new TtyHostNotificationResponse
            {
                Supported = true,
                Error = "Notification body is empty."
            };
        }

        try
        {
            RegisterApplicationIdentity();
            var scenario = request.Urgent ? " scenario=\"urgent\"" : string.Empty;
            var xml = new XmlDocument();
            xml.LoadXml($"<toast{scenario}><visual><binding template=\"ToastGeneric\"><text>{EscapeXml(title)}</text><text>{EscapeXml(body)}</text></binding></visual></toast>");
            var notification = new ToastNotification(xml)
            {
                ExpirationTime = DateTimeOffset.Now.AddMinutes(10),
                Group = "terminal",
                Tag = NormalizeTag(request.Tag)
            };
            ToastNotificationManager.CreateToastNotifier(AppUserModelId).Show(notification);
            return new TtyHostNotificationResponse { Success = true, Supported = true };
        }
        catch (Exception ex)
        {
            return new TtyHostNotificationResponse
            {
                Supported = true,
                Error = ex.Message
            };
        }
#else
        return Unsupported("Native important notifications are not available on this platform.");
#endif
    }

    private static TtyHostNotificationResponse Unsupported(string error)
    {
        return new TtyHostNotificationResponse { Error = error };
    }

    private static string Normalize(string? value, int maxLength, string fallback)
    {
        var normalized = string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
        return normalized.Length <= maxLength ? normalized : normalized[..maxLength];
    }

    private static string NormalizeTag(string? value)
    {
        var normalized = Normalize(value, 16, "terminal");
        return string.Concat(normalized.Select(character => char.IsAsciiLetterOrDigit(character) ? character : '-'));
    }

#if WINDOWS_NATIVE_NOTIFICATIONS
    private static void RegisterApplicationIdentity()
    {
        using var key = Registry.CurrentUser.CreateSubKey($@"Software\Classes\AppUserModelId\{AppUserModelId}");
        key?.SetValue("DisplayName", "tlbx", RegistryValueKind.String);
        var iconPath = Path.Combine(AppContext.BaseDirectory, "favicon.ico");
        if (File.Exists(iconPath))
        {
            key?.SetValue("IconUri", iconPath, RegistryValueKind.String);
        }
    }

    private static string EscapeXml(string value)
    {
        return value
            .Replace("&", "&amp;", StringComparison.Ordinal)
            .Replace("<", "&lt;", StringComparison.Ordinal)
            .Replace(">", "&gt;", StringComparison.Ordinal)
            .Replace("\"", "&quot;", StringComparison.Ordinal)
            .Replace("'", "&apos;", StringComparison.Ordinal);
    }
#endif
}
