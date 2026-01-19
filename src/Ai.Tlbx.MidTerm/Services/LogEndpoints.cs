using System.Text;
using System.Text.RegularExpressions;

namespace Ai.Tlbx.MidTerm.Services;

public static partial class LogEndpoints
{
    public static void MapLogEndpoints(WebApplication app, string logDirectory, TtyHostSessionManager sessionManager)
    {
        app.MapGet("/api/logs/files", () =>
        {
            var files = GetLogFiles(logDirectory, sessionManager);
            return Results.Json(new LogFilesResponse { Files = files }, AppJsonContext.Default.LogFilesResponse);
        });

        app.MapGet("/api/logs/read", (string file, int? lines, bool? fromEnd) =>
        {
            if (string.IsNullOrEmpty(file) || file.Contains("..") || file.Contains('/') || file.Contains('\\'))
            {
                return Results.BadRequest("Invalid file name");
            }

            var filePath = Path.Combine(logDirectory, file);
            if (!File.Exists(filePath))
            {
                return Results.NotFound("Log file not found");
            }

            var result = ReadLogFile(filePath, lines ?? 100, fromEnd ?? true);
            return Results.Json(result, AppJsonContext.Default.LogReadResponse);
        });

        app.MapGet("/api/logs/tail", (string file, long? position) =>
        {
            if (string.IsNullOrEmpty(file) || file.Contains("..") || file.Contains('/') || file.Contains('\\'))
            {
                return Results.BadRequest("Invalid file name");
            }

            var filePath = Path.Combine(logDirectory, file);
            if (!File.Exists(filePath))
            {
                return Results.NotFound("Log file not found");
            }

            var result = TailLogFile(filePath, position ?? 0);
            return Results.Json(result, AppJsonContext.Default.LogReadResponse);
        });
    }

    private static List<LogFileInfo> GetLogFiles(string logDirectory, TtyHostSessionManager sessionManager)
    {
        var files = new List<LogFileInfo>();

        if (!Directory.Exists(logDirectory))
        {
            return files;
        }

        var activeSessions = sessionManager.GetAllSessions().Select(s => s.Id).ToHashSet();

        foreach (var filePath in Directory.EnumerateFiles(logDirectory, "*.log"))
        {
            var fileName = Path.GetFileName(filePath);
            var fileInfo = new FileInfo(filePath);

            string source;
            string? sessionId = null;
            bool isActive = false;

            if (fileName.StartsWith("mt", StringComparison.OrdinalIgnoreCase) && !fileName.StartsWith("mthost", StringComparison.OrdinalIgnoreCase))
            {
                source = "mt";
                isActive = true;
            }
            else if (fileName.StartsWith("mthost-", StringComparison.OrdinalIgnoreCase))
            {
                source = "mthost";
                var match = MtHostLogRegex().Match(fileName);
                if (match.Success)
                {
                    sessionId = match.Groups[1].Value;
                    isActive = activeSessions.Contains(sessionId);
                }
            }
            else
            {
                continue;
            }

            files.Add(new LogFileInfo
            {
                Name = fileName,
                Source = source,
                SessionId = sessionId,
                Size = fileInfo.Length,
                Modified = fileInfo.LastWriteTimeUtc.ToString("O"),
                IsActive = isActive
            });
        }

        return files
            .OrderByDescending(f => f.IsActive)
            .ThenByDescending(f => f.Modified)
            .ToList();
    }

    private static LogReadResponse ReadLogFile(string filePath, int lineCount, bool fromEnd)
    {
        var entries = new List<LogEntryMessage>();
        long position = 0;

        try
        {
            using var fs = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            position = fs.Length;

            if (fromEnd && lineCount > 0)
            {
                entries = ReadLastLines(fs, filePath, lineCount);
            }
            else
            {
                using var reader = new StreamReader(fs, Encoding.UTF8);
                var count = 0;
                while (!reader.EndOfStream && count < lineCount)
                {
                    var line = reader.ReadLine();
                    if (string.IsNullOrWhiteSpace(line)) continue;

                    var entry = ParseLogLine(line, filePath);
                    if (entry is not null)
                    {
                        entries.Add(entry);
                        count++;
                    }
                }
            }
        }
        catch (IOException)
        {
        }

        return new LogReadResponse
        {
            Entries = entries,
            Position = position,
            FileName = Path.GetFileName(filePath)
        };
    }

