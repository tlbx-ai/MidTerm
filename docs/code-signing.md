# Windows Code Signing

## Status

**Active** — Using Certum "Open Source Code Signing in the cloud" certificate on a self-hosted GitHub Actions runner for stable releases. Dev releases are unsigned.

**Pending backup** — SignPath.io application submitted 2026-02-18 (free for OSS). If approved, would eliminate the manual SimplySign authentication step.

## Certificate Details

| Field | Value |
|-------|-------|
| Provider | Certum (by Asseco) |
| Product | Open Source Code Signing in the cloud, 365 days |
| CN | Open Source Developer Johannes Schmidt |
| Organization | Open Source Developer |
| Valid until | 2027-02-25 |
| Key storage | Certum cloud HSM (accessed via SimplySign Desktop) |
| Timestamp server | `http://time.certum.pl` |

## How It Works

Certum cloud certificates keep the private key on their HSM. Signing requires:

1. **SimplySign Desktop** running on the signing machine (provides a virtual smart card / CSP)
2. **SimplySign mobile app** for 2FA authentication (approx 2-hour session window)
3. **signtool.exe** uses the certificate via the SimplySign CSP

There is no headless/CLI API — each signing session requires mobile app confirmation.

## Release Signing Strategy

| Release type | Runner | Signing |
|-------------|--------|---------|
| Dev (`-dev` tags) | GitHub-hosted `windows-latest` | None |
| Stable (main branch) | Self-hosted `[self-hosted, windows, signing]` | Certum Authenticode via SimplySign |

macOS and Linux builds always run on GitHub-hosted runners regardless.

## Signing Flow (Stable Releases)

```
1. Tag push triggers release.yml
2. prepare job determines is_dev=false
3. build-windows job runs on self-hosted runner
4. dotnet publish builds mt.exe + mthost.exe
5. sign-windows-binaries.ps1 runs:
   a. Plays notification sound (5 system beeps + Windows toast)
   b. Checks/launches SimplySign Desktop
   c. Retries signtool every 15s for up to 10 minutes
   d. YOU: authenticate in SimplySign mobile app when you hear the bing
   e. signtool signs both binaries with SHA256 + timestamp
   f. Verifies signatures
6. SHA256SUMS generated (covers signed binaries)
7. ECDSA signs version.json (existing integrity signing)
8. Packaged as ZIP, uploaded to GitHub Release
```

## Self-Hosted Runner Setup

### Prerequisites
- Windows 10/11 machine (your dev machine)
- .NET 10 SDK
- SimplySign Desktop (installed + activated)
- Windows SDK (for signtool.exe)
- PowerShell 7+
- 7-Zip (for `7z` command in CI)

### Installation
1. GitHub repo → Settings → Actions → Runners → "New self-hosted runner"
2. OS: Windows, Architecture: x64
3. Labels: `self-hosted`, `windows`, `signing`
4. Run interactively (not as service) — needed for sound notifications and SimplySign UI
5. Ensure runner is running before triggering a stable release

### signtool Location
The signing script auto-discovers signtool from PATH or Windows SDK:
`C:\Program Files (x86)\Windows Kits\10\bin\<version>\x64\signtool.exe`

## Local Testing

```powershell
# Build a test binary
dotnet publish src/Ai.Tlbx.MidTerm/Ai.Tlbx.MidTerm.csproj -c Release -r win-x64 -p:IsPublishing=true --verbosity minimal

# Ensure SimplySign Desktop is running and authenticated

# Sign
signtool sign /a /tr http://time.certum.pl /td sha256 /fd sha256 `
  src\Ai.Tlbx.MidTerm\bin\Release\net10.0\win-x64\publish\mt.exe

# Verify
Get-AuthenticodeSignature src\Ai.Tlbx.MidTerm\bin\Release\net10.0\win-x64\publish\mt.exe
```

If multiple certificates are installed, use `/sha1 <thumbprint>` instead of `/a`.

## Key Files

| File | Purpose |
|------|---------|
| `.github/workflows/release.yml` | CI workflow — build-windows job with conditional signing |
| `scripts/sign-windows-binaries.ps1` | Signing script with notification, retry loop, verification |
| `scripts/sign-release.ps1` | ECDSA signature for version.json (all platforms) |

## Alternatives Considered

| Option | Status |
|--------|--------|
| SignPath.io (free OSS) | Application pending since 2026-02-18. Would eliminate manual step. |
| Azure Trusted Signing ($10/mo) | Azure tenant blocked due to inactivity |
| SSL.com eSigner ($200-400/yr) | Costs money, reputation builds over time |
| Full Certum automation (TOTP hack) | Fragile, 2-hour window, not officially supported |
