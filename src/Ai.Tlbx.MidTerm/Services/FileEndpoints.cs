using Ai.Tlbx.MidTerm.Models.Files;
using Ai.Tlbx.MidTerm.Services.Sessions;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Services;

public static class FileEndpoints
{
    public static void MapFileEndpoints(
        WebApplication app,
        TtyHostSessionManager sessionManager,
        SessionPathAllowlistService allowlistService,
        SettingsService settingsService)
    {
        var fileService = new FileService(sessionManager, allowlistService);

        app.MapGet("/api/files/picker/home", () =>
        {
            var homePath = ResolveLauncherHomePath(settingsService.Load());
            return Results.Json(
                new LauncherPathResponse { Path = homePath },
                AppJsonContext.Default.LauncherPathResponse);
        });

        app.MapGet("/api/files/picker/roots", () =>
        {
            var roots = GetLauncherRootEntries().ToArray();
            return Results.Json(
                new LauncherDirectoryListResponse
                {
                    Path = string.Empty,
                    ParentPath = null,
                    Entries = roots
                },
                AppJsonContext.Default.LauncherDirectoryListResponse);
        });

        app.MapGet("/api/files/picker/directories", (string path) =>
        {
            if (string.IsNullOrWhiteSpace(path))
            {
                return Results.BadRequest("Path is required");
            }

            if (!TryNormalizeExistingDirectory(path, out var fullPath, out var errorResult))
            {
                return errorResult!;
            }

            try
            {
                var entries = Directory.EnumerateDirectories(fullPath)
                    .Select(directory => new LauncherDirectoryEntry
                    {
                        Name = Path.GetFileName(directory),
                        FullPath = directory,
                        IsRoot = false
                    })
                    .OrderBy(entry => entry.Name, StringComparer.OrdinalIgnoreCase)
                    .ToArray();

                var parentPath = Directory.GetParent(fullPath)?.FullName;
                return Results.Json(
                    new LauncherDirectoryListResponse
                    {
                        Path = fullPath,
                        ParentPath = parentPath,
                        Entries = entries
                    },
                    AppJsonContext.Default.LauncherDirectoryListResponse);
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

        app.MapPut("/api/files/save", async (FileSaveRequest request, string? sessionId) =>
        {
            if (!FileService.ValidatePath(request.Path, out var errorResult))
            {
                return errorResult!;
            }

            var workingDir = await fileService.GetSessionWorkingDirectoryAsync(sessionId);
            if (!string.IsNullOrEmpty(sessionId) &&
                !fileService.IsPathAccessible(sessionId, request.Path, workingDir))
            {
                return Results.StatusCode(403);
            }

            var fullPath = Path.GetFullPath(request.Path);

            if (!File.Exists(fullPath))
            {
                return Results.NotFound("File not found");
            }

            try
            {
                await File.WriteAllTextAsync(fullPath, request.Content);
                var fileInfo = new FileInfo(fullPath);
                return Results.Json(
                    new FileSaveResponse { Success = true, Size = fileInfo.Length },
                    AppJsonContext.Default.FileSaveResponse);
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

    private static string ResolveLauncherHomePath(MidTermSettings settings)
    {
        if (OperatingSystem.IsWindows())
        {
            var configuredProfile = LensHostEnvironmentResolver.ResolveWindowsProfileDirectory(
                settings.RunAsUser,
                settings.RunAsUserSid);

            if (!string.IsNullOrWhiteSpace(configuredProfile) && Directory.Exists(configuredProfile))
            {
                return configuredProfile;
            }
        }
        else if (!string.IsNullOrWhiteSpace(settings.RunAsUser))
        {
            var unixHome = Path.Combine("/home", settings.RunAsUser);
            if (Directory.Exists(unixHome))
            {
                return unixHome;
            }
        }

        return Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    }

    private static IEnumerable<LauncherDirectoryEntry> GetLauncherRootEntries()
    {
        if (OperatingSystem.IsWindows())
        {
            return DriveInfo.GetDrives()
                .Select(static drive => new LauncherDirectoryEntry
                {
                    Name = drive.Name,
                    FullPath = drive.RootDirectory.FullName,
                    IsRoot = true
                })
                .OrderBy(static entry => entry.FullPath, StringComparer.OrdinalIgnoreCase);
        }

        return new[]
        {
            new LauncherDirectoryEntry
            {
                Name = "/",
                FullPath = "/",
                IsRoot = true
            }
        };
    }

    private static bool TryNormalizeExistingDirectory(
        string path,
        out string fullPath,
        out IResult? errorResult)
    {
        fullPath = string.Empty;
        errorResult = null;

        path = NormalizeLauncherPath(path);
        if (string.IsNullOrWhiteSpace(path))
        {
            errorResult = Results.BadRequest("Path is required");
            return false;
        }

        try
        {
            fullPath = Path.GetFullPath(path);
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
        {
            errorResult = Results.BadRequest("Invalid path");
            return false;
        }

        if (!Directory.Exists(fullPath))
        {
            errorResult = Results.NotFound("Directory not found");
            return false;
        }

        return true;
    }

    private static string NormalizeLauncherPath(string path)
    {
        var trimmed = path.Trim();
        if (trimmed.Length >= 2 &&
            ((trimmed[0] == '"' && trimmed[^1] == '"') ||
             (trimmed[0] == '\'' && trimmed[^1] == '\'')))
        {
            trimmed = trimmed[1..^1];
        }

        return Environment.ExpandEnvironmentVariables(trimmed);
    }
}
