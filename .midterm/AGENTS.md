<!-- guidance-version: 2 -->
# MidTerm Agent Workflows

Patterns for AI agents using MidTerm's browser control. Source the helpers
first: `. .midterm/mtcli.sh` (bash) or `. .midterm\mtcli.ps1` (PowerShell).

## Inspect → Act → Verify loop

The core pattern for any browser interaction:

1. **Inspect** — `mt_outline` → `mt_attrs` / `mt_css` to understand page state
2. **Act** — `mt_click`, `mt_fill`, `mt_exec` to make changes
3. **Verify** — `mt_query` or `mt_wait` to confirm the result

## Common workflows

### Debug a visual bug

```bash
mt_outline                              # see page structure
mt_css ".problematic-element" "color,background,display,visibility,margin,padding"
# ... make code fixes ...
mt_reload                               # reload the preview
mt_css ".problematic-element" "color,background,display,visibility"  # verify
```

### Debug CSS / dark mode leak

```bash
mt_css "body" "color,background-color"
mt_css ".card" "color,background-color,border-color"
mt_css ".header" "color,background-color"
# Compare values against expected theme palette
```

### Check console for JS errors

```bash
mt_log error                            # just errors
mt_log                                  # all console output
```

### Explore page structure

```bash
mt_outline                              # tree overview
mt_outline 6                            # deeper tree
mt_links                                # all navigation links
mt_forms                                # all forms with fields
mt_attrs "nav a"                        # inspect nav link attributes
```

### Fill and submit a form

```bash
mt_forms                                # understand form structure
mt_fill "#username" "testuser"
mt_fill "#password" "testpass"
mt_click "button[type=submit]"
mt_wait ".dashboard"                    # wait for navigation
mt_query ".welcome-message" true        # verify login succeeded
```

### Navigate and inspect a new page

```bash
mt_navigate "http://localhost:3000/settings"
mt_wait ".settings-page" 10             # wait up to 10s for load
mt_outline                              # get page structure
```

### Execute JavaScript for advanced queries

```bash
mt_exec "document.querySelectorAll('li').length"
mt_exec "window.location.href"
echo 'JSON.stringify(Object.keys(localStorage))' | mt_exec
```

## Tips

- Start with `mt_outline` not `mt_query` — it's much smaller output
- Use `mt_css` to inspect specific properties instead of full DOM snapshots
- Use `mt_log` after actions to catch runtime errors
- Use `true` as second arg to `mt_query` for text-only output
- Use stdin piping for complex JS: `echo 'code' | mt_exec`
- All responses are JSON — use `jq` for field extraction
- If `mt_status` shows "disconnected", the web preview panel needs to be open