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

        // Resolve relative path against session's working directory
        // deep=false (default): exact path only (fast, for hover)
        // deep=true: also search CWD tree (slower, for click)
        app.MapGet("/api/files/resolve", async (string sessionId, string path, bool deep = false) =>
        {
            if (string.IsNullOrEmpty(sessionId) || string.IsNullOrEmpty(path) || path.Contains(".."))
            {
                return Results.Json(new FileResolveResponse { Exists = false }, AppJsonContext.Default.FileResolveResponse);
            }

            var session = await sessionManager.GetSessionFreshAsync(sessionId);
            var cwd = session?.CurrentDirectory;
            if (string.IsNullOrEmpty(cwd) || !Directory.Exists(cwd))
            {
                return Results.Json(new FileResolveResponse { Exists = false }, AppJsonContext.Default.FileResolveResponse);
            }

            // Strategy 1: Try exact path relative to CWD (always)
            // Try original path first, then with normalized slashes (WSL/AI tools may use wrong style)
            foreach (var tryPath in GetSlashVariants(path))
            {
                var exactPath = Path.GetFullPath(Path.Combine(cwd, tryPath));
                if (IsWithinDirectory(exactPath, cwd) && (File.Exists(exactPath) || Directory.Exists(exactPath)))
                {
                    return Results.Json(BuildResolveResponse(exactPath), AppJsonContext.Default.FileResolveResponse);
                }
            }

            // Strategy 2: Search CWD tree (only on click, when deep=true)
            if (deep)
            {
                foreach (var tryPath in GetSlashVariants(path))
                {
                    var found = SearchTree(cwd, tryPath, maxDepth: 5);
                    if (found is not null && IsWithinDirectory(found, cwd))
                    {
                        return Results.Json(BuildResolveResponse(found), AppJsonContext.Default.FileResolveResponse);
                    }
                }
            }

            return Results.Json(new FileResolveResponse { Exists = false }, AppJsonContext.Default.FileResolveResponse);
        });
    }

    private static IEnumerable<string> GetSlashVariants(string path)
    {
        yield return path;

        // Try opposite slash style (WSL/AI tools may use wrong slashes)
        if (path.Contains('/'))
        {
            var windowsPath = path.Replace('/', '\\');
            if (windowsPath != path)
            {
                yield return windowsPath;
            }
        }
        else if (path.Contains('\\'))
        {
            var unixPath = path.Replace('\\', '/');
            if (unixPath != path)
            {
                yield return unixPath;
            }
        }
    }

    private static string? SearchTree(string rootDir, string searchPattern, int maxDepth)
    {
        var hasDirectory = searchPattern.Contains('/') || searchPattern.Contains('\\');
        var normalizedPattern = searchPattern.Replace('\\', '/');

        try
        {
            var options = new EnumerationOptions
            {
                RecurseSubdirectories = true,
                MaxRecursionDepth = maxDepth,
                IgnoreInaccessible = true
            };

            foreach (var file in Directory.EnumerateFiles(rootDir, "*", options))
            {
                var relativePath = Path.GetRelativePath(rootDir, file).Replace('\\', '/');

                if (hasDirectory)
                {
                    if (relativePath.EndsWith(normalizedPattern, StringComparison.OrdinalIgnoreCase) ||
                        relativePath.Equals(normalizedPattern, StringComparison.OrdinalIgnoreCase))
                    {
                        return file;
                    }
                }
                else
                {
                    if (Path.GetFileName(file).Equals(searchPattern, StringComparison.OrdinalIgnoreCase))
                    {
                        return file;
                    }
                }
            }
        }
        catch
        {
        }

        return null;
    }

    private static bool IsWithinDirectory(string path, string directory)
    {
        var normalizedPath = Path.GetFullPath(path);
        var normalizedDir = Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        return normalizedPath.StartsWith(normalizedDir + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
               normalizedPath.Equals(normalizedDir, StringComparison.OrdinalIgnoreCase);
    }

    private static FileResolveResponse BuildResolveResponse(string resolvedPath)
    {
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

        return response;
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
