using System.Diagnostics;
using System.Globalization;
using System.Text;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Models.Git;

using Ai.Tlbx.MidTerm.Services.Sessions;
namespace Ai.Tlbx.MidTerm.Services.Git;

internal static class GitCommandRunner
{
    private static readonly TimeSpan CommandTimeout = TimeSpan.FromSeconds(5);
    private const int MaxPatchOutputChars = 160_000;
    private static string? _runAsUser;
    private static bool _isServiceMode;

    internal static void Configure(string? runAsUser, bool isServiceMode)
    {
        _runAsUser = runAsUser;
        _isServiceMode = isServiceMode;
    }

    private static readonly object _logLock = new();
    private static (string Args, string WorkingDir, int ExitCode, string Stdout, string Stderr, DateTime Timestamp)? _lastCommand;

    internal static GitCommandLog? GetLastCommandLog()
    {
        lock (_logLock)
        {
            if (_lastCommand is not var (args, dir, exit, stdout, stderr, ts)) return null;
            return new GitCommandLog
            {
                Args = args,
                WorkingDir = dir,
                ExitCode = exit,
                Stdout = stdout.Length > 500 ? stdout[..500] + "..." : stdout,
                Stderr = stderr.Length > 500 ? stderr[..500] + "..." : stderr,
                Timestamp = ts.ToString("O", CultureInfo.InvariantCulture)
            };
        }
    }

    private static void RecordCommand(string workingDir, string[] args, int exitCode, string stdout, string stderr)
    {
        lock (_logLock)
        {
            _lastCommand = ($"git {string.Join(' ', args)}", workingDir, exitCode, stdout, stderr, DateTime.UtcNow);
        }
    }

