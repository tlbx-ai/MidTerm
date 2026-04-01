#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Creates a dev/prerelease by bumping version, committing, tagging, and pushing.

.DESCRIPTION
    Similar to release.ps1 but creates prerelease tags (v6.10.30-dev.1) on the dev branch.
    The -dev.N suffix auto-increments based on existing dev tags for the base version.

.PARAMETER Bump
    Version bump type: major, minor, or patch.
    Only applies when starting a new base version. If continuing dev builds on the same
    base version, the -dev.N suffix increments automatically.

.PARAMETER ReleaseTitle
    A concise title for this release (one line, no version number).

.PARAMETER ReleaseNotes
    MANDATORY: Array of detailed changelog entries for this release.

.PARAMETER mthostUpdate
    MANDATORY: Is this a low-level runtime refresh? (yes/no)

    This is intentionally a single release decision. There is no separate
    mtagenthost release switch.

    Answer 'yes' if ANY of these are true:
      - Changed Ai.Tlbx.MidTerm.TtyHost/ code
      - Changed Ai.Tlbx.MidTerm.AgentHost/ in a way that must ship to running installs
      - Changed Ai.Tlbx.MidTerm.Common/ (shared protocol/runtime code)
      - Changed mux WebSocket binary protocol format
      - Changed named pipe protocol between mt and mthost
      - Changed Lens runtime IPC/attach contracts
      - Changed any IPC mechanism

    Answer 'no' if ONLY these changed:
      - TypeScript/frontend code
      - CSS/HTML
      - REST API endpoints
      - Web-only C# code
      - Lens/UI changes that do not require refreshing installed host binaries

    When 'yes': Full update. Running installs refresh both mthost and mtagenthost.
    When 'no':  Web-only update. Running installs preserve their current mthost and mtagenthost.

.EXAMPLE
    .\release-dev.ps1 -Bump patch -ReleaseTitle "Test new feature" -ReleaseNotes @(
        "Added experimental feature X for testing"
    ) -mthostUpdate no
#>

param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("major", "minor", "patch")]
    [string]$Bump,

    [Parameter(Mandatory=$true)]
    [ValidateNotNullOrEmpty()]
    [string]$ReleaseTitle,

    [Parameter(Mandatory=$true)]
    [ValidateNotNullOrEmpty()]
    [string[]]$ReleaseNotes,

    [Parameter(Mandatory=$true)]
    [ValidateSet("yes", "no")]
    [string]$mthostUpdate
)

$ErrorActionPreference = "Stop"

# Ensure we're on dev branch
$currentBranch = git branch --show-current
if ($currentBranch -ne "dev") {
    Write-Host ""
    Write-Host "ERROR: release-dev.ps1 must be run from the dev branch." -ForegroundColor Red
    Write-Host ""
    Write-Host "Current branch: $currentBranch" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "For stable releases, switch to main and use:" -ForegroundColor Cyan
    Write-Host "  .\release.ps1 -Bump patch -ReleaseTitle '...' -ReleaseNotes @(...) -mthostUpdate no" -ForegroundColor White
    Write-Host ""
    exit 1
}

# Validate ReleaseTitle doesn't contain version prefix
if ($ReleaseTitle -match "^v?\d+\.\d+") {
    Write-Host ""
    Write-Host "ERROR: ReleaseTitle should NOT include a version number." -ForegroundColor Red
    exit 1
}

# Validate ReleaseNotes has meaningful content
if ($ReleaseNotes.Count -lt 1 -or ($ReleaseNotes.Count -eq 1 -and $ReleaseNotes[0].Length -lt 20)) {
    Write-Host ""
    Write-Host "ERROR: ReleaseNotes must contain meaningful changelog entries." -ForegroundColor Red
    exit 1
}

# Ensure we're up to date with remote
Write-Host "Checking remote status..." -ForegroundColor Cyan
git fetch origin 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Warning: Could not fetch from remote" -ForegroundColor Yellow
}

$localCommit = git rev-parse HEAD 2>$null
$remoteCommit = git rev-parse origin/dev 2>$null
$baseCommit = git merge-base HEAD origin/dev 2>$null

if ($localCommit -ne $remoteCommit) {
    if ($baseCommit -eq $localCommit) {
        Write-Host "Local branch is behind remote. Pulling changes..." -ForegroundColor Yellow
        git pull origin dev 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host ""
            Write-Host "ERROR: Git pull failed - likely a merge conflict." -ForegroundColor Red
            exit 1
        }
        Write-Host "Pull successful." -ForegroundColor Green
    } elseif ($baseCommit -eq $remoteCommit) {
        Write-Host "Local branch is ahead of remote (will push new commits)." -ForegroundColor Gray
    } else {
        Write-Host ""
        Write-Host "ERROR: Local and remote branches have diverged." -ForegroundColor Red
        Write-Host "Please resolve manually with: git pull origin dev" -ForegroundColor Yellow
        exit 1
    }
}

# Files to update
$versionJsonPath = "$PSScriptRoot\..\src\version.json"
# Csproj files read version dynamically from version.json - no paths needed

# Read current version from version.json
$versionJson = Get-Content $versionJsonPath | ConvertFrom-Json
$currentVersion = $versionJson.web
Write-Host "Current version: $currentVersion" -ForegroundColor Cyan

# Dev versions must be >= main's version. Use the higher of dev/main as the base.
$devBase = $currentVersion -replace '-dev(\.\d+)?$', ''
try {
    $mainJson = git show main:src/version.json 2>$null | ConvertFrom-Json
    $mainBase = $mainJson.web -replace '-dev(\.\d+)?$', ''
    if ([version]$mainBase -gt [version]$devBase) {
        Write-Host "  Using main's version ($mainBase) as base (ahead of dev's $devBase)" -ForegroundColor Yellow
        $devBase = $mainBase
    }
} catch {
    Write-Host "  Warning: Could not read main's version, using dev base" -ForegroundColor Yellow
}

