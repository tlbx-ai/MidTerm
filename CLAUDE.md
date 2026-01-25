# CLAUDE.md

## ⚠️ IMPORTANT: DO NOT USE BACKGROUND TASKS ⚠️

**DO NOT USE BACKGROUND TASKS. DO NOT USE BACKGROUND TASKS. DO NOT USE BACKGROUND TASKS.**

The `run_in_background` feature of Claude Code is currently broken. Never use:
- `run_in_background: true` on Bash commands
- Background task execution
- Any command that runs in the background

**DO NOT USE BACKGROUND TASKS.** This section will be removed when the feature works again.

---

Guidance for Claude Code when working with this repository.

## What This Is

MidTerm is a web-based terminal multiplexer. Native AOT compiled, runs on macOS/Windows/Linux. Serves terminal sessions via browser at `http://localhost:2000`.

**Binaries:**
- `mt` / `mt.exe` — Web server (UI, REST API, WebSockets)
- `mthost` / `mthost.exe` — TTY host (spawned per terminal, all platforms)

**Default port:** 2000

**Settings locations:**
- Service mode: `%ProgramData%\MidTerm\settings.json` (Win) or `/usr/local/etc/midterm/settings.json` (Unix)
- User mode: `~/.midterm/settings.json`

## Build Commands

```bash
# Build web server (debug)
dotnet build src/Ai.Tlbx.MidTerm/Ai.Tlbx.MidTerm.csproj

# Test
dotnet test src/Ai.Tlbx.MidTerm.Tests/Ai.Tlbx.MidTerm.Tests.csproj

# AOT publish (platform-specific)
src/Ai.Tlbx.MidTerm/build-aot.cmd        # Windows
./src/Ai.Tlbx.MidTerm/build-aot-linux.sh # Linux
./src/Ai.Tlbx.MidTerm/build-aot-macos.sh # macOS
```

## Asset Optimization

When adding new PNG assets or periodically during maintenance, run pngcrush for lossless compression:

```bash
C:/Tools/pngcrush/pngcrush_1_8_11_w64.exe -ow -reduce -brute <file.png>
```

This typically saves 30-40% on PNG file sizes. Ask the user if they want to run this after adding new image assets.

## Testing

When adding new functionality beyond styling changes, consider adding integration tests. The test project (`src/Ai.Tlbx.MidTerm.Tests/`) uses xUnit with `WebApplicationFactory` for HTTP/WebSocket testing.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  mt.exe (Web Server + Session Manager)                      │
│  ├─ Kestrel HTTP server (REST API, static files)            │
│  ├─ WebSocket handlers (/ws/mux, /ws/state)                 │
│  ├─ SessionManager (terminal lifecycle)                     │
│  ├─ AuthService (password auth, session cookies)            │
│  └─ UpdateService (GitHub release check)                    │
└─────────────────────────────────────────────────────────────┘
           │
           │ Spawns mthost per terminal (all platforms)
           ▼
