#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Promotes the current dev version to a stable release on main.

.DESCRIPTION
    This script automates the promotion of a dev release to stable:
    1. Verifies we're on dev branch with a -dev version
    2. Auto-gathers changelog from all dev tag annotations since the last stable release
    3. Creates and merges a PR from dev to main
    4. Updates version.json to remove -dev suffix
    5. Creates a git tag and pushes to trigger GitHub Actions build

.PARAMETER ReleaseTitle
    Optional. A concise title for this release (one line, no version number).
    If omitted, uses the most recent dev release title.

.PARAMETER ReleaseNotes
    Optional. Array of detailed changelog entries. If omitted, automatically
    gathered from all dev tag annotations since the last stable release.

.EXAMPLE
    # Auto-gather all changelog items (recommended)
    .\promote.ps1

.EXAMPLE
    # Override title, still auto-gather notes
    .\promote.ps1 -ReleaseTitle "Major UI overhaul"

.EXAMPLE
    # Fully manual (legacy behavior)
    .\promote.ps1 -ReleaseTitle "Version management improvements" -ReleaseNotes @(
        "Centralized version management: version.json is now single source of truth",
        "Fixed update failures where wrong version was baked into binaries"
    )
#>

param(
    [string]$ReleaseTitle,
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

# Find last stable tag (non-dev, sorted by version descending)
$lastStableTag = git tag --sort=-v:refname | Where-Object { $_ -notmatch '-dev' } | Select-Object -First 1
$lastStableVersion = [version]($lastStableTag -replace '^v', '')

Write-Host ""
Write-Host "  MidTerm Promotion" -ForegroundColor Cyan
Write-Host "  =================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Dev version:    $devVersion" -ForegroundColor Gray
Write-Host "  Stable version: $stableVersion" -ForegroundColor Green
Write-Host "  Last stable:    $lastStableTag" -ForegroundColor Gray
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

# --- Auto-gather changelog from dev tags since last stable release ---

Write-Host "Gathering changelog from dev releases since $lastStableTag..." -ForegroundColor Gray

# Get all dev tags sorted by version, filter to those newer than last stable
$allDevTags = git tag --sort=version:refname | Where-Object { $_ -match '-dev$' }
$devTagsInRange = @()
foreach ($tag in $allDevTags) {
    $baseVer = $tag -replace '^v', '' -replace '-dev(\.\d+)?$', ''
    try {
        if ([version]$baseVer -gt $lastStableVersion) {
            $devTagsInRange += $tag
        }
    } catch {
        # Skip tags with unparseable versions
    }
}

if ($devTagsInRange.Count -eq 0) {
    Write-Host ""
    Write-Host "ERROR: No dev tags found since $lastStableTag. Nothing to promote." -ForegroundColor Red
    Write-Host ""
    exit 1
}

# Parse each tag's annotation
$changelog = @()
foreach ($tag in $devTagsInRange) {
    $annotation = git tag -l --format='%(contents)' $tag
    if (-not $annotation) { continue }
    $lines = $annotation -split "`n"
    $title = $lines[0].Trim()
    $bullets = @($lines | Where-Object { $_ -match '^\s*-\s+' } | ForEach-Object { $_.Trim() })
    $changelog += [PSCustomObject]@{
        Tag    = $tag
        Title  = $title
        Notes  = $bullets
    }
}

Write-Host "  Found $($changelog.Count) dev releases since ${lastStableTag}:" -ForegroundColor Gray
foreach ($entry in $changelog) {
    $noteCount = $entry.Notes.Count
    Write-Host "    $($entry.Tag): $($entry.Title) ($noteCount notes)" -ForegroundColor DarkGray
}
Write-Host ""

# Use auto-gathered data if parameters not provided
if (-not $ReleaseTitle) {
    $ReleaseTitle = $changelog[-1].Title
    if (-not $ReleaseTitle) { $ReleaseTitle = "Stable release $stableVersion" }
    Write-Host "  Title (from latest dev): $ReleaseTitle" -ForegroundColor Gray
}

$autoGathered = $false
if (-not $ReleaseNotes) {
    $autoGathered = $true
    $ReleaseNotes = @()
    foreach ($entry in $changelog) {
        foreach ($note in $entry.Notes) {
            $ReleaseNotes += $note -replace '^\s*-\s+', ''
        }
    }
    Write-Host "  Auto-gathered $($ReleaseNotes.Count) changelog entries" -ForegroundColor Gray
}

if ($ReleaseNotes.Count -eq 0) {
    Write-Host ""
    Write-Host "ERROR: No changelog entries found. Dev tags may have empty annotations." -ForegroundColor Red
    Write-Host "Provide -ReleaseNotes manually." -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

# --- Build PR body (markdown, grouped by dev release) ---

$prBody = "## Summary`n"
$prBody += "Promoting ``$devVersion`` to stable ``$stableVersion`` - includes $($changelog.Count) dev releases since $lastStableTag.`n`n"
$prBody += "## Changelog`n"
foreach ($entry in $changelog) {
    $prBody += "`n### $($entry.Tag) - $($entry.Title)`n"
    foreach ($note in $entry.Notes) {
        $prBody += "$note`n"
    }
}

# --- Build commit/tag message (plain text, grouped by dev release) ---

$commitMsg = "$ReleaseTitle`n`n"
if ($autoGathered) {
    $commitMsg += "All changes since $($lastStableTag):`n`n"
    foreach ($entry in $changelog) {
        $commitMsg += "$($entry.Tag): $($entry.Title)`n"
        foreach ($note in $entry.Notes) {
            $commitMsg += "$note`n"
        }
        $commitMsg += "`n"
    }
} else {
    foreach ($note in $ReleaseNotes) {
        $commitMsg += "- $note`n"
    }
}

# Create PR from dev to main
Write-Host "Creating PR from dev to main..." -ForegroundColor Gray

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
Write-Host "Promoted v$stableVersion ($($changelog.Count) dev releases, $($ReleaseNotes.Count) changelog entries)" -ForegroundColor Green
Write-Host "Monitor build: https://github.com/tlbx-ai/MidTerm/actions" -ForegroundColor Cyan
Write-Host ""
