using Ai.Tlbx.MidTerm.Models.Sessions;
using Ai.Tlbx.MidTerm.Services.Sessions;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

[Collection(PathSensitiveEnvironmentCollection.Name)]
public sealed class AiCliCommandLocatorTests
{
    [Fact]
    public void ResolveExecutablePath_UsesAbsoluteForegroundExecutableWhenPathIsMissing()
    {
        using var fakeCodex = FakeCodexPathScope.Create();
        var originalPath = Environment.GetEnvironmentVariable("PATH");
        try
        {
            Environment.SetEnvironmentVariable("PATH", string.Empty);
            var session = new SessionInfoDto
            {
                ForegroundCommandLine = $"\"{fakeCodex.ExecutablePath}\" --yolo"
            };

            var resolved = AiCliCommandLocator.ResolveExecutablePath(AiCliProfileService.CodexProfile, session);

            Assert.Equal(fakeCodex.ExecutablePath, resolved);
        }
        finally
        {
            Environment.SetEnvironmentVariable("PATH", originalPath);
        }
    }

    [Fact]
    public async Task ResolveExecutablePath_DerivesCodexWrapperFromForegroundScriptPath()
    {
        var root = Path.Combine(Path.GetTempPath(), "midterm-codex-locator-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var npmBin = Path.Combine(root, "npm");
            var scriptDirectory = Path.Combine(npmBin, "node_modules", "@openai", "codex", "bin");
            Directory.CreateDirectory(scriptDirectory);

            var scriptPath = Path.Combine(scriptDirectory, "codex.js");
            await File.WriteAllTextAsync(scriptPath, "// fake codex");

            var wrapperPath = Path.Combine(npmBin, OperatingSystem.IsWindows() ? "codex.cmd" : "codex");
            await File.WriteAllTextAsync(wrapperPath, "@echo off");

            var originalPath = Environment.GetEnvironmentVariable("PATH");
            try
            {
                Environment.SetEnvironmentVariable("PATH", string.Empty);
                var session = new SessionInfoDto
                {
                    ForegroundCommandLine = $"node \"{scriptPath}\" --yolo"
                };

                var resolved = AiCliCommandLocator.ResolveExecutablePath(AiCliProfileService.CodexProfile, session);

                Assert.Equal(wrapperPath, resolved);
            }
            finally
            {
                Environment.SetEnvironmentVariable("PATH", originalPath);
            }
        }
        finally
        {
            try
            {
                Directory.Delete(root, recursive: true);
            }
            catch
            {
            }
        }
    }
}
