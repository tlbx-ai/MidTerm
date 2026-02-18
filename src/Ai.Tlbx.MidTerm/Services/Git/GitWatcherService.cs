using System.Collections.Concurrent;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Models.Git;

namespace Ai.Tlbx.MidTerm.Services.Git;

public sealed class GitWatcherService : IDisposable
{
    private readonly ConcurrentDictionary<string, RepoWatcher> _watchers = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, string> _sessionToRepo = new();

    private sealed class RepoWatcher : IDisposable
    {
        public FileSystemWatcher? Watcher { get; set; }
        public int RefCount;
        public CancellationTokenSource? DebounceCts;
        public GitStatusResponse? CachedStatus;

        public void Dispose()
        {
            DebounceCts?.Cancel();
            DebounceCts?.Dispose();
            Watcher?.Dispose();
        }
    }

    public event Action<string, GitStatusResponse>? OnStatusChanged;

    public async Task RegisterSessionAsync(string sessionId, string? workingDir)
    {
        if (string.IsNullOrEmpty(workingDir))
        {
            Log.Verbose(() => $"[Git] RegisterSession({sessionId}): workingDir is null/empty");
            return;
        }

        Log.Verbose(() => $"[Git] RegisterSession({sessionId}): cwd={workingDir}");

        var repoRoot = await GitCommandRunner.GetRepoRootAsync(workingDir);
        if (repoRoot is null)
        {
            Log.Verbose(() => $"[Git] RegisterSession({sessionId}): not a git repo at {workingDir}");
            return;
        }

        repoRoot = Path.GetFullPath(repoRoot).TrimEnd(Path.DirectorySeparatorChar);
        Log.Verbose(() => $"[Git] RegisterSession({sessionId}): repoRoot={repoRoot}");

        if (_sessionToRepo.TryGetValue(sessionId, out var existing)
            && string.Equals(existing, repoRoot, StringComparison.OrdinalIgnoreCase))
        {
            Log.Verbose(() => $"[Git] RegisterSession({sessionId}): already registered for {repoRoot}");
            return;
        }

        UnregisterSession(sessionId);

        _sessionToRepo[sessionId] = repoRoot;
        var watcher = _watchers.GetOrAdd(repoRoot, root => CreateWatcher(root));
        Interlocked.Increment(ref watcher.RefCount);

        await RefreshStatusAsync(repoRoot);
        Log.Verbose(() => $"[Git] RegisterSession({sessionId}): refresh complete, cached={_watchers.TryGetValue(repoRoot, out var w) && w.CachedStatus is not null}");
    }

    public void UnregisterSession(string sessionId)
    {
        if (!_sessionToRepo.TryRemove(sessionId, out var repoRoot)) return;
        if (!_watchers.TryGetValue(repoRoot, out var watcher)) return;

        if (Interlocked.Decrement(ref watcher.RefCount) <= 0)
        {
            if (_watchers.TryRemove(repoRoot, out var removed))
            {
                removed.Dispose();
            }
        }
    }

    public GitStatusResponse? GetCachedStatus(string sessionId)
    {
        if (!_sessionToRepo.TryGetValue(sessionId, out var repoRoot)) return null;
        if (!_watchers.TryGetValue(repoRoot, out var watcher)) return null;
        return watcher.CachedStatus;
    }

    public string? GetRepoRoot(string sessionId)
    {
        return _sessionToRepo.TryGetValue(sessionId, out var root) ? root : null;
    }

    public async Task RefreshStatusAsync(string repoRoot)
    {
        try
        {
            var statusTask = GitCommandRunner.GetStatusAsync(repoRoot);
            var logTask = GitCommandRunner.GetLogAsync(repoRoot);
            var stashTask = GitCommandRunner.GetStashCountAsync(repoRoot);
            var numStatTask = GitCommandRunner.GetNumStatAsync(repoRoot);

            await Task.WhenAll(statusTask, logTask, stashTask, numStatTask);

            var status = await statusTask;
            status.RecentCommits = await logTask;
            status.StashCount = await stashTask;

            var numStat = await numStatTask;
            MergeNumStat(status, numStat);

            if (_watchers.TryGetValue(repoRoot, out var watcher))
            {
                watcher.CachedStatus = status;
            }

            OnStatusChanged?.Invoke(repoRoot, status);
        }
        catch (Exception ex)
        {
            Log.Error(() => $"[Git] RefreshStatus failed for {repoRoot}: {ex.Message}");
        }
    }

    private static void MergeNumStat(GitStatusResponse status, Dictionary<string, (int Additions, int Deletions)> numStat)
    {
        var totalAdd = 0;
        var totalDel = 0;

        void ApplyToEntries(GitFileEntry[] entries)
        {
            foreach (var entry in entries)
            {
                if (numStat.TryGetValue(entry.Path, out var stats))
                {
                    entry.Additions = stats.Additions;
                    entry.Deletions = stats.Deletions;
                    totalAdd += stats.Additions;
                    totalDel += stats.Deletions;
                }
            }
        }

        ApplyToEntries(status.Staged);
        ApplyToEntries(status.Modified);

        status.TotalAdditions = totalAdd;
        status.TotalDeletions = totalDel;
    }

    private RepoWatcher CreateWatcher(string repoRoot)
    {
        var gitDir = Path.Combine(repoRoot, ".git");
        if (!Directory.Exists(gitDir))
        {
            return new RepoWatcher();
        }

        var fsw = new FileSystemWatcher(gitDir)
        {
            IncludeSubdirectories = true,
            NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.DirectoryName
        };

        var watcher = new RepoWatcher { Watcher = fsw };

        void OnChange(object? s, FileSystemEventArgs e)
        {
            if (e.Name?.EndsWith(".lock", StringComparison.OrdinalIgnoreCase) == true) return;
            DebouncedRefresh(repoRoot, watcher);
        }

        fsw.Changed += OnChange;
        fsw.Created += OnChange;
        fsw.Deleted += OnChange;
        fsw.Renamed += (s, e) => OnChange(s, e);
        fsw.EnableRaisingEvents = true;

        return watcher;
    }

    private void DebouncedRefresh(string repoRoot, RepoWatcher watcher)
    {
        watcher.DebounceCts?.Cancel();
        watcher.DebounceCts = new CancellationTokenSource();
        var token = watcher.DebounceCts.Token;

        _ = Task.Delay(300, token).ContinueWith(async _ =>
        {
            if (!token.IsCancellationRequested)
            {
                await RefreshStatusAsync(repoRoot);
            }
        }, token, TaskContinuationOptions.OnlyOnRanToCompletion, TaskScheduler.Default);
    }

    public void Dispose()
    {
        foreach (var watcher in _watchers.Values)
        {
            watcher.Dispose();
        }
        _watchers.Clear();
        _sessionToRepo.Clear();
    }
}
