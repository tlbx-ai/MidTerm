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
        if (string.IsNullOrEmpty(workingDir)) return;

        var repoRoot = await GitCommandRunner.GetRepoRootAsync(workingDir);
        if (repoRoot is null) return;

        repoRoot = Path.GetFullPath(repoRoot).TrimEnd(Path.DirectorySeparatorChar);

        UnregisterSession(sessionId);

        _sessionToRepo[sessionId] = repoRoot;
        var watcher = _watchers.GetOrAdd(repoRoot, root => CreateWatcher(root));
        Interlocked.Increment(ref watcher.RefCount);

        await RefreshStatusAsync(repoRoot);
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

            await Task.WhenAll(statusTask, logTask, stashTask);

            var status = await statusTask;
            status.RecentCommits = await logTask;
            status.StashCount = await stashTask;

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
