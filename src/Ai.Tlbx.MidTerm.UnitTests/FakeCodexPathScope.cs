namespace Ai.Tlbx.MidTerm.UnitTests;

internal sealed class FakeCodexPathScope : IDisposable
{
    private readonly string? _originalPath;

    private FakeCodexPathScope(string root, string fakeCodexBin, string? originalPath)
    {
        Root = root;
        FakeCodexBin = fakeCodexBin;
        _originalPath = originalPath;
    }

    public string Root { get; }

    public string FakeCodexBin { get; }

    public string ExecutablePath =>
        Path.Combine(FakeCodexBin, OperatingSystem.IsWindows() ? "codex.exe" : "codex");

    public static FakeCodexPathScope Create()
    {
        var root = Path.Combine(Path.GetTempPath(), "midterm-fake-codex-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);

        var fakeCodexBin = ResolveFakeCodexOutputDirectory();
        var executableName = OperatingSystem.IsWindows() ? "codex.exe" : "codex";
        var executablePath = Path.Combine(fakeCodexBin, executableName);
        if (!File.Exists(executablePath))
        {
            throw new InvalidOperationException($"Expected fake Codex executable at '{executablePath}'.");
        }

        var originalPath = Environment.GetEnvironmentVariable("PATH");
        Environment.SetEnvironmentVariable("PATH", fakeCodexBin + Path.PathSeparator + originalPath);
        return new FakeCodexPathScope(root, fakeCodexBin, originalPath);
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

    private static string ResolveFakeCodexOutputDirectory()
    {
        var repoRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
        return Path.Combine(
            repoRoot,
            "src",
            "Ai.Tlbx.MidTerm.FakeCodex",
            "bin",
            "Debug",
            "net10.0");
    }
}
