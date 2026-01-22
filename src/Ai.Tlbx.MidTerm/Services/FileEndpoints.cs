using Ai.Tlbx.MidTerm.Models;
using Microsoft.AspNetCore.StaticFiles;

namespace Ai.Tlbx.MidTerm.Services;

public static class FileEndpoints
{
    private static readonly FileExtensionContentTypeProvider _contentTypeProvider = new();

    public static void MapFileEndpoints(
        WebApplication app,
        TtyHostSessionManager sessionManager,
        FileRadarAllowlistService allowlistService)
    {
        app.MapPost("/api/files/register", (FileRegisterRequest request) =>
        {
            if (string.IsNullOrEmpty(request.SessionId))
            {
                return Results.BadRequest("sessionId is required");
            }

            if (sessionManager.GetSession(request.SessionId) is null)
            {
                return Results.BadRequest("Invalid session");
            }

            allowlistService.RegisterPaths(request.SessionId, request.Paths);
            return Results.Ok();
        });

        app.MapPost("/api/files/check", async (FileCheckRequest request, string? sessionId) =>
        {
            var results = new Dictionary<string, FilePathInfo>();
            var workingDir = GetSessionWorkingDirectory(sessionManager, sessionId);

            foreach (var path in request.Paths)
            {
                // For check, we verify the path is accessible before returning info
                if (!string.IsNullOrEmpty(sessionId) &&
                    !IsPathAccessible(sessionId, path, workingDir, allowlistService))
                {
                    results[path] = new FilePathInfo { Exists = false };
                    continue;
                }

                results[path] = await GetFileInfoAsync(path);
            }

            return Results.Json(
                new FileCheckResponse { Results = results },
                AppJsonContext.Default.FileCheckResponse);
        });

        app.MapGet("/api/files/list", (string path, string? sessionId) =>
        {
            if (!ValidatePath(path, out var errorResult))
            {
                return errorResult!;
            }

            var workingDir = GetSessionWorkingDirectory(sessionManager, sessionId);
            if (!string.IsNullOrEmpty(sessionId) &&
                !IsPathAccessible(sessionId, path, workingDir, allowlistService))
            {
                return Results.Forbid();
            }

            var fullPath = Path.GetFullPath(path);

            if (!Directory.Exists(fullPath))
            {
                return Results.NotFound("Directory not found");
            }

            try
            {
                var entries = new List<DirectoryEntry>();

                foreach (var dir in Directory.EnumerateDirectories(fullPath))
                {
                    var dirInfo = new DirectoryInfo(dir);
                    entries.Add(new DirectoryEntry
                    {
                        Name = dirInfo.Name,
                        IsDirectory = true,
                        Modified = dirInfo.LastWriteTimeUtc
                    });
                }

                foreach (var file in Directory.EnumerateFiles(fullPath))
                {
                    var fileInfo = new FileInfo(file);
                    entries.Add(new DirectoryEntry
                    {
                        Name = fileInfo.Name,
                        IsDirectory = false,
                        Size = fileInfo.Length,
                        Modified = fileInfo.LastWriteTimeUtc,
                        MimeType = GetMimeType(fileInfo.Name)
                    });
                }

                entries = entries
                    .OrderByDescending(e => e.IsDirectory)
                    .ThenBy(e => e.Name, StringComparer.OrdinalIgnoreCase)
                    .ToList();

                return Results.Json(
                    new DirectoryListResponse { Path = fullPath, Entries = entries.ToArray() },
                    AppJsonContext.Default.DirectoryListResponse);
            }
            catch (UnauthorizedAccessException)
            {
                return Results.Forbid();
            }
            catch (IOException ex)
            {
                return Results.Problem(ex.Message);
            }
        });

        app.MapGet("/api/files/view", (string path, string? sessionId) =>
        {
            return ServeFile(path, inline: true, sessionId, sessionManager, allowlistService);
        });

        app.MapGet("/api/files/download", (string path, string? sessionId) =>
        {
            return ServeFile(path, inline: false, sessionId, sessionManager, allowlistService);
        });

        // Resolve relative path against session's working directory (lazy, on hover only)
        app.MapGet("/api/files/resolve", (string sessionId, string path) =>
        {
            if (string.IsNullOrEmpty(sessionId))
            {
                return Results.Json(
                    new FileResolveResponse { Exists = false },
                    AppJsonContext.Default.FileResolveResponse);
            }

            var session = sessionManager.GetSession(sessionId);
            if (session is null)
            {
                return Results.Json(
                    new FileResolveResponse { Exists = false },
                    AppJsonContext.Default.FileResolveResponse);
            }

            var cwd = session.CurrentDirectory;
            if (string.IsNullOrEmpty(cwd))
            {
                return Results.Json(
                    new FileResolveResponse { Exists = false },
                    AppJsonContext.Default.FileResolveResponse);
            }

            // Block path traversal attempts
            if (path.Contains(".."))
            {
                return Results.Json(
                    new FileResolveResponse { Exists = false },
                    AppJsonContext.Default.FileResolveResponse);
            }

            try
            {
                var resolvedPath = Path.GetFullPath(Path.Combine(cwd, path));

                // Security: ensure resolved path stays within cwd tree
                var normalizedCwd = Path.GetFullPath(cwd).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                if (!resolvedPath.StartsWith(normalizedCwd + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) &&
                    !resolvedPath.Equals(normalizedCwd, StringComparison.OrdinalIgnoreCase))
                {
                    return Results.Json(
                        new FileResolveResponse { Exists = false },
                        AppJsonContext.Default.FileResolveResponse);
                }

                var response = new FileResolveResponse { ResolvedPath = resolvedPath };

                if (Directory.Exists(resolvedPath))
                {
                    var dirInfo = new DirectoryInfo(resolvedPath);
                    response.Exists = true;
                    response.IsDirectory = true;
                    response.Modified = dirInfo.LastWriteTimeUtc;
                }
                else if (File.Exists(resolvedPath))
                {
                    var fileInfo = new FileInfo(resolvedPath);
                    response.Exists = true;
                    response.IsDirectory = false;
                    response.Size = fileInfo.Length;
                    response.Modified = fileInfo.LastWriteTimeUtc;
                    response.MimeType = GetMimeType(fileInfo.Name);
                }

                return Results.Json(response, AppJsonContext.Default.FileResolveResponse);
            }
            catch
            {
                return Results.Json(
                    new FileResolveResponse { Exists = false },
                    AppJsonContext.Default.FileResolveResponse);
            }
        });
    }

