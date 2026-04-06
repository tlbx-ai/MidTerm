using System.Globalization;
using System.Text;
using System.Text.Json;
using Ai.Tlbx.MidTerm.Models.Sessions;

namespace Ai.Tlbx.MidTerm.Services.Sessions;

public sealed class ProviderResumeCatalogService
{
    private static readonly TimeSpan CodexHotSessionCooldown = TimeSpan.FromSeconds(12);
    private readonly string _codexHome;
    private readonly string _claudeHome;

    public ProviderResumeCatalogService()
        : this(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile))
    {
    }

    internal ProviderResumeCatalogService(string userProfileDirectory)
    {
        var home = string.IsNullOrWhiteSpace(userProfileDirectory)
            ? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)
            : userProfileDirectory;
        _codexHome = Path.Combine(home, ".codex");
        _claudeHome = Path.Combine(home, ".claude");
    }

    public IReadOnlyList<ProviderResumeCatalogEntryDto> GetCandidates(
        string provider,
        string? workingDirectory,
        bool includeAllDirectories,
        CancellationToken ct = default)
    {
        var normalizedProvider = NormalizeProvider(provider);
        var normalizedWorkingDirectory = NormalizePathOrNull(workingDirectory);
        return normalizedProvider switch
        {
            AiCliProfileService.CodexProfile => GetCodexCandidates(normalizedWorkingDirectory, includeAllDirectories, ct),
            AiCliProfileService.ClaudeProfile => GetClaudeCandidates(normalizedWorkingDirectory, includeAllDirectories, ct),
            _ => []
        };
    }

    private IReadOnlyList<ProviderResumeCatalogEntryDto> GetCodexCandidates(
        string? normalizedWorkingDirectory,
        bool includeAllDirectories,
        CancellationToken ct)
    {
        var sessionsRoot = Path.Combine(_codexHome, "sessions");
        if (!Directory.Exists(sessionsRoot))
        {
            return [];
        }

        var cooldownCutoffUtc = DateTimeOffset.UtcNow - CodexHotSessionCooldown;
        var candidates = new List<ProviderResumeCatalogEntryDto>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (var file in Directory.EnumerateFiles(sessionsRoot, "*.jsonl", SearchOption.AllDirectories)
                     .Select(static path => new FileInfo(path))
                     .Where(file => file.LastWriteTimeUtc <= cooldownCutoffUtc.UtcDateTime)
                     .OrderByDescending(static file => file.LastWriteTimeUtc)
                     .Take(400))
        {
            ct.ThrowIfCancellationRequested();

            var candidate = TryReadCodexCandidate(file, normalizedWorkingDirectory, includeAllDirectories);
            if (candidate is null || !seen.Add(candidate.SessionId))
            {
                continue;
            }

            candidates.Add(candidate);
            if (candidates.Count >= 60)
            {
                break;
            }
        }

        return candidates;
    }

    private IReadOnlyList<ProviderResumeCatalogEntryDto> GetClaudeCandidates(
        string? normalizedWorkingDirectory,
        bool includeAllDirectories,
        CancellationToken ct)
    {
        var projectsRoot = Path.Combine(_claudeHome, "projects");
        if (!Directory.Exists(projectsRoot))
        {
            return [];
        }

        var candidates = new List<ProviderResumeCatalogEntryDto>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (var path in Directory.EnumerateFiles(projectsRoot, "*.jsonl", SearchOption.AllDirectories)
                     .Where(static path => !path.Contains(
                         $"{Path.DirectorySeparatorChar}subagents{Path.DirectorySeparatorChar}",
                         StringComparison.OrdinalIgnoreCase))
                     .Select(static path => new FileInfo(path))
                     .OrderByDescending(static file => file.LastWriteTimeUtc)
                     .Take(300))
        {
            ct.ThrowIfCancellationRequested();

            var candidate = TryReadClaudeCandidate(path, normalizedWorkingDirectory, includeAllDirectories);
            if (candidate is null || !seen.Add(candidate.SessionId))
            {
                continue;
            }

            candidates.Add(candidate);
            if (candidates.Count >= 60)
            {
                break;
            }
        }

        return candidates;
    }

    private static ProviderResumeCatalogEntryDto? TryReadCodexCandidate(
        FileInfo file,
        string? normalizedWorkingDirectory,
        bool includeAllDirectories)
    {
        using var reader = OpenSharedReaderOrNull(file.FullName);
        if (reader is null)
        {
            return null;
        }

        CodexMetaCandidate? meta = null;
        string? lastUserMessage = null;

        while (reader.ReadLine() is { } line)
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            try
            {
                using var json = JsonDocument.Parse(line);
                var root = json.RootElement;
                if (meta is null && TryReadCodexMeta(root, out var parsedMeta))
                {
                    meta = parsedMeta;
                    if (!includeAllDirectories &&
                        !string.Equals(parsedMeta.NormalizedWorkingDirectory, normalizedWorkingDirectory, StringComparison.OrdinalIgnoreCase))
                    {
                        return null;
                    }

                    continue;
                }

                if (meta is null || !TryReadCodexUserMessage(root, out var message))
                {
                    continue;
                }

                lastUserMessage = message;
            }
            catch
            {
            }
        }

        if (meta is null)
        {
            return null;
        }

        var resolvedMeta = meta.Value;
        var updatedAtUtc = resolvedMeta.TimestampUtc > file.LastWriteTimeUtc
            ? resolvedMeta.TimestampUtc
            : file.LastWriteTimeUtc;
        return CreateCandidate(
            AiCliProfileService.CodexProfile,
            resolvedMeta.SessionId,
            resolvedMeta.WorkingDirectory,
            lastUserMessage,
            updatedAtUtc);
    }

    private static ProviderResumeCatalogEntryDto? TryReadClaudeCandidate(
        FileInfo file,
        string? normalizedWorkingDirectory,
        bool includeAllDirectories)
    {
        using var reader = OpenSharedReaderOrNull(file.FullName);
        if (reader is null)
        {
            return null;
        }

        string? sessionId = null;
        string? workingDirectory = null;
        string? normalizedCwd = null;
        string? lastUserMessage = null;

        while (reader.ReadLine() is { } line)
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            try
            {
                using var json = JsonDocument.Parse(line);
                var root = json.RootElement;

                if (TryGetString(root, "sessionId", out var parsedSessionId))
                {
                    sessionId = parsedSessionId;
                }

                if (TryGetString(root, "cwd", out var parsedWorkingDirectory))
                {
                    workingDirectory = parsedWorkingDirectory;
                    normalizedCwd = NormalizePathOrNull(parsedWorkingDirectory);
                }

                if (!includeAllDirectories &&
                    !string.Equals(normalizedCwd, normalizedWorkingDirectory, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                if (TryReadClaudeUserMessage(root, out var message))
                {
                    lastUserMessage = message;
                }
            }
            catch
            {
            }
        }

        if (string.IsNullOrWhiteSpace(sessionId) || string.IsNullOrWhiteSpace(workingDirectory))
        {
            return null;
        }

        if (!includeAllDirectories &&
            !string.Equals(normalizedCwd, normalizedWorkingDirectory, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        return CreateCandidate(
            AiCliProfileService.ClaudeProfile,
            sessionId,
            workingDirectory,
            lastUserMessage,
            file.LastWriteTimeUtc);
    }

    private static ProviderResumeCatalogEntryDto CreateCandidate(
        string provider,
        string sessionId,
        string workingDirectory,
        string? previewText,
        DateTime updatedAtUtc)
    {
        var normalizedPreview = NormalizePreview(previewText);
        return new ProviderResumeCatalogEntryDto
        {
            Provider = provider,
            SessionId = sessionId,
            WorkingDirectory = workingDirectory,
            Title = normalizedPreview ?? BuildDirectoryLabel(workingDirectory),
            PreviewText = normalizedPreview,
            UpdatedAtUtc = DateTime.SpecifyKind(updatedAtUtc, DateTimeKind.Utc)
        };
    }

    private static bool TryReadCodexMeta(JsonElement root, out CodexMetaCandidate meta)
    {
        meta = default;
        if (!TryGetString(root, "type", out var rootType) ||
            !string.Equals(rootType, "session_meta", StringComparison.Ordinal) ||
            !root.TryGetProperty("payload", out var payload) ||
            payload.ValueKind != JsonValueKind.Object ||
            !TryGetString(payload, "id", out var sessionId) ||
            !TryGetString(payload, "cwd", out var workingDirectory) ||
            !TryGetString(payload, "timestamp", out var timestampText) ||
            !DateTimeOffset.TryParse(timestampText, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var timestamp))
        {
            return false;
        }

        meta = new CodexMetaCandidate(
            sessionId,
            workingDirectory,
            NormalizePathOrNull(workingDirectory) ?? string.Empty,
            timestamp.UtcDateTime);
        return true;
    }

    private static bool TryReadCodexUserMessage(JsonElement root, out string? message)
    {
        message = null;
        if (!TryGetString(root, "type", out var rootType) ||
            !string.Equals(rootType, "response_item", StringComparison.Ordinal) ||
            !root.TryGetProperty("payload", out var payload) ||
            payload.ValueKind != JsonValueKind.Object ||
            !TryGetString(payload, "type", out var payloadType) ||
            !string.Equals(payloadType, "message", StringComparison.Ordinal) ||
            !TryGetString(payload, "role", out var role) ||
            !string.Equals(role, "user", StringComparison.Ordinal) ||
            !payload.TryGetProperty("content", out var content) ||
            content.ValueKind != JsonValueKind.Array)
        {
            return false;
        }

        var parts = new List<string>();
        using var items = content.EnumerateArray();
        foreach (var item in items)
        {
            if (item.ValueKind != JsonValueKind.Object ||
                !TryGetString(item, "type", out var itemType) ||
                !string.Equals(itemType, "input_text", StringComparison.Ordinal) ||
                !TryGetString(item, "text", out var text))
            {
                continue;
            }

            parts.Add(text);
        }

        message = parts.Count == 0 ? null : string.Join(" ", parts);
        return !string.IsNullOrWhiteSpace(message);
    }

    private static bool TryReadClaudeUserMessage(JsonElement root, out string? message)
    {
        message = null;
        if (!TryGetString(root, "type", out var rootType) ||
            !string.Equals(rootType, "user", StringComparison.Ordinal) ||
            !root.TryGetProperty("message", out var payload) ||
            payload.ValueKind != JsonValueKind.Object ||
            !TryGetString(payload, "role", out var role) ||
            !string.Equals(role, "user", StringComparison.Ordinal))
        {
            return false;
        }

        if (!payload.TryGetProperty("content", out var content))
        {
            return false;
        }

        if (content.ValueKind == JsonValueKind.String)
        {
            message = content.GetString();
            return !string.IsNullOrWhiteSpace(message);
        }

        if (content.ValueKind != JsonValueKind.Array)
        {
            return false;
        }

        var parts = new List<string>();
        using var items = content.EnumerateArray();
        foreach (var item in items)
        {
            if (item.ValueKind != JsonValueKind.Object ||
                !TryGetString(item, "type", out var itemType) ||
                !string.Equals(itemType, "text", StringComparison.Ordinal) ||
                !TryGetString(item, "text", out var text))
            {
                continue;
            }

            parts.Add(text);
        }

        message = parts.Count == 0 ? null : string.Join(" ", parts);
        return !string.IsNullOrWhiteSpace(message);
    }

    private static string NormalizeProvider(string provider)
    {
        return (provider ?? string.Empty).Trim().ToLowerInvariant();
    }

    private static string? NormalizePathOrNull(string? path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return null;
        }

        try
        {
            return Path.GetFullPath(path)
                .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        }
        catch
        {
            return path.Trim().TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        }
    }

    private static string BuildDirectoryLabel(string workingDirectory)
    {
        var trimmed = workingDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var leaf = Path.GetFileName(trimmed);
        return string.IsNullOrWhiteSpace(leaf) ? workingDirectory : leaf;
    }

    private static string? NormalizePreview(string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return null;
        }

        var compact = string.Join(
            " ",
            text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
        if (compact.Length <= 160)
        {
            return compact;
        }

        return compact[..157] + "...";
    }

    private static bool TryGetString(JsonElement element, string propertyName, out string value)
    {
        value = string.Empty;
        if (!element.TryGetProperty(propertyName, out var property) || property.ValueKind != JsonValueKind.String)
        {
            return false;
        }

        var result = property.GetString();
        if (string.IsNullOrWhiteSpace(result))
        {
            return false;
        }

        value = result;
        return true;
    }

    private static StreamReader? OpenSharedReaderOrNull(string path)
    {
        try
        {
            var stream = new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete);
            return new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
        }
        catch
        {
            return null;
        }
    }

    private readonly record struct CodexMetaCandidate(
        string SessionId,
        string WorkingDirectory,
        string NormalizedWorkingDirectory,
        DateTime TimestampUtc);
}
