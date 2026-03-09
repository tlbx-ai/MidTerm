namespace Ai.Tlbx.MidTerm.Services.Browser;

public static class MtcliScriptWriter
{
    internal static void WriteScripts(string midtermDir, int port, string authToken)
    {
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
        _MBR() { curl -sk -b "$_MK" "$@" 2>/dev/null; }
        _MJR() { _MBR -X POST -H "Content-Type: application/json" "$@"; }
        # Send null-delimited args to text CLI endpoint (browser commands)
        _MB() { printf '%s\0' "$@" | _MBR --data-binary @- -X POST "$_MT/api/browser"; }

        # Browser interaction (requires web preview panel open in MidTerm)
        # mt_query SELECTOR [--text]  — query DOM; --text for text-only (smaller output)
        mt_query() { _MB query "$@"; }
        # mt_click SELECTOR
        mt_click() { _MB click "$1"; }
        # mt_fill SELECTOR VALUE
        mt_fill()  { _MB fill "$1" "$2"; }
        # mt_exec JS_CODE  — or pipe: echo 'code' | mt_exec
        mt_exec() {
          local code="$1"
          if [ -z "$code" ] && [ ! -t 0 ]; then code=$(cat); fi
          _MB exec "$code"
        }
        # mt_wait SELECTOR [TIMEOUT]  — wait for element (default 5s)
        mt_wait() {
          local t=${2:-5}
          _MB wait "$1" --timeout "$t"
        }
        mt_screenshot() { _MB screenshot; }
        mt_snapshot()   { _MB snapshot; }
        # mt_outline [DEPTH]  — page structure tree (default depth 4)
        mt_outline() { local d=${1:-4}; _MB outline "$d"; }
        # mt_attrs SELECTOR  — element attributes (no children)
        mt_attrs()   { _MB attrs "$1"; }
        # mt_css SELECTOR PROPS  — computed CSS (comma-separated property names)
        mt_css()     { _MB css "$1" "$2"; }
        # mt_log [error|warn|all]  — console log buffer (default: all)
        mt_log()     { local f=${1:-all}; _MB log "$f"; }
        # mt_text [SELECTOR]  — page text content (default: body)
        mt_text()    { local s="${1:-body}"; _MB query "$s" --text; }
        # mt_submit [FORM_SELECTOR]  — submit form via JS (default: first form)
        mt_submit()  { local s="${1:-form}"; _MB submit "$s"; }
        # mt_url  — upstream page URL (not proxy URL)
        mt_url()     { _MB url; }
        # mt_links  — all links on page
        mt_links()   { _MB links; }
        # mt_forms [SELECTOR]  — form structure and values (default: all forms)
        mt_forms()   { local s="${1:-form}"; _MB forms "$s"; }

        # Web preview (dev browser)
        mt_navigate()   { _MJ -d "{\"url\":\"$(_ME "$1")\"}" -X PUT "$_MT/api/webpreview/target"; }
        _ME() { local s="$1"; s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\t'/\\t}"; s="${s//$'\n'/ }"; printf '%s' "$s"; }
        # mt_open URL  — open URL in web preview panel and dock it
        mt_open()       { mt_navigate "$1"; _MJR -d "{\"url\":\"$(_ME "$1")\"}" "$_MT/api/browser/open"; }
        # mt_close_preview  — close web preview panel
        mt_close_preview() { _MC -X DELETE "$_MT/api/webpreview/target"; }
        mt_reload()     { _MJ -d '{"mode":"soft"}' "$_MT/api/webpreview/reload"; }
        mt_target()     { _MC "$_MT/api/webpreview/target"; }
        mt_cookies()    { _MC "$_MT/api/webpreview/cookies"; }
        # mt_clearcookies  — clear all cookies (browser-side + server-side jar)
        mt_clearcookies() { _MB clearcookies; _MC -X POST "$_MT/api/webpreview/cookies/clear"; }
        # mt_hardreload  — clear cookies + reload (fresh session)
        mt_hardreload() { mt_clearcookies; mt_reload; }
        # mt_proxylog [LIMIT]  — last N proxy requests with full details (default 100)
        mt_proxylog()   { local n=${1:-100}; _MC "$_MT/api/webpreview/proxylog?limit=$n"; }
        # mt_apply_update [SOURCE]  — apply pending update and wait for server to return
        mt_apply_update() {
          local source="${1:-}" url="$_MT/api/update/apply"
          if [ -n "$source" ]; then
            url="$url?source=$(_ME "$source")"
          fi
          _MC -X POST "$url" || return $?
          sleep 3
          local i version
          for ((i=0; i<90; i++)); do
            version=$(curl -sfk "$_MT/api/version" 2>/dev/null) && break
            sleep 1
          done
          if [ -n "$version" ]; then
            printf 'Current version: %s\n' "$version"
          else
            echo "Update triggered. Server restart still in progress."
          fi
        }

        # Session management
        mt_sessions()   { _MC "$_MT/api/sessions"; }
        mt_buffer()     { _MC "$_MT/api/sessions/$1/buffer"; }
        # mt_new_session [SHELL] [CWD]  — create a new terminal session, returns JSON with session id
        mt_new_session() {
          local shell="${1:-}" cwd="${2:-}"
          local body="{}"
          if [ -n "$shell" ] && [ -n "$cwd" ]; then
            body="{\"shell\":\"$(_ME "$shell")\",\"workingDirectory\":\"$(_ME "$cwd")\"}"
          elif [ -n "$shell" ]; then
            body="{\"shell\":\"$(_ME "$shell")\"}"
          elif [ -n "$cwd" ]; then
            body="{\"workingDirectory\":\"$(_ME "$cwd")\"}"
          fi
          _MJ -d "$body" "$_MT/api/sessions"
        }
        # mt_split [-h]  — split terminal (creates adjacent pane via tmux shim)
        mt_split() { tmux split-window "$@"; }

        # Panel control
        # mt_detach  — detach web preview to a popup window
        mt_detach()    { _MJ -d '{}' "$_MT/api/browser/detach"; }
        # mt_dock  — dock web preview back from popup
        mt_dock()      { _MJ -d '{}' "$_MT/api/browser/dock"; }
        # mt_viewport WIDTH HEIGHT  — set iframe viewport size (0 0 to reset)
        mt_viewport() {
          local w=${1:-0} h=${2:-0}
          _MJ -d "{\"width\":$w,\"height\":$h}" "$_MT/api/browser/viewport"
        }

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
        function script:_MBR { & curl.exe -sk -b $script:_MK @args 2>$null }
        function script:_MJR { _MBR -X POST -H "Content-Type: application/json" @args }
        # JSON body helper: builds a safe JSON string from a hashtable (no manual escaping)
        function script:_MH { param([hashtable]$h) $h | ConvertTo-Json -Compress }
        # Send null-delimited args to text CLI endpoint (browser commands)
        function script:_MB {
            $bytes = [System.Collections.Generic.List[byte]]::new()
            foreach ($a in $args) {
                $bytes.AddRange([System.Text.Encoding]::UTF8.GetBytes($a))
                $bytes.Add(0)
            }
            $tmp = [System.IO.Path]::GetTempFileName()
            try {
                [System.IO.File]::WriteAllBytes($tmp, $bytes.ToArray())
                _MBR --data-binary "@$tmp" -X POST "$script:_MT/api/browser"
            } finally { Remove-Item $tmp -ErrorAction SilentlyContinue }
        }

        # Browser interaction (requires web preview panel open in MidTerm)
        # Mt-Query -Selector CSS_SELECTOR [-Text]  — query DOM; -Text for text-only
        function Mt-Query {
            param([string]$Selector, [switch]$Text)
            if ($Text) { _MB query $Selector --text } else { _MB query $Selector }
        }
        # Mt-Click -Selector CSS_SELECTOR
        function Mt-Click { param([string]$Selector) _MB click $Selector }
        # Mt-Fill -Selector CSS_SELECTOR -Value TEXT
        function Mt-Fill { param([string]$Selector, [string]$Value) _MB fill $Selector $Value }
        # Mt-Exec -Code JS_CODE  — or pipe: 'code' | Mt-Exec
        function Mt-Exec {
            param([Parameter(ValueFromPipeline)][string]$Code)
            process {
                if (-not $Code) { return }
                _MB exec $Code
            }
        }
        # Mt-Wait -Selector CSS_SELECTOR [-Timeout N]  — wait for element (default 5s)
        function Mt-Wait {
            param([string]$Selector, [int]$Timeout = 5)
            _MB wait $Selector --timeout $Timeout
        }
        function Mt-Screenshot { _MB screenshot }
        function Mt-Snapshot   { _MB snapshot }
        # Mt-Outline [-Depth N]  — page structure tree (default depth 4)
        function Mt-Outline { param([int]$Depth = 4) _MB outline $Depth }
        # Mt-Attrs -Selector CSS_SELECTOR  — element attributes (no children)
        function Mt-Attrs   { param([string]$Selector) _MB attrs $Selector }
        # Mt-Css -Selector CSS_SELECTOR -Props COMMA_SEPARATED  — computed CSS values
        function Mt-Css     { param([string]$Selector, [string]$Props) _MB css $Selector $Props }
        # Mt-Log [-Filter error|warn|all]  — console log buffer (default: all)
        function Mt-Log     { param([string]$Filter = "all") _MB log $Filter }
        # Mt-Text [-Selector CSS_SELECTOR]  — page text content (default: body)
        function Mt-Text    { param([string]$Selector = "body") _MB query $Selector --text }
        # Mt-Submit [-Selector FORM_SELECTOR]  — submit form via JS (default: first form)
        function Mt-Submit  { param([string]$Selector = "form") _MB submit $Selector }
        # Mt-Url  — upstream page URL (not proxy URL)
        function Mt-Url     { _MB url }
        # Mt-Links  — all links on page
        function Mt-Links   { _MB links }
        # Mt-Forms [-Selector CSS_SELECTOR]  — form structure and values (default: all forms)
        function Mt-Forms   { param([string]$Selector = "form") _MB forms $Selector }

        # Web preview (dev browser)
        function Mt-Navigate {
            param([string]$Url)
            _MJ -d (_MH @{url=$Url}) -X PUT "$script:_MT/api/webpreview/target"
        }
        # Mt-Open -Url URL  — open URL in web preview panel and dock it
        function Mt-Open {
            param([string]$Url)
            Mt-Navigate -Url $Url
            _MJR -d (_MH @{url=$Url}) "$script:_MT/api/browser/open"
        }
        # Mt-ClosePreview  — close web preview panel
        function Mt-ClosePreview { _MC -X DELETE "$script:_MT/api/webpreview/target" }
        function Mt-Reload     { _MJ -d '{"mode":"soft"}' "$script:_MT/api/webpreview/reload" }
        function Mt-Target     { _MC "$script:_MT/api/webpreview/target" }
        function Mt-Cookies    { _MC "$script:_MT/api/webpreview/cookies" }
        # Mt-ClearCookies  — clear all cookies (browser-side + server-side jar)
        function Mt-ClearCookies { _MB clearcookies; _MC -X POST "$script:_MT/api/webpreview/cookies/clear" }
        # Mt-HardReload  — clear cookies + reload (fresh session)
        function Mt-HardReload { Mt-ClearCookies; Mt-Reload }
        # Mt-ProxyLog [-Limit N]  — last N proxy requests with full details (default 100)
        function Mt-ProxyLog   { param([int]$Limit = 100) _MC "$script:_MT/api/webpreview/proxylog?limit=$Limit" }
        # Mt-ApplyUpdate [-Source SOURCE]  — apply pending update and wait for server to return
        function Mt-ApplyUpdate {
            param([string]$Source)
            $url = "$script:_MT/api/update/apply"
            if ($Source) {
                $url += "?source=$([Uri]::EscapeDataString($Source))"
            }
            _MC -X POST $url
            Start-Sleep -Seconds 3
            for ($i = 0; $i -lt 90; $i++) {
                $version = & curl.exe -sfk "$script:_MT/api/version" 2>$null
                if ($LASTEXITCODE -eq 0 -and $version) {
                    Write-Output "Current version: $version"
                    return
                }
                Start-Sleep -Seconds 1
            }
            Write-Output "Update triggered. Server restart still in progress."
        }

        # Session management
        function Mt-Sessions   { _MC "$script:_MT/api/sessions" }
        function Mt-Buffer     { param([string]$Id) _MC "$script:_MT/api/sessions/$Id/buffer" }
        # Mt-NewSession [-Shell SHELL] [-Cwd PATH]  — create a new terminal session
        function Mt-NewSession {
            param([string]$Shell, [string]$Cwd)
            $body = @{}
            if ($Shell) { $body.shell = $Shell }
            if ($Cwd) { $body.workingDirectory = $Cwd }
            _MJ -d (_MH $body) "$script:_MT/api/sessions"
        }
        # Mt-Split [-Horizontal]  — split terminal (creates adjacent pane via tmux shim)
        function Mt-Split {
            param([switch]$Horizontal)
            if ($Horizontal) { & tmux split-window -h } else { & tmux split-window }
        }

        # Panel control
        # Mt-Detach  — detach web preview to a popup window
        function Mt-Detach   { _MJ -d '{}' "$script:_MT/api/browser/detach" }
        # Mt-Dock  — dock web preview back from popup
        function Mt-Dock     { _MJ -d '{}' "$script:_MT/api/browser/dock" }
        # Mt-Viewport [-Width N] [-Height N]  — set iframe viewport size (0 0 to reset)
        function Mt-Viewport {
            param([int]$Width = 0, [int]$Height = 0)
            _MJ -d (_MH @{width=$Width; height=$Height}) "$script:_MT/api/browser/viewport"
        }

        # Status
        function Mt-Status     { try { & mtbrowser status 2>$null } catch { Mt-Target } }

        # Direct execution: pwsh .midterm\mtcli.ps1 query ".error"
        if ($args.Count -gt 0) {
            $cmd = $args[0]
            $cmdArgs = if ($args.Count -gt 1) { $args[1..($args.Count - 1)] } else { @() }
            & "Mt-$($cmd.Substring(0,1).ToUpper() + $cmd.Substring(1))" @cmdArgs
        }
        """;
}
