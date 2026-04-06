using Ai.Tlbx.MidTerm.Models.Git;

namespace Ai.Tlbx.MidTerm.Services.Git;

internal static class GitFileStatusMapBuilder
{
    internal static Dictionary<string, string> Build(GitStatusResponse status)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        AddEntries(result, status.Conflicted);
        AddEntries(result, status.Staged);
        AddEntries(result, status.Modified);
        AddEntries(result, status.Untracked);

        return result;
    }

    private static void AddEntries(Dictionary<string, string> map, IEnumerable<GitFileEntry> entries)
    {
        foreach (var entry in entries)
        {
            var relativePath = entry.Path.Replace('\\', '/');
            if (string.IsNullOrWhiteSpace(relativePath))
            {
                continue;
            }

            var badge = StatusToBadge(entry.Status);
            SetIfStronger(map, relativePath, badge);

            var directory = Path.GetDirectoryName(relativePath)?.Replace('\\', '/');
            while (!string.IsNullOrWhiteSpace(directory))
            {
                SetIfStronger(map, directory, badge);
                directory = Path.GetDirectoryName(directory)?.Replace('\\', '/');
            }
        }
    }

    private static void SetIfStronger(Dictionary<string, string> map, string path, string badge)
    {
        if (!map.TryGetValue(path, out var existing) || GetPriority(badge) > GetPriority(existing))
        {
            map[path] = badge;
        }
    }

    private static string StatusToBadge(string status)
    {
        return status switch
        {
            "conflicted" or "unmerged" => "!",
            "deleted" => "D",
            "renamed" => "R",
            "added" => "A",
            "untracked" => "?",
            _ => "M"
        };
    }

    private static int GetPriority(string badge)
    {
        return badge switch
        {
            "!" => 5,
            "D" => 4,
            "R" => 3,
            "M" => 3,
            "A" => 2,
            "?" => 1,
            _ => 0
        };
    }
}
