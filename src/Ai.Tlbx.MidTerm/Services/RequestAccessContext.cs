using Ai.Tlbx.MidTerm.Models.Share;

namespace Ai.Tlbx.MidTerm.Services;

public sealed class ShareAccessContext
{
    public string GrantId { get; init; } = "";
    public string SessionId { get; init; } = "";
    public ShareAccessMode Mode { get; init; }
    public DateTime ExpiresAtUtc { get; init; }

    public bool IsExpired(DateTime utcNow) => utcNow >= ExpiresAtUtc;
}

public static class RequestAccessContext
{
    private const string FullUserItemKey = "__midterm_full_user";
    private const string ShareAccessItemKey = "__midterm_share_access";

    public static void SetFullUser(HttpContext context, bool value)
    {
        context.Items[FullUserItemKey] = value;
    }

    public static bool HasFullUserAccess(HttpContext context)
    {
        return context.Items.TryGetValue(FullUserItemKey, out var value)
            && value is true;
    }

    public static void SetShareAccess(HttpContext context, ShareAccessContext? access)
    {
        if (access is null)
        {
            context.Items.Remove(ShareAccessItemKey);
            return;
        }

        context.Items[ShareAccessItemKey] = access;
    }

    public static ShareAccessContext? GetShareAccess(HttpContext context)
    {
        return context.Items.TryGetValue(ShareAccessItemKey, out var value)
            ? value as ShareAccessContext
            : null;
    }
}
