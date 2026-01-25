#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Creates a new release by bumping version, committing, tagging, and pushing.

.PARAMETER Bump
    Version bump type: major, minor, or patch

.PARAMETER ReleaseTitle
    A concise title for this release (one line, no version number).
    This becomes the commit subject and release headline.

    DO NOT include version numbers - they are added automatically from the tag.

    Good: "Bulletproof self-update with rollback support"
    Bad:  "v5.3.3: Fix bug" (version prefix is redundant)

.PARAMETER ReleaseNotes
    MANDATORY: Array of detailed changelog entries for this release.
    These are user-facing release notes shown in the changelog UI.

    Each entry should be a complete sentence explaining:
    - What changed
    - Why it matters to users
    - Any important technical details

    This is NOT optional. Users deserve to know what changed in each release.

.PARAMETER mthostUpdate
    MANDATORY: Does this release require updating mthost?

    Answer 'yes' if ANY of these are true:
      - Changed Ai.Tlbx.MidTerm.TtyHost/ code
      - Changed Ai.Tlbx.MidTerm.Common/ (shared protocol code)
      - Changed mux WebSocket binary protocol format
      - Changed named pipe protocol between mt and mthost
      - Changed session ID encoding/format
      - Changed any IPC mechanism

    Answer 'no' if ONLY these changed:
      - TypeScript/frontend code
      - CSS/HTML
      - REST API endpoints (not used by mthost)
      - Web-only C# code (endpoints, auth, settings)

    When 'yes': Both mt and mthost versions bumped, terminals restart on update
    When 'no':  Only mt version bumped, terminals survive the update

.EXAMPLE
    .\release.ps1 -Bump patch -ReleaseTitle "Fix settings panel closing unexpectedly" -ReleaseNotes @(
        "Fixed bug where settings panel would close when checking for updates",
        "Update button now correctly shows 'Update & Restart' text",
        "Added session preservation warning in settings panel"
    ) -mthostUpdate no

.EXAMPLE
    .\release.ps1 -Bump minor -ReleaseTitle "Bulletproof self-update with rollback support" -ReleaseNotes @(
        "Complete rewrite of update script with 6-phase process: stop, wait for locks, backup, install, verify, start",
        "Automatic rollback to previous version if update fails at any step",
        "File lock detection with 15 retry attempts before failing",
        "Copy verification ensures files are correctly written before proceeding",
        "Detailed logging to update.log for troubleshooting failed updates",
        "Toast notifications show update success or failure with error details"
    ) -mthostUpdate no

.EXAMPLE
    .\release.ps1 -Bump patch -ReleaseTitle "Fix PTY handle leak on session close" -ReleaseNotes @(
        "Fixed memory leak where PTY handles were not released when closing sessions",
        "Improved cleanup sequence ensures all resources are freed",
        "Affects mthost - terminals will restart during update"
    ) -mthostUpdate yes
#>

param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("major", "minor", "patch")]
    [string]$Bump,

    [Parameter(Mandatory=$true, HelpMessage="A concise title for this release (one line, no version number). This is the commit subject and release headline.")]
    [ValidateNotNullOrEmpty()]
    [string]$ReleaseTitle,

    [Parameter(Mandatory=$true, HelpMessage="REQUIRED: Array of detailed changelog entries. Users deserve to know what changed! Each entry should explain what changed and why it matters.")]
    [ValidateNotNullOrEmpty()]
    [string[]]$ReleaseNotes,

    [Parameter(Mandatory=$true)]
    [ValidateSet("yes", "no")]
    [string]$mthostUpdate
)

$ErrorActionPreference = "Stop"

# Ensure we're on main branch
$currentBranch = git branch --show-current
if ($currentBranch -ne "main") {
    Write-Host ""
    Write-Host "ERROR: release.ps1 must be run from the main branch." -ForegroundColor Red
    Write-Host ""
    Write-Host "Current branch: $currentBranch" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "For dev/prerelease builds, use:" -ForegroundColor Cyan
    Write-Host "  .\release-dev.ps1 -Bump patch -ReleaseTitle '...' -ReleaseNotes @(...) -mthostUpdate no" -ForegroundColor White
    Write-Host ""
    exit 1
}

