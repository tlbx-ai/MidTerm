using Ai.Tlbx.MidTerm.Models.Files;
using Ai.Tlbx.MidTerm.Services.Sessions;

namespace Ai.Tlbx.MidTerm.Services;

public static class FileEndpoints
{
    public static void MapFileEndpoints(
        WebApplication app,
        TtyHostSessionManager sessionManager,
        SessionPathAllowlistService allowlistService)
    {
        var fileService = new FileService(sessionManager, allowlistService);

        app.MapPost("/api/files/register", (FileRegisterRequest request) =>
        {
            if (string.IsNullOrEmpty(request.SessionId))
            {
                return Results.BadRequest("sessionId is required");
            }

            if (!fileService.IsSessionValid(request.SessionId))
            {
                return Results.BadRequest("Invalid session");
            }

            fileService.RegisterPaths(request.SessionId, request.Paths);
            return Results.Ok();
        });

        app.MapPost("/api/files/check", async (FileCheckRequest request, string? sessionId) =>
        {
            var results = new Dictionary<string, FilePathInfo>();
            var workingDir = await fileService.GetSessionWorkingDirectoryAsync(sessionId);

            foreach (var path in request.Paths)
            {
                if (!string.IsNullOrEmpty(sessionId) &&
                    !fileService.IsPathAccessible(sessionId, path, workingDir))
                {
                    results[path] = new FilePathInfo { Exists = false };
                    continue;
                }

                results[path] = FileService.GetFileInfo(path);
            }

            return Results.Json(
                new FileCheckResponse { Results = results },
                AppJsonContext.Default.FileCheckResponse);
        });

        app.MapGet("/api/files/list", async (string path, string? sessionId) =>
        {
            if (!FileService.ValidatePath(path, out var errorResult))
            {
                return errorResult!;
            }

            var workingDir = await fileService.GetSessionWorkingDirectoryAsync(sessionId);
            if (!string.IsNullOrEmpty(sessionId) &&
                !fileService.IsPathAccessible(sessionId, path, workingDir))
            {
                return Results.StatusCode(403);
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
                    try
                    {
                        var dirInfo = new DirectoryInfo(dir);
                        entries.Add(new DirectoryEntry
                        {
                            Name = dirInfo.Name,
                            IsDirectory = true,
                            Modified = dirInfo.LastWriteTimeUtc
                        });
                    }
                    catch { }
                }

                foreach (var file in Directory.EnumerateFiles(fullPath))
                {
                    try
                    {
                        var fileInfo = new FileInfo(file);
                        entries.Add(new DirectoryEntry
                        {
                            Name = fileInfo.Name,
                            IsDirectory = false,
                            Size = fileInfo.Length,
                            Modified = fileInfo.LastWriteTimeUtc,
                            MimeType = FileService.GetMimeType(fileInfo.Name)
                        });
                    }
                    catch { }
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
                return Results.StatusCode(403);
            }
            catch (IOException ex)
            {
                return Results.Problem(ex.Message);
            }
        });

        app.MapGet("/api/files/view", async (string path, string? sessionId) =>
        {
            return await ServeFileAsync(path, inline: true, sessionId, fileService);
        });

        app.MapGet("/api/files/download", async (string path, string? sessionId) =>
        {
            return await ServeFileAsync(path, inline: false, sessionId, fileService);
        });

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

            foreach (var tryPath in FileService.GetSlashVariants(path))
            {
                var exactPath = Path.GetFullPath(Path.Combine(cwd, tryPath));
                if (FileService.IsWithinDirectory(exactPath, cwd) && (File.Exists(exactPath) || Directory.Exists(exactPath)))
                {
                    fileService.RegisterPath(sessionId, exactPath);
                    return Results.Json(FileService.BuildResolveResponse(exactPath), AppJsonContext.Default.FileResolveResponse);
                }
            }

            if (deep)
            {
                foreach (var tryPath in FileService.GetSlashVariants(path))
                {
                    var found = FileService.SearchTree(cwd, tryPath, maxDepth: 5);
                    if (found is not null && FileService.IsWithinDirectory(found, cwd))
                    {
                        fileService.RegisterPath(sessionId, found);
                        return Results.Json(FileService.BuildResolveResponse(found), AppJsonContext.Default.FileResolveResponse);
                    }
                }
            }

            return Results.Json(new FileResolveResponse { Exists = false }, AppJsonContext.Default.FileResolveResponse);
        });

        app.MapGet("/api/files/tree", async (string path, string? sessionId, int depth) =>
        {
            if (string.IsNullOrWhiteSpace(path) || path.Contains(".."))
            {
                return Results.BadRequest("Invalid path");
            }

            var fullPath = Path.GetFullPath(path);
            if (!Directory.Exists(fullPath))
            {
                return Results.NotFound("Directory not found");
            }

            if (!string.IsNullOrEmpty(sessionId))
            {
                var workingDir = await fileService.GetSessionWorkingDirectoryAsync(sessionId);
                if (!string.IsNullOrEmpty(workingDir) && !FileService.IsWithinDirectory(fullPath, workingDir))
                {
                    return Results.StatusCode(403);
                }
            }

            var isGitRepo = false;
            HashSet<string>? gitFiles = null;

            try
            {
                var psi = new System.Diagnostics.ProcessStartInfo
                {
                    FileName = "git",
                    Arguments = "ls-files -co --exclude-standard",
                    WorkingDirectory = fullPath,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true
                };

                using var process = System.Diagnostics.Process.Start(psi);
                if (process is not null)
                {
                    using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                    var output = await process.StandardOutput.ReadToEndAsync(cts.Token);
                    await process.WaitForExitAsync(cts.Token);

                    if (process.ExitCode == 0)
                    {
                        isGitRepo = true;
                        gitFiles = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                        foreach (var line in output.Split('\n', StringSplitOptions.RemoveEmptyEntries))
                        {
                            gitFiles.Add(line.Trim());
                            var dir = Path.GetDirectoryName(line.Trim());
                            while (!string.IsNullOrEmpty(dir))
                            {
                                gitFiles.Add(dir);
                                dir = Path.GetDirectoryName(dir);
                            }
                        }
                    }
                }
            }
            catch
            {
            }

            var entries = new List<FileTreeEntry>();

            try
            {
                foreach (var dir in Directory.EnumerateDirectories(fullPath))
                {
                    var dirName = Path.GetFileName(dir);

                    if (isGitRepo && gitFiles is not null)
                    {
                        var relativePath = Path.GetRelativePath(fullPath, dir).Replace('\\', '/');
                        if (!gitFiles.Contains(relativePath) && dirName != ".git")
                        {
                            var prefix = relativePath + "/";
                            if (!gitFiles.Any(f => f.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)))
                            {
                                continue;
                            }
                        }
                        if (dirName == ".git") continue;
                    }
                    else
                    {
                        if (FileService.SkipDirectories.Contains(dirName)) continue;
                    }

                    entries.Add(new FileTreeEntry
                    {
                        Name = dirName,
                        FullPath = dir,
                        IsDirectory = true
                    });
                }

                foreach (var file in Directory.EnumerateFiles(fullPath))
                {
                    var fileName = Path.GetFileName(file);

                    if (isGitRepo && gitFiles is not null)
                    {
                        var relativePath = Path.GetRelativePath(fullPath, file).Replace('\\', '/');
                        if (!gitFiles.Contains(relativePath)) continue;
                    }

                    try
                    {
                        var fileInfo = new FileInfo(file);
                        entries.Add(new FileTreeEntry
                        {
                            Name = fileName,
                            FullPath = file,
                            IsDirectory = false,
                            Size = fileInfo.Length,
                            MimeType = FileService.GetMimeType(fileName)
                        });
                    }
                    catch { }
                }

                entries = entries
                    .OrderByDescending(e => e.IsDirectory)
                    .ThenBy(e => e.Name, StringComparer.OrdinalIgnoreCase)
                    .ToList();
            }
            catch (UnauthorizedAccessException)
            {
                return Results.StatusCode(403);
            }

            var response = new FileTreeResponse
            {
                Path = fullPath,
                Entries = entries.ToArray(),
                IsGitRepo = isGitRepo
            };

            return Results.Json(response, AppJsonContext.Default.FileTreeResponse);
        });
    }

    private static async Task<IResult> ServeFileAsync(
        string path,
        bool inline,
        string? sessionId,
        FileService fileService)
    {
        if (!FileService.ValidatePath(path, out var errorResult))
        {
            return errorResult!;
        }

        var workingDir = await fileService.GetSessionWorkingDirectoryAsync(sessionId);
        if (!string.IsNullOrEmpty(sessionId) &&
            !fileService.IsPathAccessible(sessionId, path, workingDir))
        {
            return Results.StatusCode(403);
        }

        var fullPath = Path.GetFullPath(path);

        if (!File.Exists(fullPath))
        {
            return Results.NotFound("File not found");
        }

        try
        {
            var fileInfo = new FileInfo(fullPath);
            var mimeType = FileService.GetMimeType(fileInfo.Name);
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
            return Results.StatusCode(403);
        }
        catch (IOException ex)
        {
            return Results.Problem(ex.Message);
        }
    }
}
