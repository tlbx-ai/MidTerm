# Architecture

MidTerm is a web-based terminal multiplexer. A native binary serves terminal sessions to browsers via WebSocket, with a binary protocol for efficient I/O multiplexing.

```
┌─────────────────────────────────────────────────────────────┐
│  Browser (xterm.js)                                         │
│  ├─ /ws/mux       Binary multiplexed terminal I/O          │
│  ├─ /ws/state     JSON session list updates                │
│  └─ /ws/settings  Real-time settings sync                  │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  mt (Web Server)                                            │
│  ├─ Kestrel HTTP/WebSocket                                  │
│  ├─ SessionManager                                          │
│  ├─ MuxClient per browser connection                        │
│  └─ SettingsWebSocketHandler (settings sync)                │
└─────────────────────────────────────────────────────────────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
┌───────────────────┐ ┌───────────────────┐ ┌───────────────────┐
│  mthost           │ │  mthost           │ │  mthost           │
│  (PTY session 1)  │ │  (PTY session 2)  │ │  (PTY session N)  │
└───────────────────┘ └───────────────────┘ └───────────────────┘
```

**Binaries:**
- `mt` / `mt.exe` — Web server, session manager, static file host
- `mthost` / `mthost.exe` — PTY host, one per terminal session

## Technology Choices

### Backend: C# Native AOT

The server compiles to a self-contained native binary via .NET's AOT compilation.

**Source-generated serialization**: `AppJsonContext.cs` declares all 79 serializable types at compile time. The runtime never touches reflection. See `Services/AppJsonContext.cs`.

**Platform APIs via P/Invoke**: ConPTY on Windows, forkpty on Unix. Direct system calls, no abstraction layers. See `src/Ai.Tlbx.MidTerm.TtyHost/Pty/`.

**Single-command deployment**: `dotnet publish -r win-x64 -c Release` produces one executable. No runtime installation, no dependencies.

**Kestrel's async I/O**: The same WebSocket infrastructure that handles production traffic at scale. WebSocket handlers in `Program.cs` lines 300-400.

Binary size: 15-25MB depending on platform. Startup: instant. Memory: stable after initial allocation.

### Key Services

| Service | Purpose |
|---------|---------|
| SessionManager | Terminal session lifecycle |
| AuthService | Authentication (see Security Architecture) |
| SettingsService | Settings persistence |
| UpdateService | GitHub release check, version comparison |
| SessionPathAllowlistService | Session file path allowlist security (max 1000 paths/session) |
| HistoryService | Command execution history (50 entries/shell) |
| SecurityStatusService | Security status reporting |
| CertificateGenerator/InfoService | HTTPS certificate lifecycle |
| SystemTrayService | Windows system tray integration |
| SystemUserProvider | OS-level user enumeration (Windows/macOS/Linux) |
| ISecretStorage | Cross-platform secret storage (platform-specific implementations) |
| ICertificateProtector | Platform-specific private key protection (DPAPI, AES-256) |
| SharedOutputBuffer | Zero-copy buffer sharing via reference counting |
| ClipboardService | Cross-platform clipboard image injection (Alt+V) |
| MainBrowserService | Multi-client resize coordination |
| TmuxCommandDispatcher + subsystem | Tmux compatibility layer for AI tools |
| TtyHostMuxConnectionManager | WebSocket mux connection management |

### Frontend: Vanilla TypeScript

The UI is TypeScript without React, Vue, or other frameworks. State management uses nanostores (~1KB), a minimal reactive library that adds computed stores without framework overhead.

**Reactive state**: nanostores in `stores/index.ts` provides atoms, maps, and computed stores for session and UI state.

**Ephemeral state**: `state.ts` holds WebSocket instances, DOM cache, and timers.

**Callback registration**: Modules register functions with each other at startup. `stateChannel.ts` calls `renderSessionList()` without importing the sidebar module. Wiring happens in `main.ts`:

```typescript
registerStateCallbacks({
    destroyTerminalForSession,
    createTerminalForSession,
    renderSessionList,
    selectSession,
    // ...
});
```

**Minimal reactivity**: Computed stores automatically update derived state (e.g., sorted session list). Rendering is still explicit—modules read via `.get()` and call render functions manually. Only one `.subscribe()` call exists (for connection indicator).

**Direct DOM manipulation**: xterm.js requires imperative control. Event handlers attach directly. Elements are created and appended as needed.

**Production dependencies** (3 total):