    internal static async Task<string?> GetGitVersionAsync()
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = "git",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };
            psi.ArgumentList.Add("--version");

            using var cts = new CancellationTokenSource(CommandTimeout);
            using var process = Process.Start(psi);
            if (process is null) return null;

            var stdout = await process.StandardOutput.ReadToEndAsync(cts.Token);
            await process.WaitForExitAsync(cts.Token);

            return process.ExitCode == 0 ? stdout.Trim() : null;
        }
        catch
        {
            return null;
        }
    }

    internal static async Task<string?> GetRepoRootAsync(string workingDir)
    {
        var (exitCode, stdout, _) = await RunGitAsync(workingDir, "rev-parse", "--show-toplevel");
        if (exitCode != 0) return null;
        var root = stdout.Trim();
        return string.IsNullOrEmpty(root) ? null : root;
    }

    internal static async Task<GitStatusResponse> GetStatusAsync(string repoRoot)
    {
        var response = new GitStatusResponse { RepoRoot = repoRoot };
        var (exitCode, stdout, stderr) = await RunGitAsync(repoRoot, "status", "--porcelain=v2", "-b", "--ahead-behind");

        if (exitCode != 0)
        {
            Log.Verbose(() => $"[Git] status failed: {stderr}");
            return response;
        }

        var staged = new List<GitFileEntry>();
        var modified = new List<GitFileEntry>();
        var untracked = new List<GitFileEntry>();
        var conflicted = new List<GitFileEntry>();

        foreach (var line in stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            if (line.StartsWith("# branch.head ", StringComparison.Ordinal))
            {
                response.Branch = line["# branch.head ".Length..];
            }
            else if (line.StartsWith("# branch.ab ", StringComparison.Ordinal))
            {
                var parts = line["# branch.ab ".Length..].Split(' ');
                if (parts.Length >= 2)
                {
                    if (int.TryParse(parts[0], CultureInfo.InvariantCulture, out var ahead)) response.Ahead = ahead;
                    if (int.TryParse(parts[1], CultureInfo.InvariantCulture, out var behind)) response.Behind = Math.Abs(behind);
                }
            }
            else if (line.StartsWith("1 ", StringComparison.Ordinal) || line.StartsWith("2 ", StringComparison.Ordinal))
            {
                ParseChangedEntry(line, staged, modified);
            }
            else if (line.StartsWith("u ", StringComparison.Ordinal))
            {
                ParseUnmergedEntry(line, conflicted);
            }
            else if (line.StartsWith("? ", StringComparison.Ordinal))
            {
                untracked.Add(new GitFileEntry
                {
                    Path = line[2..],
                    Status = "untracked"
                });
            }
        }

        response.Staged = staged.ToArray();
        response.Modified = modified.ToArray();
        response.Untracked = untracked.ToArray();
        response.Conflicted = conflicted.ToArray();
        return response;
    }

    internal static async Task<GitLogEntry[]> GetLogAsync(string repoRoot, int count = 20)
    {
        var format = "%H%n%h%n%s%n%an%n%ai";
        var countArgument = string.Create(CultureInfo.InvariantCulture, $"-{count}");
        var (exitCode, stdout, _) = await RunGitAsync(repoRoot, "log", $"--format={format}", countArgument);

        if (exitCode != 0) return [];

        var lines = stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        var entries = new List<GitLogEntry>();

        for (var i = 0; i + 4 < lines.Length; i += 5)
        {
            entries.Add(new GitLogEntry
            {
                Hash = lines[i],
                ShortHash = lines[i + 1],
                Message = lines[i + 2],
                Author = lines[i + 3],
                Date = lines[i + 4]
            });
        }

        return entries.ToArray();
    }

    internal static async Task<int> GetStashCountAsync(string repoRoot)
    {
        var (exitCode, stdout, _) = await RunGitAsync(repoRoot, "stash", "list");
        if (exitCode != 0) return 0;
        var trimmed = stdout.Trim();
        return string.IsNullOrEmpty(trimmed) ? 0 : trimmed.Split('\n').Length;
    }

    internal static async Task<string[]> GetTrackedAndUntrackedPathsAsync(string repoRoot)
    {
        var (exitCode, stdout, _) = await RunGitAsync(repoRoot, "ls-files", "-co", "--exclude-standard");
        if (exitCode != 0)
        {
            return [];
        }

        return stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    }

    internal static async Task<Dictionary<string, (int Additions, int Deletions)>> GetNumStatAsync(string repoRoot)
    {
        var result = new Dictionary<string, (int, int)>(StringComparer.OrdinalIgnoreCase);

        var unstagedTask = RunGitAsync(repoRoot, "diff", "--numstat");
        var stagedTask = RunGitAsync(repoRoot, "diff", "--cached", "--numstat");
        await Task.WhenAll(unstagedTask, stagedTask);

        var (_, unstaged, _) = await unstagedTask;
        ParseNumStat(result, unstaged);

        var (_, staged, _) = await stagedTask;
        ParseNumStat(result, staged);

        return result;
    }

    private static void ParseNumStat(Dictionary<string, (int Additions, int Deletions)> result, string output)
    {
        foreach (var line in output.Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            var parts = line.Split('\t');
            if (parts.Length < 3) continue;
            if (parts[0] == "-" || parts[1] == "-") continue;

            if (!int.TryParse(parts[0], CultureInfo.InvariantCulture, out var additions)) continue;
            if (!int.TryParse(parts[1], CultureInfo.InvariantCulture, out var deletions)) continue;

            var path = parts[2];
            if (result.TryGetValue(path, out var existing))
            {
                result[path] = (existing.Additions + additions, existing.Deletions + deletions);
            }
            else
            {
                result[path] = (additions, deletions);
            }
        }
    }

    internal static async Task<string> GetDiffAsync(string repoRoot, string path, bool staged)
    {
        var args = staged
            ? new[] { "diff", "--cached", "--", path }
            : new[] { "diff", "--", path };
        var (_, stdout, _) = await RunGitAsync(repoRoot, args);
        return stdout;
    }

    internal static async Task<(string Patch, bool IsTruncated)> GetDiffPatchAsync(
        string repoRoot,
        string path,
        bool staged)
    {
        var args = staged
            ? new[] { "diff", "--cached", "--find-renames", "--unified=3", "--no-color", "--", path }
            : new[] { "diff", "--find-renames", "--unified=3", "--no-color", "--", path };
        var (exitCode, stdout, _) = await RunGitAsync(repoRoot, args);
        if (exitCode != 0)
        {
            return (string.Empty, false);
        }

        return TrimOutput(stdout, MaxPatchOutputChars);
    }

    internal static async Task<GitCommitMetadata?> GetCommitMetadataAsync(string repoRoot, string hash)
    {
        const string format = "%H%x00%h%x00%s%x00%b%x00%an%x00%aI%x00%cI%x00%P";
        var (exitCode, stdout, _) = await RunGitAsync(repoRoot, "show", "--no-patch", $"--format={format}", hash);
        if (exitCode != 0)
        {
            return null;
        }

        var parts = stdout.TrimEnd('\r', '\n', '\0').Split('\0');
        if (parts.Length < 8)
        {
            return null;
        }

        return new GitCommitMetadata
        {
            Hash = parts[0],
            ShortHash = parts[1],
            Subject = parts[2],
            Body = parts[3].TrimEnd(),
            Author = parts[4],
            AuthoredDate = parts[5],
            CommittedDate = parts[6],
            ParentHashes = parts[7]
                .Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
        };
    }

    internal static async Task<(string Patch, bool IsTruncated)> GetCommitPatchAsync(string repoRoot, string hash)
    {
        var (exitCode, stdout, _) = await RunGitAsync(
            repoRoot,
            "show",
            "--find-renames",
            "--unified=3",
            "--no-color",
            "--format=",
            hash);
        if (exitCode != 0)
        {
            return (string.Empty, false);
        }

        return TrimOutput(stdout, MaxPatchOutputChars);
    }

    private static void ParseChangedEntry(string line, List<GitFileEntry> staged, List<GitFileEntry> modified)
    {
        var parts = line.Split(' ');
        if (parts.Length < 9) return;

        var xy = parts[1];
        if (xy.Length < 2) return;

        var indexStatus = xy[0];
        var worktreeStatus = xy[1];

        string? originalPath = null;
        string filePath;

        if (line.StartsWith("2 ", StringComparison.Ordinal))
        {
            var tabIndex = line.IndexOf('\t', StringComparison.Ordinal);
            if (tabIndex >= 0)
            {
                var pathParts = line[tabIndex..].Split('\t');
                filePath = pathParts.Length >= 2 ? pathParts[1] : parts[^1];
                originalPath = pathParts.Length >= 2 ? pathParts[0].TrimStart('\t') : null;
            }
            else
            {
                filePath = parts[^1];
            }
        }
        else
        {
            filePath = parts[^1];
        }

        if (indexStatus != '.')
        {
            staged.Add(new GitFileEntry
            {
                Path = filePath,
                Status = MapStatusChar(indexStatus),
                OriginalPath = originalPath
            });
        }

        if (worktreeStatus != '.')
        {
            modified.Add(new GitFileEntry
            {
                Path = filePath,
                Status = MapStatusChar(worktreeStatus)
            });
        }
    }

    private static void ParseUnmergedEntry(string line, List<GitFileEntry> conflicted)
    {
        var parts = line.Split(' ');
        if (parts.Length < 2) return;

        conflicted.Add(new GitFileEntry
        {
            Path = parts[^1],
            Status = "conflicted"
        });
    }

    private static string MapStatusChar(char c) => c switch
    {
        'M' => "modified",
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "copied",
        'T' => "type-changed",
        'U' => "unmerged",
        _ => c.ToString()
    };

    private static async Task<(int ExitCode, string Stdout, string Stderr)> RunGitAsync(string workingDir, params string[] args)
    {
        var fullArgs = new string[args.Length + 1];
        fullArgs[0] = "--no-optional-locks";
        args.CopyTo(fullArgs, 1);

        using var cts = new CancellationTokenSource(CommandTimeout);

        try
        {
#if WINDOWS
            if (_isServiceMode && OperatingSystem.IsWindows())
            {
                var result = await TtyHostSpawner.RunCommandAsUserAsync("git", fullArgs, workingDir, _runAsUser, cts.Token);
                RecordCommand(workingDir, fullArgs, result.ExitCode, result.Stdout, result.Stderr);
                return result;
            }
#endif

            return await RunGitDirectAsync(workingDir, fullArgs, cts.Token);
        }
        catch (OperationCanceledException)
        {
            Log.Warn(() => $"[Git] Command timed out: git {string.Join(' ', args)}");
            return (-1, "", "Command timed out");
        }
        catch (Exception ex)
        {
            Log.Error(() => $"[Git] Command failed: {ex.Message}");
            return (-1, "", ex.Message);
        }
    }

    private static async Task<(int ExitCode, string Stdout, string Stderr)> RunGitDirectAsync(
        string workingDir, string[] args, CancellationToken ct)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "git",
            WorkingDirectory = workingDir,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };

        foreach (var arg in args)
        {
            psi.ArgumentList.Add(arg);
        }

        using var process = Process.Start(psi);
        if (process is null)
        {
            Log.Error(() => "[Git] Failed to start git process");
            return (-1, "", "Failed to start git process");
        }

        var stdoutTask = process.StandardOutput.ReadToEndAsync(ct);
        var stderrTask = process.StandardError.ReadToEndAsync(ct);

        await process.WaitForExitAsync(ct);

        var stdout = await stdoutTask;
        var stderr = await stderrTask;

        RecordCommand(workingDir, args, process.ExitCode, stdout, stderr);
        return (process.ExitCode, stdout, stderr);
    }

    private static (string Text, bool IsTruncated) TrimOutput(string text, int maxChars)
    {
        if (text.Length <= maxChars)
        {
            return (text, false);
        }

        return (text[..maxChars], true);
    }
}
