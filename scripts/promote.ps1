#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Promotes the current dev version to a stable release on main.

.DESCRIPTION
    This script automates the promotion of a dev release to stable:
    1. Verifies we're on dev branch with a -dev version
    2. Creates and merges a PR from dev to main
    3. Updates version.json to remove -dev suffix
    4. Creates a git tag and pushes to trigger GitHub Actions build

.PARAMETER ReleaseTitle
    A concise title for this release (one line, no version number).

.PARAMETER ReleaseNotes
    MANDATORY: Array of detailed changelog entries for this release.

.EXAMPLE
    .\promote.ps1 -ReleaseTitle "Version management improvements" -ReleaseNotes @(
        "Centralized version management: version.json is now single source of truth",
        "Fixed update failures where wrong version was baked into binaries"
    )
#>

param(
    [Parameter(Mandatory=$true)]
    [ValidateNotNullOrEmpty()]
    [string]$ReleaseTitle,

    [Parameter(Mandatory=$true)]
    [ValidateNotNullOrEmpty()]
    [string[]]$ReleaseNotes
)

$ErrorActionPreference = "Stop"

# Ensure we're on dev branch
$currentBranch = git branch --show-current
if ($currentBranch -ne "dev") {
    Write-Host ""
    Write-Host "ERROR: promote.ps1 must be run from the dev branch." -ForegroundColor Red
    Write-Host "Current branch: $currentBranch" -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

# Read current version
$versionJsonPath = "$PSScriptRoot\..\version.json"
$versionJson = Get-Content $versionJsonPath | ConvertFrom-Json
$devVersion = $versionJson.web

# Verify it's a dev version
if ($devVersion -notmatch '-dev$') {
    Write-Host ""
    Write-Host "ERROR: Current version '$devVersion' is not a dev version." -ForegroundColor Red
    Write-Host "Only versions ending in -dev can be promoted." -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

# Calculate stable version
$stableVersion = $devVersion -replace '-dev$', ''

Write-Host ""
Write-Host "  MidTerm Promotion" -ForegroundColor Cyan
Write-Host "  =================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Dev version:    $devVersion" -ForegroundColor Gray
Write-Host "  Stable version: $stableVersion" -ForegroundColor Green
Write-Host ""

# Ensure dev is up to date
Write-Host "Syncing with remote..." -ForegroundColor Gray
git fetch origin 2>$null
git pull origin dev 2>&1 | Out-Null

# Check for uncommitted changes
$status = git status --porcelain
if ($status) {
    Write-Host ""
    Write-Host "ERROR: Uncommitted changes in working directory." -ForegroundColor Red
    Write-Host "Commit or stash changes before promoting." -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

# Create PR from dev to main
Write-Host "Creating PR from dev to main..." -ForegroundColor Gray

$prBody = "## Summary`n"
foreach ($note in $ReleaseNotes) {
    $prBody += "- $note`n"
}
$prBody += "`n## Release`n"
$prBody += "Promoting $devVersion to stable $stableVersion"

$prUrl = gh pr create --base main --head dev --title $ReleaseTitle --body $prBody 2>&1
if ($LASTEXITCODE -ne 0) {
    # PR might already exist
    if ($prUrl -match "already exists") {
        Write-Host "  PR already exists, finding it..." -ForegroundColor Yellow
        $prUrl = gh pr list --head dev --base main --json url --jq '.[0].url' 2>&1
    } else {
        Write-Host "ERROR: Failed to create PR: $prUrl" -ForegroundColor Red
        exit 1
    }
}
Write-Host "  PR: $prUrl" -ForegroundColor Gray

# Merge the PR
Write-Host "Merging PR..." -ForegroundColor Gray
gh pr merge --merge --delete-branch=false 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to merge PR. Check GitHub for details." -ForegroundColor Red
    exit 1
}

# Switch to main and pull
Write-Host "Switching to main..." -ForegroundColor Gray
git checkout main 2>&1 | Out-Null
git pull origin main 2>&1 | Out-Null

# Update version.json to stable version
Write-Host "Updating version to $stableVersion..." -ForegroundColor Gray
$versionJson = Get-Content $versionJsonPath | ConvertFrom-Json
$versionJson.web = $stableVersion
$versionJson | ConvertTo-Json | Set-Content $versionJsonPath

# Build commit message
$commitMsg = "$ReleaseTitle`n`n"
foreach ($note in $ReleaseNotes) {
    $commitMsg += "- $note`n"
}

# Commit, tag, and push
Write-Host "Committing and tagging v$stableVersion..." -ForegroundColor Gray
git add -A
$commitMsg | git commit -F -
if ($LASTEXITCODE -ne 0) { throw "git commit failed" }

$commitMsg | git tag -a "v$stableVersion" -F -
if ($LASTEXITCODE -ne 0) { throw "git tag failed" }

git push origin main
if ($LASTEXITCODE -ne 0) { throw "git push main failed" }

git push origin "v$stableVersion"
if ($LASTEXITCODE -ne 0) { throw "git push tag failed" }

# Switch back to dev and sync
Write-Host "Syncing dev with main..." -ForegroundColor Gray
git checkout dev 2>&1 | Out-Null
git merge main -m "Merge main v$stableVersion into dev" 2>&1 | Out-Null
git push origin dev 2>&1 | Out-Null

Write-Host ""
Write-Host "Promoted v$stableVersion" -ForegroundColor Green
Write-Host "Monitor build: https://github.com/tlbx-ai/MidTerm/actions" -ForegroundColor Cyan
Write-Host ""
