global using Ai.Tlbx.MidTerm.Models.Files;
global using Ai.Tlbx.MidTerm.Services;
global using Ai.Tlbx.MidTerm.Services.Updates;

using System.Collections.Concurrent;

namespace Ai.Tlbx.MidTerm.Settings
{
    public sealed class SettingsService
    {
        public string SettingsDirectory { get; init; } = Path.Combine(Path.GetTempPath(), "mtagenthost-settings");
        public bool IsRunningAsService => false;

        public MidTermSettingsStub Load() => new();

        public sealed class MidTermSettingsStub
        {
            public bool DevMode { get; init; }
        }
    }
}

namespace Ai.Tlbx.MidTerm.Services.Updates
{
    public static class UpdateService
    {
        public static bool IsDevEnvironment => false;
    }
}

namespace Ai.Tlbx.MidTerm.Models.Files
{
    public sealed class FilePathInfo
    {
        public bool Exists { get; set; }
        public long? Size { get; set; }
        public bool IsDirectory { get; set; }
        public string? MimeType { get; set; }
        public DateTime? Modified { get; set; }
        public bool? IsText { get; set; }
    }
}

namespace Ai.Tlbx.MidTerm.Services
{
    public static class LogPaths
    {
        public static string GetLogDirectory(bool isWindowsService, bool isUnixService)
        {
            return Path.Combine(Path.GetTempPath(), "mtagenthost-logs");
        }
    }

    public sealed class SessionPathAllowlistService
    {
        public void RegisterPath(string sessionId, string path)
        {
        }
    }

    public sealed class FileService
    {
        private static readonly Dictionary<string, string> MimeTypes = new(StringComparer.OrdinalIgnoreCase)
        {
            [".avif"] = "image/avif",
            [".bmp"] = "image/bmp",
            [".cs"] = "text/plain",
            [".css"] = "text/css",
            [".gif"] = "image/gif",
            [".html"] = "text/html",
            [".ico"] = "image/x-icon",
            [".jpeg"] = "image/jpeg",
            [".jpg"] = "image/jpeg",
            [".js"] = "text/javascript",
            [".json"] = "application/json",
            [".md"] = "text/markdown",
            [".png"] = "image/png",
            [".ps1"] = "text/plain",
            [".svg"] = "image/svg+xml",
            [".ts"] = "text/plain",
            [".txt"] = "text/plain",
            [".webp"] = "image/webp",
            [".xml"] = "application/xml",
            [".yml"] = "text/yaml",
            [".yaml"] = "text/yaml",
        };

        private static readonly HashSet<string> SkipDirectories = new(StringComparer.OrdinalIgnoreCase)
        {
            ".cache", ".git", ".idea", ".next", ".npm", ".nuget", ".vs", ".yarn",
            "__pycache__", "bin", "node_modules", "obj", "packages", "vendor"
        };

        public static bool IsWithinDirectory(string path, string directory)
        {
            var normalizedPath = Path.GetFullPath(path);
            var normalizedDirectory = Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            return normalizedPath.StartsWith(normalizedDirectory + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
                   normalizedPath.Equals(normalizedDirectory, StringComparison.OrdinalIgnoreCase);
        }

        public static IEnumerable<string> GetSlashVariants(string path)
        {
            yield return path;

            if (path.Contains('/', StringComparison.Ordinal))
            {
                var windowsPath = path.Replace('/', '\\');
                if (!string.Equals(windowsPath, path, StringComparison.Ordinal))
                {
                    yield return windowsPath;
                }
            }
            else if (path.Contains('\\', StringComparison.Ordinal))
            {
                var unixPath = path.Replace('\\', '/');
                if (!string.Equals(unixPath, path, StringComparison.Ordinal))
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
                        else if (Path.GetFileName(file).Equals(searchPattern, StringComparison.OrdinalIgnoreCase))
                        {
                            return file;
                        }
                    }

                    if (depth >= maxDepth)
                    {
                        continue;
                    }

                    foreach (var subDir in Directory.EnumerateDirectories(currentDir))
                    {
                        var directoryName = Path.GetFileName(subDir);
                        if (SkipDirectories.Contains(directoryName))
                        {
                            continue;
                        }

                        var relativePath = Path.GetRelativePath(rootDir, subDir).Replace('\\', '/');
                        if (hasDirectory)
                        {
                            if (relativePath.EndsWith(normalizedPattern, StringComparison.OrdinalIgnoreCase) ||
                                relativePath.Equals(normalizedPattern, StringComparison.OrdinalIgnoreCase))
                            {
                                return subDir;
                            }
                        }
                        else if (directoryName.Equals(searchPattern, StringComparison.OrdinalIgnoreCase))
                        {
                            return subDir;
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

        public static FilePathInfo GetFileInfo(string path)
        {
            if (string.IsNullOrWhiteSpace(path))
            {
                return new FilePathInfo();
            }

            try
            {
                var fullPath = Path.GetFullPath(path);
                if (Directory.Exists(fullPath))
                {
                    var directoryInfo = new DirectoryInfo(fullPath);
                    return new FilePathInfo
                    {
                        Exists = true,
                        IsDirectory = true,
                        Modified = directoryInfo.LastWriteTimeUtc,
                    };
                }

                if (File.Exists(fullPath))
                {
                    var fileInfo = new FileInfo(fullPath);
                    return new FilePathInfo
                    {
                        Exists = true,
                        IsDirectory = false,
                        Size = fileInfo.Length,
                        Modified = fileInfo.LastWriteTimeUtc,
                        MimeType = GetMimeType(fileInfo.Name),
                        IsText = CheckIsText(fullPath, fileInfo.Length),
                    };
                }
            }
            catch
            {
            }

            return new FilePathInfo();
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
                using var stream = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                var read = stream.Read(buffer, 0, sampleSize);
                for (var index = 0; index < read; index += 1)
                {
                    if (buffer[index] == 0)
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
            var extension = Path.GetExtension(fileName);
            return MimeTypes.TryGetValue(extension, out var mimeType)
                ? mimeType
                : "application/octet-stream";
        }
    }
}

namespace Ai.Tlbx.MidTerm.Services.Sessions
{
    public sealed class SessionLensHeatSnapshot
    {
        public static SessionLensHeatSnapshot Cold { get; } = new();

        public double CurrentHeat { get; init; }
        public DateTimeOffset? LastActivityAt { get; init; }
    }

    public sealed class TtyHostSessionManager
    {
        private readonly ConcurrentDictionary<string, HostLensSessionInfo> _sessions = new(StringComparer.Ordinal);

        public HostLensSessionInfo? GetSession(string sessionId)
        {
            return _sessions.TryGetValue(sessionId, out var session) ? session : null;
        }

        public void SetWorkingDirectory(string sessionId, string? workingDirectory)
        {
            if (string.IsNullOrWhiteSpace(sessionId))
            {
                return;
            }

            _sessions[sessionId] = new HostLensSessionInfo
            {
                SessionId = sessionId,
                CurrentDirectory = string.IsNullOrWhiteSpace(workingDirectory) ? null : workingDirectory.Trim(),
            };
        }
    }

    public sealed class HostLensSessionInfo
    {
        public string SessionId { get; init; } = string.Empty;
        public string? CurrentDirectory { get; init; }
    }
}
