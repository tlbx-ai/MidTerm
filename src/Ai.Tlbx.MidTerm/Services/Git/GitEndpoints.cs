using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Models.Git;

namespace Ai.Tlbx.MidTerm.Services.Git;

public static class GitEndpoints
{
    public static void MapGitEndpoints(WebApplication app, GitWatcherService gitWatcher, TtyHostSessionManager sessionManager)
    {
        app.MapGet("/api/git/status", async (string? sessionId) =>
        {
            if (string.IsNullOrEmpty(sessionId))
            {
                return Results.BadRequest("sessionId required");
            }

            var session = sessionManager.GetSession(sessionId);
            if (session is null)
            {
                return Results.NotFound("Session not found");
            }

            var repoRoot = gitWatcher.GetRepoRoot(sessionId);
            if (repoRoot is null)
            {
                var workingDir = session.CurrentDirectory;
                if (string.IsNullOrEmpty(workingDir))
                {
                    return Results.Json(new GitStatusResponse(), GitJsonContext.Default.GitStatusResponse);
                }

                await gitWatcher.RegisterSessionAsync(sessionId, workingDir);
                repoRoot = gitWatcher.GetRepoRoot(sessionId);
            }

            if (repoRoot is null)
            {
                return Results.Json(new GitStatusResponse(), GitJsonContext.Default.GitStatusResponse);
            }

            var cached = gitWatcher.GetCachedStatus(sessionId);
            if (cached is not null)
            {
                return Results.Json(cached, GitJsonContext.Default.GitStatusResponse);
            }

            await gitWatcher.RefreshStatusAsync(repoRoot);
            var status = gitWatcher.GetCachedStatus(sessionId) ?? new GitStatusResponse { RepoRoot = repoRoot };
            return Results.Json(status, GitJsonContext.Default.GitStatusResponse);
        });

        app.MapGet("/api/git/diff", async (string? sessionId, string? path, bool? staged) =>
        {
            if (string.IsNullOrEmpty(sessionId) || string.IsNullOrEmpty(path))
            {
                return Results.BadRequest("sessionId and path required");
            }

            var (repoRoot, error) = ResolveRepo(sessionId, gitWatcher, sessionManager);
            if (error is not null) return error;

            var diff = await GitCommandRunner.GetDiffAsync(repoRoot!, path, staged ?? false);
            return Results.Text(diff, "text/plain");
        });

        app.MapGet("/api/git/log", async (string? sessionId, int? count) =>
        {
            if (string.IsNullOrEmpty(sessionId))
            {
                return Results.BadRequest("sessionId required");
            }

            var (repoRoot, error) = ResolveRepo(sessionId, gitWatcher, sessionManager);
            if (error is not null) return error;

            var entries = await GitCommandRunner.GetLogAsync(repoRoot!, count ?? 20);
            return Results.Json(entries, GitJsonContext.Default.GitLogEntryArray);
        });
    }

    private static (string? RepoRoot, IResult? Error) ResolveRepo(
        string? sessionId,
        GitWatcherService gitWatcher,
        TtyHostSessionManager sessionManager)
    {
        if (string.IsNullOrEmpty(sessionId))
        {
            return (null, Results.BadRequest("sessionId required"));
        }

        var session = sessionManager.GetSession(sessionId);
        if (session is null)
        {
            return (null, Results.NotFound("Session not found"));
        }

        var repoRoot = gitWatcher.GetRepoRoot(sessionId);
        if (repoRoot is null)
        {
            return (null, Results.BadRequest("Session not in a git repository"));
        }

        return (repoRoot, null);
    }
}