| Dependency | Size | Replaces |
|-----------|------|----------|
| nanostores | ~1KB | Redux, MobX, Zustand — reactive atoms/maps/computed for ~20 stores |
| openapi-fetch | ~3KB | Hand-written API client — typed from OpenAPI spec |
| xterm-link-provider | ~2KB | Manual link detection in terminal output |

Everything else (xterm.js, esbuild, TypeScript, ESLint) is devDependencies only.

**Bundle**: ~200KB uncompressed → ~144KB Brotli. A React+Redux equivalent would start at 300KB+ before application code. Build time: <2 seconds via esbuild.

**What was deliberately avoided:**
- React/Vue — ~15 interactive elements don't need a component tree or virtual DOM; terminal output streams at high frequency where diffing adds overhead
- Tailwind — one stylesheet (`app.css`) covers the entire UI
- Webpack — esbuild does the same bundling without configuration files
- Heavy state libraries — nanostores covers all ~20 stores in 1KB

## Protocols

### Mux Protocol (Binary WebSocket)

Endpoint: `/ws/mux`

All terminal I/O multiplexed over a single WebSocket connection using a binary protocol.

**Frame format:**
```
┌──────────┬────────────────┬─────────────────────────────────┐
│ Type (1) │ SessionId (8)  │ Payload (variable)              │
└──────────┴────────────────┴─────────────────────────────────┘
```

**Message types:**

| Type | Name | Direction | Payload |
|------|------|-----------|---------|
| 0x01 | Output | Server→Client | `[cols:2][rows:2][data...]` |
| 0x02 | Input | Client→Server | Raw bytes |
| 0x03 | Resize | Client→Server | `[cols:2][rows:2]` |
| 0x05 | Resync | Server→Client | Clear all terminals |
| 0x06 | BufferRequest | Client→Server | Request buffer refresh |
| 0x07 | CompressedOutput | Server→Client | `[cols:2][rows:2][uncompLen:4][gzip...]` |
| 0x08 | ActiveSessionHint | Client→Server | Hint for priority |
| 0x0A | ForegroundChange | Server→Client | Process monitoring update |
| 0x0B | DataLoss | Server→Client | Background session overflow notification |

**Priority buffering** (see `MuxClient.cs`):

The server buffers output differently based on session activity:

- **Active session**: Frames sent immediately. Zero buffering delay.
- **Background sessions**: Batched until 2KB accumulated OR 2 seconds elapsed. Then compressed with GZip and sent as single frame.

This ensures the focused terminal feels responsive while reducing bandwidth for background sessions running builds or logs.

**Resync mechanism**: If the bounded queue overflows (>1000 items), oldest frames are dropped. The server detects this and sends a `Resync` frame, causing clients to clear all terminals and rebuild from current buffers.

**Data loss notification**: When a background session's buffer overflows, the server sends a `DataLoss` (0x0B) frame to notify the client. The frontend displays a warning indicator for affected sessions.

### State WebSocket (JSON)

Endpoint: `/ws/state`

Separate channel for sidebar synchronization. Pushes session list whenever sessions change (create, delete, rename, resize).

```json
{
    "sessions": {
        "sessions": [
            { "id": "a1b2c3d4", "name": null, "shellType": "pwsh", "cols": 120, "rows": 30 }
        ]
    },
    "update": { "version": "5.10.0", "isNewer": true }
}
```

Clients use this to render the sidebar without polling. Multiple browser tabs receive updates simultaneously.

### Settings WebSocket (JSON)

Endpoint: `/ws/settings`

Real-time settings synchronization across all connected clients. When settings change on one client, updates propagate to all others.

**Bidirectional protocol:**
- Server→Client: Full settings object when settings change
- Client→Server: Settings update requests

This enables features like:
- Settings panel updates reflected across browser tabs instantly
- Theme changes applied to all connected sessions
- Coordinated settings state without polling

Handler: `SettingsWebSocketHandler.cs`

### REST API

Authentication, session management, and settings via REST endpoints. Authentication details are in the Security Architecture section.

**Session management:**
- `POST /api/sessions` — Create session with optional shell type, working directory
- `DELETE /api/sessions/{id}` — Close session
- `POST /api/sessions/{id}/resize` — Resize terminal dimensions

**Bootstrap endpoint:**
- `GET /api/bootstrap` — Consolidated startup data (replaces multiple calls to sessions, settings, version, shells, update check)

**Command history:**
- `GET /api/history` — Retrieve command history
- `POST /api/history` — Add command to history

