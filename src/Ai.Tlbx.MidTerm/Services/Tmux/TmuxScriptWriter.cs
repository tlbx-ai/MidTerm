using Ai.Tlbx.MidTerm.Common.Logging;

namespace Ai.Tlbx.MidTerm.Services.Tmux;

/// <summary>
/// Writes tmux shim scripts to a temp directory at startup.
/// On Unix: creates /tmp/midterm-bin-{pid}/tmux (shell script).
/// On Windows: creates tmux.ps1 + tmux.cmd in %TEMP%\midterm-bin-{pid}.
/// The shim scripts null-delimit args and POST them to /api/tmux.
/// </summary>
public static class TmuxScriptWriter
{
    private static string? _scriptDirectory;

    /// <summary>
    /// The directory containing the tmux script. Used to prepend to PATH.
    /// </summary>
    public static string? ScriptDirectory => _scriptDirectory;

    /// <summary>
    /// Write platform-appropriate tmux shim script(s) and set <see cref="ScriptDirectory"/>.
    /// </summary>
    public static void WriteScript(int port)
    {
        if (OperatingSystem.IsWindows())
        {
            // Windows uses a PowerShell function injected in shell startup
            // But we still create a .cmd wrapper for WSL/Git Bash scenarios
            WriteWindowsScript(port);
            return;
        }

        WriteUnixScript(port);
    }

    private static void WriteUnixScript(int port)
    {
        var pid = Environment.ProcessId;
        var dir = $"/tmp/midterm-bin-{pid}";

        try
        {
            Directory.CreateDirectory(dir);
            var scriptPath = Path.Combine(dir, "tmux");

            var script = $"""
                #!/bin/sh
                printf '%s\0' "$@" | curl -s -b "mm-session=$MT_TOKEN" \
                  -H "X-Tmux-Pane: $TMUX_PANE" --data-binary @- \
                  "http://localhost:{port}/api/tmux" 2>/dev/null
                """;

            File.WriteAllText(scriptPath, script);

            if (!OperatingSystem.IsWindows())
            {
                File.SetUnixFileMode(scriptPath,
                    UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute |
                    UnixFileMode.GroupRead | UnixFileMode.GroupExecute |
                    UnixFileMode.OtherRead | UnixFileMode.OtherExecute);
            }

            _scriptDirectory = dir;
            Log.Info(() => $"TmuxScriptWriter: Created tmux script at {scriptPath}");
        }
        catch (Exception ex)
        {
            Log.Warn(() => $"TmuxScriptWriter: Failed to write Unix script: {ex.Message}");
        }
    }

    private static void WriteWindowsScript(int port)
    {
        var pid = Environment.ProcessId;
        var dir = Path.Combine(Path.GetTempPath(), $"midterm-bin-{pid}");

        try
        {
            Directory.CreateDirectory(dir);

            var ps1Path = Path.Combine(dir, "tmux.ps1");
            var ps1Script = $$"""
                $body = [System.IO.MemoryStream]::new()
                foreach ($a in $args) {
                    $b = [System.Text.Encoding]::UTF8.GetBytes($a)
                    $body.Write($b, 0, $b.Length)
                    $body.WriteByte(0)
                }
                $tmp = Join-Path $env:TEMP "mt-tmux-$PID.bin"
                [System.IO.File]::WriteAllBytes($tmp, $body.ToArray())
                try {
                    & curl.exe -s -b "mm-session=$env:MT_TOKEN" -H "X-Tmux-Pane: $env:TMUX_PANE" --data-binary "@$tmp" "http://localhost:{{port}}/api/tmux" 2>$null
                } finally {
                    Remove-Item $tmp -ErrorAction SilentlyContinue
                }
                """;
            File.WriteAllText(ps1Path, ps1Script);

            var cmdPath = Path.Combine(dir, "tmux.cmd");
            var cmdScript = """
                @echo off
                pwsh -NoProfile -NoLogo -File "%~dp0tmux.ps1" %*
                """;
            File.WriteAllText(cmdPath, cmdScript);

            _scriptDirectory = dir;
            Log.Info(() => $"TmuxScriptWriter: Created tmux scripts at {dir}");
        }
        catch (Exception ex)
        {
            Log.Warn(() => $"TmuxScriptWriter: Failed to write Windows script: {ex.Message}");
        }
    }

    /// <summary>
    /// Delete the shim script directory. Called during server shutdown.
    /// </summary>
    public static void Cleanup()
    {
        if (_scriptDirectory is null)
        {
            return;
        }

        try
        {
            if (Directory.Exists(_scriptDirectory))
            {
                Directory.Delete(_scriptDirectory, recursive: true);
                Log.Info(() => $"TmuxScriptWriter: Cleaned up {_scriptDirectory}");
            }
        }
        catch
        {
            // Best-effort cleanup
        }

        _scriptDirectory = null;
    }
}
