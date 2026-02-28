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
        # JSON-escape a string value (handles quotes, backslashes, newlines — pure bash)
        _ME() { local s="$1"; s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\t'/\\t}"; s="${s//$'\n'/ }"; printf '%s' "$s"; }

        # Browser interaction (requires web preview panel open in MidTerm)
        # mt_query SELECTOR [true]  — query DOM; pass true for text-only (smaller output)
        mt_query() {
          local t=${2:-false}
          _MJ -d "{\"selector\":\"$(_ME "$1")\",\"textOnly\":$t}" "$_MT/api/browser/query"
        }
        # mt_click SELECTOR
        mt_click() { _MJ -d "{\"selector\":\"$(_ME "$1")\"}" "$_MT/api/browser/click"; }
        # mt_fill SELECTOR VALUE
        mt_fill()  { _MJ -d "{\"selector\":\"$(_ME "$1")\",\"value\":\"$(_ME "$2")\"}" "$_MT/api/browser/fill"; }
        # mt_exec JS_CODE  — or pipe: echo 'code' | mt_exec
        mt_exec() {
          local code="$1"
          if [ -z "$code" ] && [ ! -t 0 ]; then code=$(cat); fi
          _MJ -d "{\"value\":\"$(_ME "$code")\"}" "$_MT/api/browser/exec"
        }
        # mt_wait SELECTOR [TIMEOUT]  — wait for element (default 5s)
        mt_wait() {
          local t=${2:-5}
          _MJ -d "{\"selector\":\"$(_ME "$1")\",\"timeout\":$t}" "$_MT/api/browser/wait"
        }
        mt_screenshot() { _MJ -d '{}' "$_MT/api/browser/screenshot"; }
        mt_snapshot()   { _MJ -d '{}' "$_MT/api/browser/snapshot"; }
        # mt_outline [DEPTH]  — page structure tree (default depth 4)
        mt_outline() { local d=${1:-4}; _MJ -d "{\"maxDepth\":$d}" "$_MT/api/browser/outline"; }
        # mt_attrs SELECTOR  — element attributes (no children)
        mt_attrs()   { _MJ -d "{\"selector\":\"$(_ME "$1")\"}" "$_MT/api/browser/attrs"; }
        # mt_css SELECTOR PROPS  — computed CSS (comma-separated property names)
        mt_css()     { _MJ -d "{\"selector\":\"$(_ME "$1")\",\"value\":\"$(_ME "$2")\"}" "$_MT/api/browser/css"; }
        # mt_log [error|warn|all]  — console log buffer (default: all)
        mt_log()     { local f=${1:-all}; _MJ -d "{\"value\":\"$(_ME "$f")\"}" "$_MT/api/browser/log"; }
        # mt_links  — all links on page
        mt_links()   { _MJ -d '{}' "$_MT/api/browser/links"; }
        # mt_forms [SELECTOR]  — form structure and values (default: all forms)
        mt_forms()   { local s="${1:-form}"; _MJ -d "{\"selector\":\"$(_ME "$s")\"}" "$_MT/api/browser/forms"; }

        # Web preview target management
        mt_navigate()   { _MJ -d "{\"url\":\"$(_ME "$1")\"}" -X PUT "$_MT/api/webpreview/target"; }
        mt_reload()     { _MJ -d '{"mode":"soft"}' "$_MT/api/webpreview/reload"; }
        mt_target()     { _MC "$_MT/api/webpreview/target"; }
        mt_cookies()    { _MC "$_MT/api/webpreview/cookies"; }
        # mt_proxylog [LIMIT]  — last N proxy requests with full details (default 100)
        mt_proxylog()   { local n=${1:-100}; _MC "$_MT/api/webpreview/proxylog?limit=$n"; }

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
        # JSON body helper: builds a safe JSON string from a hashtable (no manual escaping)
        function script:_MB { param([hashtable]$h) $h | ConvertTo-Json -Compress }

        # Browser interaction (requires web preview panel open in MidTerm)
        # Mt-Query -Selector CSS_SELECTOR [-Text]  — query DOM; -Text for text-only
        function Mt-Query {
            param([string]$Selector, [switch]$Text)
            _MJ -d (_MB @{selector=$Selector; textOnly=$Text.IsPresent}) "$script:_MT/api/browser/query"
        }
        # Mt-Click -Selector CSS_SELECTOR
        function Mt-Click {
            param([string]$Selector)
            _MJ -d (_MB @{selector=$Selector}) "$script:_MT/api/browser/click"
        }
        # Mt-Fill -Selector CSS_SELECTOR -Value TEXT
        function Mt-Fill {
            param([string]$Selector, [string]$Value)
            _MJ -d (_MB @{selector=$Selector; value=$Value}) "$script:_MT/api/browser/fill"
        }
        # Mt-Exec -Code JS_CODE  — or pipe: 'code' | Mt-Exec
        function Mt-Exec {
            param([Parameter(ValueFromPipeline)][string]$Code)
            process {
                if (-not $Code) { return }
                _MJ -d (_MB @{value=$Code}) "$script:_MT/api/browser/exec"
            }
        }
        # Mt-Wait -Selector CSS_SELECTOR [-Timeout N]  — wait for element (default 5s)
        function Mt-Wait {
            param([string]$Selector, [int]$Timeout = 5)
            _MJ -d (_MB @{selector=$Selector; timeout=$Timeout}) "$script:_MT/api/browser/wait"
        }
        function Mt-Screenshot { _MJ -d '{}' "$script:_MT/api/browser/screenshot" }
        function Mt-Snapshot   { _MJ -d '{}' "$script:_MT/api/browser/snapshot" }
        # Mt-Outline [-Depth N]  — page structure tree (default depth 4)
        function Mt-Outline { param([int]$Depth = 4) _MJ -d (_MB @{maxDepth=$Depth}) "$script:_MT/api/browser/outline" }
        # Mt-Attrs -Selector CSS_SELECTOR  — element attributes (no children)
        function Mt-Attrs   { param([string]$Selector) _MJ -d (_MB @{selector=$Selector}) "$script:_MT/api/browser/attrs" }
        # Mt-Css -Selector CSS_SELECTOR -Props COMMA_SEPARATED  — computed CSS values
        function Mt-Css     { param([string]$Selector, [string]$Props) _MJ -d (_MB @{selector=$Selector; value=$Props}) "$script:_MT/api/browser/css" }
        # Mt-Log [-Filter error|warn|all]  — console log buffer (default: all)
        function Mt-Log     { param([string]$Filter = "all") _MJ -d (_MB @{value=$Filter}) "$script:_MT/api/browser/log" }
        # Mt-Links  — all links on page
        function Mt-Links   { _MJ -d '{}' "$script:_MT/api/browser/links" }
        # Mt-Forms [-Selector CSS_SELECTOR]  — form structure and values (default: all forms)
        function Mt-Forms   { param([string]$Selector = "form") _MJ -d (_MB @{selector=$Selector}) "$script:_MT/api/browser/forms" }

        # Web preview target management
        function Mt-Navigate {
            param([string]$Url)
            _MJ -d (_MB @{url=$Url}) -X PUT "$script:_MT/api/webpreview/target"
        }
        function Mt-Reload     { _MJ -d '{"mode":"soft"}' "$script:_MT/api/webpreview/reload" }
        function Mt-Target     { _MC "$script:_MT/api/webpreview/target" }
        function Mt-Cookies    { _MC "$script:_MT/api/webpreview/cookies" }
        # Mt-ProxyLog [-Limit N]  — last N proxy requests with full details (default 100)
        function Mt-ProxyLog   { param([int]$Limit = 100) _MC "$script:_MT/api/webpreview/proxylog?limit=$Limit" }

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
