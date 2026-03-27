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
