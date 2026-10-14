using Ai.Tlbx.MidTerm.Models.Git;

namespace Ai.Tlbx.MidTerm.Services.Git;

internal static class GitWorkspaceQuery
{
    internal static async Task<GitWorkspaceResponse> ReadAsync(string root, CancellationToken ct)
    {
        var info = await GitCommandRunner.GetRepositoryInfoAsync(root).ConfigureAwait(false) ?? throw new IOException("Repository unavailable.");
        var statusTask = GitCommandRunner.GetStatusAsync(root);
        var branchesTask = GitCommandRunner.ExecuteAsync(root, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(HEAD)%00%(symref)%00", "refs/heads/", "refs/remotes/"], ct);
        var remotesTask = GitCommandRunner.ExecuteAsync(root, ["remote"], ct);
        var stashesTask = GitCommandRunner.ExecuteAsync(root, ["stash", "list", "--format=%gd%x00%H%x00%gs%x00%ai%x00"], ct);
        await Task.WhenAll(statusTask, branchesTask, remotesTask, stashesTask).ConfigureAwait(false);
        var status = await statusTask.ConfigureAwait(false); if (status.ReadState != "ready") throw new IOException(status.ErrorDetail ?? "Git status unavailable.");
        var branches = await branchesTask.ConfigureAwait(false); var remotes = await remotesTask.ConfigureAwait(false); var stashes = await stashesTask.ConfigureAwait(false);
        if (branches.ExitCode != 0 || remotes.ExitCode != 0 || stashes.ExitCode != 0) throw new IOException("Git workspace metadata could not be read.");
        var result = new GitWorkspaceResponse { RepoRoot = info.RepoRoot, CurrentBranch = status.Branch, HeadHash = status.HeadHash, IndexVersion = status.IndexVersion,
            Branches = ParseBranches(branches.Stdout), Remotes = remotes.Stdout.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries).Select(name => new GitRemoteView { Name = name }).ToArray(),
            Stashes = ParseStashes(stashes.Stdout), MergeInProgress = File.Exists(Path.Combine(info.GitDir, "MERGE_HEAD")) };
        var message = Path.Combine(info.GitDir, "MERGE_MSG");
        if (result.MergeInProgress && File.Exists(message)) { var text = await File.ReadAllTextAsync(message, ct).ConfigureAwait(false); result.MergeMessage = text[..Math.Min(text.Length, 65536)]; }
        return result;
    }

    private static GitBranchView[] ParseBranches(string text)
    {
        var fields = text.Split('\0'); var branches = new List<GitBranchView>();
        for (var index = 0; index + 3 < fields.Length; index += 4)
        {
            var name = fields[index].TrimStart('\r', '\n'); if (fields[index + 3].Length > 0) continue;
            var remote = name.StartsWith("refs/remotes/", StringComparison.Ordinal);
            var prefix = remote ? "refs/remotes/" : "refs/heads/";
            if (!name.StartsWith(prefix, StringComparison.Ordinal)) continue;
            branches.Add(new GitBranchView { Ref = name, Name = name[prefix.Length..], Hash = fields[index + 1], IsCurrent = fields[index + 2] == "*", IsRemote = remote });
        }
        return branches.ToArray();
    }
    private static GitStashView[] ParseStashes(string text)
    {
        var fields = text.Split('\0'); var stashes = new List<GitStashView>();
        for (var index = 0; index + 3 < fields.Length; index += 4)
            stashes.Add(new GitStashView { Ref = fields[index].TrimStart('\r', '\n'), Hash = fields[index + 1], Message = fields[index + 2], Date = fields[index + 3] });
        return stashes.ToArray();
    }

    internal static async Task<GitConflictView> ReadConflictAsync(string root, string path, CancellationToken ct)
    {
        var status = await GitCommandRunner.GetStatusAsync(root).ConfigureAwait(false);
        if (!status.Conflicted.Any(file => file.Path == path)) throw new GitOperationException(409, "conflict_changed", "This file no longer has an unresolved conflict.");
        var full = ConflictPath(root, path);
        var isText = new FileInfo(full).LinkTarget is null && File.Exists(full) && FileService.CheckIsText(full, new FileInfo(full).Length) == true;
        var result = new GitConflictView { Path = path, IsBinary = !isText, ContentVersion = await ConflictVersionAsync(full).ConfigureAwait(false) };
        if (isText)
        {
            var document = await new FileDocumentService().ReadAsync(full, full: false, ct).ConfigureAwait(false);
            result.HasMarkers = HasConflictMarkers(document.Content); result.IsTruncated = document.IsTruncated;
        }
        var stages = await Task.WhenAll(Enumerable.Range(1, 3).Select(stage => GitCommandRunner.ExecuteAsync(root,
            ["show", ":" + stage.ToString(System.Globalization.CultureInfo.InvariantCulture) + ":" + path], ct))).ConfigureAwait(false);
        result.HasOurs = stages[1].ExitCode == 0; result.HasTheirs = stages[2].ExitCode == 0;
        if (!result.IsBinary) { result.Base = Limit(stages[0].Stdout, result); result.Ours = Limit(stages[1].Stdout, result); result.Theirs = Limit(stages[2].Stdout, result); }
        return result;
    }
    private static string Limit(string text, GitConflictView result)
    { if (text.Length > 262144) { result.IsTruncated = true; return text[..262144]; } return text; }
    internal static bool HasConflictMarkers(string text) => text.Split('\n').Any(line => line.StartsWith("<<<<<<< ", StringComparison.Ordinal) || line.StartsWith(">>>>>>> ", StringComparison.Ordinal) || line.TrimEnd('\r') == "=======");
    internal static string ConflictPath(string root, string path)
    {
        root = FileDocumentService.ResolvePath(root);
        if (string.IsNullOrEmpty(path) || Path.IsPathRooted(path) || path.AsSpan().IndexOf('\0') >= 0 || path.Replace('\\', '/').Split('/').Any(part => part is "." or ".."))
            throw new GitOperationException(400, "invalid_path", "Select a repository-relative conflicted path.");
        var full = Path.GetFullPath(Path.Combine(root, path));
        var parent = Path.GetDirectoryName(full)!;
        if (!FileService.IsWithinDirectory(full, root) || !FileService.IsWithinDirectory(FileDocumentService.ResolvePath(parent), root)) throw new UnauthorizedAccessException();
        return full;
    }
    internal static Task<string> ConflictVersionAsync(string full)
    {
        var link = new FileInfo(full).LinkTarget;
        return link is null ? GitCommandRunner.HashIndexAsync(full) : Task.FromResult(Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes("link:" + link))));
    }
}
