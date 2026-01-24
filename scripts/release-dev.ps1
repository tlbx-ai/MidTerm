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
    MANDATORY: Does this release require updating mthost? (yes/no)

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
$versionJsonPath = "$PSScriptRoot\..\version.json"
$webCsprojPath = "$PSScriptRoot\..\src\Ai.Tlbx.MidTerm\Ai.Tlbx.MidTerm.csproj"
$ttyHostCsprojPath = "$PSScriptRoot\..\src\Ai.Tlbx.MidTerm.TtyHost\Ai.Tlbx.MidTerm.TtyHost.csproj"
$ttyHostProgramPath = "$PSScriptRoot\..\src\Ai.Tlbx.MidTerm.TtyHost\Program.cs"

# Read current version from version.json
$versionJson = Get-Content $versionJsonPath | ConvertFrom-Json
$currentVersion = $versionJson.web
Write-Host "Current version: $currentVersion" -ForegroundColor Cyan

# Parse current version - strip any existing prerelease suffix
$baseVersion = $currentVersion -replace '-dev(\.\d+)?$', ''
$parts = $baseVersion.Split('.')
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
    Write-Host "Release type: FULL (mt + mthost)" -ForegroundColor Yellow
} else {
    Write-Host "Release type: Web-only (mt only, sessions preserved)" -ForegroundColor Green
}

# Update version.json
$versionJson.web = $newVersion
if ($isPtyBreaking) {
    $versionJson.pty = $newVersion
    if ($versionJson.PSObject.Properties["webOnly"]) {
        $versionJson.PSObject.Properties.Remove("webOnly")
    }
} else {
    # Keep pty version as-is for web-only releases
    $versionJson | Add-Member -NotePropertyName "webOnly" -NotePropertyValue $true -Force
}
$versionJson | ConvertTo-Json | Set-Content $versionJsonPath
Write-Host "  Updated: version.json (web=$newVersion, pty=$($versionJson.pty))" -ForegroundColor Gray

# Update web csproj
$content = Get-Content $webCsprojPath -Raw
$content = $content -replace "<Version>[^<]+</Version>", "<Version>$newVersion</Version>"
Set-Content $webCsprojPath $content -NoNewline
Write-Host "  Updated: Ai.Tlbx.MidTerm.csproj" -ForegroundColor Gray

# Update TtyHost files only for PTY-breaking changes
if ($isPtyBreaking) {
    $content = Get-Content $ttyHostCsprojPath -Raw
    $content = $content -replace "<Version>[^<]+</Version>", "<Version>$newVersion</Version>"
    # FileVersion must be exactly 4 parts - use base version + 0
    $fileVersion = "$major.$minor.$patch.0"
    $content = $content -replace "<FileVersion>[^<]+</FileVersion>", "<FileVersion>$fileVersion</FileVersion>"
    Set-Content $ttyHostCsprojPath $content -NoNewline
    Write-Host "  Updated: Ai.Tlbx.MidTerm.TtyHost.csproj" -ForegroundColor Gray

    $content = Get-Content $ttyHostProgramPath -Raw
    $content = $content -replace 'public const string Version = "[^"]+"', "public const string Version = `"$newVersion`""
    Set-Content $ttyHostProgramPath $content -NoNewline
    Write-Host "  Updated: Ai.Tlbx.MidTerm.TtyHost\Program.cs" -ForegroundColor Gray
} else {
    Write-Host "  Skipped: TtyHost files (web-only release)" -ForegroundColor DarkGray
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