┌─────────────────────────────────────────────────────────────┐
│  Terminal Sessions                                          │
│  └─ Shell processes (pwsh, bash, zsh, cmd)                  │
└─────────────────────────────────────────────────────────────┘
```

## Project Structure

```
src/                                 C# solution and projects
├── MidTerm.slnx                     Solution file
├── Directory.Build.props            Shared build properties
├── Ai.Tlbx.MidTerm/                 Web Server (mt.exe)
│   ├── Program.cs                   Entry point, API endpoints, auth middleware
│   ├── Services/
│   │   ├── AuthService.cs           Password hashing (PBKDF2), session tokens
│   │   ├── SessionManager.cs        Terminal session lifecycle
│   │   ├── UpdateService.cs         GitHub release check, version comparison
│   │   ├── SettingsService.cs       Settings persistence
│   │   └── AppJsonContext.cs        AOT-safe JSON serialization
│   ├── Settings/
│   │   └── MidTermSettings.cs       Settings model (auth, defaults, appearance)
│   ├── src/
│   │   ├── ts/                      TypeScript source (compiled by esbuild)
│   │   │   ├── main.ts              Entry point, initialization
│   │   │   ├── types.ts             Shared interfaces and types
│   │   │   ├── constants.ts         Protocol constants, themes
│   │   │   ├── state.ts             Ephemeral state (WebSockets, DOM, timers)
│   │   │   ├── stores/              Reactive state (nanostores)
│   │   │   ├── modules/             Feature modules (comms, terminal, sidebar, etc.)
│   │   │   └── utils/               DOM helpers, cookies, debounce
│   │   └── static/                  Source static assets
│   │       ├── *.html               HTML pages (index, login, trust)
│   │       ├── css/                 Stylesheets (app.css, xterm.css)
│   │       ├── fonts/               Web fonts (woff/woff2)
│   │       ├── img/                 Images (logo.png)
│   │       └── favicon/             Favicon files (ico, png)
│   └── wwwroot/                     GENERATED (gitignored) - built by frontend-build.ps1
├── Ai.Tlbx.MidTerm.Common/          Shared protocol code
├── Ai.Tlbx.MidTerm.Tests/           Integration tests
└── Ai.Tlbx.MidTerm.TtyHost/         TTY Host (all platforms)
    ├── Program.cs                   Spawned per terminal, hosts PTY session
    └── Pty/
        └── IPtyConnection.cs        Cross-platform PTY abstraction

