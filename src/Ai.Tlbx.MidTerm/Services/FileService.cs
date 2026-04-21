using Ai.Tlbx.MidTerm.Models.Files;
using Ai.Tlbx.MidTerm.Services.Sessions;
using Microsoft.AspNetCore.StaticFiles;

namespace Ai.Tlbx.MidTerm.Services;

public sealed class FileService
{
    private const int FileInfoCacheMaxEntries = 2048;
    private const long FileInfoCachePositiveTtlTicks = TimeSpan.TicksPerSecond * 15;
    private const long FileInfoCacheNegativeTtlTicks = TimeSpan.TicksPerSecond * 5;
    private static readonly FileExtensionContentTypeProvider _contentTypeProvider = new();
    private static readonly Lock _fileInfoCacheLock = new();
    private static readonly Dictionary<string, FileInfoCacheEntry> _fileInfoCache = new(StringComparer.OrdinalIgnoreCase);
    private static readonly FileInfoCacheSlot[] _fileInfoCacheRing = new FileInfoCacheSlot[FileInfoCacheMaxEntries];
    private static int _fileInfoCacheRingIndex;
    private static long _fileInfoCacheGeneration;

    private static readonly HashSet<string> _skipDirectories = new(StringComparer.OrdinalIgnoreCase)
    {
        "node_modules", ".git", "bin", "obj", "__pycache__", ".next",
        ".nuget", "packages", ".vs", ".idea", ".cache", ".npm", ".yarn", "vendor"
    };

    private readonly TtyHostSessionManager _sessionManager;
    private readonly SessionPathAllowlistService _allowlistService;

    public FileService(TtyHostSessionManager sessionManager, SessionPathAllowlistService allowlistService)
    {
        _sessionManager = sessionManager;
        _allowlistService = allowlistService;
    }

    public void RegisterPaths(string sessionId, IEnumerable<string> paths)
    {
        _allowlistService.RegisterPaths(sessionId, paths);
    }

    public void RegisterPath(string sessionId, string path)
    {
        _allowlistService.RegisterPath(sessionId, path);
    }

    public bool IsSessionValid(string sessionId) =>
        _sessionManager.GetSession(sessionId) is not null;

    public async Task<string?> GetSessionWorkingDirectoryAsync(string? sessionId)
    {
        if (string.IsNullOrEmpty(sessionId)) return null;
        var session = _sessionManager.GetSession(sessionId);
        if (session?.CurrentDirectory is not null) return session.CurrentDirectory;
        var fresh = await _sessionManager.GetSessionFreshAsync(sessionId);
        return fresh?.CurrentDirectory;
    }

    public bool IsPathAccessible(string sessionId, string path, string? workingDirectory) =>
        _allowlistService.IsPathAllowed(sessionId, path, workingDirectory);

    public static bool ValidatePath(string path, out IResult? errorResult)
    {
        errorResult = null;

        if (string.IsNullOrWhiteSpace(path))
        {
            errorResult = Results.BadRequest("Path is required");
            return false;
        }

        if (path.Contains("..", StringComparison.Ordinal))
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

    public static bool IsWithinDirectory(string path, string directory)
    {
        var normalizedPath = Path.GetFullPath(path);
        var normalizedDir = Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        return normalizedPath.StartsWith(normalizedDir + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
               normalizedPath.Equals(normalizedDir, StringComparison.OrdinalIgnoreCase);
    }

    public static IEnumerable<string> GetSlashVariants(string path)
    {
        yield return path;

        if (path.Contains('/', StringComparison.Ordinal))
        {
            var windowsPath = path.Replace('/', '\\');
            if (windowsPath != path)
            {
                yield return windowsPath;
            }
        }
        else if (path.Contains('\\', StringComparison.Ordinal))
        {
            var unixPath = path.Replace('\\', '/');
            if (unixPath != path)
            {
                yield return unixPath;
            }
        }
    }

    public static string? SearchTree(string rootDir, string searchPattern, int maxDepth)
    {
        var hasDirectory = searchPattern.Contains('/', StringComparison.Ordinal) || searchPattern.Contains('\\', StringComparison.Ordinal);
        var normalizedPattern = searchPattern.Replace('\\', '/');

        try
        {
            var queue = new Queue<(string Dir, int Depth)>();
            queue.Enqueue((rootDir, 0));

            while (queue.Count > 0)
            {
                var (currentDir, depth) = queue.Dequeue();

                foreach (var file in Directory.EnumerateFiles(currentDir))
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

                if (depth >= maxDepth) continue;

                foreach (var subDir in Directory.EnumerateDirectories(currentDir))
                {
                    var dirName = Path.GetFileName(subDir);
                    if (_skipDirectories.Contains(dirName)) continue;

                    var relativePath = Path.GetRelativePath(rootDir, subDir).Replace('\\', '/');

                    if (hasDirectory)
                    {
                        if (relativePath.EndsWith(normalizedPattern, StringComparison.OrdinalIgnoreCase) ||
                            relativePath.Equals(normalizedPattern, StringComparison.OrdinalIgnoreCase))
                        {
                            return subDir;
                        }
                    }
                    else
                    {
                        if (dirName.Equals(searchPattern, StringComparison.OrdinalIgnoreCase))
                        {
                            return subDir;
                        }
                    }

                    queue.Enqueue((subDir, depth + 1));
                }
            }
        }
        catch
        {
        }

        return null;
    }

    public static FileResolveResponse BuildResolveResponse(string resolvedPath)
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
            response.IsText = CheckIsText(resolvedPath, fileInfo.Length);
        }

        return response;
    }

