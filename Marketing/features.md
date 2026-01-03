# MidTerm Features

Current feature set as of v2.4.x.

## Core Value Proposition

**Your terminal, anywhere.** Run AI coding agents and TUI apps on your machine, access them from any browser.

| Problem | Solution |
|---------|----------|
| Cloud terminals are expensive and your API keys live on someone else's server | Run locally, full power, your keys stay home |
| SSH is blocked by firewalls, corporate networks, coffee shop WiFi | HTTP/WebSocket works everywhere browsers do |
| Long-running tasks tie you to your desk | Start on desktop, continue watching from phone/tablet/laptop |

## Technical Features

### Deployment

| Feature | Details |
|---------|---------|
| Single binary | ~15MB, no dependencies, no runtime needed |
| Native AOT | Compiled ahead-of-time, instant startup |
| Cross-platform | macOS (ARM64, x64), Windows (x64), Linux (x64) |
| One-liner install | `curl ... \| bash` (Unix) or `irm ... \| iex` (Windows) |
| Install modes | System service (auto-start, always-on) or user install (no admin) |
| Auto-update | One-click update from UI, auto-restart, page reloads |

### Security

| Feature | Details |
|---------|---------|
| Password required | Set during install, cannot skip |
| PBKDF2 hashing | 100,000 iterations, SHA256, 32-byte salt |
| Session cookies | HMAC-SHA256 tokens, 3-week validity, sliding expiration |
| Rate limiting | 5 failures = 30s lockout, 10 failures = 5min lockout |
| Password change | Available in Settings > Security |

### Terminal

| Feature | Details |
|---------|---------|
| Multi-session | Multiple terminals, single WebSocket connection |
| Shell support | Zsh, Bash, PowerShell 7, Windows PowerShell, CMD |
| Manual resize | Fit terminal to any screen size with one click (⤢) |
| Scrollback | Configurable, default 10,000 lines |
| Themes | Dark, Light, Solarized Dark, Solarized Light |
| Cursor styles | Bar, Block, Underline (with optional blink) |
| Font size | Configurable 8-24px |
| Clipboard | Copy-on-select, right-click paste, platform-aware shortcuts |
| Bell styles | Desktop notification, sound, visual flash, or off |

### Architecture

| Feature | Details |
|---------|---------|
| Web server | Kestrel (ASP.NET Core), embedded static files |
| PTY handling | ConPTY (Windows), forkpty() (Unix) via mmttyhost |
| Protocol | Binary WebSocket mux for terminal I/O, JSON WebSocket for state |
| Settings | JSON file, platform-appropriate location |

## UI Features

- **Sidebar** — Session list, create/rename/close terminals
- **Mobile responsive** — Hamburger menu, touch-friendly
- **Settings panel** — All configuration in-browser
- **Security warning** — Banner if no password set
- **Update panel** — Shows available updates with version comparison
- **Connection status** — Shows WebSocket connection state
- **Changelog viewer** — View release notes from UI

## Target Use Cases

1. **AI coding agents** — Claude Code, OpenAI Codex, Aider, Cursor CLI
2. **Long-running tasks** — Builds, deployments, data processing, test suites
3. **TUI applications** — htop, vim, tmux sessions, lazygit, k9s
4. **Remote development** — Access your dev machine from anywhere
5. **Headless servers** — Terminal access without SSH (via Tailscale/Cloudflare Tunnel)

## What MidTerm Is NOT

- Not a cloud service (runs on YOUR machine)
- Not a replacement for SSH (complementary, works where SSH can't)
- Not a code editor (it's a terminal, run whatever editor you want in it)
- Not multi-user (single password, designed for personal use)

## Competitive Landscape

| Alternative | Downside MidTerm solves |
|-------------|-------------------------------|
| tmux + SSH | SSH blocked by many networks |
| ttyd | No auth, no multi-session, not cross-platform |
| Wetty | Node.js dependency, complex setup |
| Cloud terminals | Expensive, limited resources, keys on their servers |
| VNC/RDP | Heavy, overkill for terminal access |
| Tailscale SSH | Great but some networks block Tailscale |

## One-Liner Pitch Options

- "Your terminal, anywhere"
- "Run Claude Code on your rig, watch from your phone"
- "15MB binary, infinite reach"
- "Self-hosted terminal access, zero cloud dependency"
- "tmux for the HTTP age"
