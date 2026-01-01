<img src="docs/icon.png" width="80" align="left" style="margin-right: 16px">

# MiddleManager

[![GitHub Release](https://img.shields.io/github/v/release/AiTlbx/MiddleManager)](https://github.com/AiTlbx/MiddleManager/releases/latest)
[![License: MPL 2.0](https://img.shields.io/badge/License-MPL%202.0-brightgreen.svg)](https://opensource.org/licenses/MPL-2.0)
[![macOS](https://img.shields.io/badge/macOS-000000?logo=apple&logoColor=white)](#installation)
[![Windows](https://img.shields.io/badge/Windows-0078D6?logo=windows&logoColor=white)](#installation)
[![Linux](https://img.shields.io/badge/Linux-FCC624?logo=linux&logoColor=black)](#installation)

**Your terminal, anywhere.** Run AI coding agents and TUI apps on your machine, access them from any browser.

![MiddleManager Screenshot](docs/screenshot.png)

## The Problem

You kick off Claude Code on a complex refactor. It's going to take a while. Now you need to leave your desk — grab lunch, head to a meeting, go home. Your options:

- **Cloud terminals** — Expensive, resource-limited, your API keys live on someone else's server
- **SSH** — Blocked by firewalls, corporate networks, coffee shop WiFi
- **Just wait** — Watch the terminal until it's done

## The Solution

MiddleManager serves your terminal through a browser. Start a task on your main rig, continue watching from your laptop, phone, or tablet. Your machine does the work. You stay connected.

```
Your PC                          Anywhere
┌─────────────────┐              ┌─────────────────┐
│ Claude Code     │    HTTPS     │                 │
│ OpenAI Codex    │◄────────────►│   Browser       │
│ Any TUI app     │   WebSocket  │                 │
└─────────────────┘              └─────────────────┘
     Full power                    Full access
```

**Perfect for:**
- **AI coding agents** — Claude Code, OpenAI Codex, Aider, Cursor CLI
- **Long-running tasks** — Builds, deployments, data processing
- **Any TUI app** — htop, vim, tmux sessions, whatever you run in a terminal

## Features

- **Single binary** — ~15MB, no dependencies, no runtime
- **Cross-platform** — macOS, Windows, Linux (Native AOT compiled)
- **Password protected** — PBKDF2 hashed password, required during install
- **Multi-session** — Multiple terminals, one WebSocket connection
- **Manual resize** — Fit terminal to any screen size with one click
- **Any shell** — Zsh, Bash, PowerShell, CMD
- **Auto-update** — One-click update from the UI, page reloads automatically
- **Responsive UI** — Works on any screen size

## Installation

### One-liner Install

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/AiTlbx/MiddleManager/main/install.sh | bash
```

**Windows (PowerShell as Admin):**
```powershell
irm https://raw.githubusercontent.com/AiTlbx/MiddleManager/main/install.ps1 | iex
```

The installer will:
1. Ask you to choose between **system service** or **user install**
2. **Prompt for a password** (required — protects your terminal from network access)

| Option | Best for | Privileges |
|--------|----------|------------|
| **System service** | Always-on access, headless machines, remote access before login | Requires admin/sudo |
| **User install** | Try it out, occasional use, no admin rights | No special permissions |

### Manual Download

| Platform | Download |
|----------|----------|
| macOS ARM64 | [mm-osx-arm64.tar.gz](https://github.com/AiTlbx/MiddleManager/releases/latest) |
| macOS x64 | [mm-osx-x64.tar.gz](https://github.com/AiTlbx/MiddleManager/releases/latest) |
| Windows x64 | [mm-win-x64.zip](https://github.com/AiTlbx/MiddleManager/releases/latest) |
| Linux x64 | [mm-linux-x64.tar.gz](https://github.com/AiTlbx/MiddleManager/releases/latest) |

## Quick Start

```bash
# Start MiddleManager
./mm                    # macOS/Linux
mm.exe                  # Windows

# Open in browser
http://localhost:2000

# Enter your password, then start Claude Code
claude
```

## Security

MiddleManager exposes terminal access over the network. Security is mandatory:

- **Password required** — Set during installation, cannot be skipped
- **PBKDF2 hashing** — 100,000 iterations with SHA256
- **Session cookies** — 3-week validity with sliding expiration
- **Rate limiting** — Lockout after failed login attempts

Change your password anytime in **Settings > Security**.

## Terminal Resize

Terminals are created at the optimal size for your current screen. When viewing from a different device:

- Click the **resize button (⤢)** in the sidebar to fit the terminal to your current screen
- Each terminal maintains its own dimensions
- Resizing one terminal doesn't affect others

## Remote Access

For access outside your local network:

**[Tailscale](https://tailscale.com)** — The easiest option. Install on your machine and phone, access via `http://your-machine:2000`. Free for personal use.

Other options:
- **Cloudflare Tunnel** — Free, no port forwarding needed
- **Reverse proxy** — nginx/Caddy with HTTPS

## Command Line Options

```
mm [options]

  --port 2000       Port to listen on (default: 2000)
  --bind 0.0.0.0    Address to bind to (default: 0.0.0.0)
  --version         Show version and exit
  --hash-password   Hash a password for settings.json
```

## Configuration

Settings stored in:
- **Service mode:** `%ProgramData%\MiddleManager\settings.json` (Windows) or `/usr/local/etc/middlemanager/settings.json` (Unix)
- **User mode:** `~/.middlemanager/settings.json`

```json
{
  "defaultShell": "Pwsh",
  "defaultCols": 120,
  "defaultRows": 30,
  "authenticationEnabled": true,
  "passwordHash": "$PBKDF2$100000$..."
}
```

## Building from Source

Requires [.NET 10 SDK](https://dotnet.microsoft.com/download).

```bash
git clone https://github.com/AiTlbx/MiddleManager.git
cd MiddleManager

# Build
dotnet build Ai.Tlbx.MiddleManager/Ai.Tlbx.MiddleManager.csproj

# AOT binary (platform-specific)
cd Ai.Tlbx.MiddleManager
./build-aot-macos.sh     # macOS
./build-aot.cmd          # Windows
./build-aot-linux.sh     # Linux
```

## License

[Mozilla Public License 2.0](LICENSE) — Use freely, share modifications to MPL files.

---

Created by [Johannes Schmidt](https://github.com/AiTlbx)