scripts/                             Build and release scripts
docs/                                Documentation and marketing assets
```

## Services Overview

The `Services/` folder contains ~45 files organized by responsibility. When adding new functionality, check if an existing service already handles that domain.

| Category | Services | Purpose |
|----------|----------|---------|
| **Authentication** | `AuthService`, `AuthEndpoints` | Password hashing (PBKDF2), session tokens, login/logout |
| **Sessions** | `TtyHostSessionManager`, `TtyHostClient`, `TtyHostSpawner`, `SessionApiEndpoints` | Terminal session lifecycle, spawning mthost processes |
| **WebSockets** | `MuxWebSocketHandler`, `StateWebSocketHandler`, `SettingsWebSocketHandler`, `MuxClient`, `MuxProtocol` | Binary mux protocol, JSON state sync, settings broadcast |
| **Settings** | `SettingsService` (in Settings/) | Load/save settings.json, settings validation |
| **Security** | `SecurityStatusService`, `UserValidationService`, `UserEnumerationService` | Security posture checks, RunAsUser validation |
| **Secrets** | `ISecretStorage`, `WindowsSecretStorage`, `MacOsSecretStorage`, `UnixFileSecretStorage`, `SecretStorageFactory` | Platform-specific secure storage (DPAPI, Keychain, file) |
| **Certificates** | `CertificateGenerator`, `CertificateInfoService`, `CertificateCleanupService` | HTTPS cert generation, trust info |
| **Updates** | `UpdateService`, `UpdateVerification`, `UpdateScriptGenerator` | GitHub release check, script generation, signature verification |
| **Static Files** | `CompressedStaticFilesMiddleware`, `EmbeddedWebRootFileProvider`, `EmbeddedFileInfo` | Serve Brotli-compressed embedded assets |
| **System** | `SingleInstanceGuard`, `ShutdownService`, `TempCleanupService` | Instance locking, graceful shutdown, temp file cleanup |
| **Tray** | `SystemTrayService`, `TrayHelperService` | Windows/macOS system tray integration |
| **History** | `HistoryService`, `HistoryEndpoints` | Command launch history |
| **Files** | `FileEndpoints`, `FileRadarAllowlistService` | File uploads, path validation for FileRadar |
| **Logging** | `LogEndpoints` | Log streaming WebSocket, log file access |
| **JSON Contexts** | `AppJsonContext`, `GitHubReleaseContext`, `SecretsJsonContext`, `VersionManifestContext` | AOT-safe JSON serialization (see below) |

## Settings Model Pattern

Two settings classes exist for security reasons:

| Class | Location | Purpose |
|-------|----------|---------|
| `MidTermSettings` | `Settings/MidTermSettings.cs` | **Internal** - Full settings including secrets (`PasswordHash`, `SessionSecret`, `CertificatePassword`). Secrets are `[JsonIgnore]` so they're excluded from settings.json but included internally. |
| `MidTermSettingsPublic` | `Settings/MidTermSettingsPublic.cs` | **API** - Safe subset exposed to frontend. No sensitive fields. Used for `GET/PUT /api/settings`. |

**When adding a new setting:**

1. Add to `MidTermSettings.cs` with default value
2. If user-editable (not sensitive), also add to `MidTermSettingsPublic.cs`
3. Update `FromSettings()` to copy internal → public
4. Update `ApplyTo()` to copy public → internal (with validation if needed)
5. Add to `AppJsonContext` if it's a new type

## AOT JSON Serialization

**CRITICAL:** All types serialized via `System.Text.Json` must be registered in a source-generated context for Native AOT compatibility. Failing to do this causes runtime failures that only appear in AOT builds.

**When adding a new serializable type:**

```csharp
// In Services/AppJsonContext.cs, add a new [JsonSerializable] attribute:
[JsonSerializable(typeof(YourNewType))]
[JsonSerializable(typeof(List<YourNewType>))]  // If used in lists
public partial class AppJsonContext : JsonSerializerContext { }
```

**Other JSON contexts:**
- `GitHubReleaseContext` - GitHub API response types
- `SecretsJsonContext` - Secret storage serialization
- `SettingsJsonContext` - Settings file serialization
- `VersionManifestContext` - Version manifest files

**Red flags that indicate missing context:**
- Works in debug but fails in AOT publish
- `JsonException` mentioning "metadata" or "reflection"
- Serialization returns `{}`

## TypeScript Module Architecture

The `src/ts/modules/` folder uses feature-based organization. Each module is self-contained with its own index.ts barrel export.

| Module | Purpose |
|--------|---------|
| `auth/` | Login/logout, password change, auth status |
| `badges/` | Session badges (activity indicators) |
| `bootstrap/` | Initial data fetch combining multiple API calls |
| `chat/` | AI chat panel integration |
| `comms/` | WebSocket connections: `muxChannel.ts` (binary I/O), `stateChannel.ts` (session state), `settingsChannel.ts` (settings sync) |
| `diagnostics/` | Diagnostics panel for debugging |
| `fileViewer/` | In-terminal file preview |
| `history/` | Command history dropdown and API |
| `logging/` | Client-side logger with levels |
| `process/` | Foreground process monitoring |
| `settings/` | Settings panel UI, tabs, persistence |
| `sidebar/` | Session list, collapse/expand, drag reorder, network section |
| `terminal/` | xterm.js lifecycle, scaling, search, file drop, file links |
| `theming/` | Theme application and persistence |
| `touchController/` | Mobile touch bar, gestures, favorites |
| `updating/` | Update checking, changelog display, apply |
| `voice.ts`, `voiceTools.ts` | Voice input/output |
| `login.ts`, `trust.ts`, `tabTitle.ts` | Standalone page handlers |

**When adding new functionality:**

1. Check if an existing module handles that domain
2. If adding to existing module, export from its `index.ts`
3. If creating new module, add `index.ts` barrel and import in `main.ts`
4. Register any callbacks needed in `main.ts` `registerCallbacks()`

## API Endpoints

```
# Authentication
POST /api/auth/login              Login {password} → sets session cookie
POST /api/auth/logout             Clear session cookie
POST /api/auth/change-password    Change password {currentPassword, newPassword}
GET  /api/auth/status             Auth status {authenticationEnabled, passwordSet}