**File operations:**
- `GET /api/files/*` — File content and metadata
- `POST /api/files/*` — File operations (for File Radar integration)

**Settings:**
- `GET /api/settings` — Current public settings
- `PUT /api/settings` — Update settings
- `POST /api/settings/reload` — Reload from disk

**Certificates:**
- `GET /api/certificate/info` — Certificate details
- `GET /api/certificate/download/pem` — Download PEM
- `GET /api/certificate/download/mobileconfig` — iOS/macOS profile
- `GET /api/certificate/share-packet` — Share packet with network endpoints

**System:**
- `GET /api/system` — Consolidated health (version, uptime, platform, PID)
- `GET /api/networks` — Network interfaces with IPv4
- `GET /api/paths` — Settings/secrets/cert/log directories
- `GET /api/users` — System user enumeration

**Tmux compatibility:**
- `POST /api/tmux` — Tmux command dispatcher (null-delimited args)
- `POST /api/tmux/layout` — Update layout state

**Updates:**
- `GET /api/update/check` — Check for updates
- `POST /api/update/apply` — Download and apply update
- `GET /api/update/result` — Get update result
- `GET /api/update/log` — Tail update log

**Diagnostics:**
- `GET /api/logs/*` — Diagnostic log access

## Security Architecture

MidTerm exposes terminal access over a network. Every security decision follows from that threat model: an attacker who reaches the server can execute arbitrary commands. Defense is layered so no single failure grants access.

### Authentication

- PBKDF2-SHA256, 100K iterations, 32-byte random salt, 32-byte hash output
- `CryptographicOperations.FixedTimeEquals()` for timing-safe comparison of both password hashes and session token signatures
- HMAC-SHA256 session tokens (`timestamp:signature`), 72-hour sliding window — fresh token issued on every HTTP request so active sessions stay alive
- Password change calls `InvalidateAllSessions()` which rotates the session secret, invalidating all existing tokens
- Cookie: `HttpOnly`, `SameSite=Strict`, `Secure`, `Path=/`, 3-day `MaxAge`
- Progressive rate limiting by IP: 5 failures → 30s lockout, 10 failures → 5min lockout
- See: `AuthService.cs`, `AuthEndpoints.cs`

### Secret Storage

- Secrets (password hash, session secret, certificate password) stored separately from `settings.json` via `ISecretStorage` interface
- Platform implementations:

| Platform | Implementation | Mechanism |
|----------|---------------|-----------|
| Windows | `WindowsSecretStorage` | DPAPI (`secrets.bin`) |
| macOS (user) | `MacOsSecretStorage` | Keychain |
| macOS (service) / Linux | `UnixFileSecretStorage` | File with `chmod 600` + atomic writes |

- Dual settings model: `MidTermSettings` has `[JsonIgnore]` on secrets (excluded from `settings.json` but available internally), `MidTermSettingsPublic` has no secret fields at all — the API cannot leak them even if serialization is misconfigured
- See: `ISecretStorage.cs`, `MidTermSettings.cs`, `MidTermSettingsPublic.cs`

### Certificate & TLS

- ECDSA P-384 default (`ECCurve.NamedCurves.nistP384`), RSA 4096 fallback, 2-year validity
- SAN: `localhost` + hostname + all network IPs
- Private key stored separately via `ICertificateProtector`:

| Platform | Implementation | Mechanism |
|----------|---------------|-----------|
| Windows | `WindowsDpapiProtector` | DPAPI (LocalMachine or CurrentUser scope) |
| macOS / Linux | `EncryptedFileProtector` | AES-256-CBC with PBKDF2-derived key from `SHA256(machine-id + settings-dir)` — machine-bound |

