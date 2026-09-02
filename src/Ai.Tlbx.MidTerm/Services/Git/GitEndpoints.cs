using Ai.Tlbx.MidTerm.Models.Git;
using Ai.Tlbx.MidTerm.Settings;
using Ai.Tlbx.MidTerm.Startup;

using Ai.Tlbx.MidTerm.Services.Sessions;
namespace Ai.Tlbx.MidTerm.Services.Git;

public sealed class GitDebugResponse
{
    public string? MidTermVersion { get; set; }
    public string? RequestedSessionId { get; set; }
    public bool SessionFound { get; set; }
    public string? CurrentDirectory { get; set; }
    public string? GitVersion { get; set; }
    public string? RepoRootFromCwd { get; set; }
    public string? CachedRepoRoot { get; set; }
    public bool HasCachedStatus { get; set; }
    public string? CachedBranch { get; set; }
    public GitDebugSessionInfo[] Sessions { get; set; } = [];
    public GitCommandLog? LastGitCommand { get; set; }
}

public sealed class GitCommandLog
{
    public string Args { get; set; } = "";
    public string WorkingDir { get; set; } = "";
    public int ExitCode { get; set; }
    public string Stdout { get; set; } = "";
    public string Stderr { get; set; } = "";
    public string Timestamp { get; set; } = "";
}

public sealed class GitDebugSessionInfo
{
    public string Id { get; set; } = "";
    public string? CurrentDirectory { get; set; }
    public string? RegisteredRepo { get; set; }
    public GitRepoBinding[] RegisteredRepos { get; set; } = [];
    public string? RepoRootProbe { get; set; }
    public string? ProbeError { get; set; }
}