# Sessions
GET  /api/sessions                List all sessions
POST /api/sessions                Create session {cols, rows, shellType?, workingDirectory?}
DELETE /api/sessions/{id}         Close session
POST /api/sessions/{id}/resize    Resize {cols, rows}
PUT  /api/sessions/{id}/name      Rename {name}

# System
GET  /api/shells                  Available shells for platform
GET  /api/settings                Current settings
PUT  /api/settings                Update settings
GET  /api/version                 Server version string
GET  /api/health                  Health check
GET  /api/update/check            Check for updates
POST /api/update/apply            Download update and restart
```

## WebSocket Endpoints

- `/ws/mux` — Multiplexed terminal I/O (binary protocol)
- `/ws/state` — Session state changes (JSON, for sidebar sync)

## Mux Protocol & Priority Buffering

The `/ws/mux` endpoint uses a binary protocol for efficient terminal I/O multiplexing.

**Frame format:** `[1 byte type][8 byte sessionId][payload]`

**Message types:**
- `0x01` Output (server→client)
- `0x02` Input (client→server)
- `0x03` Resize (client→server)
- `0x05` Resync (server→client)
- `0x06` BufferRequest (client→server)
- `0x07` CompressedOutput (server→client, GZip)
- `0x08` ActiveSessionHint (client→server)

**Priority buffering** (`MuxClient.cs`):
- Active session: frames sent immediately
- Background sessions: batched until 2KB or 2s elapsed, then sent as compressed frame
- Timer-free design: single async loop with `Channel.WaitToReadAsync(500ms timeout)`
- Client sends `ActiveSessionHint` on tab switch and WS connect

## Authentication

- **PBKDF2** password hashing (100K iterations, SHA256, 32-byte salt)
- **HMAC-SHA256** session tokens (format: `timestamp:signature`)
- **3-day** session validity with sliding window (fresh token on each request)
- **Rate limiting**: 5 failures = 30s lockout, 10 failures = 5min lockout
- Password set during install (mandatory), changeable in Settings > Security

## Terminal Resize

- **No auto-resize** — terminals maintain their dimensions
- **New sessions** created at optimal size for current screen
- **Manual resize** via sidebar button (⤢) fits terminal to current screen
- Each terminal has independent dimensions

## Code Style (C#)

- **Braces:** Allman (opening brace on new line)
- **Indent:** 4 spaces
- **Private fields:** `_camelCase`
- **Async methods:** `Async` suffix
- **Access modifiers:** Always explicit
- **Namespaces:** File-scoped (`namespace Foo;`)
- **Null checks:** `is null` / `is not null`
- **Comments:** Minimal, only for complex logic

## Code Style (TypeScript)

When working with TypeScript files in `src/ts/`:

- **Braces:** K&R / One True Brace Style (opening brace on same line)
- **Indent:** 2 spaces (industry standard for TS/JS)
- **Semicolons:** Required
- **Quotes:** Single quotes for strings
- **Naming:**
  - `camelCase` for variables, functions, parameters
  - `PascalCase` for types, interfaces, classes
  - `SCREAMING_SNAKE_CASE` for constants
  - No underscore prefix for private (use TypeScript `private` keyword)
- **Types:** Always explicit return types on exported functions
- **Null handling:** Use `strictNullChecks`, prefer `undefined` over `null`
- **Comments:** JSDoc for exported functions, module header comment required

Example:
```typescript
/**
 * Terminal Manager Module
 *
 * Handles xterm.js terminal lifecycle, creation, destruction,
 * and event binding for terminal sessions.
 */

import type { TerminalState, Session } from '../types';
import { $activeSessionId, getSession, setSession } from '../stores';
import { state } from '../state';

const MAX_SCROLLBACK = 10000;

