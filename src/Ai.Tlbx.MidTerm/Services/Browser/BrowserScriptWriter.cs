using System.Globalization;
using Ai.Tlbx.MidTerm.Common.Logging;

namespace Ai.Tlbx.MidTerm.Services.Browser;

public static class BrowserScriptWriter
{
    private static string? _scriptDirectory;

    public static string? ScriptDirectory => _scriptDirectory;

    public static void WriteScript(int port)
    {
        if (OperatingSystem.IsWindows())
        {
            WriteWindowsScript(port);
            return;
        }

        WriteUnixScript(port);
    }

    private static void WriteUnixScript(int port)
    {
        var dir = "/tmp/midterm-bin";

        try
        {
            Directory.CreateDirectory(dir);
            var scriptPath = Path.Combine(dir, "mtbrowser");

            var script = $$"""
                #!/bin/sh
                has_arg() {
                  want="$1"; shift
                  for arg in "$@"; do
                    [ "$arg" = "$want" ] && return 0
                  done
                  return 1
                }
                if [ -n "$MT_SESSION_ID" ] && ! has_arg "--session" "$@"; then
                  set -- "$@" --session "$MT_SESSION_ID"
                fi
                if [ -n "$MT_PREVIEW_NAME" ] && ! has_arg "--preview" "$@"; then
                  set -- "$@" --preview "$MT_PREVIEW_NAME"
                fi
                printf '%s\0' "$@" | curl -sfk -b "mm-session=$MT_TOKEN" \
                  --data-binary @- \
                  "https://localhost:{{port.ToString(CultureInfo.InvariantCulture)}}/api/browser" 2>/dev/null
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
            Log.Info(() => string.Create(CultureInfo.InvariantCulture, $"BrowserScriptWriter: Created mtbrowser script at {scriptPath}"));
        }
        catch (Exception ex)
        {
            Log.Warn(() => $"BrowserScriptWriter: Failed to write Unix script: {ex.Message}");
        }
    }

    private static void WriteWindowsScript(int port)
    {
        var dir = Path.Combine(Path.GetTempPath(), "midterm-bin");

        try
        {
            Directory.CreateDirectory(dir);

            var ps1Path = Path.Combine(dir, "mtbrowser.ps1");
            var ps1Script = $$"""
                $body = [System.IO.MemoryStream]::new()
                foreach ($a in $args) {
                    $b = [System.Text.Encoding]::UTF8.GetBytes($a)
                    $body.Write($b, 0, $b.Length)
                    $body.WriteByte(0)
                }
                if ($env:MT_SESSION_ID -and -not ($args -contains "--session")) {
                    foreach ($a in @("--session", $env:MT_SESSION_ID)) {
                        $b = [System.Text.Encoding]::UTF8.GetBytes($a)
                        $body.Write($b, 0, $b.Length)
                        $body.WriteByte(0)
                    }
                }
                if ($env:MT_PREVIEW_NAME -and -not ($args -contains "--preview")) {
                    foreach ($a in @("--preview", $env:MT_PREVIEW_NAME)) {
                        $b = [System.Text.Encoding]::UTF8.GetBytes($a)
                        $body.Write($b, 0, $b.Length)
                        $body.WriteByte(0)
                    }
                }
                $tmp = Join-Path $env:TEMP "mt-browser-$PID.bin"
                [System.IO.File]::WriteAllBytes($tmp, $body.ToArray())
                try {
                    & curl.exe -sfk -b "mm-session=$env:MT_TOKEN" --data-binary "@$tmp" "https://localhost:{{port.ToString(CultureInfo.InvariantCulture)}}/api/browser" 2>$null
                } finally {
                    Remove-Item $tmp -ErrorAction SilentlyContinue
                }
                exit $LASTEXITCODE
                """;
            File.WriteAllText(ps1Path, ps1Script);

            var cmdPath = Path.Combine(dir, "mtbrowser.cmd");
            var cmdScript = """
                @echo off
                pwsh -NoProfile -NoLogo -File "%~dp0mtbrowser.ps1" %*
                """;
            File.WriteAllText(cmdPath, cmdScript);

            var bashPath = Path.Combine(dir, "mtbrowser");
            var bashScript = $$"""
                #!/bin/sh
                has_arg() {
                  want="$1"; shift
                  for arg in "$@"; do
                    [ "$arg" = "$want" ] && return 0
                  done
                  return 1
                }
                if [ -n "$MT_SESSION_ID" ] && ! has_arg "--session" "$@"; then
                  set -- "$@" --session "$MT_SESSION_ID"
                fi
                if [ -n "$MT_PREVIEW_NAME" ] && ! has_arg "--preview" "$@"; then
                  set -- "$@" --preview "$MT_PREVIEW_NAME"
                fi
                printf '%s\0' "$@" | curl -sfk -b "mm-session=$MT_TOKEN" \
                  --data-binary @- \
                  "https://localhost:{{port.ToString(CultureInfo.InvariantCulture)}}/api/browser" 2>/dev/null
                """;
            File.WriteAllText(bashPath, bashScript.Replace("\r\n", "\n", StringComparison.Ordinal));

            _scriptDirectory = dir;
            Log.Info(() => string.Create(CultureInfo.InvariantCulture, $"BrowserScriptWriter: Created mtbrowser scripts at {dir}"));
        }
        catch (Exception ex)
        {
            Log.Warn(() => $"BrowserScriptWriter: Failed to write Windows scripts: {ex.Message}");
        }
    }

    public static void Cleanup()
    {
        if (_scriptDirectory is null)
            return;

        try
        {
            var files = new[] { "mtbrowser", "mtbrowser.ps1", "mtbrowser.cmd" };
            foreach (var file in files)
            {
                var path = Path.Combine(_scriptDirectory, file);
                if (File.Exists(path))
                {
                    File.Delete(path);
                }
            }
            Log.Info(() => string.Create(CultureInfo.InvariantCulture, $"BrowserScriptWriter: Cleaned up scripts from {_scriptDirectory}"));
        }
        catch
        {
        }

        _scriptDirectory = null;
    }
}
