using Ai.Tlbx.MidTerm.Common.Logging;

namespace Ai.Tlbx.MidTerm.Services.Browser;

public static class MtcliScriptWriter
{
    public static void WriteToCwd(string cwd, int port, string authToken)
    {
        try
        {
            var midtermDir = Path.Combine(cwd, ".midterm");
            Directory.CreateDirectory(midtermDir);

            var shPath = Path.Combine(midtermDir, "mtcli.sh");
            File.WriteAllText(shPath, GenerateShellScript(port, authToken));
            if (!OperatingSystem.IsWindows())
            {
                File.SetUnixFileMode(shPath,
                    UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute |
                    UnixFileMode.GroupRead | UnixFileMode.GroupExecute |
                    UnixFileMode.OtherRead | UnixFileMode.OtherExecute);
            }

            var ps1Path = Path.Combine(midtermDir, "mtcli.ps1");
            File.WriteAllText(ps1Path, GeneratePowerShellScript(port, authToken));

            EnsureGitignore(midtermDir);
            BrowserLog.Info($"Wrote mtcli scripts to {midtermDir}");
        }
        catch (Exception ex)
        {
            Log.Verbose(() => $"MtcliScriptWriter: Failed to write to {cwd}: {ex.Message}");
        }
    }

    private static string GenerateShellScript(int port, string token) =>
        $$"""
        #!/bin/bash
        # MidTerm CLI helpers — auto-generated, do not edit.
        # Source: . .midterm/mtcli.sh   |   Run: .midterm/mtcli.sh <cmd> [args]
        #
        # Auth token below is auto-generated and ephemeral (expires in ~3 weeks).
        # It only works on this machine's MidTerm instance. Not a security risk.
        _MT="https://localhost:{{port}}"
        _MK="mm-session={{token}}"
        _MC() { curl -sfk -b "$_MK" "$@" 2>/dev/null; }
        _MJ() { _MC -X POST -H "Content-Type: application/json" "$@"; }

        # Browser interaction (requires web preview panel open in MidTerm)
        mt_query()      { local t=${2:-false}; _MJ -d "{\"selector\":\"$1\",\"textOnly\":$t}" "$_MT/api/browser/query"; }
        mt_click()      { _MJ -d "{\"selector\":\"$1\"}" "$_MT/api/browser/click"; }
        mt_fill()       { _MJ -d "{\"selector\":\"$1\",\"value\":\"$2\"}" "$_MT/api/browser/fill"; }
        mt_exec()       { _MJ -d "{\"value\":\"$1\"}" "$_MT/api/browser/exec"; }
        mt_wait()       { local t=${2:-5}; _MJ -d "{\"selector\":\"$1\",\"timeout\":$t}" "$_MT/api/browser/wait"; }
        mt_screenshot() { _MJ "$_MT/api/browser/screenshot"; }
        mt_snapshot()   { _MJ "$_MT/api/browser/snapshot"; }

        # Web preview target management
        mt_navigate()   { _MC -X PUT -H "Content-Type: application/json" -d "{\"url\":\"$1\"}" "$_MT/api/webpreview/target"; }
        mt_reload()     { _MJ -d '{"mode":"soft"}' "$_MT/api/webpreview/reload"; }
        mt_target()     { _MC "$_MT/api/webpreview/target"; }
        mt_cookies()    { _MC "$_MT/api/webpreview/cookies"; }

        # Session management
        mt_sessions()   { _MC "$_MT/api/sessions"; }
        mt_buffer()     { _MC "$_MT/api/sessions/$1/buffer"; }

        # Status
        mt_status()     { mtbrowser status 2>/dev/null || _MC "$_MT/api/webpreview/target"; }

        # Direct execution: .midterm/mtcli.sh query ".error"
        if [ -n "${BASH_SOURCE+x}" ] && [ "${BASH_SOURCE[0]}" = "$0" ]; then
          _cmd="$1"; shift 2>/dev/null; "mt_$_cmd" "$@"
        fi
        """;

