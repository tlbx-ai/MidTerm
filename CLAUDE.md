# CLAUDE.md

Guidance for Claude Code when working with this repository.

## What This Is

MidTerm is a web-based terminal multiplexer. Native AOT compiled, runs on macOS/Windows/Linux. Serves terminal sessions via browser at `http://localhost:2000`.

**Binaries:**
- `mt` / `mt.exe` — Web server (UI, REST API, WebSockets)
- `mthost` / `mthost.exe` — TTY host (spawned per terminal, all platforms)

**Default port:** 2000

**Settings locations:**
- Service mode: `%ProgramData%\MidTerm\settings.json` (Win) or `/usr/local/etc/MidTerm/settings.json` (Unix)
- User mode: `~/.MidTerm/settings.json`

## Build Commands

```bash
# Build web server
dotnet build Ai.Tlbx.MidTerm/Ai.Tlbx.MidTerm.csproj

# Test
dotnet test Ai.Tlbx.MidTerm.Tests/Ai.Tlbx.MidTerm.Tests.csproj

# AOT publish (platform-specific)
Ai.Tlbx.MidTerm/build-aot.cmd        # Windows
./Ai.Tlbx.MidTerm/build-aot-linux.sh # Linux
./Ai.Tlbx.MidTerm/build-aot-macos.sh # macOS
```

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
Ai.Tlbx.MidTerm/              Web Server (mt.exe)
├── Program.cs                      Entry point, API endpoints, auth middleware
├── Services/
│   ├── AuthService.cs              Password hashing (PBKDF2), session tokens
│   ├── SessionManager.cs           Terminal session lifecycle
│   ├── UpdateService.cs            GitHub release check, version comparison
│   ├── SettingsService.cs          Settings persistence
│   └── AppJsonContext.cs           AOT-safe JSON serialization
├── Settings/
│   └── MidTermSettings.cs    Settings model (auth, defaults, appearance)
├── src/ts/                         TypeScript source (compiled by esbuild)
│   ├── main.ts                     Entry point, initialization
│   ├── types.ts                    Shared interfaces and types
│   ├── constants.ts                Protocol constants, themes
│   ├── state.ts                    Application state management
│   ├── modules/
│   │   ├── comms/                  WebSocket communication
│   │   ├── terminal/               xterm.js lifecycle and scaling
│   │   ├── sidebar/                Session list and collapse
│   │   ├── settings/               Settings panel and persistence
│   │   ├── auth/                   Authentication and password modal
│   │   ├── theming/                Theme definitions
│   │   └── updating/               Update checker and changelog
│   └── utils/                      DOM helpers, cookies, debounce
└── wwwroot/                        Static files (embedded)
    ├── index.html                  Main UI
    ├── login.html                  Login page
    ├── js/terminal.min.js          Compiled TypeScript (generated)
    └── css/app.css                 Styles

Ai.Tlbx.MidTerm.TtyHost/      TTY Host (all platforms)
├── Program.cs                      Spawned per terminal, hosts PTY session
└── Pty/
    └── IPtyConnection.cs           Cross-platform PTY abstraction
```

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

## Authentication

- **PBKDF2** password hashing (100K iterations, SHA256, 32-byte salt)
- **HMAC-SHA256** session tokens (format: `timestamp:signature`)
- **3-week** session validity with sliding expiration
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
import { state } from '../state';

const MAX_SCROLLBACK = 10000;

export function createTerminal(sessionId: string, session: Session): TerminalState {
  // Implementation
}
```

## Platform-Specific

| Platform | PTY | Shells | Default |
|----------|-----|--------|---------|
| Windows | ConPTY (via mthost) | Pwsh, PowerShell, Cmd | Pwsh |
| macOS | forkpty (via mthost) | Zsh, Bash | Zsh |
| Linux | forkpty (via mthost) | Bash, Zsh | Bash |

## Release Process

```powershell
.\release.ps1 -Bump patch -Message "Fix bug"
.\release.ps1 -Bump minor -Message "Add feature"
.\release.ps1 -Bump major -Message "Breaking change"

# Add -PtyBreaking when mthost changes are included (terminals restart on update)
.\release.ps1 -Bump patch -Message "Fix PTY issue" -PtyBreaking
```

Without `-PtyBreaking`, only the web version is bumped (terminals survive the update). With `-PtyBreaking`, both web and pty versions are bumped together.

## Install System

**Scripts:** `install.ps1` (Windows), `install.sh` (macOS/Linux)

**Flow:**
1. Choose system service or user install
2. Set password (mandatory, with security disclaimer)
3. Download and extract binaries
4. Write settings with password hash
5. Register service (if system install)

**Password preservation:** Install scripts check for existing `passwordHash` in settings and preserve it during updates.

## Important Rules

- Never `dotnet run` without user permission
- Never `Task.Run` unless explicitly asked for threading
- Aim for 0 build warnings
- Use interfaces + DI, not static classes
- Platform checks: `OperatingSystem.IsWindows()`, `.IsLinux()`, `.IsMacOS()`
- All JSON serialization must use source-generated `AppJsonContext` for AOT safety