    private static string? GetSessionWorkingDirectory(TtyHostSessionManager sessionManager, string? sessionId)
    {
        if (string.IsNullOrEmpty(sessionId)) return null;
        var session = sessionManager.GetSession(sessionId);
        return session?.CurrentDirectory;
    }

    private static bool IsPathAccessible(
        string sessionId,
        string path,
        string? workingDirectory,
        FileRadarAllowlistService allowlistService)
    {
        return allowlistService.IsPathAllowed(sessionId, path, workingDirectory);
    }

    private static IResult ServeFile(
        string path,
        bool inline,
        string? sessionId,
        TtyHostSessionManager sessionManager,
        FileRadarAllowlistService allowlistService)
    {
        if (!ValidatePath(path, out var errorResult))
        {
            return errorResult!;
        }

        var workingDir = GetSessionWorkingDirectory(sessionManager, sessionId);
        if (!string.IsNullOrEmpty(sessionId) &&
            !IsPathAccessible(sessionId, path, workingDir, allowlistService))
        {
            return Results.Forbid();
        }

        var fullPath = Path.GetFullPath(path);

        if (!File.Exists(fullPath))
        {
            return Results.NotFound("File not found");
        }

        try
        {
            var fileInfo = new FileInfo(fullPath);
            var mimeType = GetMimeType(fileInfo.Name);
            var fileName = fileInfo.Name;

            var stream = new FileStream(
                fullPath,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete);

            return Results.Stream(
                stream,
                mimeType,
                inline ? null : fileName,
                enableRangeProcessing: true);
        }
        catch (UnauthorizedAccessException)
        {
            return Results.Forbid();
        }
        catch (IOException ex)
        {
            return Results.Problem(ex.Message);
        }
    }

    private static bool ValidatePath(string path, out IResult? errorResult)
    {
        errorResult = null;

        if (string.IsNullOrWhiteSpace(path))
        {
            errorResult = Results.BadRequest("Path is required");
            return false;
        }

        if (path.Contains(".."))
        {
            errorResult = Results.BadRequest("Path traversal not allowed");
            return false;
        }

        if (!Path.IsPathRooted(path))
        {
            errorResult = Results.BadRequest("Absolute path required");
            return false;
        }

        return true;
    }

    private static async Task<FilePathInfo> GetFileInfoAsync(string path)
    {
        var info = new FilePathInfo { Exists = false };

        if (string.IsNullOrWhiteSpace(path) || path.Contains(".."))
        {
            return info;
        }

        try
        {
            var fullPath = Path.GetFullPath(path);

            if (Directory.Exists(fullPath))
            {
                var dirInfo = new DirectoryInfo(fullPath);
                info.Exists = true;
                info.IsDirectory = true;
                info.Modified = dirInfo.LastWriteTimeUtc;
            }
            else if (File.Exists(fullPath))
            {
                var fileInfo = new FileInfo(fullPath);
                info.Exists = true;
                info.IsDirectory = false;
                info.Size = fileInfo.Length;
                info.Modified = fileInfo.LastWriteTimeUtc;
                info.MimeType = GetMimeType(fileInfo.Name);
            }
        }
        catch
        {
        }

        return await Task.FromResult(info);
    }

    private static string GetMimeType(string fileName)
    {
        if (_contentTypeProvider.TryGetContentType(fileName, out var contentType))
        {
            return contentType;
        }

        return "application/octet-stream";
    }
}
