# MidTerm Agent Workflows

Patterns for AI agents using MidTerm's browser control. Source the helpers
first: `. .midterm/mtcli.sh` (bash) or `. .midterm\mtcli.ps1` (PowerShell).

## Inspect → Act → Verify loop

The core pattern for any browser interaction:

1. **Inspect** — `mt_query` to understand current page state
2. **Act** — `mt_click`, `mt_fill`, `mt_exec` to make changes
3. **Verify** — `mt_query` or `mt_wait` to confirm the result

## Common workflows

### Debug a visual bug

```bash
mt_snapshot                          # capture current state
cat .midterm/snapshot_*/index.html   # read the DOM
cat .midterm/snapshot_*/css/*.css    # read the styles
# ... make code fixes ...
mt_reload                            # reload the preview
mt_query ".problematic-element"      # verify the fix
```

### Fill and submit a form

```bash
mt_query "form" true                 # understand form structure
mt_fill "#username" "testuser"
mt_fill "#password" "testpass"
mt_click "button[type=submit]"
mt_wait ".dashboard"                 # wait for navigation
mt_query ".welcome-message" true     # verify login succeeded
```

### Navigate and inspect a new page

```bash
mt_navigate "http://localhost:3000/settings"
mt_wait ".settings-page" 10          # wait up to 10s for load
mt_query ".settings-page" true       # read the content
```

### Take a screenshot for visual verification

```bash
mt_screenshot
# screenshot saved to .midterm/screenshots/screenshot_YYYYMMDD_HHMMSS.png
```

### Execute JavaScript for advanced queries

```bash
mt_exec "document.querySelectorAll('li').length"
mt_exec "window.location.href"
mt_exec "JSON.stringify(localStorage)"
```

## Tips

- Use `true` as second arg to `mt_query` for text-only output (much smaller)
- Use `mt_wait` before `mt_query` after navigation or clicks that trigger loads
- Snapshots are more useful than screenshots for understanding page structure
- All responses are JSON — use `jq` for field extraction
- If `mt_status` shows "disconnected", the web preview panel needs to be open