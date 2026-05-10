# C# Analyzer Campaign

This document is the persisted execution plan for the bug-focused C# analyzer rollout.
Read it at the start of each turn before continuing work. Update the progress section and
the "Next Wave" section before stopping so the next turn can resume without re-planning.

## Current Analyzer Profile

The repo intentionally keeps only bug-prone/resource-lifetime/culture/cancellation rules:

- .NET CA rules: `CA1001`, `CA1068`, `CA1305`, `CA1416`, `CA1806`, `CA1816`, `CA2000`, `CA2012`, `CA2016`, `CA2020`, `CA2201`, `CA2213`, `CA5359`
- Meziantou: `MA0001`, `MA0002`, `MA0009`, `MA0011`, `MA0040`, `MA0074`, `MA0076`, `MA0100`, `MA0134`, `MA0147`, `MA0163`
- IDisposableAnalyzers: `IDISP001`, `IDISP002`, `IDISP003`, `IDISP004`, `IDISP006`, `IDISP007`, `IDISP008`, `IDISP013`, `IDISP014`, `IDISP015`, `IDISP016`, `IDISP017`, `IDISP023`, `IDISP025`

Deliberately excluded:

- StyleCop
- XML doc enforcement
- IDE/build-time style rules
- Naming and micro-performance CA noise

## Baseline

Measured with:

```powershell
dotnet build src/MidTerm.slnx -nologo -m:1 -p:UseSharedCompilation=false
```

Current baseline log:

- `.tmp/csharp-analyzers-after-app60b.log`

Current bug-focused warning count:

- Total: `68` build-warning instances in the latest full build
- Latest progress: the remaining unit-test culture/comparer backlog is largely gone, and the build remains green
- `UpdateVerificationTests`, `TtyHostSessionManagerStateTests`, and `UpdateScriptGeneratorTests`: comparer/regex/culture tails cleared
- `SessionCodexHandoffServiceTests`: service-construction helper now uses explicit async-disposal transfer and invariant session-meta path formatting
- `SessionApp Server ControllerPulseServiceTests`: localized `MA0074` / `MA0076` and JSON-array enumeration tails cleared
- `WebPreviewProxyMiddlewareTests`: request-aborted token is now forwarded to `ReadToEndAsync`
- `FakeCodexWebSocketServer`: JSON input enumeration now disposes the array enumerator explicitly
- `SessionApp Server ControllerHostRuntimeServiceTests`: restart/recovery tests now use `await using` runtimes; all `CA2000` test-runtime construction warnings are gone
- `IntegrationTests`: most response/fixture disposal backlog is gone after explicit response ownership and direct websocket-local ownership
- Remaining backlog is now overwhelmingly the known production ownership/disposal advisory tail, with only a tiny residual test tail in `SystemSleepInhibitorServiceTests`

Top remaining rules:

1. `MA0009` - regex timeout missing
2. `MA0040` - cancellation token not forwarded
3. `MA0001` / `MA0074` - missing `StringComparison`
4. `CA2000` - undisposed disposables
5. `IDISP001` / `IDISP007` / `IDISP004` / `IDISP003` - ownership/disposal issues
6. `MA0076` - small residual implicit culture-sensitive `ToString()` tail
7. `CA1806` / `CA2020` / `CA2201` - smaller correctness tail
8. `CA1068` / `CA1001` - API/disposal shape tail
9. `IDISP015` / `IDISP016` / `IDISP025` - disposal/lifetime tail mostly outside the main app
10. `MA0011` - now effectively cleared from production code; remaining hits are only outside the current app baseline

## Execution Strategy

Use small, bounded batches. Never ask an AI to fix all warnings across the repo.

Batch dimensions:

- Prefer one rule at a time
- Prefer one project or one folder at a time
- Keep batches to roughly 20-80 edits
- Rebuild after every batch
- Update this doc before stopping

Prompt shape for AI work:

```text
Fix only <RULE_ID> in <PROJECT_OR_FOLDER>.

Rules:
- Do not fix other rule ids.
- Keep changes minimal and behavior-preserving.
- If ownership/behavior is ambiguous, leave the code unchanged and report it.
- Use the filtered warning file as source of truth.

After edits:
- run dotnet build src/MidTerm.slnx -nologo -m:1 -p:UseSharedCompilation=false
- report remaining <RULE_ID> warnings for the target scope
```

## Wave Order

### Wave 1: Low-risk culture/comparison fixes

Target rules:

- `MA0076`
- `MA0011`
- `MA0001`
- `MA0002`
- `MA0074`
- `CA1305`

Why first:

- Mostly mechanical
- Often find-and-replace or overload-selection changes
- Good signal with low behavioral risk if protocol/logging/internal formatting uses invariant culture

Guidance:

- Prefer `CultureInfo.InvariantCulture` for protocol, IDs, IPC names, logs, filenames, numeric parsing, and non-user-facing text
- Prefer `StringComparison.Ordinal` or `OrdinalIgnoreCase` unless there is a clear user-facing locale reason

### Wave 2: Cancellation propagation

Target rules:

- `MA0040`
- `CA2016`

Guidance:

- Forward existing tokens to methods that already accept them
- Do not invent new token plumbing across broad call chains in one batch

