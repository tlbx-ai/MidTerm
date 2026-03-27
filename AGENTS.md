This terminal runs inside MidTerm (web terminal multiplexer).

If `.midterm/AGENTS.md` exists, follow it for browser control and tmux workflows.
If it does not exist, do not assume extra MidTerm-specific workflow permissions.

## Release Authority

Do not run release, tag, publish, promote, or merge-to-main workflows unless the user explicitly authorizes that exact action in the current turn.

Rules:
- "Cut a dev/prerelease" does not imply "promote to stable".
- If the user says "patch release", "minor release", or "major release" without specifying stable vs dev, default to a dev/prerelease.
- Only treat it as a stable release when the user explicitly says stable, promote, or otherwise clearly asks for the stable path.
- Dev/prerelease path: use `scripts/release-dev.ps1`.
- Stable release path: use `scripts/release.ps1`.
- Promotion path: use `scripts/promote.ps1` only with explicit approval.
- Never run `scripts/promote.ps1`, create or push release tags, publish release artifacts, or merge release PRs without explicit approval.
- For urgent fixes, implement and verify the change first, then stop before release or promotion unless the user explicitly says to continue.

## Terminal Design Constraints

- Do not suggest hiding, virtualizing, or lazily deactivating visible terminal sessions as a latency optimization.
- In MidTerm, sessions that are shown are intentionally kept as genuinely active terminals; latency work must preserve that UX model.

## Session Surface Boundary

- Treat Terminal and Lens as separate surfaces with an explicit boundary.
- What happens in Terminal stays in Terminal unless the user explicitly launched a Lens session through the Lens-oriented flow.
- Do not infer a Lens session from foreground process metadata alone. Running `codex`, `claude`, or another AI CLI inside a normal terminal must not auto-switch surfaces, surface Lens tabs, or reclassify the session as Lens-owned.
- The IDE bar rule is exclusive, not additive:
  - normal terminal session: `Terminal` + `Files`
  - explicit Codex Lens session: `Codex` + `Files`
  - explicit Claude Lens session: `Claude` + `Files`

## Lens Runtime Principle

- Implement provider-backed Lens sessions as Lens-owned runtimes, not as reinterpretations of terminal transcript output.
- For each explicit Codex or Claude Lens session, MidTerm should launch or attach a dedicated provider runtime for that Lens surface and consume structured runtime events from that runtime.
- Lens is not a terminal transcript view. It must rely on explicit provider APIs and structured protocols that Codex and Claude expose for rich UI clients, with `mtagenthost` as the intended MidTerm host boundary for those integrations.
- An explicit Lens session does not own or attach to an `mthost` terminal. Its runtime boundary is `mtagenthost`, which launches the provider with the parameters and structured transport needed for a rich web UI integration.
- Do not scrape the terminal buffer, infer assistant turns from PTY text, or depend on foreground process output as the source of truth for Lens conversation state.
- Do not treat terminal stdout/stderr as the Lens protocol. PTY output may still exist for Terminal, diagnostics, or fallback scenarios, but it is not the authoritative source for Lens turns, streaming assistant output, tool lifecycle, approvals, plan-mode questions, or diffs.
- The purpose of Lens is to tap into provider capabilities that support rich UI visualization of agent operation, then render those capabilities in MidTerm's web UI.
- Lens should model progressive assistant output, tool activity, plan-mode questions, approvals, and diffs from canonical runtime events with stable per-turn and per-item identity.
- Keep provider-specific plumbing deep in the C# runtime/host layer. Codex and Claude may expose completely different transports, event schemas, and lifecycle details, but the TypeScript Lens UI should consume a mostly provider-neutral canonical event model rather than branching on provider quirks.
- When expanding Lens capabilities, prefer adapting provider events into MidTerm-owned canonical concepts such as turns, streams, items, requests, diffs, and task/tool progress instead of leaking raw provider event shapes into the frontend.
- Preserve the surface boundary while improving Lens: making Codex or Claude work better in Lens must never break, hijack, or reclassify ordinary terminal sessions.
