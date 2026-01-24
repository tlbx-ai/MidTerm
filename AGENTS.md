# Repository Guidelines

## Project Structure & Module Organization
MidTerm is a .NET 10 solution under src/. Ai.Tlbx.MidTerm hosts the ASP.NET Core service, with shared helpers in Ai.Tlbx.MidTerm.Common, a terminal bridge in Ai.Tlbx.MidTerm.TtyHost, and optional voice features in Ai.Tlbx.MidTerm.Voice. TypeScript UI assets live in src/Ai.Tlbx.MidTerm/src/ts, and compiled bundles emit into wwwroot/js. Integration and unit tests are split between src/Ai.Tlbx.MidTerm.Tests and src/Ai.Tlbx.MidTerm.UnitTests. Marketing assets sit in docs/marketing, while installer scripts are in scripts/ and install.*.

## Build, Test, and Development Commands
- dotnet build src/Ai.Tlbx.MidTerm/Ai.Tlbx.MidTerm.csproj — compile the core service with deterministic flags from Directory.Build.props.
- 
pm run build — type-check and bundle the terminal UI via esbuild.
- 
pm run watch / 
pm run watch:typecheck — live rebuild the front-end while editing TS.
- dotnet test src/Ai.Tlbx.MidTerm.Tests/Ai.Tlbx.MidTerm.Tests.csproj — integration suite that boots the server with Microsoft.AspNetCore.Mvc.Testing.
- dotnet test src/Ai.Tlbx.MidTerm.UnitTests/Ai.Tlbx.MidTerm.UnitTests.csproj — fast unit suite for Common helpers.
- Platform AOT builds run via src/Ai.Tlbx.MidTerm/build-aot-*.sh or .cmd.

## Coding Style & Naming Conventions
Follow the rules in docs/CONTRIBUTING.md and CLAUDE.md: Allman braces, 4-space indentation, explicit access modifiers, and _camelCase private fields for C#. TypeScript uses K&R braces, 2 spaces, single quotes, and required semicolons. Run 
pm run lint and 
pm run format before pushing; prefer small, focused files and keep async flows documented with brief header comments when behavior is non-obvious.

## Testing Guidelines
xUnit drives all suites (see the PackageReference metadata). Name test files *Tests.cs and methods MethodName_Scenario_Expectation. Integration specs should spin up the full host with the provided WebApplicationFactory helpers; keep shared setup in TestCleanupHelper. Aim for meaningful branch coverage on terminal session lifecycle, and update or add tests in both suites when editing shared abstractions. Always run both dotnet test commands locally and attach logs if CI fails.

## Commit & Pull Request Guidelines
History favors short, imperative subjects (e.g., "Fix File Radar matching partial paths"). Keep body text focused on rationale and regressions prevented. Each PR must confirm dotnet build, both dotnet test invocations, and the relevant npm scripts in its description. Link the tracking issue, outline manual validation steps, and include UI screenshots or recordings whenever the web client changes. Submitting the PR affirms acceptance of the CLA, so mention that teammates understand dual-licensing expectations.

## Security & Configuration Tips
Never commit generated settings.json files; point reviewers to %ProgramData%/MidTerm or ~/.MidTerm/settings.json instead. Treat installer passwords and API tokens as secrets—use environment variables or user-level config. When testing remote access, prefer Tailscale or Cloudflare Tunnel configurations documented in README.md, ensuring authentication stays enabled during demos.
