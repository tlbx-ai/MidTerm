using Ai.Tlbx.MidTerm.Models.Git;
using Ai.Tlbx.MidTerm.Services.Sessions;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Services.Git;

internal static class GitOperationEndpoints
{
    internal static void Map(WebApplication app, GitWatcherService watcher, TtyHostSessionManager sessions,
        SessionGitMetadataService metadata)
    {
        var operations = new GitOperationService();
        var settings = app.Services.GetRequiredService<SettingsService>();
        app.MapGet("/api/git/workspace", async Task<IResult> (string sessionId, string repoRoot, HttpContext context, CancellationToken ct) =>
            await RespondAsync(context, sessionId, repoRoot, sessions, settings, async () =>
            {
                var root = await ResolveAsync(sessionId, repoRoot, metadata, watcher, ct).ConfigureAwait(false);
                return Results.Json(await GitWorkspaceQuery.ReadAsync(root, ct).ConfigureAwait(false), GitJsonContext.Default.GitWorkspaceResponse);
            }).ConfigureAwait(false));
        app.MapGet("/api/git/conflict", async Task<IResult> (string sessionId, string repoRoot, string path, HttpContext context, CancellationToken ct) =>
            await RespondAsync(context, sessionId, repoRoot, sessions, settings, async () =>
            {
                var root = await ResolveAsync(sessionId, repoRoot, metadata, watcher, ct).ConfigureAwait(false);
                return Results.Json(await GitWorkspaceQuery.ReadConflictAsync(root, path, ct).ConfigureAwait(false), GitJsonContext.Default.GitConflictView);
            }).ConfigureAwait(false));
        app.MapPost("/api/git/operations", async Task<IResult> (GitOperationRequest request, HttpContext context, CancellationToken ct) =>
        {
            return await RespondAsync(context, request.SessionId, request.RepoRoot, sessions, settings, async () =>
            {
                var root = await ResolveAsync(request.SessionId, request.RepoRoot, metadata, watcher, ct).ConfigureAwait(false);
                var result = await operations.ExecuteAsync(root, request, ct,
                    () => sessions.GetSession(request.SessionId) is not null && watcher.SessionHasRepo(request.SessionId, root)).ConfigureAwait(false);
                await watcher.RefreshStatusAsync(root).ConfigureAwait(false);
                result.Status = watcher.GetCachedStatus(request.SessionId, root) ?? result.Status;
                return Results.Json(result, GitJsonContext.Default.GitOperationResponse, statusCode: result.StatusCode);
            }).ConfigureAwait(false);
        });
        app.MapGet("/api/git/operations/{operationId}", async Task<IResult> (string operationId, string sessionId, string repoRoot, HttpContext context, CancellationToken ct) =>
            await RespondAsync(context, sessionId, repoRoot, sessions, settings, async () =>
            {
                var root = await ResolveAsync(sessionId, repoRoot, metadata, watcher, ct).ConfigureAwait(false);
                var result = await GitOperationService.ReadReceiptAsync(root, operationId, ct).ConfigureAwait(false);
                return Results.Json(result, GitJsonContext.Default.GitOperationResponse, statusCode: result.StatusCode);
            }).ConfigureAwait(false));
    }

    private static async Task<IResult> RespondAsync(HttpContext context, string sessionId, string root,
        TtyHostSessionManager sessions, SettingsService settings, Func<Task<IResult>> action)
    {
        try
        {
            if (!RequestAccessContext.HasFullUserAccess(context)) throw new GitOperationException(403, "write_access_required", "Full workspace access is required for Git operations.");
            if (string.IsNullOrWhiteSpace(sessionId) || string.IsNullOrWhiteSpace(root)) throw new GitOperationException(400, "repository_required", "Select a session and repository first.");
            if (sessions.GetSession(sessionId) is null) throw new GitOperationException(404, "session_closed", "The selected session is no longer available.");
            if (!OperatingSystem.IsWindows() || !settings.IsRunningAsService) return await action().ConfigureAwait(false);
            var host = sessions.GetVerifiedHostIdentity(sessionId) ?? throw new GitOperationException(409, "caller_unavailable", "The verified session identity is unavailable.");
            return await SessionCallerIdentity.RunForSessionAsync(host.Pid, host.Started, action).ConfigureAwait(false);
        }
        catch (GitOperationException error)
        { return Error(error.StatusCode, error.Code, error.Message); }
        catch (UnauthorizedAccessException error)
        { return Error(403, "permission_denied", error.Message); }
        catch (Exception error) when (error is IOException or ArgumentException or System.Text.Json.JsonException or SessionCallerIdentityException or System.ComponentModel.Win32Exception)
        { return Error(409, "git_unavailable", error.Message); }
    }

    private static async Task<string> ResolveAsync(string sessionId, string requested,
        SessionGitMetadataService metadata, GitWatcherService watcher, CancellationToken ct)
    {
        var result = await metadata.GetAsync(sessionId, ct).ConfigureAwait(false);
        if (!result.IsSuccess) throw new GitOperationException(result.StatusCode, "repository_unavailable", result.Error ?? "Repository metadata unavailable.");
        return watcher.ResolveRepoRoot(sessionId, requested)
            ?? throw new GitOperationException(403, "repository_unbound", "The selected repository is not bound to this session.");
    }

    private static IResult Error(int status, string code, string detail) => Results.Json(
        new GitOperationResponse { State = "error", ErrorCode = code, Detail = detail }, GitJsonContext.Default.GitOperationResponse, statusCode: status);
}
