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
        # Optional: set MT_API_KEY to use API-key auth instead of the generated browser session cookie.
        _MT="https://localhost:{{port}}"
        _MK="mm-session={{token}}"
        _MC() {
          if [ -n "${MT_API_KEY:-}" ]; then
            curl -sfk -H "Authorization: Bearer $MT_API_KEY" "$@" 2>/dev/null
          else
            curl -sfk -b "$_MK" "$@" 2>/dev/null
          fi
        }
        _MJ() { _MC -X POST -H "Content-Type: application/json" "$@"; }
        _MBR() {
          if [ -n "${MT_API_KEY:-}" ]; then
            curl -sk -H "Authorization: Bearer $MT_API_KEY" "$@" 2>/dev/null
          else
            curl -sk -b "$_MK" "$@" 2>/dev/null
          fi
        }
        _MJR() { _MBR -X POST -H "Content-Type: application/json" "$@"; }
        # Send null-delimited args to text CLI endpoint (browser commands)
        _MB() { printf '%s\0' "$@" | _MBR --data-binary @- -X POST "$_MT/api/browser"; }
        _MSID() { printf '%s' "${MT_SESSION_ID:-}"; }
        _MPREVIEW() { printf '%s' "${MT_PREVIEW_NAME:-default}"; }
        _MHAS() { local want="$1"; shift; for arg in "$@"; do [ "$arg" = "$want" ] && return 0; done; return 1; }
        _MNOSESSION() { [[ "$1" == *"No browser preview connected for"* ]]; }
        _MBB() {
          local args=("$@")
          local original=("$@")
          local injectedSession=0 injectedPreview=0 output exitCode
          if [ -n "$(_MSID)" ] && ! _MHAS "--session" "${args[@]}"; then
            args+=("--session" "$(_MSID)")
            injectedSession=1
          fi
          if [ $injectedSession -eq 1 ] && ! _MHAS "--preview" "${args[@]}"; then
            args+=("--preview" "$(_MPREVIEW)")
            injectedPreview=1
          elif [ -n "${MT_PREVIEW_NAME:-}" ] && ! _MHAS "--preview" "${args[@]}"; then
            args+=("--preview" "$(_MPREVIEW)")
            injectedPreview=1
          fi
          output=$(_MB "${args[@]}")
          exitCode=$?
          if [ $injectedSession -eq 1 ] && _MNOSESSION "$output"; then
            output=$(_MB "${original[@]}")
            exitCode=$?
          fi
          printf '%s' "$output"
          return $exitCode
        }
        _MQ() {
          if [ -n "$(_MSID)" ]; then
            printf '?sessionId=%s&previewName=%s' "$(_MSID)" "$(_MPREVIEW)"
          fi
        }

        # Browser interaction (requires web preview panel open in MidTerm)
        # mt_query SELECTOR [--text]  — query DOM; --text for text-only (smaller output)
        mt_query() { _MBB query "$@"; }
        # mt_click SELECTOR
        mt_click() { _MBB click "$1"; }
        # mt_fill SELECTOR VALUE
        mt_fill()  { _MBB fill "$1" "$2"; }
        mt_session() { _MSID; echo; }
        mt_preview() {
          if [ -n "${1:-}" ]; then
            export MT_PREVIEW_NAME="$1"
          fi
          _MPREVIEW
          echo
        }
        # mt_exec JS_CODE  — or pipe: echo 'code' | mt_exec
        mt_exec() {
          local code="$1"
          if [ -z "$code" ] && [ ! -t 0 ]; then code=$(cat); fi
          _MBB exec "$code"
        }
        # mt_wait SELECTOR [TIMEOUT]  — wait for element (default 5s)
        mt_wait() {
          local t=${2:-5}
          _MBB wait "$1" --timeout "$t"
        }
        mt_screenshot() { _MBB screenshot; }
        mt_snapshot()   { _MBB snapshot; }
        # mt_outline [DEPTH]  — page structure tree (default depth 4)
        mt_outline() { local d=${1:-4}; _MBB outline "$d"; }
        # mt_attrs SELECTOR  — element attributes (no children)
        mt_attrs()   { _MBB attrs "$1"; }
        # mt_css SELECTOR PROPS  — computed CSS (comma-separated property names)
        mt_css()     { _MBB css "$1" "$2"; }
        # mt_log [error|warn|all]  — console log buffer (default: all)
        mt_log()     { local f=${1:-all}; _MBB log "$f"; }
        # mt_text [SELECTOR]  — page text content (default: body)
        mt_text()    { local s="${1:-body}"; _MBB query "$s" --text; }
        # mt_submit [FORM_SELECTOR]  — submit form via JS (default: first form)
        mt_submit()  { local s="${1:-form}"; _MBB submit "$s"; }
        # mt_url  — upstream page URL (not proxy URL)
        mt_url()     { _MBB url; }
        # mt_links  — all links on page
        mt_links()   { _MBB links; }
        # mt_forms [SELECTOR]  — form structure and values (default: all forms)
        mt_forms()   { local s="${1:-form}"; _MBB forms "$s"; }

        # Web preview (dev browser)
        _ME() { local s="$1"; s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\t'/\\t}"; s="${s//$'\n'/ }"; printf '%s' "$s"; }
        mt_navigate()   { _MJ -d "{\"sessionId\":\"$(_ME "$(_MSID)")\",\"previewName\":\"$(_ME "$(_MPREVIEW)")\",\"url\":\"$(_ME "$1")\"}" -X PUT "$_MT/api/webpreview/target"; }
        # mt_open URL  — open URL in web preview panel and dock it
        mt_open()       { mt_navigate "$1"; _MJR -d "{\"sessionId\":\"$(_ME "$(_MSID)")\",\"previewName\":\"$(_ME "$(_MPREVIEW)")\",\"url\":\"$(_ME "$1")\"}" "$_MT/api/browser/open"; }
        # mt_close_preview  — close web preview panel
        mt_close_preview() { _MC -X DELETE "$_MT/api/webpreview/target$(_MQ)"; }
        mt_reload()     { _MJ -d "{\"sessionId\":\"$(_ME "$(_MSID)")\",\"previewName\":\"$(_ME "$(_MPREVIEW)")\",\"mode\":\"soft\"}" "$_MT/api/webpreview/reload"; }
        mt_target()     { _MC "$_MT/api/webpreview/target$(_MQ)"; }
        mt_cookies()    { _MC "$_MT/api/webpreview/cookies$(_MQ)"; }
        mt_previews()   { _MC "$_MT/api/webpreview/previews?sessionId=$(_MSID)"; }
        # mt_clearcookies  — clear all cookies (browser-side + server-side jar)
        mt_clearcookies() { _MBB clearcookies; _MC -X POST "$_MT/api/webpreview/cookies/clear$(_MQ)"; }
        # mt_hardreload  — clear cookies + reload (fresh session)
        mt_hardreload() { mt_clearcookies; _MJ -d "{\"sessionId\":\"$(_ME "$(_MSID)")\",\"previewName\":\"$(_ME "$(_MPREVIEW)")\",\"mode\":\"hard\"}" "$_MT/api/webpreview/reload"; }
        # mt_proxylog [LIMIT]  — last N proxy requests with full details (default 100)
        mt_proxylog()   { local n=${1:-100}; _MC "$_MT/api/webpreview/proxylog?sessionId=$(_MSID)&previewName=$(_MPREVIEW)&limit=$n"; }
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
        mt_detach()    { _MJ -d "{\"sessionId\":\"$(_ME "$(_MSID)")\",\"previewName\":\"$(_ME "$(_MPREVIEW)")\"}" "$_MT/api/browser/detach"; }
        # mt_dock  — dock web preview back from popup
        mt_dock()      { _MJ -d "{\"sessionId\":\"$(_ME "$(_MSID)")\",\"previewName\":\"$(_ME "$(_MPREVIEW)")\"}" "$_MT/api/browser/dock"; }
        # mt_viewport WIDTH HEIGHT  — set iframe viewport size (0 0 to reset)
        mt_viewport() {
          local w=${1:-0} h=${2:-0}
          _MJ -d "{\"sessionId\":\"$(_ME "$(_MSID)")\",\"previewName\":\"$(_ME "$(_MPREVIEW)")\",\"width\":$w,\"height\":$h}" "$_MT/api/browser/viewport"
        }

        # Status
        mt_status()     { mtbrowser status 2>/dev/null || _MC "$_MT/api/webpreview/target$(_MQ)"; }

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
        # Optional: set MT_API_KEY to use API-key auth instead of the generated browser session cookie.
        $script:_MT = "https://localhost:{{port}}"
        $script:_MK = "mm-session={{token}}"

        function script:_MC {
            if ($env:MT_API_KEY) {
                & curl.exe -sfk -H "Authorization: Bearer $($env:MT_API_KEY)" @args 2>$null
            } else {
                & curl.exe -sfk -b $script:_MK @args 2>$null
            }
        }
        function script:_MJ { _MC -X POST -H "Content-Type: application/json" @args }
        function script:_MBR {
            if ($env:MT_API_KEY) {
                & curl.exe -sk -H "Authorization: Bearer $($env:MT_API_KEY)" @args 2>$null
            } else {
                & curl.exe -sk -b $script:_MK @args 2>$null
            }
        }
        function script:_MJR { _MBR -X POST -H "Content-Type: application/json" @args }
        # JSON body helper: builds a safe JSON string from a hashtable (no manual escaping)
        function script:_MH { param([hashtable]$h) $h | ConvertTo-Json -Compress }
        function script:_MSID { $env:MT_SESSION_ID }
        function script:_MPreview {
            if ($env:MT_PREVIEW_NAME) { return $env:MT_PREVIEW_NAME }
            return "default"
        }
        function script:_MShouldRetryAnonymous {
            param([string]$Output)
            return $Output -like "*No browser preview connected for*"
        }
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
        function script:_MBB {
            $originalArgs = @($args)
            $allArgs = @($args)
            $injectedSession = $false
            if ($env:MT_SESSION_ID -and -not ($allArgs -contains "--session")) {
                $allArgs += @("--session", $env:MT_SESSION_ID)
                $injectedSession = $true
            }
            $injectedPreview = $false
            if ($injectedSession -and -not ($allArgs -contains "--preview")) {
                $allArgs += @("--preview", (_MPreview))
                $injectedPreview = $true
            } elseif ($env:MT_PREVIEW_NAME -and -not ($allArgs -contains "--preview")) {
                $allArgs += @("--preview", (_MPreview))
                $injectedPreview = $true
            }
            $output = _MB @allArgs
            $exitCode = $LASTEXITCODE
            if ($injectedSession -and (_MShouldRetryAnonymous $output)) {
                $output = _MB @originalArgs
                $exitCode = $LASTEXITCODE
            }
            $global:LASTEXITCODE = $exitCode
            $output
        }
        function script:_MQuery {
            if (-not $env:MT_SESSION_ID) { return "" }
            "?sessionId=$([Uri]::EscapeDataString($env:MT_SESSION_ID))&previewName=$([Uri]::EscapeDataString((_MPreview)))"
        }

        # Browser interaction (requires web preview panel open in MidTerm)
        # Mt-Query -Selector CSS_SELECTOR [-Text]  — query DOM; -Text for text-only
        function Mt-Query {
            param([string]$Selector, [switch]$Text)
            if ($Text) { _MBB query $Selector --text } else { _MBB query $Selector }
        }
        # Mt-Click -Selector CSS_SELECTOR
        function Mt-Click { param([string]$Selector) _MBB click $Selector }
        # Mt-Fill -Selector CSS_SELECTOR -Value TEXT
        function Mt-Fill { param([string]$Selector, [string]$Value) _MBB fill $Selector $Value }
        function Mt-Session { _MSID }
        function Mt-Preview {
            param([string]$Name)
            if ($Name) { $env:MT_PREVIEW_NAME = $Name }
            _MPreview
        }
        # Mt-Exec -Code JS_CODE  — or pipe: 'code' | Mt-Exec
        function Mt-Exec {
            param([Parameter(ValueFromPipeline)][string]$Code)
            process {
                if (-not $Code) { return }
                _MBB exec $Code
            }
        }
        # Mt-Wait -Selector CSS_SELECTOR [-Timeout N]  — wait for element (default 5s)
        function Mt-Wait {
            param([string]$Selector, [int]$Timeout = 5)
            _MBB wait $Selector --timeout $Timeout
        }
        function Mt-Screenshot { _MBB screenshot }
        function Mt-Snapshot   { _MBB snapshot }
        # Mt-Outline [-Depth N]  — page structure tree (default depth 4)
        function Mt-Outline { param([int]$Depth = 4) _MBB outline $Depth }
        # Mt-Attrs -Selector CSS_SELECTOR  — element attributes (no children)
        function Mt-Attrs   { param([string]$Selector) _MBB attrs $Selector }
        # Mt-Css -Selector CSS_SELECTOR -Props COMMA_SEPARATED  — computed CSS values
        function Mt-Css     { param([string]$Selector, [string]$Props) _MBB css $Selector $Props }
        # Mt-Log [-Filter error|warn|all]  — console log buffer (default: all)
        function Mt-Log     { param([string]$Filter = "all") _MBB log $Filter }
        # Mt-Text [-Selector CSS_SELECTOR]  — page text content (default: body)
        function Mt-Text    { param([string]$Selector = "body") _MBB query $Selector --text }
        # Mt-Submit [-Selector FORM_SELECTOR]  — submit form via JS (default: first form)
        function Mt-Submit  { param([string]$Selector = "form") _MBB submit $Selector }
        # Mt-Url  — upstream page URL (not proxy URL)
        function Mt-Url     { _MBB url }
        # Mt-Links  — all links on page
        function Mt-Links   { _MBB links }
        # Mt-Forms [-Selector CSS_SELECTOR]  — form structure and values (default: all forms)
        function Mt-Forms   { param([string]$Selector = "form") _MBB forms $Selector }

        # Web preview (dev browser)
        function Mt-Navigate {
            param([string]$Url)
            _MJ -d (_MH @{sessionId=(_MSID); previewName=(_MPreview); url=$Url}) -X PUT "$script:_MT/api/webpreview/target"
        }
        # Mt-Open -Url URL  — open URL in web preview panel and dock it
        function Mt-Open {
            param([string]$Url)
            Mt-Navigate -Url $Url
            _MJR -d (_MH @{sessionId=(_MSID); previewName=(_MPreview); url=$Url}) "$script:_MT/api/browser/open"
        }
        # Mt-ClosePreview  — close web preview panel
        function Mt-ClosePreview { _MC -X DELETE "$script:_MT/api/webpreview/target$(_MQuery)" }
        function Mt-Reload     { _MJ -d (_MH @{sessionId=(_MSID); previewName=(_MPreview); mode="soft"}) "$script:_MT/api/webpreview/reload" }
        function Mt-Target     { _MC "$script:_MT/api/webpreview/target$(_MQuery)" }
        function Mt-Cookies    { _MC "$script:_MT/api/webpreview/cookies$(_MQuery)" }
        function Mt-Previews   { _MC "$script:_MT/api/webpreview/previews?sessionId=$([Uri]::EscapeDataString((_MSID)))" }
        # Mt-ClearCookies  — clear all cookies (browser-side + server-side jar)
        function Mt-ClearCookies { _MBB clearcookies; _MC -X POST "$script:_MT/api/webpreview/cookies/clear$(_MQuery)" }
        # Mt-HardReload  — clear cookies + reload (fresh session)
        function Mt-HardReload { Mt-ClearCookies; _MJ -d (_MH @{sessionId=(_MSID); previewName=(_MPreview); mode="hard"}) "$script:_MT/api/webpreview/reload" }
        # Mt-ProxyLog [-Limit N]  — last N proxy requests with full details (default 100)
        function Mt-ProxyLog   { param([int]$Limit = 100) _MC "$script:_MT/api/webpreview/proxylog$(_MQuery)&limit=$Limit" }
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
        function Mt-Detach   { _MJ -d (_MH @{sessionId=(_MSID); previewName=(_MPreview)}) "$script:_MT/api/browser/detach" }
        # Mt-Dock  — dock web preview back from popup
        function Mt-Dock     { _MJ -d (_MH @{sessionId=(_MSID); previewName=(_MPreview)}) "$script:_MT/api/browser/dock" }
        # Mt-Viewport [-Width N] [-Height N]  — set iframe viewport size (0 0 to reset)
        function Mt-Viewport {
            param([int]$Width = 0, [int]$Height = 0)
            _MJ -d (_MH @{sessionId=(_MSID); previewName=(_MPreview); width=$Width; height=$Height}) "$script:_MT/api/browser/viewport"
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
