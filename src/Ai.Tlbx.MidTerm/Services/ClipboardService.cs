using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;
using System.Text.RegularExpressions;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Services.Sessions;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Services;

public sealed class ClipboardService
{
    private const string MtBinaryPathEnvironmentVariable = "MT_BINARY_PATH";
    private const string MacOsClipboardLabelPrefix = "ai.tlbx.midterm.clipboard.set.";
    private static readonly Regex MacOsExitCodeRegex = new(@"\blast exit code = (?<code>-?\d+)\b", RegexOptions.Compiled);
    private readonly SettingsService _settingsService;

    [DllImport("libc", EntryPoint = "geteuid")]
    private static extern uint geteuid();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ProcessIdToSessionId(uint dwProcessId, out uint pSessionId);

    public ClipboardService(SettingsService settingsService)
    {
        _settingsService = settingsService;
    }

    public async Task<bool> SetImageAsync(string filePath, string? mimeType = null, int? preferredProcessId = null)
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
            return await SetImageWindowsAsync(filePath, resolvedMimeType, preferredProcessId);
        }

        if (OperatingSystem.IsMacOS())
        {
            return await SetImageMacOsAsync(filePath, resolvedMimeType);
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

    [SupportedOSPlatform("windows")]
    private async Task<bool> SetImageWindowsAsync(string filePath, string mimeType, int? preferredProcessId)
    {
        var mtBinaryPath = GetMidTermBinaryPath();
        if (string.IsNullOrWhiteSpace(mtBinaryPath) || !File.Exists(mtBinaryPath))
        {
            Log.Warn(() => $"[Clipboard] Helper missing mt binary: {mtBinaryPath ?? "(null)"}");
            return false;
        }

        var args = BuildClipboardHelperArguments(filePath, mimeType);

#if WINDOWS
        if (_settingsService.IsRunningAsService)
        {
            var workingDir = Path.GetDirectoryName(filePath);
            if (string.IsNullOrWhiteSpace(workingDir) || !Directory.Exists(workingDir))
            {
                workingDir = Path.GetTempPath();
            }

            uint? preferredSessionId = null;
            if (preferredProcessId is > 0 &&
                ProcessIdToSessionId((uint)preferredProcessId.Value, out var sessionId))
            {
                preferredSessionId = sessionId;
            }

            var runAsUser = _settingsService.Load().RunAsUser;
            var result = await TtyHostSpawner.RunCommandAsUserAsync(
                mtBinaryPath,
                args,
                workingDir,
                runAsUser,
                CancellationToken.None,
                preferredSessionId);

            if (result.ExitCode == 0)
            {
                return true;
            }

            var failure = string.IsNullOrWhiteSpace(result.Stderr)
                ? result.Stdout.Trim()
                : result.Stderr.Trim();

            Log.Warn(() => $"[Clipboard] Service-mode clipboard sync failed (runAsUser={runAsUser ?? "(auto)"}): {failure}");
            return false;
        }
#endif

        return await RunProcessAsync(mtBinaryPath, args);
    }

    private static async Task<bool> SetImageMacOsAsync(string filePath, string mimeType)
    {
        var mtBinaryPath = GetMidTermBinaryPath();
        if (string.IsNullOrWhiteSpace(mtBinaryPath) || !File.Exists(mtBinaryPath))
        {
            Log.Warn(() => $"[Clipboard] macOS helper missing mt binary: {mtBinaryPath ?? "(null)"}");
            return false;
        }

        if (await RunProcessAsync(mtBinaryPath, BuildClipboardHelperArguments(filePath, mimeType), logFailures: false))
        {
            return true;
        }

        return await SetImageMacOsViaGuiLaunchAgentAsync(filePath, mimeType, mtBinaryPath);
    }

    private static async Task<bool> SetImageLinuxAsync(string filePath, string mimeType)
    {
        var mtBinaryPath = GetMidTermBinaryPath();
        if (string.IsNullOrWhiteSpace(mtBinaryPath) || !File.Exists(mtBinaryPath))
        {
            Log.Warn(() => $"[Clipboard] Linux helper missing mt binary: {mtBinaryPath ?? "(null)"}");
            return false;
        }

        return await RunProcessAsync(mtBinaryPath, BuildClipboardHelperArguments(filePath, mimeType));
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

    private static async Task<bool> SetImageMacOsViaGuiLaunchAgentAsync(string filePath, string mimeType, string mtBinaryPath)
    {
        var uid = geteuid();
        if (uid == 0)
        {
            return false;
        }

        var label = $"{MacOsClipboardLabelPrefix}{Guid.NewGuid():N}";
        var tempDir = Path.Combine(Path.GetTempPath(), "midterm-launchagents");
        Directory.CreateDirectory(tempDir);

        var plistPath = Path.Combine(tempDir, $"{label}.plist");
        var stdoutPath = Path.Combine(tempDir, $"{label}.stdout.log");
        var stderrPath = Path.Combine(tempDir, $"{label}.stderr.log");

        var plist = BuildMacOsLaunchAgentPlist(
            label,
            BuildClipboardHelperProgramArguments(filePath, mimeType, mtBinaryPath),
            stdoutPath,
            stderrPath);

        await File.WriteAllTextAsync(plistPath, plist, Encoding.UTF8);

        // Defensive cleanup from previous failed attempt with same label.
        await RunProcessAsync("launchctl", ["bootout", $"gui/{uid}/{label}"], logFailures: false);

        var bootstrapResult = await RunProcessCaptureAsync("launchctl", ["bootstrap", $"gui/{uid}", plistPath]);
        if (!bootstrapResult.Started || bootstrapResult.ExitCode != 0)
        {
            if (!string.IsNullOrWhiteSpace(bootstrapResult.Stderr))
            {
                Log.Warn(() => $"[Clipboard] macOS GUI bootstrap failed: {bootstrapResult.Stderr.Trim()}");
            }
            TryDeleteFile(plistPath);
            return false;
        }

        try
        {
            var exitCode = await WaitForMacOsLaunchAgentExitCodeAsync(uid, label, TimeSpan.FromSeconds(5));
            if (exitCode == 0)
            {
                return true;
            }

            var stderrText = TryReadText(stderrPath);
            if (!string.IsNullOrWhiteSpace(stderrText))
            {
                Log.Warn(() => $"[Clipboard] macOS GUI helper failed: {stderrText.Trim()}");
            }

            return false;
        }
        finally
        {
            await RunProcessAsync("launchctl", ["bootout", $"gui/{uid}/{label}"], logFailures: false);
            TryDeleteFile(plistPath);
            TryDeleteFile(stdoutPath);
            TryDeleteFile(stderrPath);
        }
    }

    private static async Task<int?> WaitForMacOsLaunchAgentExitCodeAsync(
        uint uid,
        string label,
        TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;

        while (DateTime.UtcNow < deadline)
        {
            var result = await RunProcessCaptureAsync("launchctl", ["print", $"gui/{uid}/{label}"]);
            if (result.Started && result.ExitCode == 0)
            {
                var match = MacOsExitCodeRegex.Match(result.Stdout);
                if (match.Success &&
                    int.TryParse(match.Groups["code"].Value, out var parsedExit))
                {
                    return parsedExit;
                }
            }

            await Task.Delay(100);
        }

        return null;
    }

    private static string BuildMacOsLaunchAgentPlist(
        string label,
        IReadOnlyList<string> programArguments,
        string stdoutPath,
        string stderrPath)
    {
        var argsBuilder = new StringBuilder();
        foreach (var argument in programArguments)
        {
            argsBuilder.Append("        <string>");
            argsBuilder.Append(EscapeXml(argument));
            argsBuilder.AppendLine("</string>");
        }

        return $$"""
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{{EscapeXml(label)}}</string>
    <key>ProgramArguments</key>
    <array>
{{argsBuilder}}    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>{{EscapeXml(stdoutPath)}}</string>
    <key>StandardErrorPath</key>
    <string>{{EscapeXml(stderrPath)}}</string>
</dict>
</plist>
""";
    }

    private static string? GetMidTermBinaryPath()
    {
        var envPath = Environment.GetEnvironmentVariable(MtBinaryPathEnvironmentVariable);
        if (!string.IsNullOrWhiteSpace(envPath))
        {
            return envPath;
        }

        var exeName = OperatingSystem.IsWindows() ? "mt.exe" : "mt";
        var baseDir = AppContext.BaseDirectory;
        if (!string.IsNullOrWhiteSpace(baseDir))
        {
            var sameDirPath = Path.Combine(baseDir, exeName);
            if (File.Exists(sameDirPath))
            {
                return sameDirPath;
            }
        }

        var currentExe = Environment.ProcessPath;
        if (string.IsNullOrWhiteSpace(currentExe))
        {
            return null;
        }

        if (string.Equals(Path.GetFileName(currentExe), exeName, StringComparison.OrdinalIgnoreCase))
        {
            return currentExe;
        }

        return string.Equals(Path.GetFileNameWithoutExtension(currentExe), "dotnet", StringComparison.OrdinalIgnoreCase)
            ? null
            : currentExe;
    }

    private static string[] BuildClipboardHelperArguments(string filePath, string mimeType)
    {
        return ["--clipboard-write-image", filePath, "--mime", mimeType];
    }

    private static string[] BuildClipboardHelperProgramArguments(string filePath, string mimeType, string mtBinaryPath)
    {
        return [mtBinaryPath, .. BuildClipboardHelperArguments(filePath, mimeType)];
    }

    private static string EscapeXml(string value)
    {
        return value
            .Replace("&", "&amp;", StringComparison.Ordinal)
            .Replace("<", "&lt;", StringComparison.Ordinal)
            .Replace(">", "&gt;", StringComparison.Ordinal)
            .Replace("\"", "&quot;", StringComparison.Ordinal)
            .Replace("'", "&apos;", StringComparison.Ordinal);
    }

    private static string? TryReadText(string path)
    {
        try
        {
            return File.Exists(path) ? File.ReadAllText(path) : null;
        }
        catch
        {
            return null;
        }
    }

    private static void TryDeleteFile(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch
        {
            // Best effort cleanup.
        }
    }

    private static async Task<bool> RunProcessAsync(
        string fileName,
        IReadOnlyList<string> arguments,
        string? standardInputFilePath = null,
        bool logFailures = true)
    {
        var result = await RunProcessCaptureAsync(fileName, arguments, standardInputFilePath);
        if (result.Started && result.ExitCode == 0)
        {
            return true;
        }

        if (!logFailures)
        {
            return false;
        }

        if (!result.Started)
        {
            Log.Error(() => $"[Clipboard] Set failed ({fileName}): {result.Stderr}");
            return false;
        }

        Log.Warn(() => $"[Clipboard] Command failed ({fileName}, exit {result.ExitCode}): {result.Stderr.Trim()}");
        return false;
    }

    private static async Task<(bool Started, int ExitCode, string Stdout, string Stderr)> RunProcessCaptureAsync(
        string fileName,
        IReadOnlyList<string> arguments,
        string? standardInputFilePath = null)
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
            var stdout = await process.StandardOutput.ReadToEndAsync();
            var stderr = await process.StandardError.ReadToEndAsync();
            return (true, process.ExitCode, stdout, stderr);
        }
        catch (Exception ex)
        {
            return (false, -1, string.Empty, ex.Message);
        }
    }
}
