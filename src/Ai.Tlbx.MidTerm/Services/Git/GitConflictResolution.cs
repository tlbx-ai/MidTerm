using Ai.Tlbx.MidTerm.Models.Git;

namespace Ai.Tlbx.MidTerm.Services.Git;

internal static class GitConflictResolution
{
    internal static async Task<GitOperationResponse> ExecuteAsync(GitCommandRunner.GitRepositoryInfo info, GitOperationRequest request, GitStatusResponse status, CancellationToken ct)
    {
        var path = request.Paths.Single();
        if (!status.Conflicted.Any(file => file.Path == path)) throw new GitOperationException(409, "conflict_changed", "The selected conflict changed. Refresh and review it again.");
        var full = GitWorkspaceQuery.ConflictPath(info.RepoRoot, path);
        var index = await GitCommandRunner.GetIndexPathAsync(info.RepoRoot).ConfigureAwait(false);
        await using var transaction = new GitIndexTransaction(index, request.OperationId);
        if (await GitCommandRunner.HashIndexAsync(index).ConfigureAwait(false) != request.ExpectedIndexVersion || await GitWorkspaceQuery.ConflictVersionAsync(full).ConfigureAwait(false) != request.ExpectedFileVersion)
            throw new GitOperationException(409, "conflict_changed", "The reviewed index or conflicted file changed. Refresh before resolving it.");
        if (request.Resolution is not ("ours" or "theirs" or "mark")) throw new GitOperationException(400, "resolution_required", "Choose our version, their version, or a manually resolved file.");
        if (request.Resolution == "mark" && File.Exists(full) && new FileInfo(full).LinkTarget is null && FileService.CheckIsText(full, new FileInfo(full).Length) == true)
        {
            var document = await new FileDocumentService().ReadAsync(full, full: true, ct).ConfigureAwait(false);
            if (document.IsTruncated) throw new GitOperationException(409, "conflict_too_large", "The complete resolved text must be verified before staging this conflict.");
            if (GitWorkspaceQuery.HasConflictMarkers(document.Content)) throw new GitOperationException(409, "conflict_markers", "Remove all conflict markers before marking the file resolved.");
        }
        transaction.CopyOriginal();
        var environment = new Dictionary<string, string?>(StringComparer.Ordinal) { ["GIT_INDEX_FILE"] = transaction.TemporaryPath, ["GIT_TERMINAL_PROMPT"] = "0" };
        if (request.Resolution != "mark")
        {
            // An absent side means a deletion, not an empty file. Read the actual unmerged index stage.
            var stage = request.Resolution == "ours" ? "2" : "3";
            var entry = await GitCommandRunner.ExecuteAsync(info.RepoRoot, ["--literal-pathspecs", "ls-files", "--unmerged", "-z", "--", path], environment, ct).ConfigureAwait(false);
            if (entry.ExitCode != 0) throw new GitOperationException(422, "git_failed", entry.Stderr);
            if (!entry.Stdout.Split('\0').Any(line => line.Contains(" " + stage + "\t", StringComparison.Ordinal)))
            { if (File.Exists(full) || new FileInfo(full).LinkTarget is not null) File.Delete(full); }
            else
            {
                var restore = await GitCommandRunner.ExecuteAsync(info.RepoRoot, ["--literal-pathspecs", "restore", "--worktree", "--" + request.Resolution, "--", path], environment, ct).ConfigureAwait(false);
                if (restore.ExitCode != 0) throw new GitOperationException(422, "git_failed", restore.Stderr);
            }
        }
        var add = await GitCommandRunner.ExecuteAsync(info.RepoRoot, ["--literal-pathspecs", "add", "-A", "--", path], environment, ct).ConfigureAwait(false);
        if (add.ExitCode != 0) throw new GitOperationException(422, "git_failed", "The working file was resolved, but Git could not stage it. " + add.Stderr);
        await transaction.PublishAsync().ConfigureAwait(false);
        return new GitOperationResponse { OperationId = request.OperationId, RepoRoot = info.RepoRoot, Action = request.Action, State = "completed", Workspace = await GitWorkspaceQuery.ReadAsync(info.RepoRoot, ct).ConfigureAwait(false) };
    }
}
