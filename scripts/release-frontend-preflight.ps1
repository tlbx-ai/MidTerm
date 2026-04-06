#!/usr/bin/env pwsh

param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Version,

    [switch]$DevRelease,

    [switch]$SkipLinuxParity
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$FrontendRootRelative = "src/Ai.Tlbx.MidTerm"
$FrontendBuildScriptHostRelative = Join-Path $FrontendRootRelative "frontend-build.ps1"
$FrontendBuildScriptLinuxRelative = "$FrontendRootRelative/frontend-build.ps1"
$LinuxPreflightImage = "midterm-release-frontend-preflight:dotnet10-node24-pwsh"
$LinuxPreflightDockerfile = Join-Path $PSScriptRoot "release-linux-frontend-preflight.Dockerfile"

function Invoke-Git {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $null = & git @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "git $($Arguments -join ' ') failed"
    }
}

function New-ReleaseFrontendSnapshot {
    Push-Location $RepoRoot
    try {
        $snapshotCommit = (& git stash create "release-frontend-preflight" 2>$null).Trim()
        if ([string]::IsNullOrWhiteSpace($snapshotCommit)) {
            $snapshotCommit = (& git rev-parse HEAD 2>$null).Trim()
        }
        if ([string]::IsNullOrWhiteSpace($snapshotCommit)) {
            throw "Unable to resolve a snapshot commit for frontend preflight."
        }

        $snapshotPath = Join-Path ([System.IO.Path]::GetTempPath()) ("midterm-release-preflight-" + [Guid]::NewGuid().ToString("N"))
        Invoke-Git -Arguments @("worktree", "add", "--detach", $snapshotPath, $snapshotCommit)

        $untrackedFiles = @(& git ls-files --others --exclude-standard)
        foreach ($relativePath in $untrackedFiles) {
            if ([string]::IsNullOrWhiteSpace($relativePath)) {
                continue
            }

            $sourcePath = Join-Path $RepoRoot $relativePath
            if (-not (Test-Path $sourcePath -PathType Leaf)) {
                continue
            }

            $destinationPath = Join-Path $snapshotPath $relativePath
            $destinationDir = Split-Path $destinationPath -Parent
            if (-not (Test-Path $destinationDir)) {
                New-Item -ItemType Directory -Path $destinationDir -Force | Out-Null
            }
            Copy-Item $sourcePath -Destination $destinationPath -Force
        }

        return $snapshotPath
    }
    finally {
        Pop-Location
    }
}

function Remove-ReleaseFrontendSnapshot {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SnapshotPath
    )

    if (-not (Test-Path $SnapshotPath)) {
        return
    }

    Push-Location $RepoRoot
    try {
        & git worktree remove --force $SnapshotPath 2>$null
    }
    finally {
        Pop-Location
    }

    if (Test-Path $SnapshotPath) {
        Remove-Item -LiteralPath $SnapshotPath -Recurse -Force
    }
}

function Invoke-HostFrontendPreflight {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SnapshotPath
    )

    $frontendRoot = Join-Path $SnapshotPath $FrontendRootRelative
    $frontendBuildScript = Join-Path $SnapshotPath $FrontendBuildScriptHostRelative
    if (-not (Test-Path $frontendRoot -PathType Container)) {
        throw "Frontend root not found in snapshot: $frontendRoot"
    }
    if (-not (Test-Path $frontendBuildScript -PathType Leaf)) {
        throw "frontend-build.ps1 not found in snapshot: $frontendBuildScript"
    }

    Write-Host "Running clean host frontend preflight..." -ForegroundColor Cyan
    Push-Location $frontendRoot
    try {
        & npm ci --include=dev --prefer-offline --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) {
            throw "npm ci failed in clean frontend snapshot"
        }
    }
    finally {
        Pop-Location
    }

    $buildArgs = @{
        Publish = $true
        Version = $Version
    }
    if ($DevRelease) {
        $buildArgs.DevRelease = $true
    }

    & $frontendBuildScript @buildArgs
    if ($LASTEXITCODE -ne 0) {
        throw "frontend-build.ps1 failed in clean host snapshot"
    }
}

function Test-DockerAvailable {
    return $null -ne (Get-Command docker -ErrorAction SilentlyContinue)
}

function Ensure-LinuxPreflightImage {
    if (-not (Test-Path $LinuxPreflightDockerfile -PathType Leaf)) {
        throw "Linux frontend preflight Dockerfile not found: $LinuxPreflightDockerfile"
    }

    & docker image inspect $LinuxPreflightImage *> $null
    if ($LASTEXITCODE -eq 0) {
        return
    }

    Write-Host "Building Linux frontend preflight image..." -ForegroundColor Cyan
    $dockerContext = Split-Path $LinuxPreflightDockerfile -Parent
    & docker build -t $LinuxPreflightImage -f $LinuxPreflightDockerfile $dockerContext
    if ($LASTEXITCODE -ne 0) {
        throw "docker build for Linux frontend preflight image failed"
    }
}

function Invoke-LinuxFrontendPreflight {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SnapshotPath
    )

    if (-not (Test-DockerAvailable)) {
        throw "Docker is required for Linux frontend parity preflight on Windows."
    }

    Ensure-LinuxPreflightImage

    $versionLiteral = $Version.Replace("'", "''")
    $linuxCommand = @"
Set-StrictMode -Version Latest
cd /repo/$FrontendRootRelative
npm ci --include=dev --prefer-offline --no-audit --no-fund
cd /repo
`$buildArgs = @{ Publish = `$true; Version = '$versionLiteral' }
if ('$($DevRelease.IsPresent)' -eq 'True') { `$buildArgs.DevRelease = `$true }
./$FrontendBuildScriptLinuxRelative @buildArgs
"@

    Write-Host "Running Linux frontend parity preflight..." -ForegroundColor Cyan
    & docker run --rm -v "${SnapshotPath}:/repo" -w /repo $LinuxPreflightImage pwsh -Command $linuxCommand
    if ($LASTEXITCODE -ne 0) {
        throw "Linux frontend parity preflight failed"
    }
}

$snapshotPath = $null
try {
    $snapshotPath = New-ReleaseFrontendSnapshot
    Invoke-HostFrontendPreflight -SnapshotPath $snapshotPath

    if ($IsWindows -and -not $SkipLinuxParity) {
        Invoke-LinuxFrontendPreflight -SnapshotPath $snapshotPath
    }
}
finally {
    if ($null -ne $snapshotPath) {
        Remove-ReleaseFrontendSnapshot -SnapshotPath $snapshotPath
    }
}
