using System.Diagnostics;

namespace Ai.Tlbx.MidTerm.Services.Security;

public sealed class WindowsPowerShellCommandRunner : IPowerShellCommandRunner
{
    public PowerShellCommandResult Run(string script)
    {
        var psi = new ProcessStartInfo
        {
            FileName = GetPowerShellPath(),
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        psi.ArgumentList.Add("-NoProfile");
        psi.ArgumentList.Add("-NonInteractive");
        psi.ArgumentList.Add("-ExecutionPolicy");
        psi.ArgumentList.Add("Bypass");
        psi.ArgumentList.Add("-Command");
        psi.ArgumentList.Add(script);

        using var process = Process.Start(psi) ?? throw new InvalidOperationException("Failed to start PowerShell.");
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();

        return new PowerShellCommandResult
        {
            ExitCode = process.ExitCode,
            StdOut = stdout,
            StdErr = stderr
        };
    }

    private static string GetPowerShellPath()
    {
        var systemDir = Environment.GetFolderPath(Environment.SpecialFolder.System);
        return Path.Combine(systemDir, "WindowsPowerShell", "v1.0", "powershell.exe");
    }
}
