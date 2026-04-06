namespace Ai.Tlbx.MidTerm.Services.Browser;

public sealed class BrowserPreviewOwnerService
{
    private readonly Lock _lock = new();
    private readonly Dictionary<PreviewKey, string> _owners = new();

    public string? GetOwnerBrowserId(string? sessionId, string? previewName)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return null;
        }

        var key = PreviewKey.Create(sessionId, previewName);
        lock (_lock)
        {
            return _owners.GetValueOrDefault(key);
        }
    }

    public string? ResolveOwnerBrowserId(
        string? sessionId,
        string? previewName,
        IEnumerable<string?> connectedBrowserIds)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return null;
        }

        var key = PreviewKey.Create(sessionId, previewName);
        var distinctCandidates = connectedBrowserIds
            .Where(id => !string.IsNullOrWhiteSpace(id))
            .Distinct(StringComparer.Ordinal)
            .Cast<string>()
            .ToArray();

        lock (_lock)
        {
            if (_owners.TryGetValue(key, out var currentOwner))
            {
                if (distinctCandidates.Contains(currentOwner, StringComparer.Ordinal))
                {
                    return currentOwner;
                }

                if (distinctCandidates.Length == 1)
                {
                    _owners[key] = distinctCandidates[0];
                    return distinctCandidates[0];
                }

                return currentOwner;
            }

            if (distinctCandidates.Length == 1)
            {
                _owners[key] = distinctCandidates[0];
                return distinctCandidates[0];
            }

            return null;
        }
    }

    public void ClaimIfMissing(string? sessionId, string? previewName, string? browserId)
    {
        if (string.IsNullOrWhiteSpace(sessionId) || string.IsNullOrWhiteSpace(browserId))
        {
            return;
        }

        var key = PreviewKey.Create(sessionId, previewName);
        lock (_lock)
        {
            _owners.TryAdd(key, browserId);
        }
    }

    public void Claim(string? sessionId, string? previewName, string? browserId)
    {
        if (string.IsNullOrWhiteSpace(sessionId) || string.IsNullOrWhiteSpace(browserId))
        {
            return;
        }

        var key = PreviewKey.Create(sessionId, previewName);
        lock (_lock)
        {
            _owners[key] = browserId;
        }
    }

    private readonly record struct PreviewKey(string SessionId, string PreviewName)
    {
        public static PreviewKey Create(string sessionId, string? previewName)
        {
            return new PreviewKey(
                sessionId,
                string.IsNullOrWhiteSpace(previewName)
                    ? WebPreview.WebPreviewService.DefaultPreviewName
                    : previewName);
        }
    }
}
