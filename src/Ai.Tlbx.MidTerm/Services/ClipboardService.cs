using System.Diagnostics;
using Ai.Tlbx.MidTerm.Common.Logging;

namespace Ai.Tlbx.MidTerm.Services;

public sealed class ClipboardService
{
    public async Task<bool> SetFileDropAsync(string filePath)
    {
        if (OperatingSystem.IsWindows())
        {
            return await SetFileDropWindowsAsync(filePath);
        }

        if (OperatingSystem.IsMacOS())
        {
            return await SetFileDropMacOsAsync(filePath);
        }

        if (OperatingSystem.IsLinux())
        {
            return await SetFileDropLinuxAsync(filePath);
        }

        return false;
    }

    private static async Task<bool> SetFileDropWindowsAsync(string filePath)
    {
        var escapedPath = filePath.Replace("'", "''");
        var script =
            "Add-Type -AssemblyName System.Windows.Forms; " +
            "$c = [System.Collections.Specialized.StringCollection]::new(); " +
            $"$c.Add('{escapedPath}'); " +
            "[System.Windows.Forms.Clipboard]::SetFileDropList($c)";

        return await RunProcessAsync("powershell.exe", $"-NoProfile -Command \"{script}\"");
    }

    private static async Task<bool> SetFileDropMacOsAsync(string filePath)
    {
        var escapedPath = filePath.Replace("\"", "\\\"");
        var script = $"set the clipboard to (read (POSIX file \"{escapedPath}\") as «class PNGf»)";
        return await RunProcessAsync("osascript", $"-e '{script}'");
    }

    private static async Task<bool> SetFileDropLinuxAsync(string filePath)
    {
        return await RunProcessAsync("xclip", $"-selection clipboard -t image/png -i \"{filePath}\"");
    }

    private static async Task<bool> RunProcessAsync(string fileName, string arguments)
    {
        try
        {
            using var process = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = fileName,
                    Arguments = arguments,
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                }
            };
            process.Start();
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
            return process.ExitCode == 0;
        }
        catch (Exception ex)
        {
            Log.Error(() => $"[Clipboard] Set failed ({fileName}): {ex.Message}");
            return false;
        }
    }
}