export function createTerminal(sessionId: string, session: Session): TerminalState {
  // Implementation
}
```

## Frontend State Management

The frontend uses [nanostores](https://github.com/nanostores/nanostores) (~1KB) for reactive state and `state.ts` for ephemeral infrastructure.

**Nanostores (`stores/index.ts`)** - Reactive UI and session state:
- `$sessions` (map) - All sessions keyed by ID
- `$activeSessionId` (atom) - Currently selected session
- `$sessionList` (computed) - Sessions sorted by `_order`
- `$connectionStatus` (computed) - 'connected' | 'disconnected' | 'reconnecting'
- UI flags: `$settingsOpen`, `$sidebarOpen`, `$sidebarCollapsed`

**Ephemeral state (`state.ts`)** - Non-reactive infrastructure:
- WebSocket instances, DOM element cache, timers, pending frame buffers

**Usage pattern:**
```typescript
import { $activeSessionId, getSession } from '../stores';

const id = $activeSessionId.get();      // Read
$activeSessionId.set(newId);            // Write
// Computed stores update automatically
```

**Naming:** Dollar prefix (`$storeName`) for all stores.

## Platform-Specific

| Platform | PTY | Shells | Default |
|----------|-----|--------|---------|
| Windows | ConPTY (via mthost) | Pwsh, PowerShell, Cmd | Pwsh |
| macOS | forkpty (via mthost) | Zsh, Bash | Zsh |
| Linux | forkpty (via mthost) | Bash, Zsh | Bash |

## Branch Strategy & Release Process

### ⚠️ MANDATORY WORKFLOW - DO NOT DEVIATE ⚠️

**ALL development happens on the `dev` branch. The `main` branch is for stable releases ONLY.**

```
dev (default branch - all work here)
  ↓ (PR merge when ready to release)
main (stable releases only - never commit directly)
```

**If the user tries to:**
- Commit directly to `main` → **DECLINE.** Explain they must work on `dev` and promote via PR.
- Run `release.ps1` on `dev` → **DECLINE.** Explain they should use `release-dev.ps1` for dev releases.
- Run `release-dev.ps1` on `main` → **DECLINE.** Explain `main` only gets stable releases via promotion.
- Push changes to `main` without a PR → **DECLINE.** All changes to `main` come through PR merges from `dev`.

### Daily Development (on `dev` branch)

```powershell
# 1. Make changes on dev branch
git checkout dev
# ... code changes ...
git commit -m "Add feature X"
git push

# 2. Create dev/prerelease for testing
.\scripts\release-dev.ps1 -Bump patch `
    -ReleaseTitle "Test feature X" `
    -ReleaseNotes @("Added feature X for testing") `
    -mthostUpdate no
# Creates: v6.10.32-dev (prerelease on GitHub)
```

### Promoting to Stable Release

When dev is tested and ready for stable release:

```powershell
# 1. Create PR on GitHub: dev → main
# 2. Review and merge the PR
# 3. Locally:
git checkout main
git pull

# 4. Create stable release
.\scripts\release.ps1 -Bump patch `
    -ReleaseTitle "Feature X" `
    -ReleaseNotes @("Added feature X") `
    -mthostUpdate no
