#!/usr/bin/env pwsh
# Release script for MiddleManager
# Usage: ./release.ps1

$ErrorActionPreference = "Stop"

$csprojPath = "Ai.Tlbx.MiddleManager/Ai.Tlbx.MiddleManager.csproj"
$changelogPath = "CHANGELOG.md"

# Read current version
$csproj = Get-Content $csprojPath -Raw
if ($csproj -match '<Version>(\d+)\.(\d+)\.(\d+)</Version>')
{
    $major = [int]$Matches[1]
    $minor = [int]$Matches[2]
    $patch = [int]$Matches[3]
    $currentVersion = "$major.$minor.$patch"
}
else
{
    Write-Error "Could not find version in $csprojPath"
    exit 1
}

Write-Host "Current version: $currentVersion" -ForegroundColor Cyan
Write-Host ""
Write-Host "Release type:"
Write-Host "  [1] patch  ($major.$minor.$($patch + 1))"
Write-Host "  [2] minor  ($major.$($minor + 1).0)"
Write-Host "  [3] major  ($($major + 1).0.0)"
Write-Host ""

$choice = Read-Host "Select [1/2/3]"

switch ($choice)
{
    "1" { $patch++; }
    "2" { $minor++; $patch = 0; }
    "3" { $major++; $minor = 0; $patch = 0; }
    default { Write-Error "Invalid choice"; exit 1 }
}

$newVersion = "$major.$minor.$patch"
$tag = "v$newVersion"

Write-Host ""
Write-Host "New version: $newVersion" -ForegroundColor Green
Write-Host "Tag: $tag" -ForegroundColor Green
Write-Host ""

# Confirm
$confirm = Read-Host "Proceed? [y/N]"
if ($confirm -ne "y" -and $confirm -ne "Y")
{
    Write-Host "Aborted."
    exit 0
}

# Update csproj
$csproj = $csproj -replace '<Version>\d+\.\d+\.\d+</Version>', "<Version>$newVersion</Version>"
Set-Content $csprojPath $csproj -NoNewline

Write-Host "Updated $csprojPath" -ForegroundColor Gray

# Generate changelog entry
$lastTag = git describe --tags --abbrev=0 2>$null
if ($lastTag)
{
    $commits = git log --pretty=format:"- %s" "$lastTag..HEAD"
}
else
{
    $commits = git log --pretty=format:"- %s"
}

$date = Get-Date -Format "yyyy-MM-dd"
$entry = @"
## [$newVersion] - $date

$commits

"@

# Prepend to changelog
if (Test-Path $changelogPath)
{
    $existingChangelog = Get-Content $changelogPath -Raw
    $newChangelog = "# Changelog`n`n$entry`n$($existingChangelog -replace '^# Changelog\s*\n*', '')"
}
else
{
    $newChangelog = "# Changelog`n`n$entry"
}

Set-Content $changelogPath $newChangelog -NoNewline
Write-Host "Updated $changelogPath" -ForegroundColor Gray

# Git operations
git add $csprojPath $changelogPath
git commit -m "Release $tag"
git tag $tag

Write-Host ""
Write-Host "Created commit and tag $tag" -ForegroundColor Green
Write-Host ""
Write-Host "Push to trigger release build:" -ForegroundColor Yellow
Write-Host "  git push && git push --tags" -ForegroundColor White
