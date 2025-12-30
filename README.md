<img src="docs/icon.png" width="80" align="left" style="margin-right: 16px">

# MiddleManager

[![License: MPL 2.0](https://img.shields.io/badge/License-MPL%202.0-brightgreen.svg)](https://opensource.org/licenses/MPL-2.0)
[![macOS](https://img.shields.io/badge/macOS-000000?logo=apple&logoColor=white)](#installation)
[![Windows](https://img.shields.io/badge/Windows-0078D6?logo=windows&logoColor=white)](#installation)
[![Linux](https://img.shields.io/badge/Linux-FCC624?logo=linux&logoColor=black)](#installation)

**Your terminal, anywhere.** Run AI coding agents and TUI apps on your machine, access them from any browser.

<!-- TODO: Add screenshot or GIF demo here -->
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

## Why Not Just...?

| Alternative | Problem |
|-------------|---------|
| Cloud VMs | Expensive, limited resources, your API keys on their servers |
| SSH | Firewalls, NAT, corporate networks block it |
| Screen sharing | Laggy, needs coordination, can't multitask |
| tmux + SSH | Still needs SSH access |

MiddleManager: HTTP works everywhere. Your machine, your power, your keys.

## Features

- **Single binary** — ~15MB, no dependencies, no runtime
- **Cross-platform** — macOS, Windows, Linux
- **Responsive UI** — Works on any screen size. That old iPad? Now it's a terminal monitor.
- **Instant startup** — Native AOT compiled, sub-second launch
- **Multi-session** — Multiple terminals, one WebSocket connection
- **Any shell** — Zsh, Bash, PowerShell, CMD
- **Auto-update** — Checks for updates hourly, one-click update from the UI

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

The installer will ask you to choose:

| Option | Best for | Privileges |
|--------|----------|------------|
| **System service** | Always-on access, headless machines, remote access before login | Requires admin/sudo |
| **User install** | Try it out, occasional use, no admin rights | No special permissions |

**System service:** Runs in background, starts on boot, survives reboots. Great for machines you access remotely.

**User install:** You run `mm` when you need it. Simpler, no admin required, installs to your home folder.

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

# Start Claude Code in the terminal
claude
```

That's it. Now open that same URL from any device on your network.

## Remote Access

For access from your phone, tablet, or any device outside your local network:

**[Tailscale](https://tailscale.com)** — The easiest option. Install on your Mac and phone, done. Access your terminal from anywhere via `http://your-mac:2000`. Free for personal use.

Other options:
- **Cloudflare Tunnel** — Free, no port forwarding needed
- **Reverse proxy** — nginx/Caddy with HTTPS

## Options

```
mm [options]

  --port 2000       Port to listen on (default: 2000)
  --bind 0.0.0.0    Address to bind to (default: 0.0.0.0)
  --version         Show version and exit
  --check-update    Check for updates (JSON output)
  --update          Download and apply update, then restart
```

## Configuration

Settings stored in `~/.middlemanager/settings.json`:

```json
{
  "defaultShell": "Pwsh",
  "defaultCols": 120,
  "defaultRows": 30
}
```

## Building from Source

Requires [.NET 10 SDK](https://dotnet.microsoft.com/download).

```bash
git clone https://github.com/AiTlbx/MiddleManager.git
cd MiddleManager

# Build
dotnet build

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