# Validate ReleaseTitle doesn't contain version prefix
if ($ReleaseTitle -match "^v?\d+\.\d+") {
    Write-Host ""
    Write-Host "ERROR: ReleaseTitle should NOT include a version number." -ForegroundColor Red
    Write-Host ""
    Write-Host "The version is automatically included from the git tag." -ForegroundColor Yellow
    Write-Host "Your title: '$ReleaseTitle'" -ForegroundColor White
    Write-Host ""
    Write-Host "Good examples:" -ForegroundColor Green
    Write-Host "  'Fix settings panel closing unexpectedly'" -ForegroundColor White
    Write-Host "  'Bulletproof self-update with rollback support'" -ForegroundColor White
    Write-Host ""
    exit 1
}

# Validate ReleaseNotes has meaningful content
if ($ReleaseNotes.Count -lt 1 -or ($ReleaseNotes.Count -eq 1 -and $ReleaseNotes[0].Length -lt 20)) {
    Write-Host ""
    Write-Host "ERROR: ReleaseNotes must contain meaningful changelog entries." -ForegroundColor Red
    Write-Host ""
    Write-Host "Users read these notes to understand what changed in each release." -ForegroundColor Yellow
    Write-Host "Each entry should be a complete sentence explaining:" -ForegroundColor Yellow
    Write-Host "  - What changed" -ForegroundColor White
    Write-Host "  - Why it matters to users" -ForegroundColor White
    Write-Host "  - Any important technical details" -ForegroundColor White
    Write-Host ""
    Write-Host "Example:" -ForegroundColor Green
    Write-Host '  -ReleaseNotes @(' -ForegroundColor White
    Write-Host '      "Fixed bug where settings panel would close when checking for updates",' -ForegroundColor White
    Write-Host '      "Added automatic rollback if update fails at any step",' -ForegroundColor White
    Write-Host '      "Toast notifications now show update success or failure with details"' -ForegroundColor White
    Write-Host '  )' -ForegroundColor White
    Write-Host ""
    exit 1
}

# Ensure we're up to date with remote
Write-Host "Checking remote status..." -ForegroundColor Cyan
git fetch origin 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Warning: Could not fetch from remote" -ForegroundColor Yellow
}

$localCommit = git rev-parse HEAD 2>$null
$remoteCommit = git rev-parse origin/main 2>$null
$baseCommit = git merge-base HEAD origin/main 2>$null

if ($localCommit -ne $remoteCommit) {
    if ($baseCommit -eq $localCommit) {
        # Local is behind remote - need to pull
        Write-Host "Local branch is behind remote. Pulling changes..." -ForegroundColor Yellow
        git pull origin main 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host ""
            Write-Host "ERROR: Git pull failed - likely a merge conflict." -ForegroundColor Red
            Write-Host ""
            Write-Host "Please resolve manually:" -ForegroundColor Yellow
            Write-Host "  1. Run: git pull origin main" -ForegroundColor White
            Write-Host "  2. Resolve any merge conflicts" -ForegroundColor White
            Write-Host "  3. Run: git add . && git commit" -ForegroundColor White
            Write-Host "  4. Re-run this release script" -ForegroundColor White
            Write-Host ""
            exit 1
        }
        Write-Host "Pull successful." -ForegroundColor Green
    } elseif ($baseCommit -eq $remoteCommit) {
        # Local is ahead of remote - that's fine, we'll push
        Write-Host "Local branch is ahead of remote (will push new commits)." -ForegroundColor Gray
    } else {
        # Branches have diverged
        Write-Host ""
        Write-Host "ERROR: Local and remote branches have diverged." -ForegroundColor Red
        Write-Host ""
        Write-Host "Please resolve manually:" -ForegroundColor Yellow
        Write-Host "  1. Run: git pull origin main" -ForegroundColor White
        Write-Host "  2. Resolve any merge conflicts" -ForegroundColor White
        Write-Host "  3. Run: git add . && git commit" -ForegroundColor White
        Write-Host "  4. Re-run this release script" -ForegroundColor White
        Write-Host ""
        exit 1
    }
}

