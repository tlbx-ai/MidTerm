using Ai.Tlbx.MidTerm.Services;
using Ai.Tlbx.MidTerm.Services.Browser;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class MtcliScriptWriterTests : IDisposable
{
    private readonly string _tempDir = Path.Combine(Path.GetTempPath(), "midterm-mtcli-tests", Guid.NewGuid().ToString("N"));

    [Fact]
    public void WriteScripts_WritesApplyUpdateHelpers()
    {
        Directory.CreateDirectory(_tempDir);

        MtcliScriptWriter.WriteScripts(_tempDir, 2000, "test-token");

        var shell = File.ReadAllText(Path.Combine(_tempDir, "mtcli.sh"));
        var powershell = File.ReadAllText(Path.Combine(_tempDir, "mtcli.ps1"));

        Assert.Contains("mt_apply_update()", shell, StringComparison.Ordinal);
        Assert.Contains("$_MT/api/update/apply", shell, StringComparison.Ordinal);
        Assert.Contains("Current version:", shell, StringComparison.Ordinal);

        Assert.Contains("function Mt-ApplyUpdate", powershell, StringComparison.Ordinal);
        Assert.Contains("$script:_MT/api/update/apply", powershell, StringComparison.Ordinal);
        Assert.Contains("Current version:", powershell, StringComparison.Ordinal);
        Assert.Contains("_MBR", shell, StringComparison.Ordinal);
        Assert.Contains("_MJR", shell, StringComparison.Ordinal);
        Assert.Contains("curl -sk -b", shell, StringComparison.Ordinal);
        Assert.Contains("function script:_MBR", powershell, StringComparison.Ordinal);
        Assert.Contains("function script:_MJR", powershell, StringComparison.Ordinal);
    }

    [Fact]
    public void WriteScripts_WritesOptionalApiKeyAuthHelpers()
    {
        Directory.CreateDirectory(_tempDir);

        MtcliScriptWriter.WriteScripts(_tempDir, 2000, "test-token");

        var shell = File.ReadAllText(Path.Combine(_tempDir, "mtcli.sh"));
        var powershell = File.ReadAllText(Path.Combine(_tempDir, "mtcli.ps1"));

        Assert.Contains("set MT_API_KEY", shell, StringComparison.Ordinal);
        Assert.Contains("Authorization: Bearer $MT_API_KEY", shell, StringComparison.Ordinal);
        Assert.Contains("curl -sfk -H", shell, StringComparison.Ordinal);
        Assert.Contains("curl -sk -H", shell, StringComparison.Ordinal);

        Assert.Contains("set MT_API_KEY", powershell, StringComparison.Ordinal);
        Assert.Contains("$env:MT_API_KEY", powershell, StringComparison.Ordinal);
        Assert.Contains("Authorization: Bearer $($env:MT_API_KEY)", powershell, StringComparison.Ordinal);
        Assert.Contains("& curl.exe -sfk -H", powershell, StringComparison.Ordinal);
        Assert.Contains("& curl.exe -sk -H", powershell, StringComparison.Ordinal);
    }

    [Fact]
    public void WriteScripts_WritesSessionScopedPreviewHelpers()
    {
        Directory.CreateDirectory(_tempDir);

        MtcliScriptWriter.WriteScripts(_tempDir, 2000, "test-token");

        var shell = File.ReadAllText(Path.Combine(_tempDir, "mtcli.sh"));
        var powershell = File.ReadAllText(Path.Combine(_tempDir, "mtcli.ps1"));

        Assert.Contains("MT_SESSION_ID", shell, StringComparison.Ordinal);
        Assert.Contains("MT_PREVIEW_NAME", shell, StringComparison.Ordinal);
        Assert.Contains("mt_session()", shell, StringComparison.Ordinal);
        Assert.Contains("mt_preview()", shell, StringComparison.Ordinal);
        Assert.Contains("mt_previews()", shell, StringComparison.Ordinal);
        Assert.Contains("sessionId", shell, StringComparison.Ordinal);
        Assert.Contains("$(_MSID)", shell, StringComparison.Ordinal);
        Assert.Contains("previewName", shell, StringComparison.Ordinal);
        Assert.Contains("$(_MPREVIEW)", shell, StringComparison.Ordinal);
        Assert.Contains("function Mt-Session", powershell, StringComparison.Ordinal);
        Assert.Contains("function Mt-Preview", powershell, StringComparison.Ordinal);
        Assert.Contains("function Mt-Previews", powershell, StringComparison.Ordinal);
        Assert.Contains("$env:MT_SESSION_ID", powershell, StringComparison.Ordinal);
        Assert.Contains("previewName=(_MPreview)", powershell, StringComparison.Ordinal);
    }

    [Fact]
    public void WriteScripts_WritesRemoteSessionControlHelpers()
    {
        Directory.CreateDirectory(_tempDir);

        MtcliScriptWriter.WriteScripts(_tempDir, 2000, "test-token");

        var shell = File.ReadAllText(Path.Combine(_tempDir, "mtcli.sh"));
        var powershell = File.ReadAllText(Path.Combine(_tempDir, "mtcli.ps1"));

        Assert.Contains("mt_tail()", shell, StringComparison.Ordinal);
        Assert.Contains("mt_sendtext()", shell, StringComparison.Ordinal);
        Assert.Contains("mt_prompt()", shell, StringComparison.Ordinal);
        Assert.Contains("mt_prompt_now()", shell, StringComparison.Ordinal);
        Assert.Contains("mt_slash()", shell, StringComparison.Ordinal);
        Assert.Contains("mt_sendkeys()", shell, StringComparison.Ordinal);
        Assert.Contains("mt_inject()", shell, StringComparison.Ordinal);
        Assert.Contains("mt_activity()", shell, StringComparison.Ordinal);
        Assert.Contains("mt_attention()", shell, StringComparison.Ordinal);
        Assert.Contains("mt_bootstrap()", shell, StringComparison.Ordinal);
        Assert.Contains("mt_ctrlc()", shell, StringComparison.Ordinal);
        Assert.Contains("function Mt-Tail", powershell, StringComparison.Ordinal);
        Assert.Contains("function Mt-SendText", powershell, StringComparison.Ordinal);
        Assert.Contains("function Mt-Prompt", powershell, StringComparison.Ordinal);
        Assert.Contains("function Mt-PromptNow", powershell, StringComparison.Ordinal);
        Assert.Contains("function Mt-Slash", powershell, StringComparison.Ordinal);
        Assert.Contains("function Mt-SendKeys", powershell, StringComparison.Ordinal);
        Assert.Contains("function Mt-Inject", powershell, StringComparison.Ordinal);
        Assert.Contains("function Mt-Activity", powershell, StringComparison.Ordinal);
        Assert.Contains("function Mt-Attention", powershell, StringComparison.Ordinal);
        Assert.Contains("function Mt-Bootstrap", powershell, StringComparison.Ordinal);
        Assert.Contains("function Mt-Ctrlc", powershell, StringComparison.Ordinal);
        Assert.Contains("ValueFromRemainingArguments", powershell, StringComparison.Ordinal);
        Assert.Contains("/buffer/tail?lines=", shell, StringComparison.Ordinal);
        Assert.Contains("/input/keys", powershell, StringComparison.Ordinal);
        Assert.Contains("/input/text", shell, StringComparison.Ordinal);
        Assert.Contains("/input/prompt", shell, StringComparison.Ordinal);
        Assert.Contains("/inject-guidance", shell, StringComparison.Ordinal);
        Assert.Contains("/api/sessions/attention", shell, StringComparison.Ordinal);
        Assert.Contains("/api/workers/bootstrap", powershell, StringComparison.Ordinal);
        Assert.Contains("/activity?seconds=", powershell, StringComparison.Ordinal);
    }

    [Fact]
    public void WriteScripts_WritesAnonymousBrowserFallbackForImplicitSessionScope()
    {
        Directory.CreateDirectory(_tempDir);

        MtcliScriptWriter.WriteScripts(_tempDir, 2000, "test-token");

        var shell = File.ReadAllText(Path.Combine(_tempDir, "mtcli.sh"));
        var powershell = File.ReadAllText(Path.Combine(_tempDir, "mtcli.ps1"));

        Assert.Contains("_MNOSESSION()", shell, StringComparison.Ordinal);
        Assert.Contains("output=$(_MB \"${original[@]}\")", shell, StringComparison.Ordinal);
        Assert.DoesNotContain("[ $exitCode -ne 0 ] && [ $injectedSession -eq 1 ] && _MNOSESSION", shell, StringComparison.Ordinal);
        Assert.DoesNotContain("if [ -n \"$(_MPREVIEW)\" ] && ! _MHAS \"--preview\" \"${args[@]}\"; then", shell, StringComparison.Ordinal);

        Assert.Contains("function script:_MShouldRetryAnonymous", powershell, StringComparison.Ordinal);
        Assert.Contains("$output = _MB @originalArgs", powershell, StringComparison.Ordinal);
        Assert.DoesNotContain("$exitCode -ne 0 -and $injectedSession -and (_MShouldRetryAnonymous $output)", powershell, StringComparison.Ordinal);
        Assert.Contains("elseif ($env:MT_PREVIEW_NAME -and -not ($allArgs -contains \"--preview\"))", powershell, StringComparison.Ordinal);
    }

    [Fact]
    public void Ensure_WritesAgentsGuidanceWithSessionScopedPreviewWorkflow()
    {
        Directory.CreateDirectory(_tempDir);

        MidtermDirectory.Ensure(_tempDir);

        var agentsPath = Path.Combine(_tempDir, MidtermDirectory.DirectoryName, "AGENTS.md");
        var agents = File.ReadAllText(agentsPath);

        Assert.Contains("guidance-version: 18", agents, StringComparison.Ordinal);
        Assert.Contains("mt_apply_update", agents, StringComparison.Ordinal);
        Assert.Contains("continue with the new build", agents, StringComparison.Ordinal);
        Assert.Contains("mt_open` both sets the target", agents, StringComparison.Ordinal);
        Assert.Contains("mt_open is the CLI command that opens/docks the preview", agents, StringComparison.Ordinal);
        Assert.Contains("mt_session prints the current MidTerm terminal session ID", agents, StringComparison.Ordinal);
        Assert.Contains("mt_preview user1", agents, StringComparison.Ordinal);
        Assert.Contains("mt_tail", agents, StringComparison.Ordinal);
        Assert.Contains("mt_prompt", agents, StringComparison.Ordinal);
        Assert.Contains("mt_prompt_now", agents, StringComparison.Ordinal);
        Assert.Contains("mt_slash", agents, StringComparison.Ordinal);
        Assert.Contains("mt_sendkeys", agents, StringComparison.Ordinal);
        Assert.Contains("mt_activity", agents, StringComparison.Ordinal);
        Assert.Contains("mt_attention", agents, StringComparison.Ordinal);
        Assert.Contains("mt_bootstrap", agents, StringComparison.Ordinal);
        Assert.Contains("atomically", agents, StringComparison.Ordinal);
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(_tempDir))
            {
                Directory.Delete(_tempDir, recursive: true);
            }
        }
        catch
        {
        }
    }
}
