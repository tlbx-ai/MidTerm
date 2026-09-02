using System.Collections.Concurrent;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Common.Protocol;
using Ai.Tlbx.MidTerm.Models.Git;
using Ai.Tlbx.MidTerm.Services.Sessions;

namespace Ai.Tlbx.MidTerm.Services.Git;

public sealed class SessionGitMetadataService
{
    private readonly TtyHostSessionManager _sessionManager;
    private readonly SessionAppServerControlRuntimeService _appServerControlRuntime;
    private readonly GitWatcherService _gitWatcher;
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _sessionGates = new(StringComparer.Ordinal);

    public SessionGitMetadataService(
        TtyHostSessionManager sessionManager,
        SessionAppServerControlRuntimeService appServerControlRuntime,
        GitWatcherService gitWatcher)
    {
        _sessionManager = sessionManager;
        _appServerControlRuntime = appServerControlRuntime;
        _gitWatcher = gitWatcher;
        _sessionManager.OnSessionClosed += ForgetSession;
    }

    public async Task<SessionGitMetadataResult> GetAsync(string sessionId, CancellationToken ct = default)
    {
        return await WithGateAsync(sessionId, async () =>
        {
            var session = _sessionManager.GetSessionList(includeHidden: true).Sessions
                .FirstOrDefault(item => string.Equals(item.Id, sessionId, StringComparison.Ordinal));
            if (session is null)
            {
                return SessionGitMetadataResult.NotFound();
            }

            await EnsurePrimaryRepoAsync(sessionId, session.CurrentDirectory).ConfigureAwait(false);
            var repos = await ReadHostReposAsync(sessionId, session.AppServerControlOnly, ct).ConfigureAwait(false);
            if (repos is null)
            {
                return SessionGitMetadataResult.HostUnavailable();
            }

            await _gitWatcher.ReplaceSessionExtraReposAsync(sessionId, repos).ConfigureAwait(false);
            return SessionGitMetadataResult.Success(_gitWatcher.GetRepoBindings(sessionId));
        }, ct).ConfigureAwait(false);
    }

    public async Task<SessionGitMetadataResult> AddAsync(
        string sessionId,
        string path,
        string? label,
        string? role,
        CancellationToken ct = default)
    {
        return await WithGateAsync(sessionId, async () =>
        {
            var session = _sessionManager.GetSessionList(includeHidden: true).Sessions
                .FirstOrDefault(item => string.Equals(item.Id, sessionId, StringComparison.Ordinal));
            if (session is null)
            {
                return SessionGitMetadataResult.NotFound();
            }

            var normalizedPath = TryNormalizeRepoRoot(path);
            if (normalizedPath is null)
            {
                return SessionGitMetadataResult.InvalidRepo();
            }

            var repoRoot = await GitCommandRunner.GetRepoRootAsync(normalizedPath).ConfigureAwait(false);
            if (repoRoot is null)
            {
                return SessionGitMetadataResult.InvalidRepo();
            }

            repoRoot = Path.GetFullPath(repoRoot).TrimEnd(Path.DirectorySeparatorChar);
            await EnsurePrimaryRepoAsync(sessionId, session.CurrentDirectory).ConfigureAwait(false);
            if (string.Equals(_gitWatcher.GetRepoRoot(sessionId), repoRoot, StringComparison.OrdinalIgnoreCase))
            {
                return SessionGitMetadataResult.Success(_gitWatcher.GetRepoBindings(sessionId));
            }

            var current = await ReadHostReposAsync(sessionId, session.AppServerControlOnly, ct).ConfigureAwait(false);
            if (current is null)
            {
                return SessionGitMetadataResult.HostUnavailable();
            }

            var next = current
                .Where(repo => !string.Equals(repo.RepoRoot, repoRoot, StringComparison.OrdinalIgnoreCase))
                .Append(new TtyHostGitRepoMetadata
                {
                    RepoRoot = repoRoot,
                    Label = string.IsNullOrWhiteSpace(label) ? Path.GetFileName(repoRoot) : label.Trim(),
                    Role = string.IsNullOrWhiteSpace(role) ? "target" : role.Trim(),
                    Source = "manual"
                })
                .ToArray();
            var accepted = await WriteHostReposAsync(sessionId, session.AppServerControlOnly, next, ct).ConfigureAwait(false);
            if (accepted is null)
            {
                return SessionGitMetadataResult.HostUnavailable();
            }

            await _gitWatcher.ReplaceSessionExtraReposAsync(sessionId, accepted).ConfigureAwait(false);
            return SessionGitMetadataResult.Success(_gitWatcher.GetRepoBindings(sessionId));
        }, ct).ConfigureAwait(false);
    }

