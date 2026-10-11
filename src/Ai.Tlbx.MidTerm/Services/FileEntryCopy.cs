using System.Security.Cryptography;
using System.Text;

namespace Ai.Tlbx.MidTerm.Services;

internal static class FileEntryCopy
{
    private const int MaximumEntries = 100_000;
    private const int MaximumDepth = 128;

    internal static Task CopyAsync(string source, string target, CancellationToken ct) => CopyAsync(source, target, null, ct);

    internal static async Task CopyAsync(string source, string target, IReadOnlySet<string>? excluded, CancellationToken ct)
    {
        var remaining = new int[] { MaximumEntries };
        await CopyAsync(source, target, remaining, 0, excluded, ct);
    }

    private static async Task CopyAsync(string source, string target, int[] remaining, int depth, IReadOnlySet<string>? excluded, CancellationToken ct)
    {
        CheckBudget(remaining, depth, ct);
        if (FileEntryLinks.Exists(target)) throw Collision();
        if (FileEntryLinks.IsLink(source)) { FileEntryLinks.Copy(source, target); return; }
        var attributes = File.GetAttributes(source);
        var modified = File.GetLastWriteTimeUtc(source);
        UnixFileMode? unixMode = OperatingSystem.IsWindows() ? null : File.GetUnixFileMode(source);
        if ((attributes & FileAttributes.Directory) != 0)
        {
            if (OperatingSystem.IsWindows()) Directory.CreateDirectory(target);
            else Directory.CreateDirectory(target, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            HideWindowsStage(target);
            foreach (var child in Directory.EnumerateFileSystemEntries(source))
                if (excluded?.Contains(child) != true)
                    await CopyAsync(child, Path.Combine(target, Path.GetFileName(child)), remaining, depth + 1, excluded, ct);
            Directory.SetLastWriteTimeUtc(target, modified);
        }
        else if (OperatingSystem.IsWindows())
        {
            // Native copy retains alternate streams and other Windows file data.
            await Task.Run(() => File.Copy(source, target, overwrite: false), ct);
            ct.ThrowIfCancellationRequested();
            File.SetLastWriteTimeUtc(target, modified);
        }
        else
        {
            var outputOptions = new FileStreamOptions
            { Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.None, Options = FileOptions.Asynchronous | FileOptions.SequentialScan };
            if (!OperatingSystem.IsWindows()) outputOptions.UnixCreateMode = unixMode;
            await using (var input = new FileStream(source, new FileStreamOptions
            { Mode = FileMode.Open, Access = FileAccess.Read, Share = FileShare.Read, Options = FileOptions.Asynchronous | FileOptions.SequentialScan }))
            await using (var output = new FileStream(target, outputOptions))
            {
                HideWindowsStage(target);
                await input.CopyToAsync(output, ct);
                await output.FlushAsync(ct); output.Flush(flushToDisk: true);
            }
            File.SetLastWriteTimeUtc(target, modified);
        }
        File.SetAttributes(target, attributes);
        if (!OperatingSystem.IsWindows() && unixMode is { } mode) File.SetUnixFileMode(target, mode);
    }

    internal static Task<string> FingerprintAsync(string path, CancellationToken ct) => FingerprintAsync(path, null, ct);

    internal static async Task<string> FingerprintAsync(string path, IReadOnlySet<string>? excluded, CancellationToken ct)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        await HashAsync(path, string.Empty, hash, new byte[64 * 1024], [MaximumEntries], 0, excluded, ct);
        return Convert.ToHexString(hash.GetHashAndReset());
    }

