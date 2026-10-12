using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Ai.Tlbx.MidTerm.Models.Git;

namespace Ai.Tlbx.MidTerm.Services.Git;

/// <summary>Native Git operations against one validated repository and its locked index.</summary>
internal sealed class GitOperationService
{
    private static readonly StringComparer PathComparer = OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;
    private static readonly ConcurrentDictionary<string, SemaphoreSlim> Gates = new(PathComparer);

    internal async Task<GitOperationResponse> ExecuteAsync(string repoRoot, GitOperationRequest request,
        CancellationToken ct, Func<bool>? stillAuthorized = null)
    {
        ValidateRequest(request);
        var info = await GitCommandRunner.GetRepositoryInfoAsync(repoRoot).ConfigureAwait(false)
            ?? throw new GitOperationException(404, "no_repository", "The selected repository is unavailable.");
        if (!PathComparer.Equals(Path.TrimEndingDirectorySeparator(FileDocumentService.ResolvePath(repoRoot)), info.RepoRoot))
            throw new GitOperationException(409, "repository_changed", "The selected repository changed. Refresh it before retrying.");
        repoRoot = info.RepoRoot;
        var gate = Gates.GetOrAdd(info.GitDir, static _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (stillAuthorized?.Invoke() == false) throw new GitOperationException(403, "repository_unbound", "This repository is no longer bound to the session.");
            var fingerprint = Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(request, GitJsonContext.Default.GitOperationRequest)));
            var folder = Path.Combine(info.GitDir, "tlbx-operation-receipts");
            var receiptPath = Path.Combine(folder, request.OperationId + ".json");
            if (File.Exists(receiptPath))
            {
                var saved = JsonSerializer.Deserialize(await File.ReadAllTextAsync(receiptPath, ct).ConfigureAwait(false), GitJsonContext.Default.GitOperationReceipt)
                    ?? throw new IOException("Invalid Git operation receipt.");
                if (saved.Fingerprint != fingerprint) throw new GitOperationException(409, "operation_reused", "This operation ID belongs to another request.");
                saved.Result.StatusCode = saved.StatusCode;
                if (saved.Result.State == "running") { saved.Result.State = "unknown"; saved.Result.StatusCode = 409; saved.Result.ErrorCode = "outcome_unknown"; saved.Result.Detail = "The previous Git operation did not return a confirmed result. Inspect repository status before continuing."; }
                saved.Result.Status = await GitCommandRunner.GetStatusAsync(repoRoot).ConfigureAwait(false);
                return saved.Result;
            }
            Directory.CreateDirectory(folder);
            var receipt = new GitOperationReceipt { Fingerprint = fingerprint, Result = new() { OperationId = request.OperationId, RepoRoot = repoRoot, Action = request.Action, State = "running" } };
            await SaveReceiptAsync(receiptPath, receipt).ConfigureAwait(false);
            try { receipt.Result = await ExecuteLockedIndexAsync(info, request, ct).ConfigureAwait(false); }
            catch (GitOperationException error) { receipt.Result.State = "error"; receipt.Result.StatusCode = error.StatusCode; receipt.Result.ErrorCode = error.Code; receipt.Result.Detail = error.Message; }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or OperationCanceledException)
            { receipt.Result.State = "error"; receipt.Result.StatusCode = error is UnauthorizedAccessException ? 403 : 409; receipt.Result.ErrorCode = error is UnauthorizedAccessException ? "permission_denied" : "git_io_error"; receipt.Result.Detail = error.Message; }
            await SaveReceiptAsync(receiptPath, receipt).ConfigureAwait(false);
            receipt.Result.Status = await GitCommandRunner.GetStatusAsync(repoRoot).ConfigureAwait(false);
            return receipt.Result;
        }
        finally { gate.Release(); }
    }

    private static void ValidateRequest(GitOperationRequest request)
    {
        if (request.Paths is null) throw new GitOperationException(400, "invalid_paths", "Paths must be an array.");
        if (!Guid.TryParseExact(request.OperationId, "D", out _)) throw new GitOperationException(400, "invalid_operation", "A unique operation ID is required.");
        if (request.Action is not ("stage" or "unstage" or "commit" or "stage-selection" or "unstage-selection")) throw new GitOperationException(400, "invalid_action", "Unsupported Git operation.");
        if (request.Action is "stage-selection" or "unstage-selection")
        {
            if (request.All || request.Paths.Length != 1 || string.IsNullOrEmpty(request.ExpectedIndexVersion) || string.IsNullOrEmpty(request.ExpectedPatchVersion))
                throw new GitOperationException(400, "review_required", "Review one file before selecting changes to stage or unstage.");
            if (request.SelectedHunks is null || request.SelectedLines is null || request.SelectedLines.Any(line => line is null) || request.SelectedLines.Length > 10000 || request.SelectedHunks.Length > 10000)
                throw new GitOperationException(400, "invalid_selection", "Select at most 10000 changed lines or hunks.");
        }
        if (request.Action == "commit" && (string.IsNullOrWhiteSpace(request.Message) || request.Message.Length > 65536))
            throw new GitOperationException(400, "commit_message_required", "Enter a commit message of at most 65536 characters.");
        if (request.Action == "commit" && (string.IsNullOrEmpty(request.ExpectedIndexVersion) || request.ExpectedHead is null))
            throw new GitOperationException(400, "review_required", "Refresh and review staged changes before committing.");
        if (request.Action != "commit" && !request.All && request.Paths.Length == 0)
            throw new GitOperationException(400, "paths_required", "Select files before changing the index.");
        if (request.Paths.Length > 10000) throw new GitOperationException(400, "too_many_paths", "Select at most 10000 files at once.");
    }

    private static async Task<GitOperationResponse> ExecuteLockedIndexAsync(GitCommandRunner.GitRepositoryInfo info,
        GitOperationRequest request, CancellationToken ct)
    {
        var index = await GitCommandRunner.GetIndexPathAsync(info.RepoRoot).ConfigureAwait(false);
        await using var transaction = new GitIndexTransaction(index, request.OperationId);
        var temporary = transaction.TemporaryPath;
        GitOperationResponse? result = null;
        try
        {
            var before = await GitCommandRunner.GetStatusAsync(info.RepoRoot).ConfigureAwait(false);
            if (request.ExpectedIndexVersion is { } expected && expected != before.IndexVersion)
                throw new GitOperationException(409, "index_changed", "Staged changes changed since the last review. Refresh and review them again.");
            if (request.Action == "commit" && request.ExpectedHead != before.HeadHash)
                throw new GitOperationException(409, "head_changed", "The repository HEAD changed. Refresh and review before committing.");
            if (request.Action == "commit" && before.Staged.Length == 0)
                throw new GitOperationException(409, "nothing_staged", "Stage changes before creating a commit.");
            if (before.Conflicted.Length > 0 && (request.Action == "commit" || request.All || request.Paths.Any(path => before.Conflicted.Any(file => PathComparer.Equals(file.Path, path)))))
                throw new GitOperationException(409, "conflict_unresolved", "Resolve conflicted files before staging or committing them.");
            transaction.CopyOriginal();
            var paths = request.Action == "commit" ? [] : SelectPaths(info.RepoRoot, request, before);
            var environment = new Dictionary<string, string?>(StringComparer.Ordinal) { ["GIT_INDEX_FILE"] = temporary, ["GIT_TERMINAL_PROMPT"] = "0", ["GCM_INTERACTIVE"] = "never" };
            var (exitCode, stdout, stderr) = request.Action is "stage-selection" or "unstage-selection"
                ? await ApplySelectionAsync(info.RepoRoot, request, before, temporary, environment, ct).ConfigureAwait(false)
                : await GitCommandRunner.ExecuteAsync(info.RepoRoot, BuildArguments(request, before, paths), environment, ct).ConfigureAwait(false);
            result = new GitOperationResponse { OperationId = request.OperationId, RepoRoot = info.RepoRoot, Action = request.Action, State = "completed" };
            if (request.Action == "commit")
            {
                var after = await GitCommandRunner.GetStatusAsync(info.RepoRoot).ConfigureAwait(false);
                if (after.HeadHash != before.HeadHash) result.CommitHash = after.HeadHash;
                else if (exitCode == 0) throw new GitOperationException(409, "commit_unconfirmed", "Git returned without a new commit. Inspect repository status before retrying.");
            }
            if (exitCode != 0 && result.CommitHash is null) throw GitFailure(stderr, stdout, exitCode);
            await transaction.PublishAsync().ConfigureAwait(false);
            return result;
        }
        catch (Exception error) when (result?.CommitHash is not null && error is IOException or UnauthorizedAccessException or GitOperationException)
        {
            result.State = "unknown";
            result.StatusCode = 409;
            result.ErrorCode = "index_publication_failed";
            transaction.PreservePreparedIndex = true;
            result.Detail = $"Commit {result.CommitHash} exists, but its index could not be published. Do not create another commit. The prepared index remains at {temporary}. {error.Message}";
            return result;
        }
    }

    private static string[] SelectPaths(string root, GitOperationRequest request, GitStatusResponse status)
    {
        if (request.All) return ["."];
        var files = request.Action is "unstage" or "unstage-selection" ? status.Staged : status.Modified.Concat(status.Untracked).Concat(status.Staged).ToArray();
        var result = new HashSet<string>(PathComparer);
        foreach (var input in request.Paths)
        {
            if (string.IsNullOrEmpty(input) || input.AsSpan().IndexOf('\0') >= 0 || Path.IsPathRooted(input)) throw new GitOperationException(400, "invalid_path", "Git paths must be relative to the selected repository.");
            var path = OperatingSystem.IsWindows() ? input.Replace('\\', '/') : input;
            var rootPrefix = Path.EndsInDirectorySeparator(root) ? root : root + Path.DirectorySeparatorChar;
            if (path.Split('/').Any(part => part is "." or "..") || !Path.GetFullPath(Path.Combine(root, path)).StartsWith(rootPrefix, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
                throw new GitOperationException(403, "path_outside_repository", "The selected path is outside the repository.");
            var file = files.FirstOrDefault(file => PathComparer.Equals(file.Path.TrimEnd('/'), path.TrimEnd('/')))
                ?? throw new GitOperationException(409, "path_changed", "The selected file no longer has that Git state. Refresh and retry.");
            result.Add(file.Path);
            if (file.OriginalPath is { } original) result.Add(original);
        }
        return result.ToArray();
    }

    private static async Task<(int ExitCode, string Stdout, string Stderr)> ApplySelectionAsync(string root,
        GitOperationRequest request, GitStatusResponse before, string index,
        Dictionary<string, string?> environment, CancellationToken ct)
    {
        var snapshot = await GitPatchSelection.ReadAsync(root, request.Paths[0], request.Action == "unstage-selection", before).ConfigureAwait(false);
        var patch = GitPatchSelection.Build(snapshot, request);
        var patchPath = index + ".patch";
        try
        {
            await File.WriteAllTextAsync(patchPath, patch, new UTF8Encoding(false), ct).ConfigureAwait(false);
            var check = await GitCommandRunner.ExecuteAsync(root, ["apply", "--cached", "--check", "--whitespace=nowarn", "--", patchPath], environment, ct).ConfigureAwait(false);
            if (check.ExitCode != 0) throw new GitOperationException(409, "patch_conflict", "Git could not apply the selected changes to the reviewed index. " + check.Stderr);
            return await GitCommandRunner.ExecuteAsync(root, ["apply", "--cached", "--whitespace=nowarn", "--", patchPath], environment, ct).ConfigureAwait(false);
        }
        finally { if (File.Exists(patchPath)) File.Delete(patchPath); }
    }

    private static string[] BuildArguments(GitOperationRequest request, GitStatusResponse before, string[] paths)
    {
        if (request.Action == "commit") return ["commit", "--cleanup=verbatim", "-m", request.Message!];
        if (request.Action == "stage") return ["--literal-pathspecs", "add", "-A", "--", .. paths];
        return string.IsNullOrEmpty(before.HeadHash)
            ? ["--literal-pathspecs", "rm", "--cached", "--force", "--ignore-unmatch", "-r", "--", .. paths]
            : ["--literal-pathspecs", "restore", "--staged", "--", .. paths];
    }

    private static GitOperationException GitFailure(string stderr, string stdout, int exitCode)
    {
        var detail = string.IsNullOrWhiteSpace(stderr) ? stdout : stderr;
        if (detail.Length > 16000) detail = detail[..16000];
        var identity = detail.Contains("identity unknown", StringComparison.OrdinalIgnoreCase) || detail.Contains("unable to auto-detect email", StringComparison.OrdinalIgnoreCase);
        return new GitOperationException(exitCode < 0 ? 504 : 422, identity ? "identity_missing" : exitCode < 0 ? "git_timeout" : "git_failed", detail);
    }

    private static async Task SaveReceiptAsync(string path, GitOperationReceipt receipt)
    {
        receipt.StatusCode = receipt.Result.StatusCode;
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try { await File.WriteAllTextAsync(temporary, JsonSerializer.Serialize(receipt, GitJsonContext.Default.GitOperationReceipt), Encoding.UTF8).ConfigureAwait(false); File.Move(temporary, path, overwrite: true); }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    internal static async Task<GitOperationResponse> ReadReceiptAsync(string root, string operationId, CancellationToken ct)
    {
        if (!Guid.TryParseExact(operationId, "D", out _)) throw new GitOperationException(400, "invalid_operation", "Invalid operation ID.");
        var info = await GitCommandRunner.GetRepositoryInfoAsync(root).ConfigureAwait(false) ?? throw new GitOperationException(404, "no_repository", "Repository unavailable.");
        var path = Path.Combine(info.GitDir, "tlbx-operation-receipts", operationId + ".json");
        if (!File.Exists(path)) throw new GitOperationException(404, "operation_not_found", "This Git operation has no recorded result.");
        var receipt = JsonSerializer.Deserialize(await File.ReadAllTextAsync(path, ct).ConfigureAwait(false), GitJsonContext.Default.GitOperationReceipt) ?? throw new IOException("Invalid operation receipt.");
        receipt.Result.StatusCode = receipt.StatusCode;
        receipt.Result.Status = await GitCommandRunner.GetStatusAsync(root).ConfigureAwait(false);
        return receipt.Result;
    }
}