    public async Task<SessionGitMetadataResult> RemoveAsync(
        string sessionId,
        string repoRoot,
        CancellationToken ct = default)
    {
        return await WithGateAsync(sessionId, async () =>
        {
            var session = _sessionManager.GetSessionList(includeHidden: true).Sessions
                .FirstOrDefault(item => string.Equals(item.Id, sessionId, StringComparison.Ordinal));
            if (session is null)
            {
                return SessionGitMetadataResult.NotFound();
            }

            await EnsurePrimaryRepoAsync(sessionId, session.CurrentDirectory).ConfigureAwait(false);
            var normalized = TryNormalizeRepoRoot(repoRoot);
            if (normalized is null)
            {
                return SessionGitMetadataResult.InvalidRepo();
            }
            if (string.Equals(_gitWatcher.GetRepoRoot(sessionId), normalized, StringComparison.OrdinalIgnoreCase))
            {
                return SessionGitMetadataResult.PrimaryRepo();
            }

            var current = await ReadHostReposAsync(sessionId, session.AppServerControlOnly, ct).ConfigureAwait(false);
            if (current is null)
            {
                return SessionGitMetadataResult.HostUnavailable();
            }

            var next = current
                .Where(repo => !string.Equals(TryNormalizeRepoRoot(repo.RepoRoot), normalized, StringComparison.OrdinalIgnoreCase))
                .ToArray();
            var accepted = await WriteHostReposAsync(sessionId, session.AppServerControlOnly, next, ct).ConfigureAwait(false);
            if (accepted is null)
            {
                return SessionGitMetadataResult.HostUnavailable();
            }

            await _gitWatcher.ReplaceSessionExtraReposAsync(sessionId, accepted).ConfigureAwait(false);
            return SessionGitMetadataResult.Success(_gitWatcher.GetRepoBindings(sessionId));
        }, ct).ConfigureAwait(false);
    }

    public async Task ReconcileAllAsync(bool requireHosts = false, CancellationToken ct = default)
    {
        foreach (var session in _sessionManager.GetSessionList(includeHidden: true).Sessions)
        {
            ct.ThrowIfCancellationRequested();
            if (!session.AppServerControlOnly)
            {
                var result = await GetAsync(session.Id, ct).ConfigureAwait(false);
                if (requireHosts && !result.IsSuccess)
                {
                    throw new InvalidOperationException($"Cannot read Git metadata for session {session.Id}: {result.Error}");
                }
                continue;
            }

            await WithGateAsync(session.Id, async () =>
            {
                await EnsurePrimaryRepoAsync(session.Id, session.CurrentDirectory).ConfigureAwait(false);
                var hostRepos = await ReadHostReposAsync(session.Id, appServerControlOnly: true, ct).ConfigureAwait(false);
                if (hostRepos is null)
                {
                    if (requireHosts)
                    {
                        throw new InvalidOperationException($"Cannot read Git metadata for session {session.Id}: mtagenthost unavailable.");
                    }
                    Log.Warn(() => $"Git metadata reconciliation skipped for {session.Id}: mtagenthost unavailable.");
                    return SessionGitMetadataResult.HostUnavailable();
                }

                if (hostRepos.Length == 0)
                {
                    var migrationRepos = _gitWatcher.GetRepoBindings(session.Id)
                        .Where(static repo => !repo.IsPrimary)
                        .Select(ToMetadata)
                        .Concat(_sessionManager.GetPersistedSessionExtraGitRepos(session.Id))
                        .GroupBy(static repo => repo.RepoRoot, StringComparer.OrdinalIgnoreCase)
                        .Select(static group => group.First())
                        .ToArray();
                    if (migrationRepos.Length > 0)
                    {
                        hostRepos = await WriteHostReposAsync(session.Id, appServerControlOnly: true, migrationRepos, ct).ConfigureAwait(false)
                            ?? [];
                    }
                }

                await _gitWatcher.ReplaceSessionExtraReposAsync(session.Id, hostRepos).ConfigureAwait(false);
                if (_sessionManager.GetPersistedSessionExtraGitRepos(session.Id).Length > 0)
                {
                    await _sessionManager.SetSessionExtraGitReposMetadataAsync(session.Id, [], ct).ConfigureAwait(false);
                }
                return SessionGitMetadataResult.Success(_gitWatcher.GetRepoBindings(session.Id));
            }, ct).ConfigureAwait(false);
        }
    }

