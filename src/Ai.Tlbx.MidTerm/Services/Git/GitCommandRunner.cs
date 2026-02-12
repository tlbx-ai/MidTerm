using System.Diagnostics;
using System.Text;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Models.Git;

namespace Ai.Tlbx.MidTerm.Services.Git;

internal static class GitCommandRunner
{
    private static readonly TimeSpan CommandTimeout = TimeSpan.FromSeconds(5);

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
            if (line.StartsWith("# branch.head "))
            {
                response.Branch = line["# branch.head ".Length..];
            }
            else if (line.StartsWith("# branch.ab "))
            {
                var parts = line["# branch.ab ".Length..].Split(' ');
                if (parts.Length >= 2)
                {
                    if (int.TryParse(parts[0], out var ahead)) response.Ahead = ahead;
                    if (int.TryParse(parts[1], out var behind)) response.Behind = Math.Abs(behind);
                }
            }
            else if (line.StartsWith("1 ") || line.StartsWith("2 "))
            {
                ParseChangedEntry(line, staged, modified);
            }
            else if (line.StartsWith("u "))
            {
                ParseUnmergedEntry(line, conflicted);
            }
            else if (line.StartsWith("? "))
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
        var (exitCode, stdout, _) = await RunGitAsync(repoRoot, "log", $"--format={format}", $"-{count}");

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

    internal static async Task<string> GetDiffAsync(string repoRoot, string path, bool staged)
    {
        var args = staged
            ? new[] { "diff", "--cached", "--", path }
            : new[] { "diff", "--", path };
        var (_, stdout, _) = await RunGitAsync(repoRoot, args);
        return stdout;
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

        if (line.StartsWith("2 "))
        {
            var tabIndex = line.IndexOf('\t');
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

        using var cts = new CancellationTokenSource(CommandTimeout);

        try
        {
            using var process = Process.Start(psi);
            if (process is null)
            {
                Log.Error(() => "[Git] Failed to start git process");
                return (-1, "", "Failed to start git process");
            }

            var stdoutTask = process.StandardOutput.ReadToEndAsync(cts.Token);
            var stderrTask = process.StandardError.ReadToEndAsync(cts.Token);

            await process.WaitForExitAsync(cts.Token);

            var stdout = await stdoutTask;
            var stderr = await stderrTask;

            return (process.ExitCode, stdout, stderr);
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
}
