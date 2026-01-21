using Ai.Tlbx.MidTerm.Models;
using Microsoft.AspNetCore.StaticFiles;

namespace Ai.Tlbx.MidTerm.Services;

public static class FileEndpoints
{
    private static readonly FileExtensionContentTypeProvider _contentTypeProvider = new();

    public static void MapFileEndpoints(WebApplication app)
    {
        app.MapPost("/api/files/check", async (FileCheckRequest request) =>
        {
            var results = new Dictionary<string, FilePathInfo>();

            foreach (var path in request.Paths)
            {
                results[path] = await GetFileInfoAsync(path);
            }

            return Results.Json(
                new FileCheckResponse { Results = results },
                AppJsonContext.Default.FileCheckResponse);
        });

        app.MapGet("/api/files/list", (string path) =>
        {
            if (!ValidatePath(path, out var errorResult))
            {
                return errorResult!;
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

        app.MapGet("/api/files/view", (string path) =>
        {
            return ServeFile(path, inline: true);
        });

        app.MapGet("/api/files/download", (string path) =>
        {
            return ServeFile(path, inline: false);
        });
    }

    private static IResult ServeFile(string path, bool inline)
    {
        if (!ValidatePath(path, out var errorResult))
        {
            return errorResult!;
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

            var disposition = inline ? "inline" : "attachment";

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
