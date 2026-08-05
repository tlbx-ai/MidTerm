#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Installs portable PE/AOT inspection tools under .dev\aot-tools.

.DESCRIPTION
    Downloads Resource Hacker and PE-bear into a repo-local tools folder so
    Native AOT Windows binaries can be inspected without requiring admin
    installs.
#>

param(
    [string]$ToolsRoot = (Join-Path $PSScriptRoot "..\.dev\aot-tools"),
    [switch]$Force
)

$ErrorActionPreference = "Stop"

function Resolve-AbsolutePath {
    param([Parameter(Mandatory = $true)][string]$Path)

    return [System.IO.Path]::GetFullPath($Path)
}

function Assert-ChildPath {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Candidate
    )

    $rootPath = Resolve-AbsolutePath $Root
    $candidatePath = Resolve-AbsolutePath $Candidate
    $rootWithSlash = $rootPath.TrimEnd('\') + '\'

    if (-not $candidatePath.StartsWith($rootWithSlash, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to operate outside tools root. Root='$rootPath' Candidate='$candidatePath'"
    }

    return $candidatePath
}

function Invoke-Download {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$DestinationPath,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256
    )

    $parent = Split-Path -Parent $DestinationPath
    if (-not (Test-Path $parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }

    Write-Host "Downloading $Url" -ForegroundColor Cyan
    Invoke-WebRequest `
        -Uri $Url `
        -OutFile $DestinationPath `
        -Headers @{ "User-Agent" = "MidTerm-AotToolsInstaller"; "Accept" = "application/octet-stream" }

    $actualSha256 = (Get-FileHash -LiteralPath $DestinationPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualSha256 -ne $ExpectedSha256.ToLowerInvariant()) {
        throw "Checksum mismatch for $Url. Expected $ExpectedSha256, got $actualSha256."
    }
}

function Reset-Directory {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Target
    )

    $resolvedTarget = Assert-ChildPath -Root $Root -Candidate $Target
    if (Test-Path $resolvedTarget) {
        Remove-Item -LiteralPath $resolvedTarget -Recurse -Force
    }

    New-Item -ItemType Directory -Force -Path $resolvedTarget | Out-Null
    return $resolvedTarget
}

$toolsRoot = Resolve-AbsolutePath $ToolsRoot
$downloadsRoot = Join-Path $toolsRoot "_downloads"
New-Item -ItemType Directory -Force -Path $toolsRoot | Out-Null
New-Item -ItemType Directory -Force -Path $downloadsRoot | Out-Null

Write-Host "Installing portable AOT inspection tools into $toolsRoot" -ForegroundColor Green

# Resource Hacker official download page lists the current ZIP installer.
$resourceHackerVersion = "5.2.8"
$resourceHackerUrl = "https://www.angusj.com/resourcehacker/resource_hacker.zip"
$resourceHackerSha256 = "52f81ee4778070d6aa72d8719a1a68fea2f288005deb02667542754f747776f8"
$resourceHackerArchive = Join-Path $downloadsRoot "resource_hacker_$resourceHackerVersion.zip"
$resourceHackerRoot = Join-Path $toolsRoot "resourcehacker-$resourceHackerVersion"

if ($Force -or -not (Test-Path (Join-Path $resourceHackerRoot "ResourceHacker.exe"))) {
    Invoke-Download -Url $resourceHackerUrl -DestinationPath $resourceHackerArchive -ExpectedSha256 $resourceHackerSha256
    $resourceHackerExtract = Reset-Directory -Root $toolsRoot -Target $resourceHackerRoot
    Expand-Archive -LiteralPath $resourceHackerArchive -DestinationPath $resourceHackerExtract -Force
}

$peBearVersion = "0.7.2"
$peBearAssetName = "PE-bear_0.7.2_qt6_x64_win_vs22.zip"
$peBearUrl = "https://github.com/hasherezade/pe-bear/releases/download/v0.7.2/$peBearAssetName"
$peBearSha256 = "d2b995b213d0e6b3910a863c12fdb842722ce47387e65fc8e711ee9013d0876e"
$peBearArchive = Join-Path $downloadsRoot $peBearAssetName
$peBearRoot = Join-Path $toolsRoot "pe-bear-$peBearVersion"

if ($Force -or -not (Get-ChildItem -Path $peBearRoot -Filter "PE-bear.exe" -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1)) {
    Invoke-Download -Url $peBearUrl -DestinationPath $peBearArchive -ExpectedSha256 $peBearSha256
    $peBearExtract = Reset-Directory -Root $toolsRoot -Target $peBearRoot
    Expand-Archive -LiteralPath $peBearArchive -DestinationPath $peBearExtract -Force
}

$resourceHackerExe = Resolve-AbsolutePath (Join-Path $resourceHackerRoot "ResourceHacker.exe")
$peBearExe = Get-ChildItem -Path $peBearRoot -Filter "PE-bear.exe" -Recurse -File | Select-Object -First 1 -ExpandProperty FullName
if (-not $peBearExe) {
    throw "PE-bear.exe was not found under $peBearRoot"
}

$manifest = [ordered]@{
    installedAt = (Get-Date).ToString("o")
    toolsRoot = $toolsRoot
    resourceHacker = [ordered]@{
        version = $resourceHackerVersion
        path = $resourceHackerExe
        source = $resourceHackerUrl
        sha256 = $resourceHackerSha256
    }
    peBear = [ordered]@{
        version = $peBearVersion
        path = $peBearExe
        source = $peBearUrl
        sha256 = $peBearSha256
    }
}

$manifestPath = Join-Path $toolsRoot "tools.json"
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

Write-Host ""
Write-Host "Installed tools:" -ForegroundColor Green
Write-Host "  Resource Hacker: $resourceHackerExe" -ForegroundColor DarkGray
Write-Host "  PE-bear:         $peBearExe" -ForegroundColor DarkGray
Write-Host "  Manifest:        $manifestPath" -ForegroundColor DarkGray