    public static FilePathInfo GetFileInfo(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || path.Contains("..", StringComparison.Ordinal))
        {
            return new FilePathInfo { Exists = false };
        }

        try
        {
            var fullPath = Path.GetFullPath(path);
            if (TryGetCachedFileInfo(fullPath, out var cached))
            {
                return cached;
            }

            var info = GetFileInfoUncached(fullPath);
            SetCachedFileInfo(fullPath, info);
            return info;
        }
        catch
        {
            return new FilePathInfo { Exists = false };
        }
    }

    internal static void ResetFileInfoCacheForTests()
    {
        lock (_fileInfoCacheLock)
        {
            _fileInfoCache.Clear();
            Array.Clear(_fileInfoCacheRing);
            _fileInfoCacheRingIndex = 0;
            _fileInfoCacheGeneration = 0;
        }
    }

    public static bool? CheckIsText(string filePath, long fileSize)
    {
        if (fileSize == 0)
        {
            return true;
        }

        try
        {
            var sampleSize = (int)Math.Min(8192, fileSize);
            var buffer = new byte[sampleSize];

            using var fs = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            var bytesRead = fs.Read(buffer, 0, sampleSize);

            for (var i = 0; i < bytesRead; i++)
            {
                if (buffer[i] == 0)
                {
                    return false;
                }
            }

            return true;
        }
        catch
        {
            return null;
        }
    }

    public static string GetMimeType(string fileName)
    {
        if (_contentTypeProvider.TryGetContentType(fileName, out var contentType))
        {
            return contentType;
        }

        return "application/octet-stream";
    }

    public static HashSet<string> SkipDirectories => _skipDirectories;

    private static FilePathInfo GetFileInfoUncached(string fullPath)
    {
        var info = new FilePathInfo { Exists = false };

        if (Directory.Exists(fullPath))
        {
            var dirInfo = new DirectoryInfo(fullPath);
            info.Exists = true;
            info.IsDirectory = true;
            info.Modified = dirInfo.LastWriteTimeUtc;
            return info;
        }

        if (File.Exists(fullPath))
        {
            var fileInfo = new FileInfo(fullPath);
            info.Exists = true;
            info.IsDirectory = false;
            info.Size = fileInfo.Length;
            info.Modified = fileInfo.LastWriteTimeUtc;
            info.MimeType = GetMimeType(fileInfo.Name);
            info.IsText = CheckIsText(fullPath, fileInfo.Length);
        }

        return info;
    }

    private static bool TryGetCachedFileInfo(string fullPath, out FilePathInfo info)
    {
        lock (_fileInfoCacheLock)
        {
            if (_fileInfoCache.TryGetValue(fullPath, out var cached))
            {
                if (cached.ExpiresAtUtcTicks > DateTime.UtcNow.Ticks)
                {
                    info = CloneFilePathInfo(cached.Info);
                    return true;
                }

                _fileInfoCache.Remove(fullPath);
            }
        }

        info = new FilePathInfo { Exists = false };
        return false;
    }

    private static void SetCachedFileInfo(string fullPath, FilePathInfo info)
    {
        var expiresAtUtcTicks = DateTime.UtcNow.Ticks +
                                (info.Exists ? FileInfoCachePositiveTtlTicks : FileInfoCacheNegativeTtlTicks);

        lock (_fileInfoCacheLock)
        {
            var nextGeneration = ++_fileInfoCacheGeneration;
            var evictedSlot = _fileInfoCacheRing[_fileInfoCacheRingIndex];
            if (!string.IsNullOrWhiteSpace(evictedSlot.Key) &&
                _fileInfoCache.TryGetValue(evictedSlot.Key, out var current) &&
                current.Generation == evictedSlot.Generation)
            {
                _fileInfoCache.Remove(evictedSlot.Key);
            }

            _fileInfoCache[fullPath] = new FileInfoCacheEntry(CloneFilePathInfo(info), expiresAtUtcTicks, nextGeneration);
            _fileInfoCacheRing[_fileInfoCacheRingIndex] = new FileInfoCacheSlot(fullPath, nextGeneration);
            _fileInfoCacheRingIndex = (_fileInfoCacheRingIndex + 1) % _fileInfoCacheRing.Length;
        }
    }

    private static FilePathInfo CloneFilePathInfo(FilePathInfo info)
    {
        return new FilePathInfo
        {
            Exists = info.Exists,
            Size = info.Size,
            IsDirectory = info.IsDirectory,
            MimeType = info.MimeType,
            Modified = info.Modified,
            IsText = info.IsText
        };
    }

    private readonly record struct FileInfoCacheSlot(string? Key, long Generation);
    private readonly record struct FileInfoCacheEntry(FilePathInfo Info, long ExpiresAtUtcTicks, long Generation);
}