    private async Task EnsurePrimaryRepoAsync(string sessionId, string? workingDirectory)
    {
        if (_gitWatcher.GetRepoRoot(sessionId) is null && !string.IsNullOrWhiteSpace(workingDirectory))
        {
            await _gitWatcher.RegisterSessionAsync(sessionId, workingDirectory).ConfigureAwait(false);
        }
    }

    private async Task<TtyHostGitRepoMetadata[]?> ReadHostReposAsync(
        string sessionId,
        bool appServerControlOnly,
        CancellationToken ct)
    {
        if (!appServerControlOnly)
        {
            return await _sessionManager.GetSessionExtraGitReposMetadataAsync(sessionId, ct).ConfigureAwait(false);
        }

        if (!await EnsureAppServerControlHostAsync(sessionId, ct).ConfigureAwait(false))
        {
            return null;
        }

        return await _appServerControlRuntime.GetGitMetadataAsync(sessionId, ct).ConfigureAwait(false);
    }

    private async Task<TtyHostGitRepoMetadata[]?> WriteHostReposAsync(
        string sessionId,
        bool appServerControlOnly,
        TtyHostGitRepoMetadata[] repos,
        CancellationToken ct)
    {
        if (!appServerControlOnly)
        {
            return await SetTtyHostReposAsync(sessionId, repos, ct).ConfigureAwait(false);
        }

        if (!await EnsureAppServerControlHostAsync(sessionId, ct).ConfigureAwait(false))
        {
            return null;
        }

        return await _appServerControlRuntime.SetGitMetadataAsync(sessionId, repos, ct).ConfigureAwait(false);
    }

    private async Task<bool> EnsureAppServerControlHostAsync(string sessionId, CancellationToken ct)
    {
        if (_appServerControlRuntime.IsAttached(sessionId))
        {
            return true;
        }

        var session = _sessionManager.GetSessionList(includeHidden: true).Sessions
            .FirstOrDefault(item => string.Equals(item.Id, sessionId, StringComparison.Ordinal));
        return session is not null &&
            await _appServerControlRuntime.EnsureAttachedAsync(sessionId, session, ct: ct).ConfigureAwait(false);
    }

    private async Task<TtyHostGitRepoMetadata[]?> SetTtyHostReposAsync(
        string sessionId,
        TtyHostGitRepoMetadata[] repos,
        CancellationToken ct)
    {
        return await _sessionManager.SetSessionExtraGitReposMetadataAsync(sessionId, repos, ct).ConfigureAwait(false)
            ? repos
            : null;
    }

    private async Task<SessionGitMetadataResult> WithGateAsync(
        string sessionId,
        Func<Task<SessionGitMetadataResult>> action,
        CancellationToken ct)
    {
        var gate = _sessionGates.GetOrAdd(sessionId, static _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            return await action().ConfigureAwait(false);
        }
        finally
        {
            gate.Release();
        }
    }

    private static TtyHostGitRepoMetadata ToMetadata(GitRepoBinding repo) => new()
    {
        RepoRoot = repo.RepoRoot,
        Label = repo.Label,
        Role = repo.Role,
        Source = repo.Source
    };

    private static string? TryNormalizeRepoRoot(string path)
    {
        try
        {
            return string.IsNullOrWhiteSpace(path)
                ? null
                : Path.GetFullPath(path.Trim()).TrimEnd(Path.DirectorySeparatorChar);
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return null;
        }
    }

    private void ForgetSession(string sessionId)
    {
        _sessionGates.TryRemove(sessionId, out _);
    }
}

public sealed record SessionGitMetadataResult(
    bool IsSuccess,
    int StatusCode,
    string? Error,
    GitRepoBinding[] Repos)
{
    public static SessionGitMetadataResult Success(GitRepoBinding[] repos) => new(true, 200, null, repos);
    public static SessionGitMetadataResult NotFound() => new(false, 404, "Session not found", []);
    public static SessionGitMetadataResult HostUnavailable() => new(false, 503, "Owning session host is unavailable", []);
    public static SessionGitMetadataResult InvalidRepo() => new(false, 400, "Path is not in a git repository", []);
    public static SessionGitMetadataResult PrimaryRepo() => new(false, 400, "The primary working-directory repository cannot be removed", []);
}