### Wave 3: Disposable creation/ownership

Target rules:

- `CA2000`
- `CA2213`
- `IDISP001`
- `IDISP004`
- `IDISP003`

Guidance:

- Start in `Common`, `TtyHost`, and `AgentHost`
- Follow existing ownership patterns
- Prefer local `using`/`await using` or explicit disposal in owner types

### Wave 4: Ownership edge cases

Target rules:

- `IDISP007`
- `IDISP002`
- `IDISP016`
- `IDISP017`

Guidance:

- Smaller batches only
- Stop on ambiguity rather than guessing ownership

### Wave 5: Tail cleanup

Target rules:

- `CA2201`
- `CA1416`
- `MA0009`
- `CA1068`
- `CA5359`

## Progress Log

- 2026-04-03: Introduced bug-focused analyzer profile and reduced warning volume from ~65k to 1918.
- 2026-04-03: Pulled/rebased `origin/dev` with `--autostash` before continuing analyzer remediation.
- 2026-04-03: Generated per-rule warning slices in `.tmp/analyzer-slices`.
- 2026-04-03: Fixed `MA0076` and `MA0011` in `Ai.Tlbx.MidTerm.Common` (`App Server ControllerHostEndpoint`, `IpcEndpoint`, `LogWriter`). Rebuild passed and total warnings dropped to `1842`. Remaining `MA0076 Common: 0`, `MA0011 Common: 0`.
- 2026-04-03: Fixed a first `MA0076` app slice in `Program`, `Auth*`, `BrowserPreviewOriginService`, `BrowserCommandService`, `BrowserLog`, `WelcomeScreen`, `ServerSetup`, and `EndpointSetup`. Rebuild passed; total warnings dropped to `1668`, `MA0076` to `282`, and `MA0011` to `222`.
- 2026-04-03: Fixed a second `MA0076` app slice in `CliCommands`, `BrowserScriptWriter`, `BrowserCommandService`, and `Program`. Rebuild passed; total warnings dropped to `1168`, `MA0076` to `244`, and `MA0011` to `100`.
- 2026-04-03: Fixed another bounded `MA0076` slice in `CertificateCleanupService`, `CertificateGenerator`, `ClipboardService`, `GitCommandRunner`, `HistoryService`, `MidTermInstanceIdentity`, `Power/*`, `HubService`, `MacOsSecretStorage`, `UnixFileSecretStorage`, and `MuxClient`. Rebuild passed; total warnings dropped to `808`, `MA0076` to `232`, and the full-log `MA0011` count measured `220` because unit-test parsing warnings remain in scope.
- 2026-04-03: Fixed another `MA0076` batch in `SessionApiEndpoints`, `SessionApp Server ControllerRuntimeService`, `SessionApp Server ControllerHostRuntimeService`, `SessionApp Server ControllerPulseService`, `TtyHostSpawner`, `TtyHostSessionManager`, and `TtyHostClient`. Rebuild passed; total warnings dropped to `756`, main project warnings to `904`, and `MA0076` to `128`.
- 2026-04-03: Fixed the last planned `MA0076` straggler batch in `UpdateService`, `UpdateScriptGenerator`, `TmuxFormatter`, `Ai.Tlbx.MidTerm.TtyHost/Program`, `LocalClipboard`, and `WindowsPty`. Rebuild passed; total warnings dropped to `482`, main project warnings to `870`, TtyHost to `94`, and `MA0076` to `52`.
- 2026-04-03: Fixed a mechanical `MA0011` app slice in `GitCommandRunner`, `MidTermSettingsPublic.Runtime`, `WindowsFirewallService`, `WebPreviewEndpoints`, `EndpointSetup`, and `SessionApp Server ControllerPulseService`. Rebuild passed; main-app `MA0011` dropped materially and the campaign pivot remained on invariant parse/format overloads only.
- 2026-04-03: Fixed the remaining planned `MA0011` TtyHost slice in `Ai.Tlbx.MidTerm.TtyHost/Program` and `LocalClipboard`. Rebuild passed; TtyHost `MA0011` is now `0`, with the remaining `MA0011` backlog concentrated in the main app and unit tests.
- 2026-04-03: Started Wave 2 cancellation propagation with a narrow batch in `AiCliCapabilityService`, `SessionApp Server ControllerRuntimeService`, and `MuxWebSocketHandler`. Rebuild passed. Current full-solution measurement is `701` build warnings / `700` unique warning lines because the latest build completed the unit-test projects and surfaced their backlog; current main-app counts were `417`, `MA0040=65`, `CA2016=2`, and `MA0011=28`.
- 2026-04-03: Fixed a larger endpoint cancellation batch in `SessionApiEndpoints`, `CommandEndpoints`, `WebPreviewEndpoints`, and `TmuxEndpoints` by threading existing request/application tokens through already-supported overloads only. Rebuild passed. Unique warnings dropped to `678`, main-app warnings to `395`, and main-app `MA0040` dropped from `65` to `43`. `SessionApiEndpoints` `MA0040` is down to `2`, `CommandEndpoints` is `0`, `WebPreviewEndpoints` is `0`, and `TmuxEndpoints` has `1` remaining hit.
- 2026-04-03: Finished the remaining Wave 2 cancellation stragglers in `TmuxEndpoints`, `SessionApp Server ControllerRuntimeService`, `SessionApp Server ControllerHostRuntimeService`, `TtyHostMuxConnectionManager`, and `TtyHostClient`. Rebuild passed. Unique warnings are now `442`, main-app warnings are `385`, main-app `MA0040` is `35`, and `CA2016` is `0`. The targeted hotspots are now fully cleared.
- 2026-04-03: Fixed the next bounded cancellation batch in `StateWebSocketHandler`, `WebPreviewProxyMiddleware`, and the async flush path in `LogWriter`. Rebuild passed with `.tmp/csharp-analyzers-after-app12.log`. Normalized counts are now `641` unique warnings / `672` build warnings, with the main app down to `359`, TtyHost at `23`, and tests at `244`. The targeted cancellation hotspots are cleared: `StateWebSocketHandler` `MA0040=0`, `WebPreviewProxyMiddleware` `MA0040=0`; only the synchronous `LogWriter.Dispose()` wait remains in `Common`.
- 2026-04-03: Finished the last clearly mechanical Wave 2 websocket/server batch in `ServerSetup`, `SettingsWebSocketHandler`, `BrowserWebSocketHandler`, `GitWebSocketHandler`, and `HubMuxWebSocketHandler`. Rebuild passed with `.tmp/csharp-analyzers-after-app13.log`. Normalized counts are now `634` unique warnings / `650` build warnings, with the main app down to `352` and main-app `MA0040` down to `16`. The new batch is fully cleared: `ServerSetup`, `SettingsWebSocketHandler`, `BrowserWebSocketHandler`, `GitWebSocketHandler`, and `HubMuxWebSocketHandler` now contribute `0` `MA0040` warnings.
- 2026-04-03: Pivoted back to Wave 1 and fixed the first declaration-level `MA0002` batch in `FileModels`, `WebPreviewProxyLogEntry`, `AuthService`, `BrowserCommandService`, `BrowserPreviewRegistry`, `BrowserUiBridge`, `SettingsService`, `MainBrowserService`, `SessionPathAllowlistService`, and `WebPreviewService`. Rebuild passed with `.tmp/csharp-analyzers-after-app14.log`. Normalized counts are now `377` unique warnings / `393` build warnings, with the main app down to `339` and main-app `MA0002` down from `48` to `35`.
- 2026-04-03: Fixed the second and final production `MA0002` batch in `SessionRegistry`, `SessionTelemetryService`, `TtyHostMuxConnectionManager`, `TmuxCommandParser`, `TmuxPaneMapper`, `MuxClient`, `GitWatcherService`, `MiscCommands`, `UpdateService`, `TtyHostSessionManager`, `WebPreviewEndpoints`, `LogWriter`, `CertificateGenerator`, `CommandService`, `GitWebSocketHandler`, `FileEndpoints`, `WindowsSecretStorage`, `UnixFileSecretStorage`, and `PaneCommands`. Rebuild passed with `.tmp/csharp-analyzers-after-app16.log`. Normalized counts are now `585` unique warnings / `614` build warnings, with the main app down to `304`, `MA0002` cleared from the main app, `MA0011` at `28`, `MA0009` at `37`, and `MA0040` unchanged at `16`.
- 2026-04-03: Fixed the first app-focused `MA0011` batch in `ArgumentParser`, `AuthService`, `CertificateSetup`, `ClipboardService`, and `BrowserEndpoints`. Rebuild passed with `.tmp/csharp-analyzers-after-app17.log`. Normalized counts are now `576` unique warnings / `591` build warnings, with the main app down to `295` and main-app `MA0011` reduced from `28` to `19`.
- 2026-04-03: Finished the remaining production `MA0011` batch in `SystemUserProvider`, `UpdateService`, `WebPreviewService`, `TmuxTargetResolver`, `TmuxPaneMapper`, `PaneCommands`, `IoCommands`, and `TmuxFormatter`. Rebuild passed with `.tmp/csharp-analyzers-after-app18.log`. Normalized counts are now `313` unique warnings / `328` build warnings, with the main app down to `276` and production `MA0011` reduced to `0`.
- 2026-04-03: Completed the first bounded `MA0009` regex-timeout batch in `ManagerBarScheduleEntry`, `ClipboardService`, `BrowserLog`, `AiCliCommandLocator`, `TmuxFormatter`, `IoCommands`, and `TerminalOutputSanitizer`. Rebuild passed with `.tmp/csharp-analyzers-after-app19.log`. Current normalized counts are `548` unique warnings / `563` build warnings because the full test backlog is back in scope; the main app dropped to `232` and main-app `MA0009` dropped from `37` to `27`. The targeted seven files are now fully cleared from `MA0009`.
- 2026-04-03: Completed the second bounded `MA0009` regex-timeout batch in `EncryptedFileProtector`, `StaticAssetCacheHeaders`, `UserValidationService`, `TmuxLog`, `TtyHostSpawner`, and `UpdateService`. Rebuild passed with `.tmp/csharp-analyzers-after-app20.log`. Normalized counts are now `541` unique warnings / `556` build warnings, with the main app down to `226` and main-app `MA0009` reduced from `27` to `21`. The remaining app `MA0009` backlog is now concentrated in `WebPreviewEndpoints`, `WebPreviewProxyMiddleware`, and `SessionApp Server ControllerPulseService`.
- 2026-04-03: Finished the remaining app-side `MA0009` cluster in `WebPreviewEndpoints`, `WebPreviewProxyMiddleware`, and `SessionApp Server ControllerPulseService`. Rebuild passed with `.tmp/csharp-analyzers-after-app21.log`. Normalized counts are now `520` unique warnings / `535` build warnings, with the main app down to `205` and main-app `MA0009` reduced to `0`. Remaining `MA0009` warnings are now outside the production app baseline: `Ai.Tlbx.MidTerm.TtyHost/LocalClipboard` and `Ai.Tlbx.MidTerm.UnitTests/UpdateScriptGeneratorTests`.
- 2026-04-03: Completed the first disposal/lifetime cleanup batch in `CertificateSetup`, `CertificateService`, `CertificateGenerator`, and the process-spawn sites in `EndpointSetup`. Rebuild passed with `.tmp/csharp-analyzers-after-app22.log`. Normalized counts are now `504` unique warnings / `519` build warnings, with the main app down to `189`. The targeted ownership warnings are cleared from those files; only non-target `MA0001` / `MA0074` / `MA0076` items remain in `EndpointSetup`.
- 2026-04-03: Took the next disposal/ownership batch in `LogWriter`, `Program`, `BrowserWebSocketHandler`, `FileEndpoints`, and `UpdateService`. Rebuild passed with `.tmp/csharp-analyzers-after-app24.log`. `BrowserWebSocketHandler` `CA2000`, `FileEndpoints` `CA2000` / `IDISP001`, and the spawned-process leak in `UpdateService` are cleared. The remaining issues in that area are the analyzer-stubborn `LogWriter` `IDISP003` pair, `Program` `IDISP016`, and an `IDISP014` tail on `UpdateService` despite switching to a shared client instance.
- 2026-04-03: Took the planned `MA0001` / `MA0074` batch in `AuthMiddleware`, `CliCommands`, `FileService`, and the targeted `UpdateService` comparison sites. Rebuild passed with `.tmp/csharp-analyzers-after-app25.log`. The targeted mechanical comparison backlog cleared cleanly from `AuthMiddleware`, `CliCommands`, and `FileService`; the remaining `UpdateService` hits are now one `MA0074`, one `MA0001`, and the pre-existing `IDISP014`. Normalized counts are now `476` unique warnings / `952` build warnings, with the main app down to `201`, `MA0001` down to `34`, and `MA0074` down to `15`.
- 2026-04-03: Finished the next low-risk comparison-overload batch in `BrowserEndpoints`, `GitCommandRunner`, `WebPreviewService`, `ShellConfigurations`, `MidtermDirectory`, `SessionApiEndpoints`, and `WebPreviewProxyMiddleware`. Rebuild passed with `.tmp/csharp-analyzers-after-app27c.log`. `GitCommandRunner` comparison warnings are cleared; `BrowserEndpoints`, `WebPreviewService`, `ShellConfigurations`, `MidtermDirectory`, `SessionApiEndpoints`, and `WebPreviewProxyMiddleware` are now clear of the targeted `MA0001` / `MA0074` sites too. Two intermediate attempts briefly introduced `CA1847` / `CA2249` regressions in `ShellConfigurations` and `SessionApiEndpoints`; those were corrected in the same turn with span-based comparison helpers. Normalized counts are now `458` unique warnings / `916` build warnings, with the main app down to `179`, `TtyHost` to `29`, `MA0001` down to `22`, and `MA0074` down to `5`.
- 2026-04-03: Finished the next production `MA0001` / `MA0074` batch in `AuthService`, `CertificateInfoService`, `BrowserScriptWriter`, `FileEndpoints`, `SystemUserProvider`, and `SessionForegroundProcessService`. Rebuild passed with `.tmp/csharp-analyzers-after-app28.log`. All targeted comparison warnings in those files are now cleared, and the untouched warnings in that slice are only the already-known non-target items (`MA0040`, `IDISP004`, and `MA0076`). Normalized counts are now `441` unique warnings / `882` build warnings, with the main app down to `168`, `MA0001` down to `14`, and `MA0074` down to `2`.
- 2026-04-03: Finished the last production `MA0001` / `MA0074` batch in `TtyHostSpawner`, `ShareGrantService`, `EmbeddedWebRootFileProvider`, `PaneCommands`, `TmuxScriptWriter`, `UpdateScriptGenerator`, `UpdateService`, and `EndpointSetup`. Rebuild passed with `.tmp/csharp-analyzers-after-app29b.log`. An intermediate `TtyHostSpawner` compile break from the wrong `IndexOf` overload was corrected in the same turn. Production comparison warnings are now effectively exhausted: main-app `MA0001=0` and `MA0074=0`. Normalized counts are now `429` unique warnings / `858` build warnings, with the main app down to `156`.
- 2026-04-03: Finished the bounded cancellation batch in `Program`, `BrowserEndpoints`, `FileEndpoints`, `GitWatcherService`, `SessionApiEndpoints`, `CompressedStaticFilesMiddleware`, `App Server ControllerWebSocketHandler`, and `MuxClient`. Rebuild passed with `.tmp/csharp-analyzers-after-app30b.log`. One intermediate `GitWatcherService` change introduced a nullable warning because `DebounceCts` is optional; that was corrected in the same turn by falling back to `PollCts`/`CancellationToken.None`. The cancellation wave is now essentially exhausted in production code: main-app `MA0040` dropped from `17` to `1`, and the only remaining production `MA0040` hit is `LogWriter:353`. Normalized counts are now `413` unique warnings / `826` build warnings, with the main app down to `140`.
- 2026-04-03: Took the next ownership-focused disposal batch in `TtyHostSpawner`, `HubService`, `SessionApp Server ControllerHostRuntimeService`, and `WebPreviewProxyMiddleware`. `RedirectedProcessHandle` now owns and disposes its redirected streams and `Process`, `SessionApp Server ControllerHostRuntimeService` explicitly transfers Unix socket ownership to the `NetworkStream` and disposes on failure, `HubService` now disposes request-local `ByteArrayContent` and `HttpResponseMessage` instances, and `WebPreviewProxyMiddleware` now uses explicit decompression branches so the wrapped `GZipStream`/`BrotliStream`/`DeflateStream` lifetimes are visible to the analyzers. Rebuild passed with `.tmp/csharp-analyzers-after-app31.log`. Normalized counts are now `410` unique warnings / `820` build warnings, with the main app down to `137`, `CA2000` down to `11`, and `IDISP001` down to `10`.
- 2026-04-03: Took the next mechanical ownership batch in `BrowserLog`, `ServerSetup`, `SingleInstanceGuard`, `SessionApp Server ControllerRuntimeService`, and `TtyHostSpawner`. The safe wins landed: `BrowserLog` and `ServerSetup` now dispose the previous owned instance before re-assignment, `SingleInstanceGuard` disposes an old mutex before replacing it, `SessionApp Server ControllerRuntimeService` and `TtyHostSpawner` now use explicit ownership-transfer `Process` patterns, and the Windows redirected-spawn path in `TtyHostSpawner` now disposes temporary `SafeFileHandle`/`FileStream`/reader/writer wrappers on failure instead of relying on analyzer-invisible transfer. Full rebuild passed with `.tmp/csharp-analyzers-after-app32d.log`. Normalized counts are now `402` unique warnings / `158` build warnings, with the main app down to `129`, `CA2000` down to `2`, and `IDISP001` down to `6`. One localized regression remains: `SessionApp Server ControllerRuntimeService` now has a `CS8602` nullable warning in the Codex exit callback path that should be fixed first next turn.
- 2026-04-03: Cleared the localized `SessionApp Server ControllerRuntimeService` nullable regression and took two more low-risk ownership cleanups in `SystemUserProvider` and `TtyHostClient`. The Codex exit callback now uses the already-computed exit code instead of dereferencing the transferred process local, `TtyHostClient.StartReadLoop()` disposes any previous local CTS before replacing it, and `SystemUserProvider` now reads directly from `JsonDocument.RootElement` to avoid the extra root variable churn. Full rebuild passed with `.tmp/csharp-analyzers-after-app33b.log`. Normalized counts are now `400` unique warnings / `156` build warnings, with the main app down to `127`, `IDISP003` down to `17`, and `CS8602` back to `0`.
- 2026-04-03: Took the next ownership batch in `IpcServer`, the sleep inhibitor backends, `MuxClient`, `TtyHostSpawner.RedirectedProcessHandle`, and `SessionApp Server ControllerHostRuntimeService`. The concrete wins landed: `UnixSocketServer` now disposes its listener via a captured local before clearing the field, the Windows sleep inhibitor now explicitly cleans up stale worker state and release signals, `MuxClient` now uses an explicit get-or-create ownership transfer for per-session buffers, and `RedirectedProcessHandle` now has an explicit `DetachForIpc()` transfer path so IPC-spawned host state can own the `Process`/error stream directly. Full rebuild passed with `.tmp/csharp-analyzers-after-app35.log`. Normalized counts are now `391` unique warnings / `782` build warnings, with the main app down to `119`, `TtyHost` at `28`, `UnitTests` at `226`, and legacy tests at `18`. `Main IDISP001` dropped from `6` to `4`, `Main IDISP003` dropped from `17` to `15`, `MuxClient` is clear, and the Windows sleep inhibitor warnings are gone. Remaining analyzer-stubborn items from this wave are `IpcServer` `IDISP007`, `ProcessSystemSleepInhibitorBackend` `IDISP003`, and the `SessionApp Server ControllerHostRuntimeService` launch-handle `CA2000`/`IDISP003` tail.
- 2026-04-03: Took the next explicit ownership batch in `HubService`, `SystemUserProvider`, and `WebPreviewService`. The real wins landed cleanly: request-local `HttpResponseMessage` instances in `HubService` are now disposed explicitly, the `SystemUserProvider` JSON array path no longer trips the ignored-disposable analyzer, and `WebPreviewService` now makes the `SocketsHttpHandler` to `HttpClient` ownership transfer explicit. Full rebuild passed with `.tmp/csharp-analyzers-after-app36.log`. In the latest incremental full build, the main app dropped to `113`, `Main IDISP001` dropped from `4` to `0`, `Main CA2000` dropped from `2` to `1`, and `Main IDISP004` dropped from `9` to `8`. The remaining warnings in those files are now non-target or analyzer-advisory only: `HubService` `CA5359` / `IDISP014` / `IDISP007`, and `WebPreviewService` `IDISP014` / `MA0076`.
- 2026-04-03: Finished the planned `SessionApp Server ControllerRuntimeService` / `UpdateScriptGenerator` ownership tail. `SessionApp Server ControllerRuntimeService` no longer uses `JsonElement.EnumerateArray()` in the flagged `IDISP004` loops, which cleared that analyzer tail, and `UpdateScriptGenerator` now explicitly disposes the detached `Process.Start(...)` wrappers it creates. An intermediate compile regression (`CS0136` from a duplicated local name) was corrected in the same turn. Full rebuild passed with `.tmp/csharp-analyzers-after-app37b.log` (`133` warnings / `0` errors).
- 2026-04-03: Continued the `TtyHostSessionManager` ownership cleanup. The reconnect path now uses an explicit single-transfer `TtyHostClient` ownership pattern with one `finally` disposal path, and `DisposeAsync()` now captures `SessionId` before disposal so the later log path does not trip `IDISP016`. Full rebuild passed with `.tmp/csharp-analyzers-after-app38b.log` (`372` warnings / `0` errors). This cleared the earlier `TtyHostSessionManager` reconnect/dispose `IDISP016` cluster; the remaining `TtyHostSessionManager` items are the known analyzer-stubborn `CA2000` constructor warning and an `IDISP007` injected-ownership warning.
- 2026-04-03: Revisited the two remaining `SessionApp Server ControllerRuntimeService` `IDISP003` ownership sites and made the owned-runtime replacement path more explicit: `StartCodexAsync` now disposes any stale `state.Codex` before replacing it, and the Claude prompt path now resets old process/pipe handles before handing off a new `Process` into `ClaudeApp Server ControllerRuntime`. Full rebuild passed with `.tmp/csharp-analyzers-after-app39.log` (`132` warnings / `0` errors). The two `SessionApp Server ControllerRuntimeService` `IDISP003` hits did not clear and only shifted line numbers, so they are now treated as analyzer-stubborn transfer-pattern warnings unless a clearer ownership simplification appears.
- 2026-04-03: Took the next `TtyHostSpawner` ownership batch in the redirected-process and redirected-stream handoff paths. The failed direct-start branch now nulls the disposed `Process` local before returning, and the Windows redirected spawn path now constructs the reader/writer wrappers directly and transfers them through a dedicated helper so the finally block only cleans up what is still locally owned. Full rebuild passed with `.tmp/csharp-analyzers-after-app40b.log` (`128` warnings / `0` errors). This cleared the temporary `CS0219` regression from the first attempt and dropped the build warning count from `132` to `128`, but the remaining `TtyHostSpawner` `IDISP003` warnings are still transfer-pattern shaped and likely analyzer-stubborn.
- 2026-04-03: Cleaned up the next low-risk lifetime batch in `LogWriter`, `CliCommands`, and `SingleInstanceGuard`. `LogWriter.Dispose()` now waits through a linked timeout token before cancellation, the update-command paths in `CliCommands` use `using var UpdateService`, and `SingleInstanceGuard.TryAcquire()` now uses an explicit try/finally ownership transfer instead of the earlier `GC.SuppressFinalize` workaround. Full rebuild passed and dropped the full-build total to `119` warnings with `.tmp/csharp-analyzers-after-app42b.log`.
- 2026-04-03: Took the next mechanical TtyHost/owner batch in `HistoryService`, `LocalClipboard`, `WindowsProcessMonitor`, `WindowsPty`, and `Program`. `HistoryService` now implements `IDisposable` and flushes/disposes its save timer, the macOS clipboard regex now has an explicit timeout, `WindowsProcessMonitor` uses checked pointer conversions plus dispose-before-replace for its polling timer, `WindowsPty.Resize()` now checks the ConPTY HRESULT, and the TtyHost accept-loop now owns client CTS/link-token lifetimes inside a wrapper task instead of leaking them to a continuation. Full rebuild passed with `.tmp/csharp-analyzers-after-app43d.log` (`102` warnings / `0` errors). The targeted warnings in `HistoryService`, `LocalClipboard`, `WindowsProcessMonitor`, and the TtyHost client CTS setup are now gone from the log.
- 2026-04-03: Took the next production cleanup slice in `TtyHostMuxConnectionManager`, `UnixFileSecretStorage`, and `WebPreviewProxyMiddleware`. `TtyHostMuxConnectionManager` now implements `IDisposable`/`IAsyncDisposable`, cancels and completes its output queue deterministically, and disposes tracked `MuxClient` instances during shutdown; `UnixFileSecretStorage` now checks and surfaces directory `chmod` failures; and `WebPreviewProxyMiddleware` now reuses a single parsed proxy-route result instead of discarding duplicate `TryParseProxyRoute` calls. Full rebuild passed with `.tmp/csharp-analyzers-after-app44.log` (`347` warnings / `0` errors). The targeted `TtyHostMuxConnectionManager` `CA1001` / `IDISP006`, `UnixFileSecretStorage` `CA1806`, and `WebPreviewProxyMiddleware` `CA1806` warnings are gone from the log.
- 2026-04-03: Took the next small TtyHost API/culture slice in `TtyHostClient` and `Ai.Tlbx.MidTerm.TtyHost/Program`. `TtyHostClient.ConnectAsync` now takes `CancellationToken` last and the two `TtyHostSessionManager` call sites were updated accordingly, and the `TMUX` path generation in TTY host now uses invariant formatting rather than implicit culture-sensitive interpolation. Full rebuild passed with `.tmp/csharp-analyzers-after-app45.log` (`342` warnings / `0` errors). The targeted `TtyHostClient` `CA1068` and TTY host `Program` `MA0076` hits are gone from the log.
- 2026-04-03: Cleared the next production correctness/finalizer tail in `WindowsPty`, `TtyHostSpawner`, `EmbeddedWebRootFileProvider`, and `Log`. `WindowsPty` now has a native-only finalizer path so `IDISP023` is gone, the single-character search sites in `TtyHostSpawner` and `EmbeddedWebRootFileProvider` no longer trip `CA1847`, and `Log.SetupCrashHandlers()` now uses `InvalidOperationException` instead of a generic `Exception` wrapper. Full rebuild passed with `.tmp/csharp-analyzers-after-app46c.log` (`178` warnings / `0` errors).
- 2026-04-03: Took the next localized tmux/logging slice in `TmuxLog`. Writer replacement is now explicit before reassignment and the timestamp prefix now uses invariant formatting. Full rebuild passed with `.tmp/csharp-analyzers-after-app48.log` (`172` warnings / `0` errors). This cleared the targeted `TmuxLog` `IDISP003` and `MA0076` hits, but exposed `TmuxLog` `IDISP007` as the remaining ownership-advisory tail in that file. `SystemSleepInhibitorService` `IDISP008` remains analyzer-stubborn even after making backend ownership explicit.
- 2026-04-03: Finished the remaining planned production `MA0076` pass across `TtyHostClient`, `WebPreviewEndpoints`, `WebPreviewService`, `StaticAssetCacheHeaders`, `TmuxPaneMapper`, `TmuxScriptWriter`, and `TtyHostSpawner`. The tmux script templates now precompute invariant endpoint URLs, cookie/css filenames are invariant-formatted, and the remaining Win32 error logs in `TtyHostSpawner` are invariant too. A temporary raw-string interpolation regression in `TmuxScriptWriter` was corrected in the same turn. Full rebuild passed with `.tmp/csharp-analyzers-after-app49c.log` (`148` warnings / `0` errors). The remaining warnings in these files are now ownership advisories only: `TtyHostSpawner` `IDISP003`/`IDISP007` and `WebPreviewService` `IDISP014`.
- 2026-04-03: Took the next bounded production ownership/API slice in `TtyHostSessionManager` and TTY host `Program`. The TTY host now replaces `_shutdownCts` through an explicit exchange-and-clear pattern so the earlier `Program` `IDISP003` is gone. `TtyHostSessionManager.TryConnectToSessionAsync` was rewritten to use a dedicated owned-client local with explicit transfer to the registry, but `CA2000` still remains on that constructor site and is now treated as analyzer-stubborn. Full rebuild passed with `.tmp/csharp-analyzers-after-app50.log` (`146` warnings / `0` errors).
- 2026-04-03: Took a low-count cleanup batch in `SystemSleepInhibitorServiceTests`, `EndpointSetupTests`, `MtcliScriptWriter`, `BrowserScriptWriter`, `GitCommandRunner`, `EndpointSetup`, and `WindowsFirewallService`. The repeated-dispose test was rewritten into an explicit helper/finally shape, test assertions now use `StringComparison`, and the remaining script-generation interpolations now format invariant values explicitly. Full rebuild passed with `.tmp/csharp-analyzers-after-app54.log` (`284` warnings / `0` errors).
- 2026-04-03: Took another low-count cleanup batch in `ApiKeyServiceTests`, `AuthServiceTests`, `FileServiceTests`, `LogWriterTests`, `CompressedStaticFilesMiddlewareTests`, and `FakeCodexWebSocketServer`. Disposable test fixtures are now sealed and suppress finalization, small assertion tails use explicit comparison overloads, request-token overloads are forwarded in test helpers, and the fake Codex server now uses invariant endpoint formatting plus token-aware task startup. Full rebuild passed with `.tmp/csharp-analyzers-after-app55.log` (`248` warnings / `0` errors).
- 2026-04-03: Took the next test-focused parse/culture/cancellation batch in `App Server ControllerHostProtocolTests`, `SessionApp Server ControllerPulseServiceTests`, and `HubServiceTests`. Repeated synthetic timestamp parsing now uses invariant helpers, the screen-summary assertion tail uses explicit `StringComparison`, and the test hub server now uses invariant URL formatting plus available cancellation tokens. A short-lived attempt to `using`-wrap `SessionApp Server ControllerPulseService` was reverted immediately because the service is not disposable. Full rebuild passed with `.tmp/csharp-analyzers-after-app56b.log` (`117` warnings / `0` errors).
- 2026-04-03: Took the next small targeted batch in `ShareGrantServiceTests`, `MuxProtocolTests`, `MtAgentHostRealCodexSmokeTests`, `App Server ControllerHostTestClient`, and `SessionPathAllowlistServiceTests`. Constructor parsing now uses invariant culture, smoke-test readiness uses a reused `HttpClient`, and the remaining tiny comparison/formatting tails in these files are cleared. Full rebuild passed with `.tmp/csharp-analyzers-after-app57.log` (`126` warnings / `0` errors). The total is slightly higher than the previous turn because this full build surfaced the legacy integration-test project again; the targeted files touched here are cleaner.
- 2026-04-04: Cleared the next unit-test comparer/regex/culture batch in `UpdateVerificationTests`, `TtyHostSessionManagerStateTests`, and `UpdateScriptGeneratorTests`. Rebuild passed with `.tmp/csharp-analyzers-after-app58.log` (`108` warnings / `0` errors).
- 2026-04-04: Cleared the next test-focused batch in `SessionCodexHandoffServiceTests`, `SessionApp Server ControllerPulseServiceTests`, and `WebPreviewProxyMiddlewareTests`. `SessionCodexHandoffServiceTests` now uses explicit async-disposal ownership transfer and invariant session-meta formatting, `SessionApp Server ControllerPulseServiceTests` now uses explicit `StringComparison`/invariant formatting and analyzer-friendly JSON array access, and the middleware test now forwards `RequestAborted` to `ReadToEndAsync`. Rebuild passed with `.tmp/csharp-analyzers-after-app59b.log` (`75` warnings / `0` errors).
- 2026-04-04: Cleared another test/integration batch in `SystemSleepInhibitorServiceTests`, `FakeCodexWebSocketServer`, `SessionApp Server ControllerHostRuntimeServiceTests`, and `IntegrationTests`. Runtime restart/recovery tests now use `await using`, JSON array enumeration is explicitly disposed, and most legacy integration response disposal warnings are gone. Full rebuild passed with `.tmp/csharp-analyzers-after-app60b.log` (`68` warnings / `0` errors).
- 2026-04-04: Cleared the low-count `IDISP015` / `IDISP008` / `CA5359` / `MA0076` production tail in `SessionApp Server ControllerPulseService`, `SystemSleepInhibitorService`, `HubService`, and `SessionAgentFeedService`. The subscription cleanup path now has one disposable owner, sleep inhibitor backend ownership is split into explicit owned vs injected fields, Hub websocket certificate validation now trusts pinned fingerprints or clean TLS only, and the bell timestamp formatting is invariant. Full rebuild passed with `.tmp/csharp-analyzers-after-app61c.log` (`63` warnings / `0` errors).
- 2026-04-04: Cleared the remaining `Program` shutdown `IDISP016` cluster by moving the cleanup registration below the last normal startup use of the captured services. `UpdateService` also cleared its `IDISP014` by switching to a single shared static client initialized without a helper factory method. Rebuild passed with `.tmp/csharp-analyzers-next6.log`; the remaining families are now `CA2000=1`, `IDISP014=2`, `IDISP003=9`, and `IDISP007=38`.
- 2026-04-04: Cleared the last `CA2000` family and reduced the low-count ownership tail further. `TtyHostSessionManager` discovery connect now uses a dedicated helper that owns and returns the connected client explicitly, `ProcessSystemSleepInhibitorBackend` now uses an explicit process-ownership transfer helper, `App Server ControllerWebSocketHandler` now creates its owned delta subscription inside the wrapper that disposes it, and `TmuxLog` now replaces its writer through an explicit helper instead of inline replace-and-dispose. Rebuild passed with `.tmp/csharp-analyzers-next11.log`; the remaining families are now `IDISP014=2`, `IDISP003=9`, and `IDISP007=36`.

