using System.Diagnostics;
using System.Text;
using Ai.Tlbx.MidTerm.Common.Logging;

namespace Ai.Tlbx.MidTerm.Services;

public sealed class ClipboardService
{
    public async Task<bool> SetImageAsync(string filePath, string? mimeType = null)
    {
        if (string.IsNullOrWhiteSpace(filePath) || !File.Exists(filePath))
        {
            return false;
        }

        var resolvedMimeType = ResolveMimeType(filePath, mimeType);
        if (resolvedMimeType is null)
        {
            return false;
        }

        if (OperatingSystem.IsWindows())
        {
            return await SetImageWindowsAsync(filePath);
        }

        if (OperatingSystem.IsMacOS())
        {
            return await SetImageMacOsAsync(filePath);
        }

        if (OperatingSystem.IsLinux())
        {
            return await SetImageLinuxAsync(filePath, resolvedMimeType);
        }

        return false;
    }

    public Task<bool> SetFileDropAsync(string filePath)
    {
        return SetImageAsync(filePath);
    }

    private static async Task<bool> SetImageWindowsAsync(string filePath)
    {
        var escapedPath = filePath.Replace("'", "''");
        var script =
            "Add-Type -AssemblyName System.Windows.Forms; " +
            "Add-Type -AssemblyName System.Drawing; " +
            $"$path = '{escapedPath}'; " +
            "$image = [System.Drawing.Image]::FromFile($path); " +
            "try { " +
            "  $data = New-Object System.Windows.Forms.DataObject; " +
            "  $data.SetData([System.Windows.Forms.DataFormats]::Bitmap, $image); " +
            "  $files = New-Object System.Collections.Specialized.StringCollection; " +
            "  [void]$files.Add($path); " +
            "  $data.SetFileDropList($files); " +
            "  [System.Windows.Forms.Clipboard]::SetDataObject($data, $true); " +
            "} finally { " +
            "  $image.Dispose(); " +
            "}";

        var encodedScript = Convert.ToBase64String(Encoding.Unicode.GetBytes(script));
        return await RunProcessAsync("powershell.exe", ["-NoProfile", "-STA", "-EncodedCommand", encodedScript]);
    }

    private static async Task<bool> SetImageMacOsAsync(string filePath)
    {
        var escapedPath = filePath.Replace("\\", "\\\\").Replace("\"", "\\\"");
        var script = $"set the clipboard to (read (POSIX file \"{escapedPath}\") as picture)";
        return await RunProcessAsync("osascript", ["-e", script]);
    }

    private static async Task<bool> SetImageLinuxAsync(string filePath, string mimeType)
    {
        if (await RunProcessAsync("wl-copy", ["--type", mimeType], standardInputFilePath: filePath, logFailures: false))
        {
            return true;
        }

        return await RunProcessAsync("xclip", ["-selection", "clipboard", "-t", mimeType, "-i", filePath]);
    }

    private static string? ResolveMimeType(string filePath, string? mimeType)
    {
        if (!string.IsNullOrWhiteSpace(mimeType) &&
            mimeType.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
        {
            return NormalizeMimeType(mimeType);
        }

        var extension = Path.GetExtension(filePath).ToLowerInvariant();
        return extension switch
        {
            ".png" => "image/png",
            ".jpg" => "image/jpeg",
            ".jpeg" => "image/jpeg",
            ".gif" => "image/gif",
            ".bmp" => "image/bmp",
            ".webp" => "image/webp",
            ".tif" => "image/tiff",
            ".tiff" => "image/tiff",
            _ => null
        };
    }

    private static string NormalizeMimeType(string mimeType)
    {
        var normalized = mimeType.Trim().ToLowerInvariant();
        return normalized == "image/jpg" ? "image/jpeg" : normalized;
    }

    private static async Task<bool> RunProcessAsync(
        string fileName,
        IReadOnlyList<string> arguments,
        string? standardInputFilePath = null,
        bool logFailures = true)
    {
        try
        {
            using var process = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = fileName,
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    RedirectStandardInput = standardInputFilePath is not null,
                }
            };

            foreach (var argument in arguments)
            {
                process.StartInfo.ArgumentList.Add(argument);
            }

            process.Start();

            if (standardInputFilePath is not null)
            {
                await using var inputFile = File.OpenRead(standardInputFilePath);
                await inputFile.CopyToAsync(process.StandardInput.BaseStream);
                await process.StandardInput.FlushAsync();
                process.StandardInput.Close();
            }

            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
            if (process.ExitCode == 0)
            {
                return true;
            }

            if (!logFailures)
            {
                return false;
            }

            var stderr = await process.StandardError.ReadToEndAsync();
            Log.Warn(() => $"[Clipboard] Command failed ({fileName}, exit {process.ExitCode}): {stderr.Trim()}");
            return false;
        }
        catch (Exception ex)
        {
            if (logFailures)
            {
                Log.Error(() => $"[Clipboard] Set failed ({fileName}): {ex.Message}");
            }
            return false;
        }
    }
}
