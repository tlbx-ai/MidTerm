using System.Runtime.InteropServices;
using Ai.Tlbx.MidTerm.Common.Protocol;
using Ai.Tlbx.MidTerm.Models;
using Ai.Tlbx.MidTerm.Common.Shells;

namespace Ai.Tlbx.MidTerm.Services;

public static partial class SessionApiEndpoints
{
    [LibraryImport("kernel32.dll", EntryPoint = "GetShortPathNameW", StringMarshalling = StringMarshalling.Utf16)]
    private static partial uint GetShortPathName(string lpszLongPath, char[] lpszShortPath, uint cchBuffer);

    private static string ToShortPath(string path)
    {
        if (!OperatingSystem.IsWindows())
        {
            return path;
        }

        var buffer = new char[260];
        var length = GetShortPathName(path, buffer, (uint)buffer.Length);
        return length > 0 ? new string(buffer, 0, (int)length) : path;
    }

    public static void MapSessionEndpoints(
        WebApplication app,
        TtyHostSessionManager sessionManager,
        ClipboardService clipboardService)
    {
        app.MapGet("/api/sessions", () =>
        {
            return Results.Json(sessionManager.GetSessionList(), AppJsonContext.Default.SessionListDto);
        });

        app.MapPost("/api/sessions", async (CreateSessionRequest? request) =>
        {
            var cols = request?.Cols ?? 120;
            var rows = request?.Rows ?? 30;

            ShellType? shellType = null;
            if (!string.IsNullOrEmpty(request?.Shell) && Enum.TryParse<ShellType>(request.Shell, true, out var parsed))
            {
                shellType = parsed;
            }

            var sessionInfo = await sessionManager.CreateSessionAsync(
                shellType?.ToString(), cols, rows, request?.WorkingDirectory);

            if (sessionInfo is null)
            {
                return Results.Problem("Failed to create session");
            }

            return Results.Json(MapToDto(sessionInfo), AppJsonContext.Default.SessionInfoDto);
        });

        app.MapDelete("/api/sessions/{id}", async (string id) =>
        {
            await sessionManager.CloseSessionAsync(id);
            return Results.Ok();
        });

        app.MapPost("/api/sessions/{id}/resize", async (string id, ResizeRequest request) =>
        {
            var success = await sessionManager.ResizeSessionAsync(id, request.Cols, request.Rows);
            if (!success)
            {
                return Results.NotFound();
            }
            return Results.Json(new ResizeResponse
            {
                Accepted = true,
                Cols = request.Cols,
                Rows = request.Rows
            }, AppJsonContext.Default.ResizeResponse);
        });

        app.MapPut("/api/sessions/{id}/name", async (string id, RenameSessionRequest request, bool auto = false) =>
        {
            if (!await sessionManager.SetSessionNameAsync(id, request.Name, isManual: !auto))
            {
                return Results.NotFound();
            }
            return Results.Ok();
        });

        app.MapPost("/api/sessions/{id}/upload", async (string id, IFormFile file) =>
        {
            if (sessionManager.GetSession(id) is null)
            {
                return Results.NotFound();
            }

            if (file is null || file.Length == 0)
            {
                return Results.BadRequest("No file provided");
            }

            var targetPath = await SaveUploadedFileAsync(sessionManager, id, file);

            // To make Johannes happy
            if (!File.Exists(targetPath))
            {
                return Results.Problem("File write succeeded but file not found");
            }

            // Use 8.3 short path on Windows for compatibility with legacy apps
            var responsePath = ToShortPath(targetPath);

            return Results.Json(new FileUploadResponse { Path = responsePath }, AppJsonContext.Default.FileUploadResponse);
        }).DisableAntiforgery();

        app.MapPost("/api/sessions/{id}/paste-clipboard-image", async (string id, IFormFile file) =>
        {
            if (sessionManager.GetSession(id) is null)
            {
                return Results.NotFound();
            }

            if (file is null || file.Length == 0)
            {
                return Results.BadRequest("No file provided");
            }

            var targetPath = await SaveUploadedFileAsync(sessionManager, id, file);

            var success = await clipboardService.SetFileDropAsync(targetPath);
            if (!success)
            {
                return Results.Problem("Failed to set clipboard");
            }

            await sessionManager.SendInputAsync(id, new byte[] { 0x1b, 0x76 });

            return Results.Ok();
        }).DisableAntiforgery();
    }

    private static async Task<string> SaveUploadedFileAsync(
        TtyHostSessionManager sessionManager, string sessionId, IFormFile file)
    {
        var fileName = Path.GetFileName(file.FileName);
        if (string.IsNullOrWhiteSpace(fileName))
        {
            fileName = $"upload_{DateTime.UtcNow:yyyyMMdd_HHmmss}";
        }

        var tempDir = sessionManager.GetTempDirectory(sessionId);

        var targetPath = Path.Combine(tempDir, fileName);
        var counter = 1;
        var baseName = Path.GetFileNameWithoutExtension(fileName);
        var extension = Path.GetExtension(fileName);
        while (File.Exists(targetPath))
        {
            fileName = $"{baseName}_{counter}{extension}";
            targetPath = Path.Combine(tempDir, fileName);
            counter++;
        }

        await using (var stream = File.Create(targetPath))
        {
            await file.CopyToAsync(stream);
        }

        return targetPath;
    }

    private static SessionInfoDto MapToDto(SessionInfo sessionInfo)
    {
        return new SessionInfoDto
        {
            Id = sessionInfo.Id,
            Pid = sessionInfo.Pid,
            CreatedAt = sessionInfo.CreatedAt,
            IsRunning = sessionInfo.IsRunning,
            ExitCode = sessionInfo.ExitCode,
            Cols = sessionInfo.Cols,
            Rows = sessionInfo.Rows,
            ShellType = sessionInfo.ShellType,
            Name = sessionInfo.Name,
            ManuallyNamed = sessionInfo.ManuallyNamed,
            CurrentDirectory = sessionInfo.CurrentDirectory,
            ForegroundPid = sessionInfo.ForegroundPid,
            ForegroundName = sessionInfo.ForegroundName,
            ForegroundCommandLine = sessionInfo.ForegroundCommandLine
        };
    }
}
