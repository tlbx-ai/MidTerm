using Ai.Tlbx.MidTerm.Models.Files;
using Ai.Tlbx.MidTerm.Services.Git;

namespace Ai.Tlbx.MidTerm.Services;

/// <summary>One filesystem listing and visibility policy for tree, modal and dock.</summary>
public static class FileDirectoryService
{
    public static async Task<(FileTreeEntry[] Entries, FileVisibilitySummary Visibility)> ReadAsync(
        string path, bool showHidden, bool showIgnored, Func<string, Task<string?>> accessiblePath)
    {
        var paths = Directory.EnumerateFileSystemEntries(path).ToArray();
        var repoRoot = await GitCommandRunner.GetRepoRootAsync(path);
        var physicalParent = FileDocumentService.ResolvePath(path);
        // Git reports a physical root even when the listing uses an alias such as macOS /var.
        // Resolve the parent only: a symlink entry belongs to this worktree, not to its target.
        var relative = repoRoot is null ? [] : paths.Select(entry =>
            Path.GetRelativePath(repoRoot, Path.Combine(physicalParent, Path.GetFileName(entry))).Replace('\\', '/')).ToArray();
        var ignored = repoRoot is null ? null : await GitCommandRunner.GetIgnoredPathsAsync(repoRoot, relative);
        var summary = new FileVisibilitySummary { TotalCount = paths.Length, IsGitRepo = repoRoot is not null,
            IgnoreAvailable = repoRoot is null || ignored is not null };
        var result = new List<FileTreeEntry>();
        for (var i = 0; i < paths.Length; i++)
        {
            var entryPath = paths[i];
            var attributes = File.GetAttributes(entryPath);
            var hidden = (attributes & FileAttributes.Hidden) != 0;
            var isIgnored = ignored?.Contains(relative[i]) == true;
            if (hidden) summary.HiddenCount++;
            if (isIgnored) summary.IgnoredCount++;
            if ((!showHidden && hidden) || (!showIgnored && isIgnored)) { summary.ExcludedCount++; continue; }
            var isDirectory = (attributes & FileAttributes.Directory) != 0;
            var entry = new FileTreeEntry { Name = Path.GetFileName(entryPath), FullPath = entryPath,
                IsDirectory = isDirectory, IsHidden = hidden, IsIgnored = isIgnored };
            var canonical = await accessiblePath(entryPath);
            if (canonical is not null)
            {
                entry.Modified = File.GetLastWriteTimeUtc(canonical);
                if (!isDirectory)
                {
                    var info = FileService.GetFileInfo(canonical, fresh: true);
                    entry.Size = info.Size; entry.MimeType = info.MimeType; entry.IsText = info.IsText;
                }
            }
            result.Add(entry);
        }
        summary.ShownCount = result.Count;
        return (result.OrderByDescending(entry => entry.IsDirectory)
            .ThenBy(entry => entry.Name, StringComparer.OrdinalIgnoreCase).ToArray(), summary);
    }
}
