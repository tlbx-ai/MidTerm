# MidTerm Frontend Perf Profiling

This folder contains browser-side scenarios for Chrome/CDP profiling. They are meant to be run through the local Codex `chrome-perf` skill so traces, CPU profiles, heap snapshots, DOM counters, long tasks, RAF pacing, and summaries land under:

```text
%USERPROFILE%\.codex\artifacts\chrome-perf\<timestamp-label>\
```

## Terminal Stress Scenario

`midterm-terminal-stress.js` exercises the main operator path:

- create three real terminal sessions through the MidTerm API
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

## Baseline Evidence

Last validated local service: `9.8.27-dev`.

Successful run:

```text
C:\Users\johan\.codex\artifacts\chrome-perf\20260508-145539-midterm-terminal-stress-background\summary.json
```

Observed result:

- JS heap delta after scenario cleanup and forced GC: `+4.33 MB`
- DOM node delta after cleanup: `+564`
- long tasks: `4`, max `104 ms`
- RAF p95: `33.4 ms`
- session switch p95: `53.2 ms`, max `67.8 ms`
- background/restore two-RAF latency: `29.2 ms`
- created sessions cleaned up: `3/3`

This is a smoke baseline, not a proof that leaks cannot exist. Treat regressions in heap, DOM node count, listener count, p95 switch latency, or long-task count as candidates for focused trace/CPU-profile inspection.
