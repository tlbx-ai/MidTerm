using Ai.Tlbx.MidTerm.Services.Tmux.Commands;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public class BashTranslationTests
{
    [Fact]
    public void PowerShell_ClaudeCodeAgentCommand()
    {
        var bash = "cd 'Q:\\repos\\MidTerm' && CLAUDECODE=1 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 'C:\\Users\\johan\\.local\\bin\\claude.exe' --agent-id uncle-bob@code-review --model claude-opus-4-6";
        var result = IoCommands.TranslateForPowerShell(bash);

        Assert.Equal(
            "cd 'Q:\\repos\\MidTerm'; $env:CLAUDECODE='1'; $env:CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS='1'; & 'C:\\Users\\johan\\.local\\bin\\claude.exe' --agent-id uncle-bob@code-review --model claude-opus-4-6",
            result);
    }

    [Fact]
    public void PowerShell_NoEnvVars_PassesThrough()
    {
        var result = IoCommands.TranslateForPowerShell("cd 'Q:\\repos' && ls -la");
        Assert.Equal("cd 'Q:\\repos'; ls -la", result);
    }

    [Fact]
    public void PowerShell_SingleEnvVar()
    {
        var result = IoCommands.TranslateForPowerShell("FOO=bar command --arg");
        Assert.Equal("$env:FOO='bar'; command --arg", result);
    }

    [Fact]
    public void PowerShell_QuotedCommand_AddsCallOperator()
    {
        var result = IoCommands.TranslateForPowerShell("MY_VAR=123 '/path/to/exe' --flag");
        Assert.Equal("$env:MY_VAR='123'; & '/path/to/exe' --flag", result);
    }

    [Fact]
    public void PowerShell_UnquotedCommand_NoCallOperator()
    {
        var result = IoCommands.TranslateForPowerShell("MY_VAR=123 command --flag");
        Assert.Equal("$env:MY_VAR='123'; command --flag", result);
    }

    [Fact]
    public void PowerShell_PlainCommand_Unchanged()
    {
        var result = IoCommands.TranslateForPowerShell("ls -la /tmp");
        Assert.Equal("ls -la /tmp", result);
    }

    [Fact]
    public void PowerShell_MultipleChainedSegments()
    {
        var result = IoCommands.TranslateForPowerShell("cd /tmp && FOO=1 BAR=2 cmd && echo done");
        Assert.Equal("cd /tmp; $env:FOO='1'; $env:BAR='2'; cmd; echo done", result);
    }

    [Fact]
    public void Cmd_ClaudeCodeAgentCommand()
    {
        var bash = "cd 'Q:\\repos\\MidTerm' && CLAUDECODE=1 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 'C:\\Users\\johan\\.local\\bin\\claude.exe' --agent-id uncle-bob@code-review";
        var result = IoCommands.TranslateForCmd(bash);

        Assert.Equal(
            "cd 'Q:\\repos\\MidTerm'&&set \"CLAUDECODE=1\"&& set \"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1\"&& 'C:\\Users\\johan\\.local\\bin\\claude.exe' --agent-id uncle-bob@code-review",
            result);
    }

    [Fact]
    public void Cmd_NoEnvVars_PassesThrough()
    {
        var result = IoCommands.TranslateForCmd("cd /tmp && dir");
        Assert.Equal("cd /tmp&&dir", result);
    }

    [Fact]
    public void Cmd_SingleEnvVar()
    {
        var result = IoCommands.TranslateForCmd("FOO=bar command --arg");
        Assert.Equal("set \"FOO=bar\"&& command --arg", result);
    }

    [Fact]
    public void Routing_Pwsh_Translates()
    {
        var result = IoCommands.TranslateBashEnvVars("FOO=1 cmd", "Pwsh");
        Assert.Equal("$env:FOO='1'; cmd", result);
    }

    [Fact]
    public void Routing_PowerShell_Translates()
    {
        var result = IoCommands.TranslateBashEnvVars("FOO=1 cmd", "PowerShell");
        Assert.Equal("$env:FOO='1'; cmd", result);
    }

    [Fact]
    public void Routing_Cmd_Translates()
    {
        var result = IoCommands.TranslateBashEnvVars("FOO=1 cmd", "Cmd");
        Assert.Equal("set \"FOO=1\"&& cmd", result);
    }

    [Fact]
    public void Routing_Bash_ReturnsNull()
    {
        var result = IoCommands.TranslateBashEnvVars("FOO=1 cmd", "Bash");
        Assert.Null(result);
    }

    [Fact]
    public void Routing_Zsh_ReturnsNull()
    {
        var result = IoCommands.TranslateBashEnvVars("FOO=1 cmd", "Zsh");
        Assert.Null(result);
    }

    [Fact]
    public void Routing_Null_ReturnsNull()
    {
        var result = IoCommands.TranslateBashEnvVars("FOO=1 cmd", null);
        Assert.Null(result);
    }
}