    private static async Task HashAsync(string path, string relative, IncrementalHash hash, byte[] buffer, int[] remaining, int depth, IReadOnlySet<string>? excluded, CancellationToken ct)
    {
        CheckBudget(remaining, depth, ct);
        hash.AppendData(Encoding.UTF8.GetBytes(relative + '\0'));
        if (FileEntryLinks.IsLink(path))
        {
            hash.AppendData("link\0"u8); hash.AppendData(FileEntryLinks.Descriptor(path)); hash.AppendData([0]); return;
        }
        var attributes = File.GetAttributes(path);
        var directory = (attributes & FileAttributes.Directory) != 0;
        hash.AppendData(directory ? "directory\0"u8 : "file\0"u8);
        if (directory)
        {
            foreach (var child in Directory.EnumerateFileSystemEntries(path).Order(StringComparer.Ordinal))
                if (excluded?.Contains(child) != true)
                    await HashAsync(child, Path.Combine(relative, Path.GetFileName(child)), hash, buffer, remaining, depth + 1, excluded, ct);
        }
        else
        {
            await using var input = new FileStream(path, new FileStreamOptions
            { Mode = FileMode.Open, Access = FileAccess.Read, Share = FileShare.Read, Options = FileOptions.Asynchronous | FileOptions.SequentialScan });
            hash.AppendData(BitConverter.GetBytes(input.Length));
            int count;
            while ((count = await input.ReadAsync(buffer, ct)) > 0) hash.AppendData(buffer.AsSpan(0, count));
        }
        hash.AppendData([0]);
    }

    internal static void Move(string source, string target)
    {
        if (FileEntryLinks.Exists(target)) throw Collision();
        if (OperatingSystem.IsWindows()) { FileEntryLinks.MoveWindows(source, target); return; }
        FileEntryMove.MoveUnix(source, target);
    }

    internal static void RemoveOwnedStage(string path, bool clearReadOnly = false)
    {
        var name = Path.GetFileName(path);
        if (!name.StartsWith(".tlbx-ops-", StringComparison.Ordinal) || !Guid.TryParseExact(name[10..], "N", out _))
            throw new InvalidOperationException("Only an operation's own staging entry may be removed.");
        RemoveEntry(path, clearReadOnly, [MaximumEntries], 0);
    }

    private static void RemoveEntry(string path, bool clearReadOnly, int[] remaining, int depth)
    {
        if (!FileEntryLinks.Exists(path)) return;
        CheckBudget(remaining, depth, default);
        var directory = FileEntryLinks.IsDirectory(path);
        if (directory && !FileEntryLinks.IsLink(path))
            foreach (var child in Directory.EnumerateFileSystemEntries(path)) RemoveEntry(child, clearReadOnly, remaining, depth + 1);
        if (clearReadOnly && !FileEntryLinks.IsLink(path)) File.SetAttributes(path, File.GetAttributes(path) & ~FileAttributes.ReadOnly);
        if (directory) Directory.Delete(path, recursive: false);
        else File.Delete(path);
    }

    internal static void RequireDeletable(string path)
        => RequireDeletable(path, [MaximumEntries], 0);

    private static void RequireDeletable(string path, int[] remaining, int depth)
    {
        CheckBudget(remaining, depth, default);
        if (FileEntryLinks.IsLink(path)) return;
        var attributes = File.GetAttributes(path);
        if ((attributes & FileAttributes.Directory) != 0)
        {
            foreach (var child in Directory.EnumerateFileSystemEntries(path)) RequireDeletable(child, remaining, depth + 1);
        }
        else if ((attributes & FileAttributes.ReadOnly) != 0)
            throw new UnauthorizedAccessException("A selected file is read-only.");
    }

    private static void CheckBudget(int[] remaining, int depth, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if (--remaining[0] < 0 || depth > MaximumDepth)
            throw new FileDocumentException(413, "directory_limit", "This directory exceeds the safe operation limit. Select smaller subdirectories.");
    }

    private static FileDocumentException Collision() => new(409, "name_conflict", "A file or folder with that name already exists.");

    internal static void HideWindowsStage(string path)
    {
        if (OperatingSystem.IsWindows() && Path.GetFileName(path).StartsWith(".tlbx-ops-", StringComparison.Ordinal) && !FileEntryLinks.IsLink(path))
            File.SetAttributes(path, File.GetAttributes(path) | FileAttributes.Hidden);
    }
}
