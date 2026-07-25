using System.Globalization;

namespace Ai.Tlbx.MidTerm.Services.Browser;

/// <summary>
/// Writes the generated tlbx_graphs helper scripts. The graph CLI is CRUD-only:
/// agents publish nodes, edges, positions, and launch specs; the canvas UI is
/// where stored actions are executed.
/// </summary>
public static class TlbxGraphsScriptWriter
{
    internal static void WriteScripts(string tlbxDir, int port, string authToken)
    {
        var shPath = Path.Combine(tlbxDir, "tlbx_graphs.sh");
        File.WriteAllText(shPath, GenerateShellScript(port, authToken));
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(shPath,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute |
                UnixFileMode.GroupRead | UnixFileMode.GroupExecute |
                UnixFileMode.OtherRead | UnixFileMode.OtherExecute);
        }

        var ps1Path = Path.Combine(tlbxDir, "tlbx_graphs.ps1");
        File.WriteAllText(ps1Path, GeneratePowerShellScript(port, authToken));
    }

    private static string GenerateShellScript(int port, string token) =>
        $$"""
        #!/bin/bash
        # tlbx graph CLI helpers — auto-generated, do not edit.
        # Source: . .tlbx/tlbx_graphs.sh   |   Run: .tlbx/tlbx_graphs.sh <cmd> [args]
        #
        # Auth token below is auto-generated and ephemeral. Optional: set MT_API_KEY instead.
        _MTG="https://localhost:{{port.ToString(CultureInfo.InvariantCulture)}}"
        _MTGK="mm-session={{token}}"
        _MTGCURL() {
          if command -v curl.exe >/dev/null 2>&1; then curl.exe "$@"; else curl "$@"; fi
        }
        _MTGC() {
          if [ -n "${MT_API_KEY:-}" ]; then
            _MTGCURL --fail-with-body -sSk -H "Authorization: Bearer $MT_API_KEY" "$@"
          else
            _MTGCURL --fail-with-body -sSk -b "$_MTGK" "$@"
          fi
        }
        _MTGJ() { _MTGC -X "$1" -H "Content-Type: application/json" --data-binary "$2" "$_MTG$3"; echo; }
        _MTGBODY() {
          # Second arg is raw JSON, '-' for stdin, or empty for stdin.
          if [ -z "${1:-}" ] || [ "$1" = "-" ]; then cat; else printf '%s' "$1"; fi
        }
        _MTGESC() { local s="$1"; s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; printf '%s' "$s"; }

        # mtg_graphs  — list graphs
        mtg_graphs() { _MTGC "$_MTG/api/graphs"; echo; }
        # mtg_graph GRAPH  — dump one graph (nodes + edges) as JSON
        mtg_graph() { _MTGC "$_MTG/api/graphs/$1"; echo; }
        # mtg_graph_new ID [NAME...]  — create or rename a graph
        mtg_graph_new() {
          local id="$1"; shift || true
          local name="$*"
          if [ -n "$name" ]; then
            _MTGJ POST "{\"id\":\"$(_MTGESC "$id")\",\"name\":\"$(_MTGESC "$name")\"}" "/api/graphs"
          else
            _MTGJ POST "{\"id\":\"$(_MTGESC "$id")\"}" "/api/graphs"
          fi
        }
        # mtg_graph_rm GRAPH  — delete a graph
        mtg_graph_rm() { _MTGC -X DELETE "$_MTG/api/graphs/$1"; echo; }
        # mtg_node_add GRAPH [JSON|-]  — create a node from a JSON body (stdin when omitted or '-')
        mtg_node_add() { local g="$1"; shift || true; _MTGBODY "${1:-}" | _MTGC -X POST -H "Content-Type: application/json" --data-binary @- "$_MTG/api/graphs/$g/nodes"; echo; }
        # mtg_node_set GRAPH NODE [JSON|-]  — partial update; omitted fields are kept, x/y move only when sent
        mtg_node_set() { local g="$1" n="$2"; shift 2 || true; _MTGBODY "${1:-}" | _MTGC -X PATCH -H "Content-Type: application/json" --data-binary @- "$_MTG/api/graphs/$g/nodes/$n"; echo; }
        # mtg_node_rm GRAPH NODE  — delete a node and its edges
        mtg_node_rm() { _MTGC -X DELETE "$_MTG/api/graphs/$1/nodes/$2"; echo; }
        # mtg_move GRAPH NODE X Y  — set a node position
        mtg_move() { _MTGJ POST "{\"x\":$3,\"y\":$4}" "/api/graphs/$1/nodes/$2/position"; }
        # mtg_edge_add GRAPH FROM TO [LABEL] [KIND]  — connect two nodes
        mtg_edge_add() {
          local body="{\"fromId\":\"$(_MTGESC "$2")\",\"toId\":\"$(_MTGESC "$3")\""
          [ -n "${4:-}" ] && body="$body,\"label\":\"$(_MTGESC "$4")\""
          [ -n "${5:-}" ] && body="$body,\"kind\":\"$(_MTGESC "$5")\""
          body="$body}"
          _MTGJ POST "$body" "/api/graphs/$1/edges"
        }
        # mtg_edge_rm GRAPH EDGE  — delete an edge
        mtg_edge_rm() { _MTGC -X DELETE "$_MTG/api/graphs/$1/edges/$2"; echo; }

        # Direct execution: .tlbx/tlbx_graphs.sh graphs
        if [ -n "${BASH_SOURCE+x}" ] && [ "${BASH_SOURCE[0]}" = "$0" ]; then
          _cmd="${1:-}"
          shift 2>/dev/null
          _normalized_cmd="${_cmd#mtg_}"
          if [ -n "$_cmd" ] && command -v "$_cmd" >/dev/null 2>&1; then
            "$_cmd" "$@"
          elif [ -n "$_normalized_cmd" ] && command -v "mtg_$_normalized_cmd" >/dev/null 2>&1; then
            "mtg_$_normalized_cmd" "$@"
          else
            printf 'Unknown tlbx graphs command: %s\n' "$_cmd" >&2
            exit 1
          fi
        fi
        """;

    private static string GeneratePowerShellScript(int port, string token) =>
        $$"""
        # tlbx graph CLI helpers — auto-generated, do not edit.
        # Dot-source: . .tlbx\tlbx_graphs.ps1   |   Run: pwsh .tlbx\tlbx_graphs.ps1 <cmd> [args]
        #
        # Auth token below is auto-generated and ephemeral. Optional: set MT_API_KEY instead.
        $script:_MTG = "https://localhost:{{port.ToString(CultureInfo.InvariantCulture)}}"
        $script:_MTGK = "mm-session={{token}}"

        function script:_MtgCurl {
            param([Parameter(ValueFromRemainingArguments = $true)][string[]]$CurlArgs)
            if ($env:MT_API_KEY) {
                & curl.exe --fail-with-body -sSk -H "Authorization: Bearer $($env:MT_API_KEY)" @CurlArgs
            }
            else {
                & curl.exe --fail-with-body -sSk -b $script:_MTGK @CurlArgs
            }
        }

        function script:_MtgJson {
            param([string]$Method, [string]$Body, [string]$Route)
            $tmp = Join-Path $env:TEMP "mtg-$PID.json"
            [System.IO.File]::WriteAllText($tmp, $Body)
            try {
                _MtgCurl -X $Method -H "Content-Type: application/json" --data-binary "@$tmp" "$script:_MTG$Route"
            }
            finally {
                Remove-Item $tmp -ErrorAction SilentlyContinue
            }
        }

        function script:_MtgBody {
            param([string]$Json)
            if (-not $Json -or $Json -eq '-') { return [Console]::In.ReadToEnd() }
            return $Json
        }

        # Mtg-Graphs  — list graphs
        function Mtg-Graphs { _MtgCurl "$script:_MTG/api/graphs" }
        # Mtg-Graph GRAPH  — dump one graph (nodes + edges) as JSON
        function Mtg-Graph { param([string]$GraphId) _MtgCurl "$script:_MTG/api/graphs/$GraphId" }
        # Mtg-GraphNew ID [NAME]  — create or rename a graph
        function Mtg-GraphNew {
            param([string]$GraphId, [Parameter(ValueFromRemainingArguments = $true)][string[]]$Name)
            $payload = @{ id = $GraphId }
            if ($Name) { $payload.name = ($Name -join ' ') }
            _MtgJson POST ($payload | ConvertTo-Json -Compress) "/api/graphs"
        }
        # Mtg-GraphRm GRAPH  — delete a graph
        function Mtg-GraphRm { param([string]$GraphId) _MtgCurl -X DELETE "$script:_MTG/api/graphs/$GraphId" }
        # Mtg-NodeAdd GRAPH [JSON|-]  — create a node from a JSON body (stdin when omitted or '-')
        function Mtg-NodeAdd {
            param([string]$GraphId, [string]$Json)
            _MtgJson POST (_MtgBody $Json) "/api/graphs/$GraphId/nodes"
        }
        # Mtg-NodeSet GRAPH NODE [JSON|-]  — partial update; omitted fields are kept, x/y move only when sent
        function Mtg-NodeSet {
            param([string]$GraphId, [string]$NodeId, [string]$Json)
            _MtgJson PATCH (_MtgBody $Json) "/api/graphs/$GraphId/nodes/$NodeId"
        }
        # Mtg-NodeRm GRAPH NODE  — delete a node and its edges
        function Mtg-NodeRm { param([string]$GraphId, [string]$NodeId) _MtgCurl -X DELETE "$script:_MTG/api/graphs/$GraphId/nodes/$NodeId" }
        # Mtg-Move GRAPH NODE X Y  — set a node position
        function Mtg-Move {
            param([string]$GraphId, [string]$NodeId, [double]$X, [double]$Y)
            _MtgJson POST (@{ x = $X; y = $Y } | ConvertTo-Json -Compress) "/api/graphs/$GraphId/nodes/$NodeId/position"
        }
        # Mtg-EdgeAdd GRAPH FROM TO [LABEL] [KIND]  — connect two nodes
        function Mtg-EdgeAdd {
            param([string]$GraphId, [string]$FromId, [string]$ToId, [string]$Label, [string]$Kind)
            $payload = @{ fromId = $FromId; toId = $ToId }
            if ($Label) { $payload.label = $Label }
            if ($Kind) { $payload.kind = $Kind }
            _MtgJson POST ($payload | ConvertTo-Json -Compress) "/api/graphs/$GraphId/edges"
        }
        # Mtg-EdgeRm GRAPH EDGE  — delete an edge
        function Mtg-EdgeRm { param([string]$GraphId, [string]$EdgeId) _MtgCurl -X DELETE "$script:_MTG/api/graphs/$GraphId/edges/$EdgeId" }

        Set-Alias -Name mtg_graphs -Value Mtg-Graphs
        Set-Alias -Name mtg_graph -Value Mtg-Graph
        Set-Alias -Name mtg_graph_new -Value Mtg-GraphNew
        Set-Alias -Name mtg_graph_rm -Value Mtg-GraphRm
        Set-Alias -Name mtg_node_add -Value Mtg-NodeAdd
        Set-Alias -Name mtg_node_set -Value Mtg-NodeSet
        Set-Alias -Name mtg_node_rm -Value Mtg-NodeRm
        Set-Alias -Name mtg_move -Value Mtg-Move
        Set-Alias -Name mtg_edge_add -Value Mtg-EdgeAdd
        Set-Alias -Name mtg_edge_rm -Value Mtg-EdgeRm

        # Direct execution: pwsh .tlbx\tlbx_graphs.ps1 graphs
        if ($MyInvocation.InvocationName -ne '.' -and $args.Count -gt 0) {
            $cmd = [string]$args[0]
            $rest = @($args | Select-Object -Skip 1)
            $normalizedCmd = if ($cmd -match '^(?i)mtg[_-](.+)$') { $Matches[1] } else { $cmd }
            $candidates = @($cmd, "mtg_$normalizedCmd")
            foreach ($candidate in $candidates) {
                $resolved = Get-Command $candidate -ErrorAction SilentlyContinue
                if ($resolved) {
                    & $resolved @rest
                    exit $LASTEXITCODE
                }
            }
            Write-Error "Unknown tlbx graphs command: $cmd"
            exit 1
        }
        """;
}
