# MidTerm Features

Current feature set as of `v9.8.2`.

This page is the high-detail marketing and product feature brief. The exhaustive engineering inventory remains in `docs/FEATURES.md`; this page explains the product in terms a user, buyer, reviewer, or launch partner can evaluate quickly.

## Core Value Proposition

**Your real terminal workspace, available from any browser.**

MidTerm runs on your own machine as a small self-hosted web terminal workspace. It keeps your shells, AI coding agents, web previews, local files, git state, and long-running tasks close to the machine that actually owns the work, while making that workspace reachable from desktop, laptop, tablet, or phone through HTTPS and WebSockets.

| Problem | MidTerm answer |
| --- | --- |
| SSH is blocked, awkward on mobile, or hard to expose safely | Browser-based HTTPS access with built-in authentication, TLS, and optional service install |
| AI coding agents run for a long time and need supervision | Persistent terminal sessions, activity indicators, session notes, Command Bay input, browser previews, and agent-oriented Agent Controller Session work |
| Local dev servers need visual validation | Session-scoped web previews with named browser contexts, proxying, DOM inspection, screenshots, logs, and automation helpers |
| Cloud terminals move API keys and source context away from your machine | MidTerm stays local; your shells, credentials, repos, and hardware stay under your control |
| Terminal workflows sprawl across tmux, browser tabs, editors, git tools, and scripts | One browser workspace combines terminal panes, files, git inspection, command runners, previews, diagnostics, and mobile controls |

## Product Shape

MidTerm is not just a terminal-in-a-tab. The current product is a browser terminal workspace with these major surfaces:

- **Terminal workspace:** multiple persistent sessions, split layouts, manual terminal sizing, activity heat, terminal search, paste/upload flows, and cross-device viewing.
- **Sidebar:** session list, quick session creation, session notes, process/cwd detail, drag reorder, layout docking, update cards, network/share information, and mobile navigation.
- **Per-session work area:** Terminal, Files, Git, Commands, web preview, sharing, and agent-oriented surfaces bound to the active session.
- **Command Bay / Automation Bar:** an adaptive footer input and quick-action area for sending text, running saved actions, attaching files, voice/touch entry, and Agent Controller Session composition.
- **Web preview:** isolated named browser contexts per session with reverse proxying, detached/docked views, viewport overrides, screenshots, DOM tools, proxy logs, and automation.
- **Settings and operations:** appearance, behavior, update channel, security, certificates, diagnostics, API keys, logs, and restart/shutdown controls.

## Platform, Install, And Update

| Feature | Details |
| --- | --- |
| Native AOT server | MidTerm ships as a self-contained .NET Native AOT web server with embedded frontend assets. |
| Separate PTY host | Terminal processes are hosted outside the web server process through `mthost`, which keeps the server boundary cleaner and supports host updates when needed. |
| Cross-platform builds | Windows x64, macOS x64/arm64, Linux x64/arm64, with release assets selected by installer scripts. |
| User or service install | User-mode install avoids admin/sudo; service install provides always-on access and can start with the machine. |
| Required password | Installers require an access password. Reinstall/update flows preserve it unless the operator explicitly changes it. |
| Built-in HTTPS | MidTerm can generate and manage a local TLS certificate with localhost, host name, and discovered IP subject names. |
| Certificate trust helpers | The UI and installers expose trust guidance, PEM download, and Apple mobileconfig output where relevant. |
| Stable and dev channels | Update checks use GitHub releases and can track stable releases or dev builds. |
| Web-only updates | Web/frontend-only updates can preserve running terminal sessions. |
| Full host updates | Protocol or host changes can update the server plus `mthost`/`mtagenthost` binaries. |
| Update safety | Generated scripts back up binaries, settings, secrets, and certificates, write logs/results, and support rollback paths. |
| Release diagnostics | Settings and diagnostics expose version, environment, code-signing, log, and update status information. |

## Security And Access Control

