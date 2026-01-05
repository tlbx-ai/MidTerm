namespace Ai.Tlbx.MidTerm.Common.Shells;

public interface IShellConfiguration
{
    ShellType ShellType { get; }
    string DisplayName { get; }
    string ExecutablePath { get; }
    string[] Arguments { get; }
    bool SupportsOsc7 { get; }

    Dictionary<string, string> GetEnvironmentVariables();
    bool IsAvailable();
}

public abstract class ShellConfigurationBase : IShellConfiguration
{
    public abstract ShellType ShellType { get; }
    public abstract string DisplayName { get; }
    public abstract string ExecutablePath { get; }
    public abstract string[] Arguments { get; }
    public abstract bool SupportsOsc7 { get; }

    /// <summary>
    /// Configure environment variables for the shell process.
    ///
    /// IMPORTANT FOR TUI IMAGE SUPPORT (e.g., Claude Code):
    /// Complex TUI apps like Claude Code detect their terminal environment to enable features.
    /// Claude Code specifically checks for Windows Terminal by looking at env vars.
    ///
    /// WINDOWS REQUIREMENTS (discovered through testing):
    /// - WT_PROFILE_ID: Must have curly braces around GUID, e.g., {550e8400-...}
    /// - WT_SESSION: Plain GUID without braces
    /// - TERM: Must NOT be set (Windows Terminal doesn't set it)
    /// - COLORTERM: Must NOT be set (Windows Terminal doesn't set it)
    ///
    /// If these don't match exactly, Claude Code won't recognize image paths dropped/pasted
    /// into the terminal and will just show the raw path instead of [Image #1].
    ///
    /// MAC/LINUX REQUIREMENTS (not yet tested):
    /// When testing on Mac/Linux, run Claude Code in the native terminal and compare:
    ///   env | grep -E 'TERM|COLORTERM|ITERM|APPLE|LC_'
    /// Then adjust this method to match what the native terminal sets.
    /// The pattern-matching for image paths may also differ (Unix paths vs Windows paths).
    /// </summary>
    public virtual Dictionary<string, string> GetEnvironmentVariables()
    {
        var env = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (System.Collections.DictionaryEntry entry in Environment.GetEnvironmentVariables())
        {
            if (entry.Key is string key && !string.IsNullOrEmpty(key))
            {
                env[key] = entry.Value?.ToString() ?? string.Empty;
            }
        }

        // Platform-specific terminal environment setup
        if (OperatingSystem.IsWindows())
        {
            // Windows: Mimic Windows Terminal exactly
            // DO NOT set TERM or COLORTERM - Windows Terminal doesn't set these
            env["WT_SESSION"] = Guid.NewGuid().ToString();
            env["WT_PROFILE_ID"] = "{" + Guid.NewGuid().ToString() + "}";
        }
        else
        {
            // Unix: Set standard terminal variables
            // TODO: Test with Claude Code on Mac/Linux and adjust if needed
            env["TERM"] = "xterm-256color";
            env["COLORTERM"] = "truecolor";
        }

        env["LANG"] = "en_US.UTF-8";
        env["LC_ALL"] = "en_US.UTF-8";
        env["MSYS"] = "enable_pcon";

        return env;
    }

    public virtual bool IsAvailable()
    {
        var resolved = ResolveExecutablePath();
        return resolved is not null;
    }

    protected string? ResolveExecutablePath()
    {
        if (Path.IsPathRooted(ExecutablePath) && File.Exists(ExecutablePath))
        {
            return ExecutablePath;
        }

        var pathEnv = Environment.GetEnvironmentVariable("PATH");
        if (pathEnv is null)
        {
            return null;
        }

        var extensions = OperatingSystem.IsWindows()
            ? new[] { ".exe", ".cmd", ".bat", "" }
            : new[] { "" };

        foreach (var dir in pathEnv.Split(Path.PathSeparator))
        {
            foreach (var ext in extensions)
            {
                var candidate = ExecutablePath.EndsWith(ext, StringComparison.OrdinalIgnoreCase)
                    ? Path.Combine(dir, ExecutablePath)
                    : Path.Combine(dir, ExecutablePath + ext);

                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
        }

        return null;
    }
}

public sealed class PwshShellConfiguration : ShellConfigurationBase
{
    private const string StartupScript =
        "[Console]::OutputEncoding=[Console]::InputEncoding=[Text.UTF8Encoding]::new();" +
        "function prompt{$e=[char]27;$b=[char]7;$p='/'+($PWD.Path-replace'\\\\','/');\"$e]7;file://$env:COMPUTERNAME$p$b\"+\"PS $PWD> \"}";

    public override ShellType ShellType => ShellType.Pwsh;
    public override string DisplayName => "PowerShell 7";
    public override string ExecutablePath => "pwsh";
    public override bool SupportsOsc7 => true;
    public override string[] Arguments => ["-NoLogo", "-NoExit", "-Command", StartupScript];
}

public sealed class PowerShellShellConfiguration : ShellConfigurationBase
{
    private const string StartupScript =
        "[Console]::OutputEncoding=[Console]::InputEncoding=[Text.UTF8Encoding]::new();" +
        "function prompt{$e=[char]27;$b=[char]7;$p='/'+($PWD.Path-replace'\\\\','/');\"$e]7;file://$env:COMPUTERNAME$p$b\"+\"PS $PWD> \"}";

    public override ShellType ShellType => ShellType.PowerShell;
    public override string DisplayName => "Windows PowerShell";
    public override string ExecutablePath => "powershell";
    public override bool SupportsOsc7 => true;
    public override string[] Arguments => ["-NoLogo", "-NoExit", "-Command", StartupScript];

    public override bool IsAvailable()
    {
        return OperatingSystem.IsWindows() && base.IsAvailable();
    }
}

public sealed class CmdShellConfiguration : ShellConfigurationBase
{
    public override ShellType ShellType => ShellType.Cmd;
    public override string DisplayName => "Command Prompt";
    public override string ExecutablePath => "cmd.exe";
    public override bool SupportsOsc7 => false;
    public override string[] Arguments => [];

    public override bool IsAvailable()
    {
        return OperatingSystem.IsWindows() && base.IsAvailable();
    }
}

public sealed class BashShellConfiguration : ShellConfigurationBase
{
    public override ShellType ShellType => ShellType.Bash;
    public override string DisplayName => "Bash";
    public override string ExecutablePath => "bash";
    public override bool SupportsOsc7 => true;
    public override string[] Arguments => ["-l"];

    public override Dictionary<string, string> GetEnvironmentVariables()
    {
        var env = base.GetEnvironmentVariables();
        env["PROMPT_COMMAND"] = "printf '\\e]7;file://%s%s\\a' \"$HOSTNAME\" \"$PWD\"";
        return env;
    }

    public override bool IsAvailable()
    {
        return (OperatingSystem.IsLinux() || OperatingSystem.IsMacOS()) && base.IsAvailable();
    }
}

public sealed class ZshShellConfiguration : ShellConfigurationBase
{
    public override ShellType ShellType => ShellType.Zsh;
    public override string DisplayName => "Zsh";
    public override string ExecutablePath => "zsh";
    public override bool SupportsOsc7 => true;
    public override string[] Arguments => ["-l"];

    public override Dictionary<string, string> GetEnvironmentVariables()
    {
        var env = base.GetEnvironmentVariables();
        env["precmd"] = "() { print -Pn \"\\e]7;file://%m%~\\a\" }";
        return env;
    }

    public override bool IsAvailable()
    {
        return (OperatingSystem.IsLinux() || OperatingSystem.IsMacOS()) && base.IsAvailable();
    }
}
