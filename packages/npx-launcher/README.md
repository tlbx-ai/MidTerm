# @tlbx-ai/midterm

Launch MidTerm through `npx`.

```bash
npx @tlbx-ai/midterm
```

The launcher downloads the native MidTerm release for your platform, caches it in your user profile, runs it locally, and opens MidTerm in your default browser.

Supported platforms:

- Windows x64
- macOS x64
- macOS ARM64
- Linux x64

Extra arguments are passed through to `mt`:

```bash
npx @tlbx-ai/midterm -- --port 2001 --bind 127.0.0.1
```

Launcher-only options:

- `--channel stable|dev`
- `--no-browser`
- `--help-launcher`

Notes:

- Default channel is `stable`
- If you do not pass `--bind`, the launcher forces `127.0.0.1`
- If you do not pass `--port`, the launcher opens `https://127.0.0.1:2000`
- The launcher sets `MIDTERM_LAUNCH_MODE=npx` for the child process
- If you invoke `npx` from WSL but it resolves to Windows `node/npm`, the launcher detects the WSL working directory and runs the Linux MidTerm build inside that distro
