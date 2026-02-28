namespace Ai.Tlbx.MidTerm.Services.Browser;

public static class AgentGuidanceWriter
{
    private const string GuidanceVersion = "2";

    public static void WriteToCwd(string cwd)
    {
        try
        {
            var midtermDir = Path.Combine(cwd, ".midterm");
            Directory.CreateDirectory(midtermDir);

            WriteIfOutdated(Path.Combine(midtermDir, "CLAUDE.md"), ClaudeMdContent);
            WriteIfOutdated(Path.Combine(midtermDir, "AGENTS.md"), AgentsMdContent);
        }
        catch
        {
        }
    }

    private static void WriteIfOutdated(string path, string content)
    {
        if (File.Exists(path))
        {
            var existing = File.ReadAllText(path);
            if (existing.Contains($"guidance-version: {GuidanceVersion}"))
                return;
        }

        File.WriteAllText(path, content);
    }

    private const string ClaudeMdContent =
        $$"""
        <!-- guidance-version: {{GuidanceVersion}} -->
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
        | `mt_proxylog [limit]` | Last N proxy requests with full details (default 100) |

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
        """;

    private const string AgentsMdContent =
        $$"""
        <!-- guidance-version: {{GuidanceVersion}} -->
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
        """;
}