- `CryptographicOperations.ZeroMemory()` on private key bytes and PFX exports after use
- TLS 1.2 + 1.3 only; AEAD cipher suites enforced on Unix (GCM + ChaCha20-Poly1305); server header removed (`AddServerHeader = false`)
- Security headers: HSTS (`max-age=31536000; includeSubDomains`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`
- Content Security Policy: `default-src 'self'`, `script-src 'self'`, `frame-ancestors 'none'`
- See: `CertificateGenerator.cs`, `Services/Security/`, `Startup/ServerSetup.cs`

### Static File Isolation

- Production: all assets Brotli-compressed and embedded as assembly resources at build time
- `EmbeddedWebRootFileProvider` serves from memory — no filesystem path access at runtime
- Eliminates path traversal; assets are immutable after deployment
- See: `CompressedStaticFilesMiddleware.cs`, `EmbeddedWebRootFileProvider.cs`

## Architecture Patterns

### Process Isolation

Each terminal session runs in a separate `mthost` process:

```
mt (web server)
  │
  ├── IPC ──► mthost (session 1) ──► /bin/bash
  ├── IPC ──► mthost (session 2) ──► pwsh.exe
  └── IPC ──► mthost (session 3) ──► /bin/zsh
```

**Benefits:**
- **Crash isolation**: A shell crash kills one mthost, not the server
- **Privilege dropping**: On Unix, mthost can run as non-root user
- **Clean process model**: Each PTY has dedicated file descriptors

**IPC mechanism:**
- Windows: Named pipes (`\\.\pipe\mthost-{sessionId}-{pid}`)
- Unix: Unix domain sockets (`/tmp/mthost-{sessionId}-{pid}.sock`)

Protocol: 5-byte header (type + length) + JSON/binary payload.

### AOT-Safe Patterns

Native AOT compilation prohibits runtime reflection. All dynamic behavior must be resolved at compile time.

**Source-generated JSON** (see `AppJsonContext.cs`):
```csharp
[JsonSerializable(typeof(SessionListDto))]
[JsonSerializable(typeof(CreateSessionRequest))]
// ... 77 more types
internal partial class AppJsonContext : JsonSerializerContext { }
```

**Platform detection**:
```csharp
if (OperatingSystem.IsWindows())
    return new WindowsPty(sessionId, shell, workingDir);
else
    return new UnixPty(sessionId, shell, workingDir);
```

**Compile-time conditionals** for platform-specific code:
```csharp
#if WINDOWS
    [DllImport("kernel32.dll")]
    private static extern bool CreatePseudoConsole(...);
#endif
```

### Frontend State Management

State is split between nanostores (reactive) and module-level variables (ephemeral).

**Nanostores (`stores/index.ts`)** - ~1KB reactive library:
- `atom<T>` for simple values (`$activeSessionId`, `$settingsOpen`)
- `map<Record>` for collections (`$sessions`)
- `computed` for derived state (`$sessionList` auto-sorts when `$sessions` changes)

**New stores for advanced features:**
- `$currentSettings` — Current settings from server
- `$layout` — Multi-pane layout tree
- `$focusedSessionId` — Keyboard focus in layout
- `$isMainBrowser` — Main browser flag
- `$renamingSessionId` — Active rename tracking
- `$processStates` — Per-session foreground process info
- `$dataLossDetected` — Tracks sessions with buffer overflow

**Ephemeral state (`state.ts`)** - Non-reactive:
- WebSocket instances, DOM cache, timers, pending buffers
- Pending rename handling (survives reconnect)
- Strictly ordered output queue with cursor-based dequeue
- Traffic metrics with EMA smoothing

```typescript
// stores/index.ts
export const $sessions = map<Record<string, Session>>({});
export const $activeSessionId = atom<string | null>(null);
export const $sessionList = computed([$sessions], sessions =>
  Object.values(sessions).sort((a, b) => a._order - b._order)
);

// Reading state
const id = $activeSessionId.get();
const session = getSession(id);
```

Modules communicate via callback registration:

```typescript
// stateChannel.ts (WebSocket handler)
function handleStateUpdate(newSessions: Session[]): void {
    setSessions(newSessions);    // Updates $sessions store
    renderSessionList();         // Explicit render call
    updateEmptyState();
}
```

Data flow:
```
WebSocket message
    → handleStateUpdate()
        → setSessions()        // Updates $sessions store
        → $sessionList         // Recomputes automatically
        → renderSessionList()  // Explicit render call
            → DOM mutations
```

Nanostores handles derived state automatically. Explicit render calls remain—no hidden re-renders.

## Features

### File Radar

Terminal file path detection with security controls.

- **Path detection**: Parses terminal output for file paths
- **Allowlist service**: Security boundary (max 1000 paths/session)
- **Integration**: Clicking detected paths opens file viewer or external editor

Settings: `fileRadar` (enable/disable path detection)

### Voice Chat

Voice input integration for terminal commands.

- **Module**: `voice.ts` (760 lines)
- **Integration**: Speech-to-text for command input
- **UI**: Voice panel with recording controls

### Touch Controller

Mobile gesture support for touch devices.

- **Module**: `touchController/` (995 lines)
- **Gestures**: Swipe, pinch-zoom, tap handling
- **Responsive**: Adapts UI for touch interaction

### Command History

Searchable command execution history.

- **Service**: `HistoryService` (50 entries per shell type)
- **Module**: `history/` (frontend)
- **API**: `GET/POST /api/history`
- **UI**: Command launcher with fuzzy search

### Foreground Process Monitoring

Tracks and displays currently running process in each terminal.

- **Protocol**: `ForegroundChange` (0x0A) message type
- **Store**: `$processStates` for UI updates
- **Tab titles**: `tabTitleMode: foregroundProcess` option

### Manager Bar

Customizable quick-action buttons below the terminal area. Clicking a button sends its text + Enter to the active terminal.

- **Settings**: `managerBarEnabled`, `managerBarButtons`
- **Module**: `managerBar/`

### IDE Mode

Per-session tabbed UI adding Files, Git, and Commands panels alongside the terminal.

- **Tabs**: Terminal | Files | Git | Commands
- **Module**: `sessionTabs/` (tabBar, tabManager, per-tab content panels)
- **Sub-modules**: `git/` (WebSocket monitoring), `fileViewer/`, `commands/`
- **Setting**: `ideMode` (default: true)
- **When off**: CSS class `ide-mode-off` hides tab bar, git WebSocket disconnects, backend stops directory monitoring

### Multi-Pane Layout

Tmux-like split-pane terminal arrangement. Dock, undock, swap sessions. Layout persisted to localStorage.

- **Module**: `layout/` (`layoutRenderer.ts`, `dockOverlay.ts`, `layoutStore.ts`)

### Tmux Compatibility

Shim script injected into terminal sessions so AI coding tools that detect tmux can use MidTerm's split-pane API.

- **Services**: 12 files under `Services/Tmux/`
- **API**: `POST /api/tmux`
- **Setting**: `tmuxCompatibility` (default: true)

### PWA Support

Installable web app via `site.webmanifest`. Standalone display mode, themed splash screen. Install button in Settings.

### Clipboard Image Injection

Alt+V pastes clipboard image into terminal via `ClipboardService`. Platform-specific: PowerShell (Windows), osascript (macOS), xclip (Linux).

### Main Browser Coordination

`MainBrowserService` tracks which client can auto-resize. First connection becomes main. Other connections scale terminals via CSS transform. Prevents unintended resize from secondary clients.

### Settings Synchronization

Real-time settings sync across all connected clients via `/ws/settings` WebSocket.

### New Settings

| Setting | Purpose |
|---------|---------|
| `fileRadar` | Terminal file path detection |
| `scrollbackProtection` | Claude Code glitch protection |
| `minimumContrastRatio` | Accessibility color contrast |
| `tabTitleMode` | 5 modes: hostname, static, sessionName, terminalTitle, foregroundProcess |
| `cursorInactiveStyle` | 5 styles for unfocused cursor |
| `runAsUser` / `runAsUserSid` | Windows service user impersonation |
| `keyProtection` | OsProtected or LegacyPfx |
| `updateChannel` | stable or dev |
| `tmuxCompatibility` | Tmux shim injection for AI tools |
| `managerBarEnabled` | Quick-action button bar |
| `managerBarButtons` | Custom button definitions |
| `ideMode` | Per-session IDE tabs (Files, Git, Commands) |
| `scrollbarStyle` | Off / Hover / Always |
| `smoothScrolling` | Smooth scroll animation |

## Design Philosophy

### Simplicity Over Abstraction

The right amount of complexity is the minimum needed for the current task.

- Three similar lines of code > premature abstraction
- Minimal reactivity (computed stores) > full reactive frameworks
- State changes traceable via `.get()`/`.set()` calls
- Direct function calls > message buses

### Explicit Over Implicit

Every state change has a traceable call path.

- Computed stores update derived state automatically
- Rendering remains explicit—no automatic re-renders
- Only one subscription in codebase (connection indicator)
- DOM updates happen when code calls render functions

### Platform-Native Over Cross-Platform Abstraction

Use platform APIs directly rather than abstracting to a lowest common denominator.

- ConPTY on Windows, forkpty on Unix
- Named pipes on Windows, Unix sockets elsewhere
- Compile-time conditionals over runtime factory patterns

## Design Trade-offs

### Minimal State Management

The decision to use nanostores (~1KB) instead of React/Redux has specific implications:

**Debugging**: `grep '\$sessions'` locates store usage. `grep 'setSession'` finds mutations. Call stacks show the path from WebSocket message to store update to explicit render call.

**Coupling**: The callback registration pattern in `main.ts` serves as the dependency graph. Modules don't import each other; they receive function references at startup. This achieves the decoupling that dependency injection provides, without the container.

### Native AOT vs Runtime Alternatives

C# AOT trades some flexibility for deployment simplicity:

**What works**: P/Invoke to platform APIs (ConPTY, forkpty) compiles cleanly. Source-generated JSON handles all serialization. Kestrel's WebSocket implementation is AOT-compatible.

**Constraints**: No runtime code generation. All types must be known at compile time. The 79-type `AppJsonContext` declares everything upfront.

**Binary size**: 15-25MB includes the runtime, HTTP server, WebSocket handling, and compression. Most of this would exist in any web server; the delta for AOT is minimal.

### Browser-Based Terminal Architecture

Terminal multiplexing in a browser involves inherent constraints:

**Network path**: Every keystroke travels browser → WebSocket → server → PTY → shell. Latency is unavoidable. The binary mux protocol minimizes overhead; priority buffering ensures the active session feels responsive.

**No native terminal emulation**: xterm.js handles escape sequences in JavaScript. It's remarkably complete, but edge cases exist in TUI applications.

**Advantage**: Any device with a browser becomes a terminal client. No SSH configuration. No native app installation. The server handles session persistence across disconnects.

## Testing

The project has two test projects:

**Integration tests** (`src/Ai.Tlbx.MidTerm.Tests/`):
- REST API endpoints (sessions, version, resize)
- WebSocket protocols (mux binary frames, state JSON updates)
- Session lifecycle (create, list, delete)

**Unit tests** (`src/Ai.Tlbx.MidTerm.UnitTests/`):
- `AuthServiceTests` — Password hashing, token validation
- `MuxProtocolTests` — Binary protocol encoding/decoding

**Test patterns**:
- `WebApplicationFactory<Program>` for in-process HTTP/WebSocket testing
- `IAsyncLifetime` for test setup/teardown with session cleanup
- Polling helpers for async state verification

## Build System

The build pipeline transforms C# source types into a fully typed, compressed frontend bundle embedded in the native AOT binary.

```
C# DTOs (Models/*.cs)
  │
  ▼
Ai.Tlbx.MidTerm.Api          Shared endpoint definitions + handler interfaces
  │
  ▼
Ai.Tlbx.MidTerm.OpenApi      Stub app → Microsoft.AspNetCore.OpenApi → openapi.json
  │
  ▼
openapi-typescript            openapi.json → api.generated.ts (TypeScript types)
  │
  ▼
tsc --noEmit                  Type-check all TypeScript (catches API drift)
  │
  ▼
ESLint + Prettier             Lint and format
  │
  ▼
esbuild                       Bundle → terminal.min.js (~200 KB)
  │
  ▼
Brotli (publish only)         Compress all text assets → .br files
  │
  ▼
EmbeddedResource              MSBuild embeds wwwroot/** into the binary
```

### frontend-build.ps1 Phases

| Phase | What it does |
|-------|-------------|
| 0 | Clean/create `wwwroot/` output directory |
| 0.5 | Build OpenAPI project → generate `openapi.json` → run `openapi-typescript` → `api.generated.ts` |
| 1 | `tsc --noEmit` — Type-check all TypeScript |
| 2 | ESLint (includes Prettier via plugin) |
| 3 | `esbuild` — Bundle + minify → `terminal.min.js` with `BUILD_VERSION` injected |
| 4 | Copy binary assets (fonts, images, favicons) |
| 5 | Process text assets (HTML, CSS, license files). CSS minified via esbuild. Publish: Brotli-compress all text files |
| 6 | Publish only: Brotli-compress generated JS + source map, delete uncompressed originals |

### MSBuild Re-Invocation Pattern

Static `<ItemGroup>` elements are evaluated when MSBuild loads the project, but `.br` files are created by a target that runs later. Chicken-and-egg problem.

Solution: The `EnsureFrontendPublish` target runs `frontend-build.ps1`, then re-invokes MSBuild with `_FrontendReady=true`. The second invocation evaluates ItemGroups fresh and sees the generated files. `_FrontendReady=true` prevents infinite recursion.

Debug builds only re-invoke on the first build after clean (when `terminal.min.js` doesn't exist yet). Subsequent builds skip re-invocation since the ItemGroup already found the files.

### Debug vs Publish

| | Debug | Publish |
|---|-------|---------|
| Asset format | Uncompressed files in `wwwroot/` | Brotli `.br` files only |
| Embedding | `wwwroot\**\*` | `wwwroot\**\*.br` + non-compressible binaries |
| Serving | `EmbeddedWebRootFileProvider` decompresses on demand | `CompressedStaticFilesMiddleware` serves `.br` with `Content-Encoding: br` |
| CSS originals deleted | No | Yes (only `.br` embedded) |
| JS originals deleted | No | Yes (only `.br` embedded) |

### Version Management

`version.json` at the repository root is the single source of truth:

```json
{
  "web": "6.14.9",
  "pty": "6.14.5-dev",
  "protocol": 1,
  "minCompatiblePty": "2.0.0",
  "webOnly": true
}
```

Both csproj files read their version dynamically via a `ReadVersionJson` MSBuild target that runs `node -p "require('./version.json').web"`. No hardcoded `<Version>` tags in csproj files. Release scripts only update `version.json`.

### AOT Publish

Platform-specific scripts handle the full publish:

- `build-aot.cmd` (Windows) — `dotnet publish -r win-x64 -c Release`
- `build-aot-linux.sh` (Linux) — `dotnet publish -r linux-x64 -c Release`
- `build-aot-macos.sh` (macOS) — `dotnet publish -r osx-arm64 -c Release`

These pass `-p:IsPublishing=true` which activates the AOT optimizations PropertyGroup and the Brotli compression path in `frontend-build.ps1`.

## Type-Safe API Bridge

### The Problem

A C# backend and a TypeScript frontend need to agree on API shapes. Manual type definitions drift. Runtime errors show up in production instead of at build time.

### The Architecture

```
┌──────────────────────────────────────────────────┐
│  Ai.Tlbx.MidTerm.Api (shared project)            │
│  ├─ Models/          C# DTOs (single source)     │
│  ├─ Endpoints/       Route definitions            │
│  ├─ Handlers/        Handler interfaces           │
│  └─ AppJsonContext   AOT JSON registration        │
│                                                    │
│  Referenced by:                                    │
│    • Main web server (implements handlers)         │
│    • OpenAPI project (generates spec)              │
└──────────────────────────────────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────────────┐
│  Ai.Tlbx.MidTerm.OpenApi                         │
│  ├─ Registers stub handlers (no-op)              │
│  ├─ Builds endpoints from Api project            │
│  ├─ Microsoft.AspNetCore.OpenApi generates spec   │
│  └─ Schema transformers fix nullability/unions    │
│                                                    │
│  Output: openapi/openapi.json                     │
└──────────────────────────────────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────────────┐
│  openapi-typescript (npm)                         │
│  Converts openapi.json → api.generated.ts         │
│  ├─ paths: typed route definitions                │
│  └─ components.schemas: all DTOs as TS types      │
└──────────────────────────────────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────────────┐
│  openapi-fetch client (src/ts/api/client.ts)      │
│  createClient<paths>() provides typed methods:     │
│  • client.POST('/api/sessions', { body })         │
│  • client.GET('/api/auth/status')                 │
│  Full IntelliSense on routes, params, responses    │
└──────────────────────────────────────────────────┘
```

### What This Means

If a C# DTO changes — a field renamed, a type changed, a property removed — the OpenAPI spec regenerates, `openapi-typescript` emits new types, and `tsc --noEmit` fails if TypeScript code uses the old shape. The build breaks before the code ships.

No manual type definitions. No `any` casts. No runtime surprises from API drift.

### Example: CreateSessionRequest

**1. C# definition** (`Models/Sessions/CreateSessionRequest.cs`):
```csharp
public sealed class CreateSessionRequest
{
    public int Cols { get; set; } = 120;
    public int Rows { get; set; } = 30;
    public string? Shell { get; set; }
    public string? WorkingDirectory { get; set; }
}
```

**2. Endpoint definition** (`Endpoints/SessionEndpointDefinitions.cs`):
```csharp
app.MapPost("/api/sessions", async (CreateSessionRequest? request, ISessionHandler handler) =>
    await handler.CreateSessionAsync(request))
    .Produces<SessionInfoDto>(StatusCodes.Status200OK);
```

**3. Generated TypeScript** (`api.generated.ts`):
```typescript
components: {
  schemas: {
    CreateSessionRequest: {
      cols: number;
      rows: number;
      shell?: null | string;
      workingDirectory?: null | string;
    };
  };
}
```

**4. Typed client usage**:
```typescript
import { createSession } from '../../api/client';

const { data, response } = await createSession({ cols: 120, rows: 30, shell: 'pwsh' });
// data is SessionInfoDto | undefined — fully typed
```

## File Reference

| Area | Key Files |
|------|-----------|
| Entry point | `src/Ai.Tlbx.MidTerm/Program.cs` |
| Mux protocol | `src/Ai.Tlbx.MidTerm/Services/WebSockets/MuxClient.cs`, `MuxProtocol.cs` |
| Session management | `src/Ai.Tlbx.MidTerm/Services/Sessions/TtyHostSessionManager.cs` |
| AOT JSON | `src/Ai.Tlbx.MidTerm/Services/AppJsonContext.cs` |
| Settings WebSocket | `src/Ai.Tlbx.MidTerm/Services/WebSockets/SettingsWebSocketHandler.cs` |
| Session Path Allowlist | `src/Ai.Tlbx.MidTerm/Services/SessionPathAllowlistService.cs` |
| History | `src/Ai.Tlbx.MidTerm/Services/HistoryService.cs` |
| PTY (Windows) | `src/Ai.Tlbx.MidTerm.TtyHost/Pty/ConPty/` |
| PTY (Unix) | `src/Ai.Tlbx.MidTerm.TtyHost/Pty/UnixPty.cs` |
| Frontend stores | `src/Ai.Tlbx.MidTerm/src/ts/stores/index.ts` |
| Ephemeral state | `src/Ai.Tlbx.MidTerm/src/ts/state.ts` |
| Frontend wiring | `src/Ai.Tlbx.MidTerm/src/ts/main.ts` |
| Mux client (TS) | `src/Ai.Tlbx.MidTerm/src/ts/modules/comms/muxChannel.ts` |
| State client (TS) | `src/Ai.Tlbx.MidTerm/src/ts/modules/comms/stateChannel.ts` |
| Settings client (TS) | `src/Ai.Tlbx.MidTerm/src/ts/modules/comms/settingsChannel.ts` |
| Voice | `src/Ai.Tlbx.MidTerm/src/ts/modules/voice.ts` |
| Touch | `src/Ai.Tlbx.MidTerm/src/ts/modules/touchController/` |
| File links | `src/Ai.Tlbx.MidTerm/src/ts/modules/fileLinks.ts` |
| History (TS) | `src/Ai.Tlbx.MidTerm/src/ts/modules/history/` |
| Tmux services | `src/Ai.Tlbx.MidTerm/Services/Tmux/` |
| Layout module | `src/Ai.Tlbx.MidTerm/src/ts/modules/layout/` |
| Manager Bar module | `src/Ai.Tlbx.MidTerm/src/ts/modules/managerBar/` |
| Clipboard | `src/Ai.Tlbx.MidTerm/Services/ClipboardService.cs` |
| Main Browser | `src/Ai.Tlbx.MidTerm/Services/MainBrowserService.cs` |
| PWA manifest | `src/Ai.Tlbx.MidTerm/src/static/site.webmanifest` |
| API contract | `src/Ai.Tlbx.MidTerm.Api/` (Models, Endpoints, Handlers) |
| OpenAPI generator | `src/Ai.Tlbx.MidTerm.OpenApi/Program.cs` |
| OpenAPI spec | `src/Ai.Tlbx.MidTerm/openapi/openapi.json` |
| Generated TS types | `src/Ai.Tlbx.MidTerm/src/ts/api.generated.ts` |
| API client (TS) | `src/Ai.Tlbx.MidTerm/src/ts/api/client.ts` |
| API type exports | `src/Ai.Tlbx.MidTerm/src/ts/api/types.ts` |
| Frontend build | `src/Ai.Tlbx.MidTerm/frontend-build.ps1` |
| Version source | `version.json` |
| Authentication | `src/Ai.Tlbx.MidTerm/Services/AuthService.cs`, `Services/AuthEndpoints.cs` |
| Secret storage | `src/Ai.Tlbx.MidTerm/Services/Secrets/ISecretStorage.cs` + platform implementations |
| Certificate protection | `src/Ai.Tlbx.MidTerm/Services/Security/` |
| TLS & server setup | `src/Ai.Tlbx.MidTerm/Startup/ServerSetup.cs` |
| Certificate generation | `src/Ai.Tlbx.MidTerm/Startup/CertificateSetup.cs`, `Services/Certificates/CertificateGenerator.cs` |
