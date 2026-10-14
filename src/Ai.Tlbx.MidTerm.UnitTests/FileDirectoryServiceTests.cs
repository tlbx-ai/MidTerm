using System.Diagnostics;
using Ai.Tlbx.MidTerm.Services;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class FileDirectoryServiceTests : IDisposable
{
    private readonly string _folder = Path.Combine(Path.GetTempPath(), $"file_visibility_test_{Guid.NewGuid():N}");
    public FileDirectoryServiceTests() => Directory.CreateDirectory(_folder);
    private Task<string?> Accessible(string path) => Task.FromResult<string?>(FileDocumentService.ResolvePath(path));

    [Fact]
    public async Task NonGitFoldersAreNotSilentlyExcluded()
    {
        Directory.CreateDirectory(Path.Combine(_folder, "node_modules"));
        Directory.CreateDirectory(Path.Combine(_folder, "bin"));
        Directory.CreateDirectory(Path.Combine(_folder, "empty"));
        var hidden = Path.Combine(_folder, ".hidden.txt");
        File.WriteAllText(hidden, "hidden");
        if (OperatingSystem.IsWindows()) File.SetAttributes(hidden, File.GetAttributes(hidden) | FileAttributes.Hidden);
        var defaultView = await FileDirectoryService.ReadAsync(_folder, false, true, Accessible);
        Assert.Contains(defaultView.Entries, entry => entry.Name == "node_modules");
        Assert.Contains(defaultView.Entries, entry => entry.Name == "bin");
        Assert.DoesNotContain(defaultView.Entries, entry => entry.Name == ".hidden.txt");
        Assert.Equal(1, defaultView.Visibility.HiddenCount);
        Assert.False(defaultView.Visibility.IsGitRepo);
        var all = await FileDirectoryService.ReadAsync(_folder, true, false, Accessible);
        Assert.Equal(4, all.Entries.Length);
        Assert.Equal(0, all.Visibility.ExcludedCount);
    }

    [Fact]
    public async Task GitRulesIncludeEmptyDirectoriesAndDoNotHideTrackedFiles()
    {
        await Git("init", "--quiet");
        File.WriteAllText(Path.Combine(_folder, ".gitignore"), "*.log\nignored-empty/\nmixed/\n");
        foreach (var name in new[] { "tracked.log", "with space.log", "unicode-Ω.log", "visible.txt" }) File.WriteAllText(Path.Combine(_folder, name), name);
        Directory.CreateDirectory(Path.Combine(_folder, "ignored-empty"));
        Directory.CreateDirectory(Path.Combine(_folder, "visible-empty"));
        Directory.CreateDirectory(Path.Combine(_folder, "mixed"));
        File.WriteAllText(Path.Combine(_folder, "mixed", "tracked.txt"), "tracked inside ignored directory");
        await Git("add", "--force", "tracked.log");
        await Git("add", "--force", "mixed/tracked.txt");
        var all = await FileDirectoryService.ReadAsync(_folder, true, true, Accessible);
        Assert.True(all.Visibility.IgnoreAvailable);
        Assert.Contains(all.Entries, entry => entry.Name == "ignored-empty" && entry.IsIgnored);
        Assert.Contains(all.Entries, entry => entry.Name == "with space.log" && entry.IsIgnored);
        Assert.Contains(all.Entries, entry => entry.Name == "unicode-Ω.log" && entry.IsIgnored);
        Assert.Contains(all.Entries, entry => entry.Name == "tracked.log" && !entry.IsIgnored);
        var filtered = await FileDirectoryService.ReadAsync(_folder, true, false, Accessible);
        Assert.Contains(filtered.Entries, entry => entry.Name == "tracked.log");
        Assert.Contains(filtered.Entries, entry => entry.Name == "visible-empty");
        Assert.Contains(filtered.Entries, entry => entry.Name == "mixed");
        Assert.DoesNotContain(filtered.Entries, entry => entry.IsIgnored);
        Assert.Equal(all.Entries.Length - filtered.Entries.Length, filtered.Visibility.ExcludedCount);
    }

    private async Task Git(params string[] args)
    {
        using var process = new Process { StartInfo = new ProcessStartInfo("git")
        { WorkingDirectory = _folder, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true } };
        foreach (var arg in args) process.StartInfo.ArgumentList.Add(arg);
        process.Start();
        var stdout = process.StandardOutput.ReadToEndAsync(Xunit.TestContext.Current.CancellationToken); var stderr = process.StandardError.ReadToEndAsync(Xunit.TestContext.Current.CancellationToken);
        await process.WaitForExitAsync(Xunit.TestContext.Current.CancellationToken); await stdout;
        Assert.True(process.ExitCode == 0, await stderr);
    }

    public void Dispose()
    {
        var full = Path.GetFullPath(_folder);
        if (!full.StartsWith(Path.GetFullPath(Path.GetTempPath()), StringComparison.OrdinalIgnoreCase) ||
            !Path.GetFileName(full).StartsWith("file_visibility_test_", StringComparison.Ordinal)) throw new InvalidOperationException("Unexpected fixture.");
        foreach (var file in Directory.EnumerateFiles(full, "*", SearchOption.AllDirectories)) File.SetAttributes(file, FileAttributes.Normal);
        Directory.Delete(full, recursive: true); GC.SuppressFinalize(this);
    }
}