| Feature | Details |
| --- | --- |
| Password authentication | Browser access is protected by password login. |
| PBKDF2 password hashes | Passwords use PBKDF2-SHA256 with fixed-time verification and per-install secret material. |
| Signed sessions | Browser sessions use signed HMAC cookies with expiration and invalidation on password change. |
| Login rate limits | Repeated failed login attempts are throttled. |
| Secret storage | Secrets live outside the public settings model; Windows uses DPAPI-backed storage, macOS can use Keychain, and Unix stores restricted files. |
| API keys | Operators can mint, mask, and revoke named API keys for scripted control. |
| Session sharing | A scoped terminal share link can grant read-only or writable access without exposing the whole workspace. |
| Firewall support | Windows service installs can surface and manage firewall rule status. |
| Local-first model | MidTerm does not require a hosted control plane for normal operation. |

## Terminal Workspace

| Feature | Details |
| --- | --- |
| Multiple sessions | One browser UI manages many live terminal sessions over a multiplexed WebSocket. |
| Shell defaults | MidTerm chooses platform-appropriate defaults: PowerShell on Windows, zsh on macOS, bash on Linux. |
| Manual size ownership | Existing sessions keep their server-side rows/columns until a user explicitly resizes them. Secondary clients scale visually instead of taking terminal-size authority. |
| Split layouts | Sessions can be docked into left/right/up/down panes, swapped, focused, restored, and undocked. |
| Persistent layout state | Split layout trees and session membership persist in backend state and survive reconnects. |
| Terminal search | Search supports next/previous navigation, result counts, Enter/Shift+Enter navigation, and Escape close. |
| Scrollback | Scrollback is configurable and protected by optional runaway-redraw safeguards. |
| Clipboard | Copy-on-select, right-click paste, platform-aware shortcuts, sanitized paste, OSC52 clipboard writes, and insecure-context paste handling are supported. |
| File drops and image paste | Drag-and-drop uploads, image clipboard paste, camera capture paths, and binary/document/archive rejection protect terminal input flows. |
| File Radar | Terminal output can be scanned for file paths and open those files in MidTerm viewers inside the session boundary. |
| Multi-client awareness | Active-session hints, activity bytes, background buffering, gzip compression, and data-loss frames make reconnects and background sessions observable. |

## App Chrome, Sidebar, And Session Management

| Feature | Details |
| --- | --- |
| Session creation | The sidebar creates new terminals and shows pending creation state. |
| Rich session rows | Rows can show custom name, terminal title fallback, cwd/process details, activity heat, layout badges, tmux-child styling, and mobile/collapsed variants. |
| Session notes | Recent `v9.6.x` work added and refined a sidebar scratchpad for per-session notes, including focus fixes and transparent styling. |
| Session actions | Rename, inject guidance, close, undock, share, git, commands, and preview actions are exposed where relevant. |
| Drag reorder | Desktop and touch users can reorder sessions, with visual drag state and persistence. |
| Drag docking | Dragging sessions into the workspace can dock them into split layouts while suppressing file-drop overlays during the move. |
| History and bookmarks | A dropdown separates pinned entries from recent entries, supports launching sessions from saved shell context, inline rename/delete, and drag reordering. |
| Desktop collapse | The sidebar can collapse to icon-only mode and remembers width/collapsed state. |
| Mobile navigation | The sidebar slides open and closed on mobile and session selection closes it. |
| Recent polish | `v9.6.20` through `v9.8.2` heavily refined app chrome, sidebar transparency, readable blur, icon treatment, session action buttons, empty-terminal branding, and dev-browser sizing. |

## Presentation And Theming

| Feature | Details |
| --- | --- |
| UI theme | Appearance settings control the overall app theme. |
| Terminal scheme | Terminal color scheme is independent from the UI theme. |
| Bundled terminal schemes | Dark, light, Solarized variants, Dark2, diagnostics palettes, and high-fidelity truecolor support are represented in the current code line. |
| Claude truecolor | `v9.7.5-dev` enabled Claude truecolor rendering in terminals. |
| Color fidelity fixes | Recent commits fixed WebGL glyph color darkening, terminal screenshots, Dark2 persistence/background behavior, diagnostics colors, and box-drawing stroke controls. |
| Font and cursor settings | Users can configure font size, bundled font family, cursor shape, blink, unfocused cursor styling, and contrast behavior. |
| Background images | Background image upload, enable/disable/remove controls, cover layout, and Ken Burns motion settings are available. |
| Transparency | UI transparency applies across workspace panes, terminal gaps, sidebar groups, notes, app chrome, and background stacks. |
| Recent gap cleanup | `v9.6.38` through `v9.6.41` fixed terminal gap fillers, backdrop seams, and background matching so transparent layouts do not expose rough edges. |

