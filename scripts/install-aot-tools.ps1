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
        [Parameter(Mandatory = $true)][string]$DestinationPath
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

function Get-GitHubJson {
    param([Parameter(Mandatory = $true)][string]$Url)

    return Invoke-RestMethod `
        -Uri $Url `
        -Headers @{ "User-Agent" = "MidTerm-AotToolsInstaller"; "Accept" = "application/vnd.github+json" }
}

$toolsRoot = Resolve-AbsolutePath $ToolsRoot
$downloadsRoot = Join-Path $toolsRoot "_downloads"
New-Item -ItemType Directory -Force -Path $toolsRoot | Out-Null
New-Item -ItemType Directory -Force -Path $downloadsRoot | Out-Null

Write-Host "Installing portable AOT inspection tools into $toolsRoot" -ForegroundColor Green

# Resource Hacker official download page lists the current ZIP installer.
$resourceHackerVersion = "5.2.8"
$resourceHackerUrl = "https://www.angusj.com/resourcehacker/resource_hacker.zip"
$resourceHackerArchive = Join-Path $downloadsRoot "resource_hacker_$resourceHackerVersion.zip"
$resourceHackerRoot = Join-Path $toolsRoot "resourcehacker-$resourceHackerVersion"

if ($Force -or -not (Test-Path (Join-Path $resourceHackerRoot "ResourceHacker.exe"))) {
    Invoke-Download -Url $resourceHackerUrl -DestinationPath $resourceHackerArchive
    $resourceHackerExtract = Reset-Directory -Root $toolsRoot -Target $resourceHackerRoot
    Expand-Archive -LiteralPath $resourceHackerArchive -DestinationPath $resourceHackerExtract -Force
}

$peBearRelease = Get-GitHubJson -Url "https://api.github.com/repos/hasherezade/pe-bear/releases/latest"
$peBearAsset = @($peBearRelease.assets | Where-Object { $_.name -match '^PE-bear_.*_qt6.*_x64_win_.*\.zip$' } | Select-Object -First 1)
if ($peBearAsset.Count -ne 1) {
    throw "Could not find a Windows x64 PE-bear asset in release '$($peBearRelease.tag_name)'."
}

$peBearVersion = $peBearRelease.tag_name.TrimStart('v')
$peBearArchive = Join-Path $downloadsRoot $peBearAsset.name
$peBearRoot = Join-Path $toolsRoot "pe-bear-$peBearVersion"

if ($Force -or -not (Get-ChildItem -Path $peBearRoot -Filter "PE-bear.exe" -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1)) {
    Invoke-Download -Url $peBearAsset.browser_download_url -DestinationPath $peBearArchive
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
    }
    peBear = [ordered]@{
        version = $peBearVersion
        path = $peBearExe
        source = $peBearAsset.browser_download_url
    }
}

$manifestPath = Join-Path $toolsRoot "tools.json"
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

Write-Host ""
Write-Host "Installed tools:" -ForegroundColor Green
Write-Host "  Resource Hacker: $resourceHackerExe" -ForegroundColor DarkGray
Write-Host "  PE-bear:         $peBearExe" -ForegroundColor DarkGray
Write-Host "  Manifest:        $manifestPath" -ForegroundColor DarkGray
