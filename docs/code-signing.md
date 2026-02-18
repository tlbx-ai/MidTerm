# Windows Code Signing — SignPath.io

## Status

**Applied 2026-02-18** — Waiting for SignPath Foundation approval (typically days to ~2 weeks).

Application sent to: oss-support@signpath.org with filled OSSRequestForm-v4-filled.xlsx.

## Why

Native AOT compiled Windows binaries (mt.exe, mthost.exe) trigger antivirus false positives.
Authenticode code signing reduces this significantly.

## Chosen Solution: SignPath.io (Free for OSS)

- Free for open source projects
- No Azure account needed
- Provides Authenticode signing via SignPath Foundation certificate
- Certificate stored on their HSM
- GitHub Actions integration via `signpath/github-action-submit-signing-request@v2`
- Origin verification: signing only works from CI builds, not local

### Alternatives Considered

| Option | Why not |
|--------|---------|
| Azure Trusted Signing ($10/mo) | Azure tenant was blocked due to inactivity, instant SmartScreen trust but costs money |
| EV Code Signing Cert ($300-600/yr) | Expensive, requires hardware token or cloud HSM |
| SSL.com eSigner ($200-400/yr) | Costs money, reputation must build over time |

## What Happens After Approval

### 1. SignPath Dashboard Setup

- Install the **SignPath GitHub App** on `tlbx-ai/MidTerm`
- Create an **Artifact Configuration** (sign `mt.exe` and `mthost.exe`)
- Create a **Signing Policy** (release-signing)
- Copy secrets to GitHub repo (`Settings → Secrets → Actions`):
  - `SIGNPATH_API_TOKEN`
  - `SIGNPATH_ORG_ID`
  - Project/policy slugs

### 2. Modify release.yml

Add signing step **after** Windows build, **before** checksums:

```yaml
# After building Windows binaries, before checksums:

- name: Upload unsigned artifacts
  id: upload-unsigned
  uses: actions/upload-artifact@v4
  with:
    name: win-x64-unsigned
    path: staging/

- name: Sign Windows binaries
  if: matrix.runtime == 'win-x64'
  uses: signpath/github-action-submit-signing-request@v2
  with:
    api-token: '${{ secrets.SIGNPATH_API_TOKEN }}'
    organization-id: '${{ secrets.SIGNPATH_ORG_ID }}'
    project-slug: 'midterm'
    signing-policy-slug: 'release-signing'
    github-artifact-id: '${{ steps.upload-unsigned.outputs.artifact-id }}'
    wait-for-completion: true
    output-artifact-directory: staging/

# Then existing sha256sum + sign-release.ps1 run on the now-signed binaries
```

### 3. Pipeline Order (Critical)

```
1. dotnet publish → mt.exe, mthost.exe
2. Copy to staging/
3. ★ Authenticode sign (SignPath) ★
4. Compute SHA256 checksums (covers signed binary)
5. ECDSA sign version.json (existing integrity signing)
6. Package into ZIP
7. Upload to GitHub Release
```

### 4. Add Attribution to Repo

Required by SignPath Foundation terms — add to README or homepage:

> "Windows binaries are code-signed. Free code signing provided by
> [SignPath.io](https://signpath.io), certificate by
> [SignPath Foundation](https://signpath.org)."

### 5. Note: Manual Approval Per Release

SignPath requires a team member to approve each signing request in their dashboard.
This adds one manual click per release. Not fully hands-off.

## Verification

After first signed release:

```powershell
Get-AuthenticodeSignature .\mt.exe
# Status: Valid
# SignerCertificate: [SignPath Foundation subject]
```

## Limitations

- SmartScreen reputation builds over time (not instant like Azure Trusted Signing)
- AOT binaries may still trigger some heuristic scanners — signing reduces but doesn't eliminate all false positives
- Signing only works from GitHub Actions (origin verification), not local builds