## Files, Git, And Commands

| Feature | Details |
| --- | --- |
| Files tab | Each session can open a file browser rooted in the foreground cwd. |
| Lazy tree loading | File trees lazy-load directories, sort directories first, sort entries alphabetically, and can show file size and git-state badges. |
| File previews | Images, video, audio, text, markdown, and binary dumps can render in the browser. |
| Text editing | Text previews support syntax highlighting, inline editing, explicit save, and Ctrl/Cmd+S. |
| Safety guardrails | Recent file-preview work unified preview behavior and guards large clipboard loads. |
| Git panel | Git surfaces summarize repository root, branch, ahead/behind state, aggregate changes, conflicts, staged/unstaged/untracked files, stash/clean state, and line deltas. |
| Commit inspection | Recent commits can be inspected with structured patch detail. |
| Explicit write handoff | Git panels can suggest terminal commands instead of silently mutating the repo. |
| Commands panel | Per-session scripts can be listed, created, edited, deleted, run, stopped, and streamed through hidden execution sessions. |

## Command Bay, Smart Input, Voice, Touch, And Mobile

| Feature | Details |
| --- | --- |
| Shared footer dock | Terminal and Agent Controller Session share an adaptive active-session footer rather than separate disconnected input strips. |
| Smart Input | Smart Input can replace direct terminal focus, coexist with terminal typing, keep per-session drafts, auto-grow upward, send on Enter, and insert newlines on Shift+Enter. |
| Multiline overlay growth | Recent Command Bay commits extended prompt overlay growth while preserving the active viewport. |
| Quick actions | Automation buttons can send text to the active terminal, optionally send Enter, and be added, renamed, deleted, or mirrored into mobile actions. |
| Attachments | Smart Input supports multiple files, touch-device photos, desktop webcam capture, and image paste paths. |
| Voice readiness | Voice controls can detect MidTerm.Voice availability, enumerate providers/devices, request microphone permission, stream audio, play responses, and show status. |
| Touch controller | Mobile/touch users get arrow keys, modifiers, special keys, long-press alternates, dismiss/restore behavior, and context-aware visibility. |
| Mobile shell | Mobile actions can create sessions, show touch controls, fullscreen, Ctrl+C, paste, rename, inject guidance, close, switch tabs, open preview, commands, share, and git. |
| PWA support | MidTerm ships a web manifest, notification permission flow, install-as-app settings, and mobile picture-in-picture session monitoring. |
| Recent polish | `v9.8.1-dev` refined Command Bay and terminal header styling; `v9.8.2` aligned app chrome and dev browser sizing. |

## Web Preview And Browser Automation

| Feature | Details |
| --- | --- |
| Session-scoped previews | Web previews belong to sessions instead of one global browser panel. |
| Named previews | One session can own multiple named browser contexts with separate target URL, cookie jar, proxy log, detached state, and viewport. |
| Docked and detached modes | Previews can be hidden, docked inside MidTerm, detached into a chromeless window, and docked back. |
| Resizable dock | Dock width persists per browser client and coexists with files, git, and commands panels. |
| URL bar and refresh | The dock has URL entry, protocol/localhost normalization, reload, and reset flows. |
| Clear state | Preview cookies, storage, cache, service workers, and route state can be cleared for repeatable validation. |
| Proxy rewriting | HTML, fetch, XHR, WebSocket, EventSource, DOM writes, forms, links, and history navigation are rewritten to stay inside the preview proxy where possible. |
| Cookie handling | Browser-visible cookies bridge to server-side jars while HttpOnly cookies stay server-side. |
| Automation bridge | CLI/API commands can open, dock, detach, set viewport, query DOM, click, fill, execute JavaScript, wait, screenshot, outline, inspect CSS/attrs, list links/forms, show logs, and submit forms. |
| Self-preview | Dev mode can run previews on a secondary origin and supports previewing MidTerm itself. |
| Recent diagnostics | `v9.6.8-dev` improved dev browser diagnostics; recent helpers fail loudly when a scoped preview cannot be controlled instead of silently using the wrong target. |

