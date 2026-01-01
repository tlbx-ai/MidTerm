# CLAUDE.md

Guidance for Claude Code when working with this repository.

## What This Is

MiddleManager is a web-based terminal multiplexer. Native AOT compiled, runs on macOS/Windows/Linux. Serves terminal sessions via browser at `http://localhost:2000`.

**Binaries:**
- `mm` / `mm.exe` — Web server (UI, REST API, WebSockets)
- `mm-con-host` / `mm-con-host.exe` — ConPTY host (Windows only, spawned per terminal)

**Default port:** 2000

**Settings locations:**
- Service mode: `%ProgramData%\MiddleManager\settings.json` (Win) or `/usr/local/etc/middlemanager/settings.json` (Unix)
- User mode: `~/.middlemanager/settings.json`

## Build Commands

```bash
# Build web server
dotnet build Ai.Tlbx.MiddleManager/Ai.Tlbx.MiddleManager.csproj

# Test
dotnet test Ai.Tlbx.MiddleManager.Tests/Ai.Tlbx.MiddleManager.Tests.csproj

# AOT publish (platform-specific)
Ai.Tlbx.MiddleManager/build-aot.cmd        # Windows
./Ai.Tlbx.MiddleManager/build-aot-linux.sh # Linux
./Ai.Tlbx.MiddleManager/build-aot-macos.sh # macOS
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  mm.exe (Web Server + Session Manager)                      │
│  ├─ Kestrel HTTP server (REST API, static files)            │
│  ├─ WebSocket handlers (/ws/mux, /ws/state)                 │
│  ├─ SessionManager (terminal lifecycle)                     │
│  ├─ AuthService (password auth, session cookies)            │
│  └─ UpdateService (GitHub release check)                    │
└─────────────────────────────────────────────────────────────┘
           │
           │ Windows: spawns mm-con-host.exe per terminal
           │ Unix: direct forkpty()
           ▼
┌─────────────────────────────────────────────────────────────┐
│  Terminal Sessions                                          │
│  └─ Shell processes (pwsh, bash, zsh, cmd)                  │
└─────────────────────────────────────────────────────────────┘
```

## Project Structure

```
Ai.Tlbx.MiddleManager/              Web Server (mm.exe)
├── Program.cs                      Entry point, API endpoints, auth middleware
├── Services/
│   ├── AuthService.cs              Password hashing (PBKDF2), session tokens
│   ├── SessionManager.cs           Terminal session lifecycle
│   ├── UpdateService.cs            GitHub release check, version comparison
│   ├── SettingsService.cs          Settings persistence
│   └── AppJsonContext.cs           AOT-safe JSON serialization
├── Settings/
│   └── MiddleManagerSettings.cs    Settings model (auth, defaults, appearance)
└── wwwroot/                        Static files (embedded)
    ├── index.html                  Main UI
    ├── login.html                  Login page
    ├── js/terminal.js              Terminal logic, auth handling
    └── css/app.css                 Styles

Ai.Tlbx.MiddleManager.ConHost/      ConPTY Host (Windows only)
├── Program.cs                      Spawned per terminal for correct ConPTY context
└── Services/
    └── ConHostSession.cs           PTY wrapper
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

## Code Style

- **Braces:** Allman (opening brace on new line)
- **Indent:** 4 spaces
- **Private fields:** `_camelCase`
- **Async methods:** `Async` suffix
- **Access modifiers:** Always explicit
- **Namespaces:** File-scoped (`namespace Foo;`)
- **Null checks:** `is null` / `is not null`
- **Comments:** Minimal, only for complex logic

## Platform-Specific

| Platform | PTY | Shells | Default |
|----------|-----|--------|---------|
| Windows | ConPTY (via mm-con-host) | Pwsh, PowerShell, Cmd | Pwsh |
| macOS | forkpty() libSystem | Zsh, Bash | Zsh |
| Linux | forkpty() libc | Bash, Zsh | Bash |

## Release Process

```powershell
.\release.ps1 -Bump patch -Message "Fix bug"
.\release.ps1 -Bump minor -Message "Add feature"
.\release.ps1 -Bump major -Message "Breaking change"
```

The script bumps version in all csproj files and version.json, commits, tags, and pushes. GitHub Actions builds releases for all platforms.

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
