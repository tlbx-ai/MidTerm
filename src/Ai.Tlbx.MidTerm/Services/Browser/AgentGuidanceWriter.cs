namespace Ai.Tlbx.MidTerm.Services.Browser;

public static class AgentGuidanceWriter
{
    public static void WriteToCwd(string cwd)
    {
        try
        {
            var midtermDir = Path.Combine(cwd, ".midterm");
            Directory.CreateDirectory(midtermDir);

            WriteIfMissing(Path.Combine(midtermDir, "CLAUDE.md"), ClaudeMdContent);
            WriteIfMissing(Path.Combine(midtermDir, "AGENTS.md"), AgentsMdContent);
        }
        catch
        {
        }
    }

    private static void WriteIfMissing(string path, string content)
    {
        if (!File.Exists(path))
            File.WriteAllText(path, content);
    }

    private const string ClaudeMdContent =
        """
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

        # Query the page DOM
        mt_query "body"
        mt_query ".error-message" true    # text-only (smaller output)

        # Interact with the page
        mt_click "#submit-btn"
        mt_fill "#email" "test@example.com"
        mt_wait ".success-toast"

        # Save state for analysis
        mt_snapshot
        mt_screenshot
        ```

        ## Available commands

        ### Browser interaction (requires web preview panel open)

        | Command | Description |
        |---------|-------------|
        | `mt_query <selector> [textOnly]` | Query DOM elements matching CSS selector |
        | `mt_click <selector>` | Click an element |
        | `mt_fill <selector> <value>` | Fill an input field |
        | `mt_exec <js-code>` | Execute JavaScript in the page |
        | `mt_wait <selector> [timeout]` | Wait for element to appear (default 5s) |
        | `mt_screenshot` | Save screenshot to .midterm/screenshots/ |
        | `mt_snapshot` | Save DOM snapshot to .midterm/snapshot_*/ |

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

        ## Snapshots & screenshots

        - **Snapshots** capture the live rendered DOM (including JS-injected content)
          saved to `.midterm/snapshot_YYYYMMDD_HHMMSS/index.html` + `css/`
        - **Screenshots** save a PNG to `.midterm/screenshots/`
        - Both are gitignored automatically

        ## Notes

        - `mtcli.sh` / `mtcli.ps1` contain an auto-generated auth token (ephemeral,
          expires in ~3 weeks, only works on this machine's MidTerm instance)
        - The `mtbrowser` CLI is also available in PATH for raw browser commands
        - All commands return JSON; pipe through `jq` for parsing
        """;

    private const string AgentsMdContent =
        """
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
        """;
}
