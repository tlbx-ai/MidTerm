namespace Ai.Tlbx.MidTerm.Services.Browser;

internal static class BrowserIdentity
{
    public static string? Build(string? clientId, string? tabId)
    {
        if (string.IsNullOrWhiteSpace(clientId))
        {
            return null;
        }

        return string.IsNullOrWhiteSpace(tabId)
            ? clientId
            : $"{clientId}:{tabId}";
    }

    public static bool AreSameBrowser(string? left, string? right)
    {
        if (string.IsNullOrWhiteSpace(left) || string.IsNullOrWhiteSpace(right))
        {
            return false;
        }

        return string.Equals(left, right, StringComparison.Ordinal)
            || string.Equals(GetClientPart(left), GetClientPart(right), StringComparison.Ordinal);
    }

    public static string GetClientPart(string browserId)
    {
        var separatorIndex = browserId.IndexOf(':', StringComparison.Ordinal);
        return separatorIndex < 0 ? browserId : browserId[..separatorIndex];
    }
}
