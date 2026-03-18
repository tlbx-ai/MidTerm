# Architecture

MidTerm is a web-based terminal workspace built around a native server (`mt`), a per-session PTY host (`mthost`), and a browser frontend that adds layout, files, git, commands, web preview, mobile controls, and operations UI around live terminal sessions.

The important architectural point is that MidTerm is not only a terminal renderer. The browser shell coordinates multiple long-lived sessions, several WebSocket channels, local settings and storage, browser preview bridges, session sharing, and an installer/update pipeline that has to keep real user installs recoverable.

## Runtime Topology

```text
Browser
├─ xterm.js terminals
├─ sidebar, layout engine, files/git/commands panels
├─ smart input, touch/mobile shell, diagnostics
├─ web preview iframe or detached preview window
├─ /ws/mux       binary terminal I/O
├─ /ws/state     JSON session/update state
├─ /ws/settings  JSON settings sync
└─ REST APIs for auth, sessions, files, preview, updates, logs
            │
            ▼
mt / mt.exe
├─ Kestrel HTTP + WebSocket host
├─ Session lifecycle + mux fanout
├─ settings, auth, share, cert, update, diagnostics services
├─ embedded static assets
└─ web preview proxy + browser bridge coordination
            │
            ▼
mthost / mthost.exe (one per session)
└─ PTY host for ConPTY on Windows or forkpty on Unix
```

## 1. Runtime Model

### `mt`

`mt` is the long-lived server process. It owns:

- HTTP endpoints, authentication, and static file serving
- the terminal session registry and lifecycle
- mux fanout for terminal output and client input
- settings persistence and settings WebSocket sync
- updates, logs, diagnostics, certificate lifecycle, and share-link services
- the web preview reverse proxy and preview/browser bridge routing

The server is compiled with Native AOT, uses source-generated JSON serialization, and keeps platform-specific behavior explicit rather than reflection-driven.

### `mthost`

Each terminal session runs in its own `mthost` process. That gives MidTerm:

- crash isolation between sessions
- a clean privilege boundary between the web server and the PTY process
- platform-specific PTY handling without pulling terminal lifecycle into the web host
- the ability to restart or replace the web server separately from terminal hosts in web-only update flows

### Static Assets

Production assets are precompressed and embedded into the server assembly. MidTerm serves its frontend from memory instead of relying on a mutable on-disk web root.

## 2. Frontend Composition

MidTerm's frontend is vanilla TypeScript organized by feature modules rather than a component framework. `main.ts` wires the subsystems together at startup.

The browser shell includes:

- sidebar modules for sessions, history, update notices, network/share, and voice controls
- terminal modules for creation, sizing, search, paste/drop handling, scaling, and mobile PiP
- layout modules for split panes and dock overlays
- session wrappers that add Files tabs plus web, commands, share, and git actions per session
- feature panels for files, git, commands, and web preview
- manager bar, smart input, chat, touch controller, PWA, and diagnostics modules

State is split between:

- **nanostores** for reactive shared state such as sessions, active session, settings, layout, and process metadata
- **module-local state** for ephemeral UI concerns such as DOM handles, timers, drag state, preview clients, and pending buffers

That split keeps high-frequency terminal paths imperative while still allowing the rest of the UI to react to shared state changes.

## 3. Session and Terminal Pipeline

### Session Lifecycle

Session creation, deletion, reordering, naming, bookmarking, sharing, and resize requests go through the server APIs and state WebSocket updates. The frontend renders the session list from live state instead of polling.

### Mux Channel

`/ws/mux` carries multiplexed binary terminal traffic for every visible session. The server prioritizes the active session and can batch and compress background output.

Relevant frame families include:

- output
- input
- resize
- resync
- compressed background output
- active-session hint
- foreground-process change
- data-loss notification

### Foreground Process and Session Metadata

MidTerm tracks foreground cwd, process, command line, and terminal title. That data feeds:

- session naming fallbacks
- per-session cwd display in the session bar
- tab-title modes
- history/bookmark labeling
- session heat and activity presentation

