namespace Ai.Tlbx.MidTerm.UnitTests;

internal sealed class FakeCodexPathScope : IDisposable
{
    private readonly string? _originalPath;
    private readonly string? _originalCapturePath;

    private FakeCodexPathScope(string root, string fakeCodexBin, string capturePath, string? originalPath, string? originalCapturePath)
    {
        Root = root;
        FakeCodexBin = fakeCodexBin;
        CapturePath = capturePath;
        _originalPath = originalPath;
        _originalCapturePath = originalCapturePath;
    }

    public string Root { get; }

    public string FakeCodexBin { get; }

    public string CapturePath { get; }

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
        var capturePath = Path.Combine(root, "fake-codex-launch.json");
        var originalCapturePath = Environment.GetEnvironmentVariable("MIDTERM_FAKE_CODEX_CAPTURE_PATH");
        Environment.SetEnvironmentVariable("PATH", fakeCodexBin + Path.PathSeparator + originalPath);
        Environment.SetEnvironmentVariable("MIDTERM_FAKE_CODEX_CAPTURE_PATH", capturePath);
        return new FakeCodexPathScope(root, fakeCodexBin, capturePath, originalPath, originalCapturePath);
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable("PATH", _originalPath);
        Environment.SetEnvironmentVariable("MIDTERM_FAKE_CODEX_CAPTURE_PATH", _originalCapturePath);
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
