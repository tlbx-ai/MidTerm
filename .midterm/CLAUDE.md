<!-- guidance-version: 2 -->
# MidTerm — AI Agent Integration

This folder is managed by [MidTerm](https://midterm.sh), a web-based terminal
multiplexer with built-in web preview and browser control.

## What's in .midterm/

| File | Purpose |
|------|---------|
| `CLAUDE.md` | This file — overview for AI agents (safe to commit) |
| `AGENTS.md` | Workflow patterns and examples (safe to commit) |
| `mtcli.sh` | Shell helpers — source with `. .midterm/mtcli.sh` |
| `mtcli.ps1` | PowerShell helpers — dot-source with `. .midterm\mtcli.ps1` |
| `snapshot_*/` | DOM snapshots (gitignored) |
| `screenshots/` | Browser screenshots (gitignored) |

## Quick start

```bash
# Load helpers (picks up auth token + server URL automatically)
. .midterm/mtcli.sh

# Check what's being previewed
mt_target

# Get page structure (token-efficient overview)
mt_outline

# Query specific elements
mt_query ".error-message" true    # text-only (smaller output)

# Inspect CSS
mt_css "body" "color,background-color,font-size"

# Check for JS errors
mt_log error

# Interact with the page
mt_click "#submit-btn"
mt_fill "#email" "test@example.com"
mt_wait ".success-toast"
```

## Available commands

### Browser inspection (read-only, token-efficient)

| Command | Description |
|---------|-------------|
| `mt_outline [depth]` | Page structure tree — tag names, ids, classes (default depth 4) |
| `mt_attrs <selector>` | Element attributes only (no children, no text) |
| `mt_css <selector> <props>` | Computed CSS values for comma-separated properties |
| `mt_log [error\|warn\|all]` | Console log buffer (last 50 entries) |
| `mt_links` | All links on page (href + text) |
| `mt_forms [selector]` | Form structure: inputs, types, values, labels |

### Browser interaction

| Command | Description |
|---------|-------------|
| `mt_query <selector> [textOnly]` | Query DOM elements matching CSS selector |
| `mt_click <selector>` | Click an element |
| `mt_fill <selector> <value>` | Fill an input field |
| `mt_exec <js-code>` | Execute JavaScript in the page |
| `mt_wait <selector> [timeout]` | Wait for element to appear (default 5s) |
| `mt_screenshot` | Save screenshot to .midterm/screenshots/ |
| `mt_snapshot` | Save full DOM snapshot to .midterm/snapshot_*/ |

### Web preview management

| Command | Description |
|---------|-------------|
| `mt_navigate <url>` | Set web preview target URL |
| `mt_reload` | Soft-reload the preview |
| `mt_target` | Show current preview target |
| `mt_cookies` | List server-side cookie jar |

### Session management

| Command | Description |
|---------|-------------|
| `mt_sessions` | List terminal sessions |
| `mt_buffer <id>` | Read terminal buffer for a session |
| `mt_status` | Browser connection status |

## Recommended workflow

Start with `mt_outline` to understand page structure, then drill down with
`mt_attrs` or `mt_css` for specific elements. Use `mt_query` only when you
need the actual HTML content. This keeps context usage minimal.

## Notes

- `mtcli.sh` / `mtcli.ps1` contain an auto-generated auth token (ephemeral,
  expires in ~3 weeks, only works on this machine's MidTerm instance)
- The `mtbrowser` CLI is also available in PATH for raw browser commands
- All commands return JSON; pipe through `jq` for parsing