# Creates: v6.10.30 (full release on GitHub)
```

### Update Channels

Users can choose which releases to receive via `settings.json`:

| Channel | Setting | Receives |
|---------|---------|----------|
| Stable (default) | `"updateChannel": "stable"` | Only full releases (v6.10.32) |
| Dev | `"updateChannel": "dev"` | Prereleases + full releases (v6.10.32-dev) |

### Release Script Parameters

Both scripts share the same parameters:
- `-Bump`: `major`, `minor`, or `patch`
- `-ReleaseTitle`: One-line headline (NO version number)
- `-ReleaseNotes`: MANDATORY array of detailed changelog entries
- `-mthostUpdate`: `yes` if TtyHost/Common/protocol changed, `no` for web-only

**Good ReleaseNotes:**
- "Fixed bug where settings panel would close when checking for updates"
- "Complete rewrite of update script with 6-phase process and automatic rollback"

**Bad ReleaseNotes:**
- "Fix bug" (too vague)
- "Update UI" (what specifically?)

With `-mthostUpdate no`: Only mt version bumped, terminals survive update.
With `-mthostUpdate yes`: Both mt and mthost bumped, terminals restart.

## Install System

**Scripts:** `install.ps1` (Windows), `install.sh` (macOS/Linux)

**Flow:**
1. Choose system service or user install
2. Set password (mandatory, with security disclaimer)
3. Download and extract binaries
4. Write settings with password hash
5. Register service (if system install)

**Password preservation:** Install scripts check for existing `passwordHash` in settings and preserve it during updates.

## ⚠️ Version Management - DO NOT CHANGE ⚠️

**version.json is the single source of truth for all version numbers.**

Both csproj files read their versions dynamically at build time via MSBuild targets:
- `Ai.Tlbx.MidTerm.csproj` reads `web` → `$(WebVersion)`
- `Ai.Tlbx.MidTerm.TtyHost.csproj` reads `pty` → `$(PtyVersion)`

**DO NOT:**
- Add hardcoded `<Version>X.Y.Z</Version>` to csproj files
- Pass `-p:Version` to dotnet build/publish commands
- Update csproj files in release scripts

**Release scripts only update version.json** - the csproj files pick up the new version automatically on next build.

This architecture exists because hardcoded versions caused update failures where the wrong version was baked into binaries.

## Important Rules

- **Branch workflow is mandatory:** All work on `dev`, promote to `main` via PR only
- Never `dotnet run` without user permission
- Never `Task.Run` unless explicitly asked for threading
- Aim for 0 build warnings
- Use interfaces + DI, not static classes
- Platform checks: `OperatingSystem.IsWindows()`, `.IsLinux()`, `.IsMacOS()`
- All JSON serialization must use source-generated `AppJsonContext` for AOT safety

## Marketing Video Workflow

Location: `docs/marketing/`

**Goal:** Create short meme videos for social media (10/day target).

### The Flow

1. **Pick idea** from `ideas.md`
2. **Write story** (2-3 scenes with start/end/transition descriptions)
3. **Generate clips** with `create_clip.py`
4. **Chain clips** with `chain_clips.py`
5. **Draft tweet** text
6. **Post manually** (API too expensive)

### Quick Commands

```bash
cd docs/marketing

# Generate a single clip from JSON config
python create_clip.py scene1.json

# Generate clip from command line args
python create_clip.py --clip-id test001 \
    --start "Dev at desk, frustrated" \
    --end "Dev smiling with phone" \
    --transition "picks up phone, relief washes over" \
    --aspect 9:16 --duration 4

# Chain 2-3 clips into final video
python chain_clips.py output/scene1 output/scene2 output/scene3 -o output/final.mp4

# With crossfade transitions
python chain_clips.py output/scene1 output/scene2 --crossfade 0.5 -o output/final.mp4
```

### Environment Setup

```powershell
$env:VERTEX_AI_PROJECT_ID = "your-project-id"
$env:VERTEX_AI_SERVICE_ACCOUNT_JSON = "C:\path\to\service-account.json"
```

### Story Format

Each idea needs 2-3 scenes. Each scene has:
- **Start prompt:** Visual description of opening frame
- **End prompt:** Visual description of ending frame
- **Transition prompt:** Description of motion between frames

Keep character descriptions consistent across scenes for visual continuity.

### Aspect Ratios

- `9:16` — TikTok, Instagram Reels, YouTube Shorts (vertical, default)
- `16:9` — YouTube, LinkedIn (horizontal)
- `1:1` — Twitter, Instagram feed (square)

### Cost Per Video

~$0.72 (6 images + 3 video clips) = ~$7/day for 10 videos

### Files

- `ideas.md` — Idea tracker with status and story templates
- `create_clip.py` — Single clip generator (Vertex AI)
- `chain_clips.py` — FFmpeg clip merger
- `features.md`, `features_usecases.md`, `why.md` — Content source material
- `meme-spots.md` — Meme format ideas
