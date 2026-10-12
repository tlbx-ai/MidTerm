using Ai.Tlbx.MidTerm.Models.Files;
using Ai.Tlbx.MidTerm.Settings;
using Ai.Tlbx.MidTerm.Services.Sessions;

namespace Ai.Tlbx.MidTerm.Services;

internal static class FileOperationEndpoints
{
    internal static void Map(WebApplication app, FileService files, SettingsService settings)
    {
        var operations = new FileOperationService(settings.SettingsDirectory);
        app.MapPost("/api/files/operations", async (FileOperationRequest request, string sessionId, CancellationToken ct) =>
        {
            try
            {
                var (access, roots) = await Authority(files, sessionId);
                var result = await AsSessionOwner(operations, files, settings, sessionId, scoped => scoped.ExecuteAsync(request, access, roots, ct));
                return Results.Json(result, AppJsonContext.Default.FileOperationResponse);
            }
            catch (Exception ex) when (IsOperationError(ex)) { return FileEndpoints.DocumentError(ex, sessionId, files); }
        });
        app.MapGet("/api/files/operations/{id}", async (string id, string sessionId) =>
        {
            try
            {
                var (access, _) = await Authority(files, sessionId);
                return Results.Json(await AsSessionOwner(operations, files, settings, sessionId, scoped => Task.FromResult(scoped.GetOperation(id, access))), AppJsonContext.Default.FileOperationResponse);
            }
            catch (Exception ex) when (IsOperationError(ex)) { return FileEndpoints.DocumentError(ex, sessionId, files); }
        });
        app.MapGet("/api/files/recovery", async (string directory, string sessionId, string? cursor) =>
        {
            try
            {
                var (access, _) = await Authority(files, sessionId);
                return Results.Json(await AsSessionOwner(operations, files, settings, sessionId, scoped => Task.FromResult(scoped.ListRecovery(directory, cursor, access))), AppJsonContext.Default.FileRecoveryResponse);
            }
            catch (Exception ex) when (IsOperationError(ex)) { return FileEndpoints.DocumentError(ex, sessionId, files); }
        });
        app.MapPost("/api/files/restore", async (FileRestoreRequest request, string sessionId, CancellationToken ct) =>
        {
            try
            {
                var (access, _) = await Authority(files, sessionId);
                return Results.Json(await AsSessionOwner(operations, files, settings, sessionId, scoped => scoped.RestoreAsync(request, access, ct)), AppJsonContext.Default.FileOperationItem);
            }
            catch (Exception ex) when (IsOperationError(ex)) { return FileEndpoints.DocumentError(ex, sessionId, files); }
        });
    }

    private static async Task<(Func<string, bool> Accessible, string[] Roots)> Authority(FileService files, string sessionId)
    {
        if (!files.IsSessionValid(sessionId)) throw new FileDocumentException(404, "session_closed", "The selected session is no longer available.");
        var cwd = await files.GetSessionWorkingDirectoryAsync(sessionId);
        var roots = files.GetNavigationRoots(sessionId, cwd).Where(root => root.Kind is "cwd" or "repo").Select(root => root.Path).ToArray();
        return (path => files.IsPathAccessible(sessionId, path, cwd), roots);
    }

    private static async Task<T> AsSessionOwner<T>(FileOperationService operations, FileService files, SettingsService settings,
        string sessionId, Func<FileOperationService, Task<T>> action)
    {
        if (!OperatingSystem.IsWindows() || !settings.IsRunningAsService) return await action(operations);
        return await AsWindowsSessionOwner(operations, files, sessionId, action);
    }

    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    private static async Task<T> AsWindowsSessionOwner<T>(FileOperationService operations, FileService files,
        string sessionId, Func<FileOperationService, Task<T>> action)
    {
        var host = files.GetSessionHostIdentity(sessionId) ?? throw new FileDocumentException(404, "session_closed", "The session host is no longer available.");
        var sid = await SessionCallerIdentity.RunForSessionAsync(host.Pid, host.Started, () => {
            using var identity = System.Security.Principal.WindowsIdentity.GetCurrent();
            return Task.FromResult(identity.User?.Value ?? throw new UnauthorizedAccessException());
        });
        var scoped = operations.ForOwner(sid);
        scoped.GrantStorageOwner(sid);
        return await SessionCallerIdentity.RunForSessionAsync(host.Pid, host.Started, () => action(scoped));
    }

    private static bool IsOperationError(Exception ex) => ex is IOException or UnauthorizedAccessException or
        FileDocumentException or System.ComponentModel.Win32Exception or ArgumentException or System.Text.Json.JsonException or SessionCallerIdentityException;
}