    private static List<LogEntryMessage> ReadLastLines(FileStream fs, string filePath, int lineCount)
    {
        var lines = new List<string>();
        var buffer = new byte[8192];
        var position = fs.Length;
        var partialLine = new StringBuilder();

        while (position > 0 && lines.Count < lineCount)
        {
            var readSize = (int)Math.Min(buffer.Length, position);
            position -= readSize;
            fs.Seek(position, SeekOrigin.Begin);
            var bytesRead = fs.Read(buffer, 0, readSize);

            var text = Encoding.UTF8.GetString(buffer, 0, bytesRead);

            for (var i = text.Length - 1; i >= 0; i--)
            {
                if (text[i] == '\n')
                {
                    if (partialLine.Length > 0)
                    {
                        var lineChars = new char[partialLine.Length];
                        for (var j = 0; j < partialLine.Length; j++)
                        {
                            lineChars[j] = partialLine[partialLine.Length - 1 - j];
                        }
                        var line = new string(lineChars).TrimEnd('\r');
                        if (!string.IsNullOrWhiteSpace(line))
                        {
                            lines.Add(line);
                        }
                        partialLine.Clear();
                    }
                }
                else
                {
                    partialLine.Append(text[i]);
                }
            }
        }

        if (partialLine.Length > 0)
        {
            var lineChars = new char[partialLine.Length];
            for (var j = 0; j < partialLine.Length; j++)
            {
                lineChars[j] = partialLine[partialLine.Length - 1 - j];
            }
            var line = new string(lineChars).TrimEnd('\r');
            if (!string.IsNullOrWhiteSpace(line))
            {
                lines.Add(line);
            }
        }

        lines.Reverse();
        if (lines.Count > lineCount)
        {
            lines = lines.Skip(lines.Count - lineCount).ToList();
        }

        var entries = new List<LogEntryMessage>();
        foreach (var line in lines)
        {
            var entry = ParseLogLine(line, filePath);
            if (entry is not null)
            {
                entries.Add(entry);
            }
        }

        return entries;
    }

    private static LogReadResponse TailLogFile(string filePath, long fromPosition)
    {
        var entries = new List<LogEntryMessage>();
        long position = fromPosition;

        try
        {
            using var fs = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);

            if (fs.Length < fromPosition)
            {
                fromPosition = 0;
            }

            fs.Seek(fromPosition, SeekOrigin.Begin);

            using var reader = new StreamReader(fs, Encoding.UTF8);
            while (!reader.EndOfStream)
            {
                var line = reader.ReadLine();
                if (string.IsNullOrWhiteSpace(line)) continue;

                var entry = ParseLogLine(line, filePath);
                if (entry is not null)
                {
                    entries.Add(entry);
                }
            }

            position = fs.Position;
        }
        catch (IOException)
        {
        }

        return new LogReadResponse
        {
            Entries = entries,
            Position = position,
            FileName = Path.GetFileName(filePath)
        };
    }

    private static LogEntryMessage? ParseLogLine(string line, string filePath)
    {
        var match = LogLineRegex().Match(line);
        if (!match.Success)
        {
            return null;
        }

        var fileName = Path.GetFileName(filePath);
        var source = fileName.StartsWith("mthost-", StringComparison.OrdinalIgnoreCase) ? "mthost" : "mt";
        string? sessionId = null;

        if (source == "mthost")
        {
            var sessionMatch = MtHostLogRegex().Match(fileName);
            if (sessionMatch.Success)
            {
                sessionId = sessionMatch.Groups[1].Value;
            }
        }

        return new LogEntryMessage
        {
            MessageType = "log",
            Source = source,
            SessionId = sessionId,
            Timestamp = match.Groups[1].Value,
            Level = match.Groups[2].Value.ToLowerInvariant(),
            Message = match.Groups[3].Value
        };
    }

    [GeneratedRegex(@"^mthost-([a-f0-9]+)", RegexOptions.IgnoreCase | RegexOptions.Compiled)]
    private static partial Regex MtHostLogRegex();

    [GeneratedRegex(@"^\[([^\]]+)\] \[([^\]]+)\] \[[^\]]+\] (.+)$", RegexOptions.Compiled)]
    private static partial Regex LogLineRegex();
}

public sealed class LogFilesResponse
{
    public List<LogFileInfo> Files { get; init; } = [];
}

public sealed class LogFileInfo
{
    public string Name { get; init; } = "";
    public string Source { get; init; } = "";
    public string? SessionId { get; init; }
    public long Size { get; init; }
    public string Modified { get; init; } = "";
    public bool IsActive { get; init; }
}

public sealed class LogReadResponse
{
    public List<LogEntryMessage> Entries { get; init; } = [];
    public long Position { get; init; }
    public string FileName { get; init; } = "";
}
