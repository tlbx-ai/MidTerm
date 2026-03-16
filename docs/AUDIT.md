# Build Verification & Audit

MidTerm releases are built entirely through GitHub Actions using public CI infrastructure. This document explains how to verify releases and the current limitations of reproducible builds.

## Accountability Model

All release binaries are produced by GitHub Actions with:

- **Public workflow**: [`.github/workflows/release.yml`](.github/workflows/release.yml) defines the complete build process
- **No secrets in build**: Build steps use only public inputs (source code, .NET SDK, Node.js)
- **Immutable build environment**: GitHub-hosted runners with published OS/SDK versions
- **Tamper-evident releases**: Each release includes `checksums.txt` with SHA256 hashes

The accountability comes from GitHub as a trusted third party. The build process has no hidden side-channels—what you see in the workflow file is what runs.

## Verifying a Release

### 1. Check the workflow run

Every release tag triggers a build. Find the corresponding workflow run:

```
https://github.com/tlbx-ai/MidTerm/actions/workflows/release.yml
```

Verify:
- The run was triggered by a tag push (not manual dispatch)
- The commit SHA matches the tagged release
- All build jobs completed successfully

### 2. Verify checksums

Each release includes a `checksums.txt` file and per-platform `SHA256SUMS.txt` inside archives.

```bash
# Download and verify
curl -LO https://github.com/tlbx-ai/MidTerm/releases/download/v5.x.x/checksums.txt
curl -LO https://github.com/tlbx-ai/MidTerm/releases/download/v5.x.x/mt-win-x64.zip

# Extract and check
unzip mt-win-x64.zip
sha256sum -c SHA256SUMS.txt
```

### 3. Inspect the build logs

GitHub Actions logs are public and retained for 90 days. The logs show:
- Exact SDK versions used
- Full compiler output
- Generated checksums

## Reproducible Builds: Current Limitations

### The Goal

Reproducible builds allow anyone to compile the source and get a byte-identical binary, proving the release matches the source code.

### What We've Configured

The project includes reproducible build settings:

```xml
<!-- Directory.Build.props -->
<Deterministic>true</Deterministic>
<ContinuousIntegrationBuild>true</ContinuousIntegrationBuild>
```

Build scripts support reproducible mode:
```bash
# Windows
.\build-aot.ps1 -Reproducible

# Linux/macOS
./build-aot-linux.sh --reproducible
```

### Why AOT Builds Are Not Yet Reproducible

**Tested result**: Building the same source twice with identical settings produces different binaries.

```
Build 1: 83F8A57588C4A59BCE3B887B844E981925E1D50EBB440C9CB073A59191FA7C00
Build 2: 1F7DDB8D04EA869260C943EFD183B5E442D7853C6414ACA906D444197CA61F13
```

The .NET Native AOT compiler (ILC) currently has non-deterministic elements:
- Timestamp or GUID embedding in native code
- Non-deterministic ordering in certain compilation phases
- Platform linker behavior variations

This is a known limitation. The .NET team is working toward fully reproducible AOT builds, but it's not available as of .NET 10.

### What IS Deterministic

- **IL compilation**: The intermediate assembly (`mt.dll`) before AOT is deterministic
- **TypeScript bundle**: `terminal.min.js` is deterministic (esbuild is reproducible)
- **Workflow execution**: Same workflow + same commit = same build steps

## For Auditors

### Trust Model

Since local reproducibility isn't achievable with AOT, trust relies on:

1. **Source code review**: All code is public in this repository
2. **Workflow review**: Build process is fully defined in `.github/workflows/release.yml`
3. **GitHub as build authority**: GitHub Actions provides the trusted execution environment
4. **Checksum consistency**: Hashes in release artifacts match workflow output logs

### Verification Checklist

- [ ] Review source code changes between versions
- [ ] Verify workflow file hasn't been modified to inject malicious steps
- [ ] Confirm release was created by workflow (check Actions tab)
- [ ] Match checksums from release with workflow run logs
- [ ] Verify no manual artifacts were uploaded (all from matrix build jobs)

### Building Locally (For Comparison)

To build locally with the same settings as CI:

```bash
# Requires: .NET 10 SDK, Node.js 24.x, Visual Studio 2022 (Windows)

# 1. Clone at the release tag
git clone https://github.com/tlbx-ai/MidTerm.git
cd MidTerm
git checkout v5.x.x

# 2. Build frontend
npm ci
cd Ai.Tlbx.MidTerm
npx tsc --noEmit
npx esbuild src/ts/main.ts --bundle --minify --sourcemap=linked \
  --outfile=wwwroot/js/terminal.min.js --target=es2020

# 3. Build native binary (reproducible mode)
dotnet publish -c Release -r win-x64 /p:IsPublishing=true /p:ContinuousIntegrationBuild=true

# 4. Compare hash (will differ from release due to AOT non-determinism)
sha256sum bin/Release/net10.0/win-x64/publish/mt.exe
```

**Expected result**: Hash will differ from the release binary. This does NOT indicate tampering—it reflects AOT compiler non-determinism.

## Future Improvements

When .NET achieves reproducible AOT builds:
- Local builds will match CI builds byte-for-byte
- Third-party verification becomes fully independent
- The reproducible build configuration is already in place

Until then, GitHub Actions provides the verifiable build chain.
