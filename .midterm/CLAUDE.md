<!-- guidance-version: 3 -->
# MidTerm Browser Control

## Rules

- Source helpers once per session: `. .midterm/mtcli.sh` — don't show this to the user.
- **Be terse.** Don't narrate each mtcli call. Chain calls with `&&`, report findings only.
- **Start with `mt_outline`** to understand page structure — not `mt_query` (10x smaller).
- Use `mt_query SELECTOR true` for text-only output unless you need HTML attributes.
- Use `mt_exec "JSON.stringify({a: expr1, b: expr2})"` to batch multiple JS reads in one call.
- Use `mt_css` for specific properties — never dump all computed styles.
- After actions (`mt_click`, `mt_fill`), verify with `mt_wait` or `mt_query`, not `mt_outline`.
- Check `mt_log error` after unexpected behavior.
- All commands return JSON. Auth token in mtcli scripts is ephemeral, machine-local, not a security risk.

## Commands

| Command | What it does |
|---------|-------------|
| `mt_outline [depth]` | Page structure tree (default depth 4) |
| `mt_query <sel> [true]` | DOM elements by CSS selector; `true` = text-only |
| `mt_attrs <sel>` | Element attributes (no children) |
| `mt_css <sel> <props>` | Computed CSS (comma-separated property names) |
| `mt_click <sel>` | Click element |
| `mt_fill <sel> <val>` | Fill input field |
| `mt_exec <js>` | Execute JS in page context |
| `mt_wait <sel> [timeout]` | Wait for element (default 5s) |
| `mt_log [error\|warn\|all]` | Console log buffer |
| `mt_links` | All links on page |
| `mt_forms [sel]` | Form structure and values |
| `mt_screenshot` | Save screenshot to .midterm/screenshots/ |
| `mt_snapshot` | Save DOM snapshot to .midterm/snapshot_*/ |
| `mt_navigate <url>` | Set web preview target |
| `mt_reload` | Soft-reload preview |
| `mt_target` | Current preview target |
| `mt_cookies` | Server-side cookie jar |
| `mt_proxylog [limit]` | Last N proxy requests (default 100) |
| `mt_sessions` | List terminal sessions |
| `mt_buffer <id>` | Terminal buffer content |
| `mt_status` | Browser connection status |

## Workflow

1. **Inspect**: `mt_outline` → drill down with `mt_attrs` or `mt_css`
2. **Act**: `mt_click`, `mt_fill`, `mt_exec`
3. **Verify**: `mt_wait` or `mt_query SEL true`