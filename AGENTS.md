This terminal runs inside MidTerm (web terminal multiplexer).

If `.midterm/AGENTS.md` exists, follow it for browser control and tmux workflows.
If it does not exist, do not assume extra MidTerm-specific workflow permissions.

## Release Authority

Do not run release, tag, publish, promote, or merge-to-main workflows unless the user explicitly authorizes that exact action in the current turn.

Rules:
- "Cut a dev/prerelease" does not imply "promote to stable".
- If the user says "patch release", "minor release", or "major release" without specifying stable vs dev, default to a dev/prerelease.
- Only treat it as a stable release when the user explicitly says stable, promote, or otherwise clearly asks for the stable path.
- Never run `scripts/promote.ps1`, create or push release tags, publish release artifacts, or merge release PRs without explicit approval.
- For urgent fixes, implement and verify the change first, then stop before release or promotion unless the user explicitly says to continue.