# Files to update
$versionJsonPath = "$PSScriptRoot\..\version.json"
# Csproj files read version dynamically from version.json - no paths needed

# Read current version from version.json
$versionJson = Get-Content $versionJsonPath | ConvertFrom-Json
$currentVersion = $versionJson.web
Write-Host "Current version: $currentVersion" -ForegroundColor Cyan

# Parse and bump version (strip -dev suffix and 4th component if present)
$baseVersion = $currentVersion -replace '-dev$', ''
$parts = $baseVersion.Split('.')
$major = [int]$parts[0]
$minor = [int]$parts[1]
$patch = [int]$parts[2]

if ($currentVersion -match '-dev$') {
    Write-Host "  (Promoting from dev version to stable release)" -ForegroundColor Yellow
} elseif ($parts.Count -eq 4) {
    Write-Host "  (Promoting from local dev version to release)" -ForegroundColor Yellow
}

switch ($Bump) {
    "major" { $major++; $minor = 0; $patch = 0 }
    "minor" { $minor++; $patch = 0 }
    "patch" { $patch++ }
}

$newVersion = "$major.$minor.$patch"
Write-Host "New version: $newVersion" -ForegroundColor Green

# Determine release type
$isPtyBreaking = $mthostUpdate -eq "yes"
if ($isPtyBreaking) {
    Write-Host "Release type: FULL (mt + mthost)" -ForegroundColor Yellow
} else {
    Write-Host "Release type: Web-only (mt only, sessions preserved)" -ForegroundColor Green
}

# Update version.json
$versionJson.web = $newVersion
if ($isPtyBreaking) {
    $versionJson.pty = $newVersion
    # Remove webOnly flag for PTY-breaking releases (mthost checksum will be included)
    if ($versionJson.PSObject.Properties["webOnly"]) {
        $versionJson.PSObject.Properties.Remove("webOnly")
    }
} else {
    # Strip 4th component from pty if present (from local release)
    $ptyParts = $versionJson.pty.Split('.')
    if ($ptyParts.Count -eq 4) {
        $versionJson.pty = "$($ptyParts[0]).$($ptyParts[1]).$($ptyParts[2])"
    }
    # Mark as web-only release so sign-release.ps1 skips mthost checksum
    $versionJson | Add-Member -NotePropertyName "webOnly" -NotePropertyValue $true -Force
}
$versionJson | ConvertTo-Json | Set-Content $versionJsonPath
Write-Host "  Updated: version.json (web=$newVersion, pty=$($versionJson.pty))" -ForegroundColor Gray

# Web csproj reads version dynamically from version.json - no update needed

# TtyHost csproj reads version dynamically from version.json - no update needed
if ($isPtyBreaking) {
    Write-Host "  TtyHost: will use pty version from version.json" -ForegroundColor Gray
} else {
    Write-Host "  TtyHost: skipped (web-only release)" -ForegroundColor DarkGray
}

# Git operations
Write-Host ""
Write-Host "Committing and tagging..." -ForegroundColor Cyan

git add -A
if ($LASTEXITCODE -ne 0) { throw "git add failed" }

# Build commit/tag message: Title + Release Notes
# Version is in the tag name, not in the message body
$commitMsg = "$ReleaseTitle`n`n"
foreach ($note in $ReleaseNotes) {
    $commitMsg += "- $note`n"
}

$commitMsg | git commit -F -
if ($LASTEXITCODE -ne 0) { throw "git commit failed" }

$commitMsg | git tag -a "v$newVersion" -F -
if ($LASTEXITCODE -ne 0) { throw "git tag failed" }

git push origin main
if ($LASTEXITCODE -ne 0) { throw "git push main failed" }

git push origin "v$newVersion"
if ($LASTEXITCODE -ne 0) { throw "git push tag failed" }

Write-Host ""
Write-Host "Released v$newVersion" -ForegroundColor Green
Write-Host "Monitor build: https://github.com/tlbx-ai/MidTerm/actions" -ForegroundColor Cyan
