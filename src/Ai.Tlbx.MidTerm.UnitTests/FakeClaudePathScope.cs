namespace Ai.Tlbx.MidTerm.UnitTests;

internal sealed class FakeClaudePathScope : IDisposable
{
    private readonly string? _originalPath;

    private FakeClaudePathScope(string root, string fakeClaudeBin, string? originalPath)
    {
        Root = root;
        FakeClaudeBin = fakeClaudeBin;
        _originalPath = originalPath;
    }

    public string Root { get; }
    public string FakeClaudeBin { get; }
    public string ExecutablePath => Path.Combine(FakeClaudeBin, OperatingSystem.IsWindows() ? "claude.exe" : "claude");

    public static FakeClaudePathScope Create()
    {
        var root = Path.Combine(Path.GetTempPath(), "tlbx-fake-claude-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var executablePath = TestExecutablePathResolver.ResolveExecutablePath(AppContext.BaseDirectory, "Ai.Tlbx.MidTerm.FakeClaude", "claude");
        var bin = Path.GetDirectoryName(executablePath) ?? throw new InvalidOperationException("Fake Claude output directory was not found.");
        var originalPath = Environment.GetEnvironmentVariable("PATH");
        Environment.SetEnvironmentVariable("PATH", bin + Path.PathSeparator + originalPath);
        return new FakeClaudePathScope(root, bin, originalPath);
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable("PATH", _originalPath);
        try { Directory.Delete(Root, recursive: true); } catch { }
    }
}
