using System.Diagnostics;
using System.Globalization;
using System.Runtime;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Services.Git;

namespace Ai.Tlbx.MidTerm.Services.Sessions;

/// <summary>
/// Owns session-scoped server cleanup and the deliberately user-triggered
/// managed-memory reclamation that follows a successful tab/session close.
/// Automatic process exits use the same logical cleanup without forcing a GC.
/// </summary>
public sealed class SessionCloseCleanupService
{
    private static readonly SemaphoreSlim CollectGate = new(1, 1);

    private readonly TtyHostMuxConnectionManager _muxManager;
    private readonly InputHistoryService _inputHistory;
    private readonly SessionPathAllowlistService _pathAllowlist;
    private readonly GitWatcherService _gitWatcher;

    public SessionCloseCleanupService(
        TtyHostMuxConnectionManager muxManager,
        InputHistoryService inputHistory,
        SessionPathAllowlistService pathAllowlist,
        GitWatcherService gitWatcher)
    {
        _muxManager = muxManager;
        _inputHistory = inputHistory;
        _pathAllowlist = pathAllowlist;
        _gitWatcher = gitWatcher;
    }

    public void ClearSessionState(string sessionId)
    {
        _inputHistory.ClearSession(sessionId);
        _pathAllowlist.ClearSession(sessionId);
        _gitWatcher.UnregisterSession(sessionId);

        // The file metadata cache is intentionally small and short-lived, but
        // it is process-global rather than attributable to one session. A tab
        // close is the deterministic point where stale file-browser metadata
        // can be discarded without affecting correctness.
        FileService.ClearCachedMetadata();
    }

    public async Task ReclaimAfterUserTriggeredCloseAsync(string sessionId)
    {
        // OnSessionClosed invokes ClearSessionState synchronously. The mux path
        // and Git refresh path have their own processors, so wait for both
        // purge/idle barriers before collecting.
        await Task.WhenAll(
            _muxManager.WaitForSessionCleanupAsync(sessionId),
            _gitWatcher.WaitForSessionCleanupAsync(sessionId)).ConfigureAwait(false);

        await CollectGate.WaitAsync().ConfigureAwait(false);
        try
        {
            using var process = Process.GetCurrentProcess();
            process.Refresh();
            var privateBefore = process.PrivateMemorySize64;
            var workingSetBefore = process.WorkingSet64;
            var managedBefore = GC.GetTotalMemory(forceFullCollection: false);

            GCSettings.LargeObjectHeapCompactionMode = GCLargeObjectHeapCompactionMode.CompactOnce;
            GC.Collect(GC.MaxGeneration, GCCollectionMode.Forced, blocking: true, compacting: true);
            GC.WaitForPendingFinalizers();
            GC.Collect(GC.MaxGeneration, GCCollectionMode.Forced, blocking: true, compacting: true);

            process.Refresh();
            var privateAfter = process.PrivateMemorySize64;
            var workingSetAfter = process.WorkingSet64;
            var managedAfter = GC.GetTotalMemory(forceFullCollection: false);
            Log.Info(() =>
                $"Session close memory reclaim ({sessionId}): " +
                $"managed {FormatMiB(managedBefore)} -> {FormatMiB(managedAfter)}, " +
                $"private {FormatMiB(privateBefore)} -> {FormatMiB(privateAfter)}, " +
                $"working set {FormatMiB(workingSetBefore)} -> {FormatMiB(workingSetAfter)}");
        }
        finally
        {
            CollectGate.Release();
        }
    }

    private static string FormatMiB(long bytes) =>
        string.Create(CultureInfo.InvariantCulture, $"{bytes / (1024d * 1024d):F1} MiB");
}
