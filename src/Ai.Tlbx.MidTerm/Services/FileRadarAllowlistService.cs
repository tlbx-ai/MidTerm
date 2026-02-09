using System.Collections.Concurrent;

namespace Ai.Tlbx.MidTerm.Services;

/// <summary>
/// Tracks file paths detected in terminal output, allowing access only to paths
/// that have been seen in a session's terminal output or are within the session's
/// working directory.
/// </summary>
public sealed class FileRadarAllowlistService
{
    private const int MaxPathsPerSession = 1000;

    private readonly ConcurrentDictionary<string, OrderedAllowlist> _allowlists = new();

    public void RegisterPath(string sessionId, string path)
    {
        var normalizedPath = NormalizePath(path);
        if (string.IsNullOrEmpty(normalizedPath)) return;

        var allowlist = _allowlists.GetOrAdd(sessionId, _ => new OrderedAllowlist());

        lock (allowlist)
        {
            if (allowlist.Set.Contains(normalizedPath)) return;

            if (allowlist.Order.Count >= MaxPathsPerSession)
            {
                var oldest = allowlist.Order[0];
                allowlist.Order.RemoveAt(0);
                allowlist.Set.Remove(oldest);
            }

            allowlist.Order.Add(normalizedPath);
            allowlist.Set.Add(normalizedPath);
        }
    }

    public void RegisterPaths(string sessionId, IEnumerable<string> paths)
    {
        foreach (var path in paths)
        {
            RegisterPath(sessionId, path);
        }
    }

    public bool IsPathAllowed(string sessionId, string path, string? workingDirectory)
    {
        var normalizedPath = NormalizePath(path);
        if (string.IsNullOrEmpty(normalizedPath)) return false;

        if (!string.IsNullOrEmpty(workingDirectory))
        {
            var normalizedWorkDir = NormalizePath(workingDirectory);
            if (!string.IsNullOrEmpty(normalizedWorkDir) && IsUnderDirectory(normalizedPath, normalizedWorkDir))
            {
                return true;
            }
        }

        if (_allowlists.TryGetValue(sessionId, out var allowlist))
        {
            lock (allowlist)
            {
                if (allowlist.Set.Contains(normalizedPath))
                {
                    return true;
                }

                var parent = Path.GetDirectoryName(normalizedPath);
                while (!string.IsNullOrEmpty(parent))
                {
                    if (allowlist.Set.Contains(parent))
                    {
                        return true;
                    }
                    parent = Path.GetDirectoryName(parent);
                }
            }
        }

        return false;
    }

    public void ClearSession(string sessionId)
    {
        _allowlists.TryRemove(sessionId, out _);
    }

    private static string? NormalizePath(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return null;

        try
        {
            return Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        }
        catch
        {
            return null;
        }
    }

    private static bool IsUnderDirectory(string path, string directory)
    {
        var normalizedDir = directory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        return path.StartsWith(normalizedDir + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
            || path.Equals(normalizedDir, StringComparison.OrdinalIgnoreCase);
    }

    private sealed class OrderedAllowlist
    {
        public List<string> Order { get; } = new();
        public HashSet<string> Set { get; } = new(StringComparer.OrdinalIgnoreCase);
    }
}
