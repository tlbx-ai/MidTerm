using System.Collections.Concurrent;
using System.Diagnostics.CodeAnalysis;
using System.Security.Cryptography;
using Ai.Tlbx.MidTerm.Models.Browser;

namespace Ai.Tlbx.MidTerm.Services.Browser;

public sealed class BrowserPreviewRegistry
{
    private static readonly TimeSpan PreviewLifetime = TimeSpan.FromHours(8);
    private readonly ConcurrentDictionary<string, RegisteredPreview> _previews = new();

    public BrowserPreviewClientResponse Create(string? sessionId, string? browserId = null)
    {
        CleanupExpired();

        var preview = new RegisteredPreview
        {
            SessionId = string.IsNullOrWhiteSpace(sessionId) ? null : sessionId,
            PreviewId = Guid.NewGuid().ToString("N"),
            PreviewToken = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(24)),
            BrowserId = string.IsNullOrWhiteSpace(browserId) ? null : browserId,
            ExpiresAtUtc = DateTimeOffset.UtcNow.Add(PreviewLifetime)
        };

        _previews[preview.PreviewId] = preview;

        return new BrowserPreviewClientResponse
        {
            SessionId = preview.SessionId,
            PreviewId = preview.PreviewId,
            PreviewToken = preview.PreviewToken
        };
    }

    public bool TryValidate(
        string? previewId,
        string? previewToken,
        [NotNullWhen(true)] out BrowserPreviewRegistration? preview)
    {
        CleanupExpired();
        preview = null;

        if (string.IsNullOrWhiteSpace(previewId) || string.IsNullOrWhiteSpace(previewToken))
            return false;

        if (!_previews.TryGetValue(previewId, out var registered))
            return false;

        if (!registered.PreviewToken.Equals(previewToken, StringComparison.Ordinal))
            return false;

        preview = new BrowserPreviewRegistration
        {
            SessionId = registered.SessionId,
            PreviewId = registered.PreviewId,
            PreviewToken = registered.PreviewToken,
            BrowserId = registered.BrowserId
        };
        return true;
    }

    private void CleanupExpired()
    {
        var now = DateTimeOffset.UtcNow;
        foreach (var entry in _previews)
        {
            if (entry.Value.ExpiresAtUtc <= now)
            {
                _previews.TryRemove(entry.Key, out _);
            }
        }
    }

    private sealed class RegisteredPreview
    {
        public string? SessionId { get; init; }
        public string PreviewId { get; init; } = "";
        public string PreviewToken { get; init; } = "";
        public string? BrowserId { get; init; }
        public DateTimeOffset ExpiresAtUtc { get; init; }
    }
}
