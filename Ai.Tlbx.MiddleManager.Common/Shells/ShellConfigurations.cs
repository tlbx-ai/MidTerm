namespace Ai.Tlbx.MiddleManager.Common.Shells;

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
        env["TERM"] = OperatingSystem.IsWindows() ? "windows-terminal" : "xterm-256color";
        env["COLORTERM"] = "truecolor";
        env["LANG"] = "en_US.UTF-8";
        env["LC_ALL"] = "en_US.UTF-8";
        env["MSYS"] = "enable_pcon";

        // Mimic Windows Terminal to enable features like bracketed paste detection
        if (OperatingSystem.IsWindows())
        {
            env["WT_SESSION"] = Guid.NewGuid().ToString();
            env["WT_PROFILE_ID"] = Guid.NewGuid().ToString();
        }

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