## Next Wave

The remaining backlog is now almost entirely ownership-boundary work. Keep the batches narrow and prefer explicit ownership transfer or constructor splitting over suppression.

Concrete next steps:

1. Revisit the two `IDISP014` sites in `HubService` and `WebPreviewService` with owner-type construction, but only if the new shape reduces warnings instead of trading them for `CA2000` / `IDISP008`.
2. Then take the remaining explicit reassignment sites in:
   - `ProcessSystemSleepInhibitorBackend` `IDISP003`
   - `SessionApp Server ControllerHostRuntimeService` `IDISP003`
   - `SessionApp Server ControllerRuntimeService` `IDISP003`
3. Then keep burning down the smallest isolated `IDISP007` sites before the large session-runtime cluster:
   - `TmuxLog`
   - `TtyHostSessionManager`
   - `HubService`
4. Leave the largest injected-ownership cluster for last:
   - `IpcServer` `IDISP007`
   - `TtyHostSpawner` `IDISP007`
   - `SessionApp Server ControllerRuntimeService` `IDISP007`
   - `SessionApp Server ControllerHostRuntimeService` `IDISP007`
   - `App Server ControllerWebSocketHandler` is now clear

When stopping after any turn:

1. Update the progress log.
2. Replace this "Next Wave" section with the next concrete batch.
3. Mention any ambiguous ownership/behavior decisions that need human review.
