using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Models;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Services;

public sealed class HistoryService
{
    private readonly string _historyPath;
    private readonly object _lock = new();
    private LaunchHistory _history = new();
    private const int MaxRecentEntries = 50;

    public HistoryService(SettingsService settingsService)
    {
        _historyPath = Path.Combine(settingsService.SettingsDirectory, "history.json");
        Log.Info(() => $"HistoryService: path={_historyPath}");
        Load();
    }

    private void Load()
    {
        lock (_lock)
        {
            if (!File.Exists(_historyPath))
            {
                _history = new LaunchHistory();
                return;
            }

            try
            {
                var json = File.ReadAllText(_historyPath);
                _history = JsonSerializer.Deserialize(json, HistoryJsonContext.Default.LaunchHistory)
                    ?? new LaunchHistory();
            }
            catch (Exception ex)
            {
                Log.Warn(() => $"Failed to load history: {ex.Message}");
                _history = new LaunchHistory();
            }
        }
    }

    private void Save()
    {
        lock (_lock)
        {
            try
            {
                var dir = Path.GetDirectoryName(_historyPath);
                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                {
                    Directory.CreateDirectory(dir);
                }

                var json = JsonSerializer.Serialize(_history, HistoryJsonContext.Default.LaunchHistory);
                File.WriteAllText(_historyPath, json);
            }
            catch (Exception ex)
            {
                Log.Warn(() => $"Failed to save history: {ex.Message}");
            }
        }
    }

    public void RecordEntry(string shellType, string executable, string? commandLine, string workingDirectory)
    {
        Log.Info(() => $"RecordEntry: shell={shellType}, exe={executable}, cmd={commandLine}, cwd={workingDirectory}");

        if (string.IsNullOrWhiteSpace(executable) || string.IsNullOrWhiteSpace(workingDirectory))
        {
            Log.Info(() => "RecordEntry skipped: empty executable or workingDirectory");
            return;
        }

        // Strip .exe extension for cleaner display
        var cleanExecutable = executable.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)
            ? executable[..^4]
            : executable;

        // Don't record shell as subprocess (e.g., "pwsh" when running pwsh)
        if (cleanExecutable.Equals(shellType, StringComparison.OrdinalIgnoreCase))
        {
            Log.Info(() => $"RecordEntry skipped: exe matches shell ({cleanExecutable})");
            return;
        }
        executable = cleanExecutable;

        var id = GenerateId(shellType, executable, commandLine, workingDirectory);
        Log.Info(() => $"RecordEntry: recording id={id}");

        lock (_lock)
        {
            var existing = _history.Entries.FirstOrDefault(e => e.Id == id);
            if (existing is not null)
            {
                existing.Weight++;
                existing.LastUsed = DateTime.UtcNow;
            }
            else
            {
                var entry = new LaunchEntry
                {
                    Id = id,
                    ShellType = shellType,
                    Executable = executable,
                    CommandLine = commandLine,
                    WorkingDirectory = workingDirectory,
                    IsStarred = false,
                    Weight = 1,
                    LastUsed = DateTime.UtcNow
                };
                _history.Entries.Add(entry);
            }

            Prune();
            Save();
        }

        Log.Verbose(() => $"Recorded history: {executable} in {workingDirectory}");
    }

    public List<LaunchEntry> GetEntries()
    {
        lock (_lock)
        {
            // Starred first, then by weight (descending), then by lastUsed (descending)
            return _history.Entries
                .OrderByDescending(e => e.IsStarred)
                .ThenByDescending(e => e.Weight)
                .ThenByDescending(e => e.LastUsed)
                .ToList();
        }
    }

    public bool ToggleStar(string id)
    {
        lock (_lock)
        {
            var entry = _history.Entries.FirstOrDefault(e => e.Id == id);
            if (entry is null)
            {
                return false;
            }

            entry.IsStarred = !entry.IsStarred;
            Save();
            return true;
        }
    }

    public bool RemoveEntry(string id)
    {
        lock (_lock)
        {
            var removed = _history.Entries.RemoveAll(e => e.Id == id);
            if (removed > 0)
            {
                Save();
                return true;
            }
            return false;
        }
    }

    private void Prune()
    {
        var starred = _history.Entries.Where(e => e.IsStarred).ToList();
        var nonStarred = _history.Entries
            .Where(e => !e.IsStarred)
            .OrderByDescending(e => e.LastUsed)
            .Take(MaxRecentEntries)
            .ToList();

        _history.Entries = starred.Concat(nonStarred).ToList();
    }

    private static string GenerateId(string shellType, string executable, string? commandLine, string workingDirectory)
    {
        var normalized = $"{shellType.ToLowerInvariant()}|{executable.ToLowerInvariant()}|{commandLine ?? ""}|{NormalizePath(workingDirectory)}";
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(normalized));
        return Convert.ToHexString(hash)[..16].ToLowerInvariant();
    }

    private static string NormalizePath(string path)
    {
        return path.Replace('\\', '/').ToLowerInvariant().TrimEnd('/');
    }
}
