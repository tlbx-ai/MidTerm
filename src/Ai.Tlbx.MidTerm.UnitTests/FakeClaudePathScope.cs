namespace Ai.Tlbx.MidTerm.UnitTests;

internal sealed class FakeClaudePathScope : IDisposable
{
    private const string FakeClaudeStateDirVariable = "MIDTERM_FAKE_CLAUDE_STATE_DIR";

    private readonly string? _originalPath;
    private readonly string? _originalStateDir;

    private FakeClaudePathScope(
        string root,
        string fakeClaudeBin,
        string? originalPath,
        string? originalStateDir)
    {
        Root = root;
        FakeClaudeBin = fakeClaudeBin;
        _originalPath = originalPath;
        _originalStateDir = originalStateDir;
    }

    public string Root { get; }

    public string FakeClaudeBin { get; }

    public string ExecutablePath =>
        Path.Combine(FakeClaudeBin, OperatingSystem.IsWindows() ? "claude.exe" : "claude");

    public static FakeClaudePathScope Create()
    {
        var root = Path.Combine(Path.GetTempPath(), "midterm-fake-claude-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);

        var executablePath = TestExecutablePathResolver.ResolveExecutablePath(
            AppContext.BaseDirectory,
            "Ai.Tlbx.MidTerm.FakeClaude",
            "claude");
        var fakeClaudeBin = Path.GetDirectoryName(executablePath)
            ?? throw new InvalidOperationException($"Could not determine fake Claude output directory from '{executablePath}'.");

        var originalPath = Environment.GetEnvironmentVariable("PATH");
        var originalStateDir = Environment.GetEnvironmentVariable(FakeClaudeStateDirVariable);
        var stateDir = Path.Combine(root, "state");
        Directory.CreateDirectory(stateDir);
        Environment.SetEnvironmentVariable("PATH", fakeClaudeBin + Path.PathSeparator + originalPath);
        Environment.SetEnvironmentVariable(FakeClaudeStateDirVariable, stateDir);
        return new FakeClaudePathScope(root, fakeClaudeBin, originalPath, originalStateDir);
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable("PATH", _originalPath);
        Environment.SetEnvironmentVariable(FakeClaudeStateDirVariable, _originalStateDir);
        try
        {
            Directory.Delete(Root, recursive: true);
        }
        catch
        {
        }
    }
}
