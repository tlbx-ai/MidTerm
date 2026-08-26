# MidTerm Frontend Perf Profiling

This folder contains browser-side scenarios for Chrome/CDP profiling. They are meant to be run through the local Codex `chrome-perf` skill so traces, CPU profiles, heap snapshots, DOM counters, long tasks, RAF pacing, and summaries land under:

```text
%USERPROFILE%\.codex\artifacts\chrome-perf\<timestamp-label>\
```

## Terminal Stress Scenario

`midterm-terminal-stress.js` exercises the main operator path:

- create three real terminal sessions through the visible MidTerm UI and session launcher
- emit terminal output into each session
- switch rapidly between visible sessions through the actual sidebar DOM
- exercise dock-layout focus switching
- delete all created sessions again so heap and DOM deltas catch retained-state leaks

Example command from a JPA/MidTerm-supervised shell:

```powershell
$mt = Get-Content -Raw Q:\repos\Jpa\.midterm\mtcli.ps1
$cookie = [regex]::Match($mt, '\$script:_MK = "([^"]+)"').Groups[1].Value
pwsh -File "$env:USERPROFILE\.codex\skills\chrome-perf\scripts\Invoke-ChromePerfProfile.ps1" `
  -Url https://localhost:2000/ `
  -Scenario script `
  -ActionScriptPath Q:\repos\MidTermReleaseHotfix-987-csiu\scripts\perf\midterm-terminal-stress.js `
  -DurationSeconds 3 `
  -FreezeSeconds 2 `
  -CookieHeader $cookie `
  -MaxHeapGrowthMB 100 `
  -MaxDomNodeGrowth 3000
```

For a repeated outer-shell campaign, use:

```powershell
pwsh -File Q:\repos\MidTermReleaseHotfix-987-csiu\scripts\perf\run-midterm-outer-shell-perf.ps1 `
  -Url https://127.0.0.1:2100/ `
  -Runs 10 `
  -DurationSeconds 1 `
  -FreezeSeconds 1 `
  -IgnoreCertificateErrors
```

## Baseline Evidence

Last validated local service: `9.8.27-dev`.

Successful post-fix 10-run source outer-shell campaign:

```text
C:\Users\johan\.codex\artifacts\chrome-perf\midterm-outer-shell-10run-20260508-153132\aggregate-summary.json
```

Observed aggregate:

- completed runs: `10/10`, failures: `0`
- JS heap delta after scenario cleanup and forced GC: avg `+2.98 MB`, p95 `+3.20 MB`
- DOM node delta after cleanup: avg `+593.7`, p95 `+683`
- session-tab bars after cleanup: `0` in every run
- `[data-session-id]` nodes after cleanup: `0` in every run
- xterms after cleanup: `0` in every run
- long task max: avg `109.8 ms`, p95 `120 ms`
- RAF p95: `16.8 ms`
- session switch p95: avg `41.36 ms`, p95 `48.2 ms`
- background/restore two-RAF latency: avg `24.23 ms`, p95 `28.4 ms`
- created sessions cleaned up: `3/3` in every run

This is a smoke baseline, not a proof that leaks cannot exist. Treat regressions in heap, DOM node count, listener count, p95 switch latency, or long-task count as candidates for focused trace/CPU-profile inspection.

## Six Live Terminals Resource Profile

`run-live-terminal-resource-profile.mjs` opens six real terminal tabs, keeps all six
PTYs producing bounded continuous output, and samples browser/tlbx CPU and memory. It uses
an isolated visible Chrome profile, records a zero-session baseline in the same run, splits
tlbx-owned processes from shell/console processes, switches through every busy session and
records end-to-end catch-up latency, then waits five seconds before steady-state sampling.
It deletes every temporary terminal before closing. Set `TLBX_PERF_CPU_PROFILE=1` when a V8
CPU profile is needed; it is off by default so its growing trace buffer cannot inflate the
RAM measurement. Override the settling and switch phases with
`TLBX_PERF_WARMUP_SECONDS` and `TLBX_PERF_SWITCH_CYCLES` when needed.

```powershell
$env:TLBX_PERF_URL = 'https://127.0.0.1:2100/'
$env:TLBX_PERF_SERVER_PID = '<source mt PID>'
node scripts/perf/run-live-terminal-resource-profile.mjs
```

The resulting `summary.json`, `samples.json`, and optional `cpu-profile.json` are written below
`%USERPROFILE%\.codex\artifacts\chrome-perf\<timestamp>-tlbx-live-terminal-resources\`.

## Mux Lifecycle And Recovery Scenario

`midterm-background-live-output-smoke.js` keeps a real terminal live while output is
produced, runs twelve mobile/PWA hide-show-resume-focus cycles, and fails if any lifecycle
event emits a buffer request without data-loss evidence. The Chrome profiler then measures
retained heap, DOM/listener growth, long tasks, CPU, and frame pacing after the session is
deleted. Pair it with `-FreezeSeconds` to include a real Chrome background/restore boundary:

```powershell
pwsh -File "$env:USERPROFILE\.codex\skills\chrome-perf\scripts\Invoke-ChromePerfProfile.ps1" `
  -Url https://127.0.0.1:2100/ `
  -Scenario script `
  -ActionScriptPath Q:\repos\MidTerm\scripts\perf\midterm-background-live-output-smoke.js `
  -DurationSeconds 3 `
  -FreezeSeconds 2 `
  -CookieHeader $cookie `
  -IgnoreCertificateErrors `
  -MaxHeapGrowthMB 30 `
  -MaxDomNodeGrowth 1000
```

Protocol unit tests provide deterministic forward-gap injection and verify one in-flight
request, session-local queue invalidation, ordered recovery begin/end, and replay completion.
The browser profile complements those tests with the long-running mobile lifecycle and
cleanup surface that is most likely to expose retained timers, maps, listeners, or repaint
loops.