## Agent Controller Session And Agent-Oriented Workflows

| Feature | Details |
| --- | --- |
| Explicit surface boundary | Normal terminal sessions stay Terminal sessions. Running `codex` or `claude` in a shell does not automatically convert the session into Agent Controller Session. |
| Provider-backed runtime intent | Agent Controller Session is designed around provider-backed runtime events through `mtagenthost`, not scraping PTY output. |
| Canonical history | Agent Controller Session keeps provider history as backend-owned canonical history and renders bounded history windows in the browser. |
| Virtualized history | Recent work hardened upward scroll, mobile history rendering, scroll recovery, viewport-centered refetch, and progress-based navigation. |
| Turn-bound settings | Agent Controller Session quick settings lock to turn boundaries so configuration changes do not split active turns. |
| Surface-aware keys | Shift+Tab is surface-aware: Agent Controller Session can use it for plan mode while Terminal receives raw backtab behavior. |
| Recovery states | Recent Agent Controller Session work improved recovery, progress navigator behavior, shell-repair cleanup, and browse-window handling. |
| Command Bay integration | Agent Controller Session composition uses the same adaptive footer infrastructure as terminal Smart Input, keeping the workspace model unified. |

## Diagnostics And Operator Tooling

| Feature | Details |
| --- | --- |
| Diagnostics tab | Settings expose system, status, license, version, settings, secrets, certificate, and log paths. |
| Latency tools | Diagnostics can measure server RTT, host RTT, terminal output latency, and show a latency overlay. |
| Input tracing | `v9.6.10-dev`, `v9.6.21-dev`, and related work added/split input latency trace diagnostics for typing-to-render investigations. |
| Terminal buffer dump | Diagnostic utilities can inspect terminal buffer/render state for fidelity bugs. |
| Git debug overlay | Git panel state can be inspected during development. |
| Logs | APIs can list, read, and tail MidTerm logs. |
| Restart/shutdown | Power APIs can restart or stop the server from the UI. |
| CLI helpers | Generated `.midterm` helpers expose browser preview control, DOM inspection, screenshots, terminal session steering, prompt routing, activity checks, and worker bootstrapping. |
| DOM reconciliation | Recent sidebar work introduced keyed DOM reconciliation for hot updates that preserve node identity and avoid unnecessary rebuilds. |

## Recent Release Delta: `v9.6.0` To `v9.8.2`

Recent commits from April 2026 changed the product in four visible directions:

1. **Visual coherence and transparency became a first-class theme.** The `v9.6.20` to `v9.7.0` line refined sidebar/workspace transparency, readable blur, terminal gap fillers, app chrome, background images, SVG branding, and transparent-sidebar contrast. The current UI is much closer to a polished desktop workspace than the older utilitarian shell.
2. **Terminal rendering got a fidelity pass.** Commits fixed WebGL color darkening, screenshot color fidelity, Dark2 scheme persistence and background rendering, diagnostic terminal colors, Claude truecolor, and box-drawing stroke controls.
3. **The sidebar became more useful and stable.** Session notes, session action icons, drag docking, DOM update stabilization, process/cwd display helpers, readable blur, empty-terminal branding, and session action spacing all received concrete work.
4. **The Command Bay and diagnostics matured.** Recent work refined the prompt overlay, footer responsiveness, terminal header styling, input latency tracing, dev browser diagnostics, and release/build test reliability.

Representative commits analyzed:

