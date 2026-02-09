# Repository Guidelines

This file consolidates the existing repository guidance with additional operational and architectural guidance from `CLAUDE.md`.

## Critical Operational Warnings

### Do Not Use Background Tasks
- Do not use background task execution.
- Do not run commands with any background mode/flag.
- Avoid any workflow that depends on detached execution.

### Installer / Self-Updater Robustness Is Non-Negotiable
Changes to `install.sh`, `install.ps1`, or `UpdateScriptGenerator.cs` must prioritize:
1. User can always update.
2. Certificate/password loss is acceptable if needed to recover.
3. Temporary service downtime is acceptable.

Rules:
- Keep update logic simple and defensive.
- Prefer failing forward over rollback where possible.
- Use correct platform-specific secret file handling.
- Test the generated update script, not only generator code.
- Assume update scripts run unattended.

## What MidTerm Is

MidTerm is a web-based terminal multiplexer (Native AOT, macOS/Windows/Linux).

Binaries:
- `mt` / `mt.exe`: web server (UI, REST API, WebSockets)
- `mthost` / `mthost.exe`: TTY host per terminal session

Default port:
- `2000`

Settings locations:
- Service mode:
  - Windows: `%ProgramData%\MidTerm\settings.json`
  - Unix: `/usr/local/etc/midterm/settings.json`
- User mode:
  - `~/.midterm/settings.json`

## Project Structure & Module Organization

MidTerm is a .NET 10 solution under `src/`.

- `src/Ai.Tlbx.MidTerm`: ASP.NET Core service (`mt`)
- `src/Ai.Tlbx.MidTerm.Common`: shared protocol/helpers
- `src/Ai.Tlbx.MidTerm.TtyHost`: terminal host (`mthost`)
- `src/Ai.Tlbx.MidTerm.Voice`: optional voice features
- `src/Ai.Tlbx.MidTerm/src/ts`: TypeScript frontend source
- `src/Ai.Tlbx.MidTerm/src/static`: source static assets
- `src/Ai.Tlbx.MidTerm/wwwroot`: generated frontend output
- `src/Ai.Tlbx.MidTerm.Tests`: integration tests
- `src/Ai.Tlbx.MidTerm.UnitTests`: unit tests
- `docs/marketing`: marketing video tooling/content
- `scripts/`: release and utility scripts

## Build, Test, and Development Commands

- `dotnet build src/Ai.Tlbx.MidTerm/Ai.Tlbx.MidTerm.csproj`
- `npm run build`
- `npm run watch`
- `npm run watch:typecheck`
- `dotnet test src/Ai.Tlbx.MidTerm.Tests/Ai.Tlbx.MidTerm.Tests.csproj`
- `dotnet test src/Ai.Tlbx.MidTerm.UnitTests/Ai.Tlbx.MidTerm.UnitTests.csproj`
- AOT builds:
  - `src/Ai.Tlbx.MidTerm/build-aot.cmd`
  - `src/Ai.Tlbx.MidTerm/build-aot-linux.sh`
  - `src/Ai.Tlbx.MidTerm/build-aot-macos.sh`

## Asset Optimization

For PNG optimization:

`C:/Tools/pngcrush/pngcrush_1_8_11_w64.exe -ow -reduce -brute <file.png>`

Ask before running it after adding image assets.

## Coding Style & Naming Conventions

### C#
- Allman braces
- 4-space indentation
- explicit access modifiers
- private fields use `_camelCase`
- async methods use `Async` suffix
- file-scoped namespaces
- `is null` / `is not null`

### TypeScript
- K&R braces
- 2-space indentation
- semicolons required
- single quotes
- explicit return types on exported functions
- module header comments and JSDoc on exported APIs

Run before pushing:
- `npm run lint`
- `npm run format`

## Testing Guidelines

- xUnit for backend tests.
- Use `*Tests.cs` naming and `MethodName_Scenario_Expectation`.
- Integration tests should use provided `WebApplicationFactory` patterns.
- Add tests for behavior changes, not just styling when logic changed.
- Run both dotnet test suites locally when touching shared/backend behavior.

## Commit & Pull Request Guidelines

- Short imperative commit subjects.
- PRs should include:
  - `dotnet build` confirmation
  - both `dotnet test` confirmations
  - relevant npm script confirmation
  - linked tracking issue
  - manual validation notes
  - UI evidence (screenshots/recordings) for web changes

## Security & Configuration Tips

- Never commit generated `settings.json`.
- Treat installer passwords and API tokens as secrets.
- Prefer env vars or user-level config for sensitive data.
- Keep authentication enabled in remote access demos.

## Services Overview

Major service areas include:
- Authentication: `AuthService`, `AuthEndpoints`
- Sessions: `TtyHostSessionManager`, `TtyHostClient`, `TtyHostSpawner`, session endpoints
- WebSockets: mux/state/settings handlers and protocol
- Settings: `SettingsService`
- Security/user validation
- Secret storage per platform
- Certificate generation/info/cleanup
- Updates and script generation
- Static file serving/compression
- System lifecycle (shutdown, cleanup, single instance)
- History and file features
- Log endpoints

## Settings Model Pattern

Two settings models exist by design:
- `MidTermSettings`: internal model (contains sensitive/internal fields)
- `MidTermSettingsPublic`: API-safe model for frontend

