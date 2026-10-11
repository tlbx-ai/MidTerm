using System.Text;
using Ai.Tlbx.MidTerm.Services;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class FileDocumentServiceTests : IDisposable
{
    private readonly string _folder = Path.Combine(Path.GetTempPath(), $"file_document_test_{Guid.NewGuid():N}");
    private readonly FileDocumentService _documents = new();

    public FileDocumentServiceTests() => Directory.CreateDirectory(_folder);

    public void Dispose()
    {
        var resolved = Path.GetFullPath(_folder);
        if (!resolved.StartsWith(Path.GetFullPath(Path.GetTempPath()), StringComparison.OrdinalIgnoreCase) ||
            !Path.GetFileName(resolved).StartsWith("file_document_test_", StringComparison.Ordinal))
            throw new InvalidOperationException("Unexpected test fixture path.");
        Directory.Delete(resolved, recursive: true);
        GC.SuppressFinalize(this);
    }

    [Fact]
    public async Task ChangedOnDisk_IsRejectedWithoutTouchingEitherVersion()
    {
        var path = Path.Combine(_folder, "notes.md");
        await File.WriteAllTextAsync(path, "base\n");
        var original = await _documents.ReadAsync(path, true, default);
        await File.WriteAllTextAsync(path, "external agent\n");
        var error = await Assert.ThrowsAsync<FileDocumentException>(() =>
            _documents.SaveAsync(path, "my draft\n", original.Version!, default));
        Assert.Equal(409, error.StatusCode);
        Assert.Equal("changed", error.Code);
        Assert.Equal("external agent\n", await File.ReadAllTextAsync(path));
        Assert.Empty(Directory.EnumerateFiles(_folder, ".tlbx-*"));
    }

    [Fact]
    public async Task ConcurrentClients_OnlyOneDistinctDraftCanCommitTheSameBase()
    {
        var path = Path.Combine(_folder, "shared.md");
        await File.WriteAllTextAsync(path, "base");
        var original = await _documents.ReadAsync(path, true, default);
        async Task<bool> Save(string text)
        {
            try { await _documents.SaveAsync(path, text, original.Version!, default); return true; }
            catch (FileDocumentException ex) when (ex.StatusCode == 409) { return false; }
        }
        var commits = await Task.WhenAll(Save("client one"), Save("client two"));
        Assert.Single(commits.Where(static committed => committed));
        Assert.Contains(await File.ReadAllTextAsync(path), new[] { "client one", "client two" }, StringComparer.Ordinal);
        Assert.Empty(Directory.EnumerateFiles(_folder, ".tlbx-*"));
    }

    [Theory]
    [InlineData("utf8")]
    [InlineData("utf8-bom")]
    [InlineData("utf16-le")]
    [InlineData("utf16-be")]
    [InlineData("utf32-le")]
    [InlineData("utf32-be")]
    public async Task Save_PreservesEncodingBomAndCrLf(string kind)
    {
        Encoding encoding = kind switch
        {
            "utf8-bom" => new UTF8Encoding(true),
            "utf16-le" => new UnicodeEncoding(false, true),
            "utf16-be" => new UnicodeEncoding(true, true),
            "utf32-le" => new UTF32Encoding(false, true),
            "utf32-be" => new UTF32Encoding(true, true),
            _ => new UTF8Encoding(false)
        };
        var path = Path.Combine(_folder, kind + ".txt");
        await File.WriteAllTextAsync(path, "Hällo 🎸\r\nsecond\r\n", encoding);
        var original = await _documents.ReadAsync(path, true, default);
        Assert.Equal("Hällo 🎸\nsecond\n", original.Content);
        Assert.Equal("crlf", original.LineEnding);
        var saved = await _documents.SaveAsync(path, "Changed 🎸\nsecond\n", original.Version!, default);
        var wanted = encoding.GetPreamble().Concat(encoding.GetBytes("Changed 🎸\r\nsecond\r\n")).ToArray();
        Assert.Equal(wanted, await File.ReadAllBytesAsync(path));
        var current = await _documents.ReadAsync(path, true, default);
        Assert.Equal(current.Version, saved.Version);
        Assert.Equal(original.Encoding, saved.Encoding);
    }

    [Fact]
    public async Task DeletedDocument_IsNotSilentlyRecreated()
    {
        var path = Path.Combine(_folder, "deleted.txt");
        await File.WriteAllTextAsync(path, "base");
        var original = await _documents.ReadAsync(path, true, default);
        File.Delete(path);
        await Assert.ThrowsAsync<FileNotFoundException>(() => _documents.SaveAsync(path, "draft", original.Version!, default));
        Assert.False(File.Exists(path));
    }

    [Fact]
    public async Task VersionFromAnotherPath_CannotAuthorizeAWrite()
    {
        var first = Path.Combine(_folder, "A.txt");
        var second = Path.Combine(_folder, "B.txt");
        await File.WriteAllTextAsync(first, "same base");
        await File.WriteAllTextAsync(second, "same base");
        var original = await _documents.ReadAsync(first, true, default);
        var error = await Assert.ThrowsAsync<FileDocumentException>(() => _documents.SaveAsync(second, "wrong target", original.Version!, default));
        Assert.Equal(409, error.StatusCode);
        Assert.Equal("same base", await File.ReadAllTextAsync(second));
    }

    [Fact]
    public async Task ARepeatedCompletedSave_IsIdempotent()
    {
        var path = Path.Combine(_folder, "retry.txt");
        await File.WriteAllTextAsync(path, "base");
        var original = await _documents.ReadAsync(path, true, default);
        var first = await _documents.SaveAsync(path, "draft", original.Version!, default);
        var modified = File.GetLastWriteTimeUtc(path);
        var repeated = await _documents.SaveAsync(path, "draft", original.Version!, default);
        Assert.Equal(first.Version, repeated.Version);
        Assert.Equal(modified, File.GetLastWriteTimeUtc(path));
    }

    [Fact]
    public async Task CancellationBeforePublication_LeavesOriginalUntouched()
    {
        var path = Path.Combine(_folder, "cancelled.txt");
        await File.WriteAllTextAsync(path, "base");
        var original = await _documents.ReadAsync(path, true, default);
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => _documents.SaveAsync(path, "draft", original.Version!, cancelled.Token));
        Assert.Equal("base", await File.ReadAllTextAsync(path, CancellationToken.None));
        Assert.Empty(Directory.EnumerateFiles(_folder, ".tlbx-*"));
    }

    [Fact]
    public async Task MissingVersion_NeverChangesTheFile()
    {
        var path = Path.Combine(_folder, "blind.txt");
        await File.WriteAllTextAsync(path, "base");
        var error = await Assert.ThrowsAsync<FileDocumentException>(() => _documents.SaveAsync(path, "draft", "", default));
        Assert.Equal(428, error.StatusCode);
        Assert.Equal("base", await File.ReadAllTextAsync(path));
    }

    [Fact]
    public async Task ReadOnlyFile_IsNotChangedEvenWithAValidVersion()
    {
        var path = Path.Combine(_folder, "readonly.txt");
        await File.WriteAllTextAsync(path, "base");
        var original = await _documents.ReadAsync(path, true, default);
        File.SetAttributes(path, File.GetAttributes(path) | FileAttributes.ReadOnly);
        try
        {
            await Assert.ThrowsAsync<UnauthorizedAccessException>(() => _documents.SaveAsync(path, "draft", original.Version!, default));
            Assert.Equal("base", await File.ReadAllTextAsync(path));
            Assert.True((await _documents.ReadAsync(path, true, default)).ReadOnly);
        }
        finally { File.SetAttributes(path, FileAttributes.Normal); }
    }

    [Fact]
    public async Task PreviewDoesNotReplaceAnIncompleteUnicodeCodePoint()
    {
        var path = Path.Combine(_folder, "unicode-boundary.txt");
        await File.WriteAllTextAsync(path, new string('x', FileDocumentService.PreviewBytes - 2) + "🎸end");
        var preview = await _documents.ReadAsync(path, false, default);
        Assert.True(preview.IsTruncated);
        Assert.DoesNotContain('\uFFFD', preview.Content);
        Assert.DoesNotContain("🎸", preview.Content, StringComparison.Ordinal);
        Assert.Equal(FileDocumentService.PreviewBytes - 2, preview.Content.Length);
    }

    [Fact]
    public async Task PartialPreview_IsReadOnlyAndCarriesNoWritableVersion()
    {
        var path = Path.Combine(_folder, "large.txt");
        await File.WriteAllTextAsync(path, new string('x', FileDocumentService.PreviewBytes) + "🎸tail");
        var preview = await _documents.ReadAsync(path, false, default);
        Assert.True(preview.ReadOnly);
        Assert.True(preview.IsTruncated);
        Assert.True(preview.CanLoadFull);
        Assert.Null(preview.Version);
        Assert.DoesNotContain('\uFFFD', preview.Content);
        var complete = await _documents.ReadAsync(path, true, default);
        Assert.False(complete.IsTruncated);
        Assert.NotNull(complete.Version);
        Assert.EndsWith("🎸tail", complete.Content, StringComparison.Ordinal);
    }
}