### Terminal Resize Principle

MidTerm intentionally does **not** auto-resize existing sessions just because another client connected or a page reloaded.

The model is:

1. New sessions are created at the best size for the creating viewport.
2. Existing sessions keep their server-side dimensions.
3. Secondary browsers CSS-scale terminals locally instead of sending resize commands.
4. Users explicitly claim a new size with a manual fit action when they want one.

This is what makes multi-device usage predictable instead of having one client constantly break another client's layout.

### Terminal UX Layer

Around the raw PTY stream, MidTerm adds:

- font preloading and calibration terminals
- WebGL-backed rendering when enabled
- search UI with keyboard navigation
- copy/paste and OSC52 clipboard support
- image paste and file-drop handling
- File Radar path detection with a per-session allowlist boundary
- scrollback protection and visibility-aware focus handling

## 4. Workspace Surfaces Around the Terminal

### Sidebar and Layout

The sidebar is a full control surface, not just a tab strip. It handles:

- create/settings/history entry points
- session rename, close, bookmark, inject-guidance, and undock actions
- session ordering and drag-to-layout docking
- update notices, voice controls, network/share helpers, and footer telemetry
- mobile open/close behavior and desktop collapse/resize persistence

The layout subsystem stores split trees in browser storage and reattaches sessions into panes without resizing them behind the user's back.

### Files, Git, and Commands

Each session wrapper adds:

- a Files tab with a cwd-rooted tree, previews, syntax-highlighted text viewing, and inline save
- git status summaries with sectioned file lists, hierarchical trees, and diff overlays
- a commands panel for saved scripts that run in hidden backing sessions

### Manager Bar

The manager bar is a user-defined quick-action bar below the terminal area. Buttons are stored in settings and send prebuilt text plus Enter to the active session. The same actions are exposed in the mobile action menu.

### Smart Input, Voice, Touch, and Mobile Shell

MidTerm has a second input model in addition to direct terminal focus:

- Smart Input can replace or complement terminal typing
- voice capture and chat hooks connect to MidTerm.Voice
- the touch controller provides terminal-friendly virtual keys
- the mobile action menu exposes common terminal operations
- document Picture-in-Picture can show a miniature live terminal when the app backgrounds on supported mobile browsers

## 5. Web Preview and Browser Automation

Web preview is its own subsystem, not a simple iframe wrapper.

### Preview Model

Each terminal session can own multiple named previews. Every named preview keeps separate:

- target URL
- proxy route key
- cookie jar
- detached/docked state
- proxy log
- browser bridge client identity

Previews can be hidden, docked beside the terminal, or detached into a dedicated popup window.

### Reverse Proxy

The preview proxy rewrites outgoing browser-side requests so the embedded app stays inside `/webpreview/{routeKey}/...`. The injected runtime handles:

- `fetch`
- XHR
- WebSocket and `EventSource`
- history mutations
- DOM `src` / `href` / `action` writes

HTTP and HTML handling are separate from WebSocket relay. HTTP responses may be rewritten or augmented; WebSocket payloads are intentionally relayed without content rewriting.

### Browser Bridge

MidTerm also exposes browser-control APIs and CLI helpers for the current preview client. That bridge is preview-scoped, not global, so browser actions target the intended session and preview.

Available operations include:

- open, dock, detach, and viewport changes
- DOM query/click/fill/submit
- script execution and wait operations
- screenshot, snapshot, outline, attrs, CSS, forms, links, and proxy-log flows

For deeper implementation detail, see [devbrowser.md](devbrowser.md).

## 6. Settings, Data Model, and Storage

### Public vs Internal Settings

MidTerm uses two settings models:

- `MidTermSettings` for internal state, including secrets and platform-only details
- `MidTermSettingsPublic` for the API-safe subset exposed to the browser

That separation prevents accidental secret exposure even if serialization or endpoint code changes.

### Settings Transport

Settings are:

- loaded from disk on the server
- served to clients during bootstrap
- edited through the settings API
- synchronized live over `/ws/settings`

