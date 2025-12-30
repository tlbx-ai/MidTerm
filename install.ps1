#!/usr/bin/env pwsh
# MiddleManager Windows Installer
# Usage: irm https://raw.githubusercontent.com/AiTlbx/MiddleManager/main/install.ps1 | iex

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ServiceName = "MiddleManager"
$DisplayName = "MiddleManager Terminal Server"
$Publisher = "AiTlbx"
$RepoOwner = "AiTlbx"
$RepoName = "MiddleManager"
$BinaryName = "mm.exe"
$AssetPattern = "mm-win-x64.zip"

function Write-Header
{
    Write-Host ""
    Write-Host "  MiddleManager Installer" -ForegroundColor Cyan
    Write-Host "  ========================" -ForegroundColor Cyan
    Write-Host ""
}

function Test-Administrator
{
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]$identity
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-LatestRelease
{
    Write-Host "Fetching latest release..." -ForegroundColor Gray
    $apiUrl = "https://api.github.com/repos/$RepoOwner/$RepoName/releases/latest"
    $release = Invoke-RestMethod -Uri $apiUrl -Headers @{ "User-Agent" = "MiddleManager-Installer" }
    return $release
}

function Get-AssetUrl
{
    param($Release)
    $asset = $Release.assets | Where-Object { $_.name -eq $AssetPattern }
    if (-not $asset)
    {
        throw "Could not find $AssetPattern in release assets"
    }
    return $asset.browser_download_url
}

function Install-MiddleManager
{
    param(
        [bool]$AsService,
        [string]$Version
    )

    if ($AsService)
    {
        $installDir = "$env:ProgramFiles\MiddleManager"
    }
    else
    {
        $installDir = "$env:LOCALAPPDATA\MiddleManager"
    }

    # Create install directory
    if (-not (Test-Path $installDir))
    {
        New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    }

    # Download and extract
    $tempZip = Join-Path $env:TEMP "mm-download.zip"
    $tempExtract = Join-Path $env:TEMP "mm-extract"

    Write-Host "Downloading..." -ForegroundColor Gray
    $assetUrl = Get-AssetUrl -Release $script:release
    Invoke-WebRequest -Uri $assetUrl -OutFile $tempZip

    Write-Host "Extracting..." -ForegroundColor Gray
    if (Test-Path $tempExtract) { Remove-Item $tempExtract -Recurse -Force }
    Expand-Archive -Path $tempZip -DestinationPath $tempExtract

    # Copy binary
    $sourceBinary = Join-Path $tempExtract $BinaryName
    $destBinary = Join-Path $installDir $BinaryName
    Copy-Item $sourceBinary $destBinary -Force

    # Cleanup temp files
    Remove-Item $tempZip -Force -ErrorAction SilentlyContinue
    Remove-Item $tempExtract -Recurse -Force -ErrorAction SilentlyContinue

    if ($AsService)
    {
        Install-AsService -InstallDir $installDir -Version $Version
    }
    else
    {
        Install-AsUserApp -InstallDir $installDir -Version $Version
    }

    Write-Host ""
    Write-Host "Installation complete!" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Location: $installDir" -ForegroundColor Gray
    Write-Host "  URL:      http://localhost:2000" -ForegroundColor Cyan
    Write-Host ""
}

function Install-AsService
{
    param(
        [string]$InstallDir,
        [string]$Version
    )

    $binaryPath = Join-Path $InstallDir $BinaryName

    # Stop existing service if running
    $existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($existingService)
    {
        Write-Host "Stopping existing service..." -ForegroundColor Gray
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
        sc.exe delete $ServiceName | Out-Null
        Start-Sleep -Seconds 2
    }

    # Create Windows service
    Write-Host "Creating Windows service..." -ForegroundColor Gray
    sc.exe create $ServiceName binPath= "`"$binaryPath`"" start= auto DisplayName= "$DisplayName" | Out-Null
    sc.exe description $ServiceName "Web-based terminal multiplexer for AI coding agents and TUI apps" | Out-Null

    # Start service
    Write-Host "Starting service..." -ForegroundColor Gray
    Start-Service -Name $ServiceName

    # Register in Add/Remove Programs
    Register-Uninstall -InstallDir $InstallDir -Version $Version -IsService $true

    # Create uninstall script
    Create-UninstallScript -InstallDir $InstallDir -IsService $true
}

function Install-AsUserApp
{
    param(
        [string]$InstallDir,
        [string]$Version
    )

    # Add to user PATH
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -notlike "*$InstallDir*")
    {
        Write-Host "Adding to PATH..." -ForegroundColor Gray
        [Environment]::SetEnvironmentVariable("Path", "$userPath;$InstallDir", "User")
    }

    # Register in Add/Remove Programs (user scope)
    Register-Uninstall -InstallDir $InstallDir -Version $Version -IsService $false

    # Create uninstall script
    Create-UninstallScript -InstallDir $InstallDir -IsService $false

    Write-Host ""
    Write-Host "Run 'mm' to start MiddleManager" -ForegroundColor Yellow
}

function Register-Uninstall
{
    param(
        [string]$InstallDir,
        [string]$Version,
        [bool]$IsService
    )

    $uninstallScript = Join-Path $InstallDir "uninstall.ps1"

    if ($IsService)
    {
        $regPath = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\MiddleManager"
    }
    else
    {
        $regPath = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\MiddleManager"
    }

    $regValues = @{
        DisplayName = $DisplayName
        DisplayVersion = $Version
        Publisher = $Publisher
        InstallLocation = $InstallDir
        UninstallString = "pwsh -ExecutionPolicy Bypass -File `"$uninstallScript`""
        DisplayIcon = Join-Path $InstallDir $BinaryName
        NoModify = 1
        NoRepair = 1
    }

    if (-not (Test-Path $regPath))
    {
        New-Item -Path $regPath -Force | Out-Null
    }

    foreach ($key in $regValues.Keys)
    {
        Set-ItemProperty -Path $regPath -Name $key -Value $regValues[$key]
    }
}