$parts = $devBase.Split('.')
$major = [int]$parts[0]
$minor = [int]$parts[1]
$patch = [int]$parts[2]

# Bump the base version
switch ($Bump) {
    "major" { $major++; $minor = 0; $patch = 0 }
    "minor" { $minor++; $patch = 0 }
    "patch" { $patch++ }
}

$newVersion = "$major.$minor.$patch-dev"
Write-Host "New version: $newVersion" -ForegroundColor Green

# Determine release type
$isPtyBreaking = $mthostUpdate -eq "yes"
if ($isPtyBreaking) {
    Write-Host "Release type: FULL runtime refresh (running installs replace mthost + mtagenthost)" -ForegroundColor Yellow
} else {
    Write-Host "Release type: Web-only updater (running installs preserve mthost + mtagenthost; archives may still include host binaries)" -ForegroundColor Green
}

# Update version.json
$versionJson.web = $newVersion
if ($isPtyBreaking) {
    $versionJson.pty = $newVersion
    if ($versionJson.PSObject.Properties["webOnly"]) {
        $versionJson.PSObject.Properties.Remove("webOnly")
    }
} else {
    # Keep pty version as-is, but ensure it's not behind main's pty version
    try {
        $mainPtyBase = $mainJson.pty -replace '-dev(\.\d+)?$', ''
        $devPtyBase = $versionJson.pty -replace '-dev(\.\d+)?$', ''
        if ([version]$mainPtyBase -gt [version]$devPtyBase) {
            $versionJson.pty = "$mainPtyBase-dev"
            Write-Host "  Synced pty version to main's $mainPtyBase" -ForegroundColor Yellow
        }
    } catch {
        # mainJson may not exist if main fetch failed
    }
    # Mark as web-only so running installs preserve the currently installed host runtimes.
    $versionJson | Add-Member -NotePropertyName "webOnly" -NotePropertyValue $true -Force
}
$versionJson | ConvertTo-Json | Set-Content $versionJsonPath
Write-Host "  Updated: version.json (web=$newVersion, pty=$($versionJson.pty))" -ForegroundColor Gray
$syncNpxLauncherScript = Join-Path $PSScriptRoot "sync-npx-launcher-version.mjs"
node $syncNpxLauncherScript $newVersion
if ($LASTEXITCODE -ne 0) { throw "Failed to sync npx launcher version" }
Write-Host "  Synced: src/npx-launcher/package.json" -ForegroundColor Gray

# Web csproj reads version dynamically from version.json - no update needed

# TtyHost csproj reads version dynamically from version.json - no update needed
if ($isPtyBreaking) {
    Write-Host "  TtyHost: will use pty version from version.json" -ForegroundColor Gray
} else {
    Write-Host "  Host runtimes: release archives may still ship them, but running installs stay on their current mthost + mtagenthost" -ForegroundColor DarkGray
}

# Pre-release build verification (catches ESLint, TypeScript, C# errors before committing)
Write-Host ""
Write-Host "Running build verification..." -ForegroundColor Cyan
$buildResult = dotnet build "$PSScriptRoot\..\src\Ai.Tlbx.MidTerm\Ai.Tlbx.MidTerm.csproj" -c Release 2>&1
$buildExitCode = $LASTEXITCODE
$buildLines = @($buildResult | ForEach-Object { "$_" })
$hasReinvokeSentinel = $buildLines | Where-Object { $_ -match '_REINVOKE_SUCCESS_' }
$realErrorLines = $buildLines | Where-Object { $_ -match ':\s*error\b' -and $_ -notmatch '_REINVOKE_SUCCESS_' }
$reinvokeOnlyFailure = $buildExitCode -ne 0 -and $hasReinvokeSentinel -and $realErrorLines.Count -eq 0
if ($buildExitCode -ne 0 -and -not $reinvokeOnlyFailure) {
    Write-Host ""
    Write-Host "ERROR: Build failed — aborting release before any git changes." -ForegroundColor Red
    Write-Host ""
    Write-Host "Build output:" -ForegroundColor Yellow
    $buildLines | ForEach-Object { Write-Host "  $_" }
    Write-Host ""
    Write-Host "Fix the build errors and try again." -ForegroundColor Yellow
    # Revert version changes
    git checkout -- $versionJsonPath "$PSScriptRoot\..\src\npx-launcher\package.json" 2>$null
    exit 1
}
if ($reinvokeOnlyFailure) {
    Write-Host "Build succeeded via frontend reinvoke." -ForegroundColor Green
} else {
Write-Host "Build succeeded." -ForegroundColor Green
}

# Git operations
Write-Host ""
Write-Host "Committing and tagging..." -ForegroundColor Cyan

git add -A
if ($LASTEXITCODE -ne 0) { throw "git add failed" }

$commitMsg = "$ReleaseTitle`n`n"
foreach ($note in $ReleaseNotes) {
    $commitMsg += "- $note`n"
}

$commitMsg | git commit -F -
if ($LASTEXITCODE -ne 0) { throw "git commit failed" }

$commitMsg | git tag -a "v$newVersion" -F -
if ($LASTEXITCODE -ne 0) { throw "git tag failed" }

git push origin dev
if ($LASTEXITCODE -ne 0) { throw "git push dev failed" }

git push origin "v$newVersion"
if ($LASTEXITCODE -ne 0) { throw "git push tag failed" }

Write-Host ""
Write-Host "Released v$newVersion (prerelease)" -ForegroundColor Green
Write-Host "Monitor build: https://github.com/tlbx-ai/MidTerm/actions" -ForegroundColor Cyan