The frontend settings registry defines editability, apply mode, control ownership, and special writers such as background-image upload/delete flows.

### Storage Boundaries

MidTerm uses a mix of server-side and browser-side storage:

| Area | Storage |
| --- | --- |
| Server settings | `settings.json` |
| Secrets | platform-specific secret storage |
| Certificates and keys | settings directory plus protected key storage |
| History and share data | server-side files/services |
| Split layout | browser `localStorage` |
| Sidebar width/collapse | cookies |
| Smart Input/chat/touch prefs | browser `localStorage` |
| Preview snapshots | `.midterm/snapshot_*` under the working tree |

## 7. Security and Remote Access

MidTerm assumes that anyone who reaches the UI could gain shell access, so the design layers multiple controls.

### Authentication

- PBKDF2-SHA256 password hashing
- fixed-time comparison for secrets
- signed session cookies
- rate limiting on failed logins
- session invalidation on password changes

### Secret Storage

| Platform | Secret storage |
| --- | --- |
| Windows | DPAPI-backed `secrets.bin` |
| macOS user mode | Keychain-backed storage |
| macOS service mode / Linux | file-backed secret storage with restricted permissions |

### Certificates

MidTerm generates and manages a local HTTPS certificate, exposes trust helpers in the UI, and can download platform-friendly trust artifacts such as PEM output and Apple `mobileconfig` profiles.

### Additional Security Surfaces

MidTerm also includes:

- API-key management
- run-as-user support for service installs
- Windows firewall helpers
- single-session share grants with expiry and scoped access modes
- shared-session UI reduction so the recipient only sees the granted terminal context

## 8. Install and Update Pipeline

MidTerm treats installer and self-update reliability as part of the architecture, not an afterthought.

### Installers

The root `install.ps1` and `install.sh` scripts handle:

- service mode versus user mode decisions
- password setup, preservation, and intentional replacement during reinstall
- certificate reuse or trust flows
- platform-specific install paths and service registration
- channel selection and release download
- update logging

### Update Service

The update service reads `version.json`, checks GitHub releases, compares protocol/web/PTY versions, and classifies releases as:

- **web-only** when only the web server/UI needs replacement
- **full** when PTY compatibility or protocol changes require replacing `mthost` too

### Generated Update Scripts

The update-script generator produces non-interactive scripts that:

- stop services and running processes
- wait for file handles to release
- create backups of binaries, settings, secrets, and certificates
- copy and verify replacement files
- write logs and a structured result file
- roll back if replacement or restart fails

That is how MidTerm can update installed systems without asking users to manually babysit file replacement.

## 9. Protocols and APIs

### WebSockets

| Endpoint | Purpose |
| --- | --- |
| `/ws/mux` | Binary multiplexed terminal I/O |
| `/ws/state` | Session list, update state, and related JSON state pushes |
| `/ws/settings` | Live settings synchronization |

### HTTP API Groups

Major API areas include:

- auth and password management
- bootstrap and system info
- sessions, resize, names, bookmarks, clipboard image paste, guidance injection
- files, tree browsing, viewing, and save
- git and commands panels
- certificates, trust assets, and share packets
- share grants and shared-session bootstrap
- browser preview and browser-control commands
- update check/apply/result/log
- diagnostics, logs, restart, and shutdown

MidTerm's API surface is large because the browser shell is a real workstation shell, not only a terminal transport.

## 10. Diagnostics and Operations

The diagnostics layer exposes:

- server RTT
- `mthost` RTT
- output latency
- latency and git debug overlays
- settings, secrets, certificate, and log paths
- settings reload and server restart actions
- frontend logging helpers

Operationally, MidTerm also tracks update results, log files, session ordering, and preview proxy logs so users can debug the product from inside the product.

## Related Documents

- [FEATURES.md](FEATURES.md) for the exhaustive capability inventory
- [devbrowser.md](devbrowser.md) for preview proxy and browser-control internals
- [file-radar.md](file-radar.md) for path detection design