public static class GitEndpoints
{
    public static void MapGitEndpoints(
        WebApplication app,
        GitWatcherService gitWatcher,
        TtyHostSessionManager sessionManager,
        SessionGitMetadataService gitMetadata)
    {
        app.MapGet("/api/git/debug", async (string? sessionId) =>
        {
            var session = string.IsNullOrEmpty(sessionId) ? null : sessionManager.GetSession(sessionId);
            var cwd = session?.CurrentDirectory;
            string? repoRoot = null;

            var gitVersionOutput = await GitCommandRunner.GetGitVersionAsync();

            if (!string.IsNullOrEmpty(cwd))
            {
                repoRoot = await GitCommandRunner.GetRepoRootAsync(cwd);
            }

            var cachedRepoRoot = string.IsNullOrEmpty(sessionId) ? null : gitWatcher.GetRepoRoot(sessionId!);
            var cachedStatus = string.IsNullOrEmpty(sessionId) ? null : gitWatcher.GetCachedStatus(sessionId!);

            var debug = new GitDebugResponse
            {
                MidTermVersion = CliCommands.GetVersion(),
                RequestedSessionId = sessionId,
                SessionFound = session is not null,
                CurrentDirectory = cwd,
                GitVersion = gitVersionOutput,
                RepoRootFromCwd = repoRoot,
                CachedRepoRoot = cachedRepoRoot,
                HasCachedStatus = cachedStatus is not null,
                CachedBranch = cachedStatus?.Branch,
                Sessions = await Task.WhenAll(sessionManager.GetAllSessions().Select(async s =>
                {
                    string? probeRoot = null;
                    string? probeError = null;
                    if (!string.IsNullOrEmpty(s.CurrentDirectory))
                    {
                        try
                        {
                            probeRoot = await GitCommandRunner.GetRepoRootAsync(s.CurrentDirectory);
                        }
                        catch (Exception ex)
                        {
                            probeError = ex.Message;
                        }
                    }
                    return new GitDebugSessionInfo
                    {
                        Id = s.Id,
                        CurrentDirectory = s.CurrentDirectory,
                RegisteredRepo = gitWatcher.GetRepoRoot(s.Id),
                RegisteredRepos = gitWatcher.GetRepoBindings(s.Id),
                        RepoRootProbe = probeRoot,
                        ProbeError = probeError
                    };
                })),
                LastGitCommand = GitCommandRunner.GetLastCommandLog()
            };

            return Results.Json(debug, GitJsonContext.Default.GitDebugResponse);
        });

        app.MapGet("/api/git/repos", async (string? sessionId, CancellationToken ct) =>
        {
            if (string.IsNullOrEmpty(sessionId))
            {
                return Results.BadRequest("sessionId required");
            }

            return ToResult(await gitMetadata.GetAsync(sessionId, ct));
        });

        app.MapPost("/api/git/repos", async (GitRepoBindRequest request, CancellationToken ct) =>
        {
            if (string.IsNullOrEmpty(request.SessionId) || string.IsNullOrEmpty(request.Path))
            {
                return Results.BadRequest("sessionId and path required");
            }

            var result = await gitMetadata.AddAsync(
                request.SessionId,
                request.Path,
                request.Label,
                request.Role,
                ct);
            return ToResult(result);
        });

        app.MapDelete("/api/git/repos", async (string? sessionId, string? repoRoot, CancellationToken ct) =>
        {
            if (string.IsNullOrEmpty(sessionId) || string.IsNullOrEmpty(repoRoot))
            {
                return Results.BadRequest("sessionId and repoRoot required");
            }

            return ToResult(await gitMetadata.RemoveAsync(sessionId, repoRoot, ct));
        });

        app.MapPost("/api/git/repos/refresh", async (GitRepoRefreshRequest request, CancellationToken ct) =>
        {
            if (string.IsNullOrEmpty(request.SessionId))
            {
                return Results.BadRequest("sessionId required");
            }

            var metadata = await gitMetadata.GetAsync(request.SessionId, ct);
            if (!metadata.IsSuccess)
            {
                return ToResult(metadata);
            }

            if (!string.IsNullOrWhiteSpace(request.RepoRoot))
            {
                var repoRoot = gitWatcher.ResolveRepoRoot(request.SessionId, request.RepoRoot);
                if (repoRoot is null)
                {
                    return Results.BadRequest("Repository is not bound to this session");
                }

                await gitWatcher.RefreshStatusAsync(repoRoot);
            }
            else
            {
                var repoRoots = gitWatcher.GetRepoBindings(request.SessionId)
                    .Select(static repo => repo.RepoRoot)
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .ToArray();
                await Task.WhenAll(repoRoots.Select(gitWatcher.RefreshStatusAsync));
            }

            return Results.Json(
                new GitRepoListResponse { Repos = gitWatcher.GetRepoBindings(request.SessionId) },
                GitJsonContext.Default.GitRepoListResponse);
        });

        app.MapGet("/api/git/status", async (string? sessionId, string? repoRoot, CancellationToken ct) =>
        {
            if (string.IsNullOrEmpty(sessionId))
            {
                return Results.BadRequest("sessionId required");
            }

            var metadata = await gitMetadata.GetAsync(sessionId, ct);
            if (!metadata.IsSuccess)
            {
                return ToResult(metadata);
            }

            var resolvedRepoRoot = gitWatcher.ResolveRepoRoot(sessionId, repoRoot);

            if (resolvedRepoRoot is null)
            {
                return Results.Json(new GitStatusResponse(), GitJsonContext.Default.GitStatusResponse);
            }

            var cached = gitWatcher.GetCachedStatus(sessionId, resolvedRepoRoot);
            if (cached is not null)
            {
                return Results.Json(cached, GitJsonContext.Default.GitStatusResponse);
            }

            await gitWatcher.RefreshStatusAsync(resolvedRepoRoot);
            var status = gitWatcher.GetCachedStatus(sessionId, resolvedRepoRoot) ?? new GitStatusResponse { RepoRoot = resolvedRepoRoot };
            return Results.Json(status, GitJsonContext.Default.GitStatusResponse);
        });

        app.MapGet("/api/git/diff", async (string? sessionId, string? repoRoot, string? path, bool? staged, CancellationToken ct) =>
        {
            if (string.IsNullOrEmpty(sessionId) || string.IsNullOrEmpty(path))
            {
                return Results.BadRequest("sessionId and path required");
            }

            var (resolvedRepoRoot, error) = await ResolveRepoAsync(sessionId, repoRoot, gitWatcher, gitMetadata, ct);
            if (error is not null) return error;

            var diff = await GitCommandRunner.GetDiffAsync(resolvedRepoRoot!, path, staged ?? false);
            return Results.Text(diff, "text/plain");
        });

        app.MapGet("/api/git/diff-view", async (string? sessionId, string? repoRoot, string? path, string? scope, CancellationToken ct) =>
        {
            if (string.IsNullOrEmpty(sessionId) || string.IsNullOrEmpty(path))
            {
                return Results.BadRequest("sessionId and path required");
            }

            var normalizedScope = string.Equals(scope, "staged", StringComparison.OrdinalIgnoreCase)
                ? "staged"
                : "worktree";

            var (resolvedRepoRoot, error) = await ResolveRepoAsync(sessionId, repoRoot, gitWatcher, gitMetadata, ct);
            if (error is not null) return error;

            var (patch, isTruncated) = await GitCommandRunner.GetDiffPatchAsync(
                resolvedRepoRoot!,
                path,
                normalizedScope == "staged");

            var response = GitPatchParser.ParseDiff(normalizedScope, patch, isTruncated);
            return Results.Json(response, GitJsonContext.Default.GitDiffViewResponse);
        });

        app.MapGet("/api/git/log", async (string? sessionId, string? repoRoot, int? count, CancellationToken ct) =>
        {
            if (string.IsNullOrEmpty(sessionId))
            {
                return Results.BadRequest("sessionId required");
            }

            var (resolvedRepoRoot, error) = await ResolveRepoAsync(sessionId, repoRoot, gitWatcher, gitMetadata, ct);
            if (error is not null) return error;

            var entries = await GitCommandRunner.GetLogAsync(resolvedRepoRoot!, count ?? 20);
            return Results.Json(entries, GitJsonContext.Default.GitLogEntryArray);
        });

        app.MapGet("/api/git/commit", async (string? sessionId, string? repoRoot, string? hash, CancellationToken ct) =>
        {
            if (string.IsNullOrEmpty(sessionId) || string.IsNullOrEmpty(hash))
            {
                return Results.BadRequest("sessionId and hash required");
            }

            var (resolvedRepoRoot, error) = await ResolveRepoAsync(sessionId, repoRoot, gitWatcher, gitMetadata, ct);
            if (error is not null) return error;

            var metadata = await GitCommandRunner.GetCommitMetadataAsync(resolvedRepoRoot!, hash);
            if (metadata is null)
            {
                return Results.NotFound("Commit not found");
            }

            var (patch, isTruncated) = await GitCommandRunner.GetCommitPatchAsync(resolvedRepoRoot!, hash);
            var response = GitPatchParser.ParseCommitDetails(metadata, patch, isTruncated);
            return Results.Json(response, GitJsonContext.Default.GitCommitDetailsResponse);
        });
    }

    private static IResult ToResult(SessionGitMetadataResult result)
    {
        if (result.IsSuccess)
        {
            return Results.Json(
                new GitRepoListResponse { Repos = result.Repos },
                GitJsonContext.Default.GitRepoListResponse);
        }

        return Results.Problem(result.Error, statusCode: result.StatusCode);
    }

    private static async Task<(string? RepoRoot, IResult? Error)> ResolveRepoAsync(
        string? sessionId,
        string? repoRoot,
        GitWatcherService gitWatcher,
        SessionGitMetadataService gitMetadata,
        CancellationToken ct)
    {
        if (string.IsNullOrEmpty(sessionId))
        {
            return (null, Results.BadRequest("sessionId required"));
        }

        var metadata = await gitMetadata.GetAsync(sessionId, ct);
        if (!metadata.IsSuccess)
        {
            return (null, ToResult(metadata));
        }

        var resolvedRepoRoot = gitWatcher.ResolveRepoRoot(sessionId, repoRoot);
        if (resolvedRepoRoot is null)
        {
            return (null, Results.BadRequest("Session not in a git repository"));
        }

        return (resolvedRepoRoot, null);
    }
}