    private static string GeneratePowerShellScript(int port, string token) =>
        $$"""
        # MidTerm CLI helpers — auto-generated, do not edit.
        # Dot-source: . .midterm\mtcli.ps1   |   Run: pwsh .midterm\mtcli.ps1 <cmd> [args]
        #
        # Auth token below is auto-generated and ephemeral (expires in ~3 weeks).
        # It only works on this machine's MidTerm instance. Not a security risk.
        $script:_MT = "https://localhost:{{port}}"
        $script:_MK = "mm-session={{token}}"

        function script:_MC { & curl.exe -sfk -b $script:_MK @args 2>$null }
        function script:_MJ { _MC -X POST -H "Content-Type: application/json" @args }

        # Browser interaction (requires web preview panel open in MidTerm)
        function Mt-Query      { param([string]$Selector, [switch]$Text) _MJ -d "{`"selector`":`"$Selector`",`"textOnly`":$($Text.IsPresent.ToString().ToLower())}" "$script:_MT/api/browser/query" }
        function Mt-Click      { param([string]$Selector) _MJ -d "{`"selector`":`"$Selector`"}" "$script:_MT/api/browser/click" }
        function Mt-Fill       { param([string]$Selector, [string]$Value) _MJ -d "{`"selector`":`"$Selector`",`"value`":`"$Value`"}" "$script:_MT/api/browser/fill" }
        function Mt-Exec       { param([string]$Code) _MJ -d "{`"value`":`"$Code`"}" "$script:_MT/api/browser/exec" }
        function Mt-Wait       { param([string]$Selector, [int]$Timeout = 5) _MJ -d "{`"selector`":`"$Selector`",`"timeout`":$Timeout}" "$script:_MT/api/browser/wait" }
        function Mt-Screenshot { _MJ "$script:_MT/api/browser/screenshot" }
        function Mt-Snapshot   { _MJ "$script:_MT/api/browser/snapshot" }

        # Web preview target management
        function Mt-Navigate   { param([string]$Url) _MC -X PUT -H "Content-Type: application/json" -d "{`"url`":`"$Url`"}" "$script:_MT/api/webpreview/target" }
        function Mt-Reload     { _MJ -d '{"mode":"soft"}' "$script:_MT/api/webpreview/reload" }
        function Mt-Target     { _MC "$script:_MT/api/webpreview/target" }
        function Mt-Cookies    { _MC "$script:_MT/api/webpreview/cookies" }

        # Session management
        function Mt-Sessions   { _MC "$script:_MT/api/sessions" }
        function Mt-Buffer     { param([string]$Id) _MC "$script:_MT/api/sessions/$Id/buffer" }

        # Status
        function Mt-Status     { try { & mtbrowser status 2>$null } catch { Mt-Target } }

        # Direct execution: pwsh .midterm\mtcli.ps1 query ".error"
        if ($args.Count -gt 0) {
            $cmd = $args[0]
            $cmdArgs = if ($args.Count -gt 1) { $args[1..($args.Count - 1)] } else { @() }
            & "Mt-$($cmd.Substring(0,1).ToUpper() + $cmd.Substring(1))" @cmdArgs
        }
        """;

    private static void EnsureGitignore(string midtermDir)
    {
        var gitignorePath = Path.Combine(midtermDir, ".gitignore");
        var entries = new[] { "snapshot_*/", "screenshots/", "mtcli.sh", "mtcli.ps1" };

        try
        {
            var existing = File.Exists(gitignorePath) ? File.ReadAllText(gitignorePath) : "";
            var lines = existing.Split('\n', StringSplitOptions.RemoveEmptyEntries).ToList();
            var changed = false;

            foreach (var entry in entries)
            {
                if (!lines.Contains(entry))
                {
                    lines.Add(entry);
                    changed = true;
                }
            }

            if (changed)
            {
                File.WriteAllText(gitignorePath, string.Join("\n", lines) + "\n");
            }
        }
        catch
        {
        }
    }
}