When adding a new setting:
1. Add to internal model.
2. Add to public model if user-editable and safe.
3. Map in `FromSettings()`.
4. Map/validate in `ApplyTo()`.
5. Register new serializable types in JSON context(s).

## AOT JSON Serialization (Critical)

All `System.Text.Json` types used at runtime must be source-generated for AOT.

When adding serializable types, register with `[JsonSerializable(typeof(...))]` in the relevant context (`AppJsonContext`, `SettingsJsonContext`, etc.).

Common symptom of missing metadata: works in debug, fails in AOT publish.

## Frontend Module Architecture

`src/ts/modules/` is feature-based. Reuse existing modules first:
- auth, comms, terminal, sidebar, settings, theming, updating, diagnostics, history, fileViewer, touchController, process, logging, chat, bootstrap, badges, voice.

If creating a module:
1. add `index.ts` barrel,
2. wire into `main.ts` init/register flow as needed.

## API Endpoints (Core)

Authentication:
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `POST /api/auth/change-password`
- `GET /api/auth/status`

Sessions:
- `GET /api/sessions`
- `POST /api/sessions`
- `DELETE /api/sessions/{id}`
- `POST /api/sessions/{id}/resize`
- `PUT /api/sessions/{id}/name`

System/settings/update:
- `GET/PUT /api/settings`
- `GET /api/shells`
- `GET /api/version`
- `GET /api/health`
- `GET /api/update/check`
- `POST /api/update/apply`

WebSockets:
- `/ws/mux` (binary terminal I/O protocol)
- `/ws/state` (JSON session state)

## Mux Protocol Notes

Frame format: `[1 byte type][8 byte sessionId][payload]`

Key message types:
- output/input/resize/resync/buffer request/compressed output/active session hint

Priority behavior:
- active session is immediate
- background sessions are batched/compressed

## Authentication Notes

- PBKDF2 password hashing
- HMAC-SHA256 session tokens
- session validity with sliding refresh
- lockout after repeated failures

## Terminal Resize Principle (Do Not Break)

The user decides when to resize. Never auto-resize existing sessions.

- New sessions use creator viewport size.
- Existing sessions keep server-side dimensions.
- Reconnect/reload must not push resize automatically.
- Multi-client attach should scale visually, not resize implicitly.
- Layout restore should apply CSS scaling, not forced server resize.

## Frontend State Management

- Nanostores for reactive app/session UI state.
- `state.ts` for ephemeral infrastructure (sockets, DOM refs, timers, frame buffers).
- Store naming convention: `$storeName`.

## Platform-Specific Defaults

- Windows: ConPTY, default shell `Pwsh`
- macOS: `forkpty`, default shell `zsh`
- Linux: `forkpty`, default shell `bash`

## Branch Strategy & Release Process (Mandatory)

### Branch Policy
- All development on `dev`.
- `main` is stable only.
- Promote via PR `dev -> main`.
- Do not commit directly to `main`.

### Pull Strategy
- Rebase pull preferred (`pull.rebase=true`) to keep linear history.

### Dev Release Procedure

1. Confirm branch is `dev`.
2. Ensure clean working tree.
3. `git pull --rebase`
4. `git push`
5. Draft meaningful release title/notes from commit range since last tag.
6. Set `-mthostUpdate yes|no` based on TtyHost/Common/protocol impact.
7. Run:

`pwsh -NoProfile -File scripts/release-dev.ps1 -Bump <major|minor|patch> -ReleaseTitle "<title>" -ReleaseNotes @("<note1>", "<note2>") -mthostUpdate <yes|no>`

Avoid:
- releasing with dirty tree
- forgetting to push before release
- vague release notes

### Stable Promotion

Use PR merge `dev -> main`, then run `scripts/release.ps1` on `main`.

### Update Channels

- stable: full releases only
- dev: prereleases + full releases

## Version Management (Critical)

`version.json` is the single source of truth.

Do not:
- hardcode `<Version>` in csproj files
- pass manual `-p:Version` in build/publish scripts
- update csproj versions in release scripts

Release scripts should update `version.json` only.

## Install System Notes

Installer flow:
1. choose service/user install
2. set password
3. download/extract binaries
4. write settings/password hash
5. register service (if system)

Password hash is preserved across updates where possible.

## Important Engineering Rules

- Never run `dotnet run` without user permission.
- Never use `Task.Run` unless explicitly needed/requested.
- Target zero build warnings.
- Prefer interfaces + DI over static-heavy designs.
- Use `OperatingSystem.IsWindows/IsLinux/IsMacOS` for platform checks.
- Register all JSON serialization types for AOT compatibility.
- After significant implementation tasks, offer a dev patch release.

## Marketing Video Workflow (docs/marketing)

Goal: high-volume short social clips.

Core flow:
1. pick idea from `ideas.md`
2. write short scene story
3. generate clips with `create_clip.py`
4. chain clips with `chain_clips.py`
5. draft tweet/post copy
6. post manually

Helpful commands:
- `python create_clip.py ...`
- `python chain_clips.py ...`

Environment variables:
- `VERTEX_AI_PROJECT_ID`
- `VERTEX_AI_SERVICE_ACCOUNT_JSON`