function Create-UninstallScript
{
    param(
        [string]$InstallDir,
        [bool]$IsService
    )

    $uninstallScript = Join-Path $InstallDir "uninstall.ps1"

    if ($IsService)
    {
        $content = @"
# MiddleManager Uninstaller
`$ErrorActionPreference = "Stop"

Write-Host "Uninstalling MiddleManager..." -ForegroundColor Cyan

# Stop and remove service
Stop-Service -Name "$ServiceName" -Force -ErrorAction SilentlyContinue
sc.exe delete "$ServiceName" | Out-Null

# Remove registry entry
Remove-Item -Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\MiddleManager" -Force -ErrorAction SilentlyContinue

# Remove install directory (schedule for next reboot if locked)
`$installDir = "$InstallDir"
Start-Sleep -Seconds 2
Remove-Item -Path `$installDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "MiddleManager uninstalled." -ForegroundColor Green
"@
    }
    else
    {
        $content = @"
# MiddleManager Uninstaller
`$ErrorActionPreference = "Stop"

Write-Host "Uninstalling MiddleManager..." -ForegroundColor Cyan

# Remove from PATH
`$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
`$newPath = (`$userPath -split ";" | Where-Object { `$_ -ne "$InstallDir" }) -join ";"
[Environment]::SetEnvironmentVariable("Path", `$newPath, "User")

# Remove registry entry
Remove-Item -Path "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\MiddleManager" -Force -ErrorAction SilentlyContinue

# Remove install directory
Remove-Item -Path "$InstallDir" -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "MiddleManager uninstalled." -ForegroundColor Green
"@
    }

    Set-Content -Path $uninstallScript -Value $content
}

# Main
Write-Header

# Fetch release info first
$script:release = Get-LatestRelease
$version = $script:release.tag_name -replace "^v", ""

Write-Host "  Latest version: $version" -ForegroundColor White
Write-Host ""

# Prompt for install mode
Write-Host "  How would you like to install MiddleManager?" -ForegroundColor White
Write-Host ""
Write-Host "  [1] System service (recommended for always-on access)" -ForegroundColor Cyan
Write-Host "      - Runs in background, starts on boot" -ForegroundColor Gray
Write-Host "      - Available before you log in" -ForegroundColor Gray
Write-Host "      - Installs to Program Files" -ForegroundColor Gray
Write-Host "      - Requires admin privileges" -ForegroundColor Yellow
Write-Host ""
Write-Host "  [2] User install (no admin required)" -ForegroundColor Cyan
Write-Host "      - You start it manually when needed" -ForegroundColor Gray
Write-Host "      - Only available after you log in" -ForegroundColor Gray
Write-Host "      - Installs to your AppData folder" -ForegroundColor Gray
Write-Host "      - No special permissions needed" -ForegroundColor Green
Write-Host ""

$choice = Read-Host "  Your choice [1/2]"
$asService = ($choice -eq "" -or $choice -eq "1")

if ($asService)
{
    # Check if we need to elevate
    if (-not (Test-Administrator))
    {
        Write-Host ""
        Write-Host "Requesting administrator privileges..." -ForegroundColor Yellow

        # Re-run as admin
        $scriptUrl = "https://raw.githubusercontent.com/$RepoOwner/$RepoName/main/install.ps1"
        $elevatedCommand = "irm '$scriptUrl' | iex"

        Start-Process pwsh -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $elevatedCommand -Verb RunAs
        exit
    }
}

Install-MiddleManager -AsService $asService -Version $version