| Commit/tag | Feature impact |
| --- | --- |
| `b4dc71a4` / `v9.8.2` | Align app chrome and dev browser sizing. |
| `f25434f1` / `v9.8.1-dev` | Refine Command Bay and terminal header styling. |
| `c3c88713` / `v9.8.0-dev` | Refine sidebar session action icons. |
| `61d0d013` / `v9.7.5-dev` | Enable Claude truecolor in terminals. |
| `46d29750`, `150dc46f`, `b64f72d2` | Fix Dark2 color persistence/background and add diagnostics colors. |
| `d01ab079` | Restore box drawing stroke controls. |
| `c694d0bd` / `v9.7.0-dev` | Terminal UI transparency and sidebar refinements. |
| `e8e95857`, `54803038`, `60f8f00b` | Fix terminal backdrops, seams, and gap fillers. |
| `dfe58a6b` through `cf22111a` | Refine sidebar contrast, icons, readable blur, and transparent text behavior. |
| `5e14fe6b` | Stabilize `mthost` PTY read latency. |
| `6e3821e5` | Fix transparency setting isolation. |
| `e450c0cd` through `4d6e7d9c` | Add and harden sidebar session notes. |
| `c144773f`, `0984bde3` | Add and split input latency tracing diagnostics. |
| `cc1b59d5` | Stabilize sidebar DOM updates. |
| `8d8f1300` | Unify file previews and guard large clipboard loads. |
| `f2583998` | Improve Agent Controller Session recovery and settings organization. |

## Target Use Cases

1. **AI coding agent supervision:** Run Codex, Claude Code, Aider, or other CLIs on your own machine, keep them alive, inspect their terminal output, attach notes, drive browser previews, and continue supervision from another device.
2. **Long-running engineering work:** Builds, deployments, database migrations, test suites, local servers, and data-processing jobs can keep running while the browser reconnects later.
3. **Local web app validation:** Pair a terminal session with one or more named previews, inspect DOM state, run browser commands, capture screenshots, check logs, and reset browser state without leaving the workspace.
4. **Mobile terminal control:** Check progress from a phone, send common controls, use touch arrows/modifiers, paste, speak or type into Smart Input, and keep a small background view of active output.
5. **Headless or remote dev machines:** Expose a browser workspace over a trusted network, VPN, or tunnel when SSH is inconvenient or blocked.
6. **TUI and ops dashboards:** Run `vim`, `lazygit`, `k9s`, `htop`, tmux, REPLs, and custom scripts with browser-based persistence and sharing options.
7. **Single-user secure sharing:** Share one terminal temporarily with another person without granting the whole MidTerm workspace.

## What MidTerm Is Not

- Not a hosted cloud terminal service. It runs on your machine.
- Not an SSH replacement in every environment. It is a complementary HTTPS/browser path for the cases where SSH is blocked, painful, or too low-level.
- Not a full code editor. It provides files, previews, git inspection, commands, and terminal surfaces around your existing tools.
- Not a team multi-tenant product. The core security model is a personal or controlled-machine workspace with scoped sharing.
- Not a generic remote desktop. It focuses on terminals, developer workflows, previews, and automation rather than streaming a full GUI.

## Differentiators

| Alternative | MidTerm difference |
| --- | --- |
| `tmux` + SSH | Browser reach, mobile controls, previews, file/git panels, share links, and local HTTPS auth. |
| ttyd / Wetty | Broader workspace surface, cross-platform installer/update story, persistent multi-session model, settings, previews, diagnostics, and security features. |
| Cloud terminals | Local credentials and hardware stay local; no hosted control plane is required for normal operation. |
| VNC/RDP | Far lighter and more developer-specific: terminal, files, git, previews, commands, and automation instead of full desktop streaming. |
| IDE remote tunnels | Terminal-first and agent-supervision-first, with explicit support for long-running shell workflows and browser preview automation. |

## Short Pitch Options

- "Your real terminal workspace, anywhere."
- "Run AI agents on your machine, supervise them from any browser."
- "Local-first terminal, preview, git, files, and automation in one web workspace."
- "A browser control room for long-running terminal work."
- "Self-hosted terminal access with previews, mobile controls, and no cloud dependency."
