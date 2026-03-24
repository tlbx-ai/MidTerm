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

    public string ExecutablePath =>
        Path.Combine(FakeClaudeBin, OperatingSystem.IsWindows() ? "claude.exe" : "claude");

    public static FakeClaudePathScope Create()
    {
        var root = Path.Combine(Path.GetTempPath(), "midterm-fake-claude-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);

        var fakeClaudeBin = ResolveFakeClaudeOutputDirectory();
        var executableName = OperatingSystem.IsWindows() ? "claude.exe" : "claude";
        var executablePath = Path.Combine(fakeClaudeBin, executableName);
        if (!File.Exists(executablePath))
        {
            throw new InvalidOperationException($"Expected fake Claude executable at '{executablePath}'.");
        }

        var originalPath = Environment.GetEnvironmentVariable("PATH");
        Environment.SetEnvironmentVariable("PATH", fakeClaudeBin + Path.PathSeparator + originalPath);
        return new FakeClaudePathScope(root, fakeClaudeBin, originalPath);
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable("PATH", _originalPath);
        try
        {
            Directory.Delete(Root, recursive: true);
        }
        catch
        {
        }
    }

    private static string ResolveFakeClaudeOutputDirectory()
    {
        var repoRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
        return Path.Combine(
            repoRoot,
            "src",
            "Ai.Tlbx.MidTerm.FakeClaude",
            "bin",
            "Debug",
            "net10.0");
    }
}
