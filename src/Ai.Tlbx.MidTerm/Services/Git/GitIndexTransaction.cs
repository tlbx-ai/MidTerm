using Ai.Tlbx.MidTerm.Models.Git;

namespace Ai.Tlbx.MidTerm.Services.Git;

/// <summary>Owns only the index lock and temporary files created for one Git operation.</summary>
internal sealed class GitIndexTransaction : IAsyncDisposable
{
    private readonly string _index;
    private readonly string _lockPath;
    private readonly FileStream _lock;
    private bool _closed;
    private bool _published;
    internal string TemporaryPath { get; }
    internal bool PreservePreparedIndex { get; set; }

    internal GitIndexTransaction(string index, string operationId)
    {
        _index = index;
        _lockPath = index + ".lock";
        TemporaryPath = index + ".tlbx-" + operationId;
        try { _lock = new FileStream(_lockPath, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, FileOptions.Asynchronous); }
        catch (IOException) when (File.Exists(_lockPath))
        { throw new GitOperationException(409, "git_locked", "Another Git operation is using this repository. Wait for it to finish and retry."); }
    }

    internal void CopyOriginal()
    {
        if (File.Exists(_index)) File.Copy(_index, TemporaryPath);
    }

    internal async Task PublishAsync()
    {
        if (!File.Exists(TemporaryPath)) throw new GitOperationException(409, "index_unavailable", "Git did not return a complete index.");
        if (_closed) throw new InvalidOperationException("The index transaction is already closed.");
        await using (var prepared = new FileStream(TemporaryPath, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, FileOptions.Asynchronous))
        { await prepared.CopyToAsync(_lock, CancellationToken.None).ConfigureAwait(false); }
        await _lock.FlushAsync(CancellationToken.None).ConfigureAwait(false);
        _lock.Flush(flushToDisk: true);
        await _lock.DisposeAsync().ConfigureAwait(false);
        _closed = true;
        if (!OperatingSystem.IsWindows() && File.Exists(_index)) File.SetUnixFileMode(_lockPath, File.GetUnixFileMode(_index));
        for (var retry = 0; ; retry++)
        {
            try { File.Move(_lockPath, _index, overwrite: true); _published = true; return; }
            catch (IOException) when (OperatingSystem.IsWindows() && retry < 10)
            { await Task.Delay(25, CancellationToken.None).ConfigureAwait(false); }
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (!_closed) { await _lock.DisposeAsync().ConfigureAwait(false); _closed = true; }
        if (!_published && File.Exists(_lockPath)) File.Delete(_lockPath);
        if (File.Exists(TemporaryPath) && (_published || !PreservePreparedIndex)) File.Delete(TemporaryPath);
        if (File.Exists(TemporaryPath + ".lock")) File.Delete(TemporaryPath + ".lock");
    }
}
