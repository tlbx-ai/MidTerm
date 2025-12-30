#!/usr/bin/env pwsh
# MiddleManager Windows Installer
# Usage: irm https://raw.githubusercontent.com/AiTlbx/MiddleManager/main/install.ps1 | iex

param(
    [string]$RunAsUser,
    [string]$RunAsUserSid,
    [switch]$ServiceMode
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$WebServiceName = "MiddleManager"
$HostServiceName = "MiddleManagerHost"
$WebDisplayName = "MiddleManager Terminal Server"
$HostDisplayName = "MiddleManager PTY Host"
$Publisher = "AiTlbx"
$RepoOwner = "AiTlbx"
$RepoName = "MiddleManager"
$WebBinaryName = "mm.exe"
$HostBinaryName = "mm-host.exe"
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

function Get-CurrentUserInfo
{
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $userName = $identity.Name.Split('\')[-1]
    $userSid = $identity.User.Value
    return @{
        Name = $userName
        Sid = $userSid
    }
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

function Write-ServiceSettings
{
    param(
        [string]$Username,
        [string]$UserSid
    )

    $configDir = "$env:ProgramData\MiddleManager"
    $settingsPath = Join-Path $configDir "settings.json"
    $oldSettingsPath = Join-Path $configDir "settings.json.old"

    if (-not (Test-Path $configDir))
    {
        New-Item -ItemType Directory -Path $configDir -Force | Out-Null
    }

    # Backup existing settings for migration by the app
    if (Test-Path $settingsPath)
    {
        Write-Host "  Backing up existing settings..." -ForegroundColor Gray
        Move-Item -Path $settingsPath -Destination $oldSettingsPath -Force
    }

    # Write minimal bootstrap settings - app will migrate user preferences from .old
    $settings = @{
        runAsUser = $Username
        runAsUserSid = $UserSid
    }

    $json = $settings | ConvertTo-Json -Depth 10
    Set-Content -Path $settingsPath -Value $json -Encoding UTF8

    Write-Host "  Terminal user: $Username" -ForegroundColor Gray
}

function Install-MiddleManager
{
    param(
        [bool]$AsService,
        [string]$Version,
        [string]$RunAsUser,
        [string]$RunAsUserSid
    )

    if ($AsService)
    {
        $installDir = "$env:ProgramFiles\MiddleManager"

        # Stop existing services before copying (files may be locked)
        $existingWebService = Get-Service -Name $WebServiceName -ErrorAction SilentlyContinue
        $existingHostService = Get-Service -Name $HostServiceName -ErrorAction SilentlyContinue

        if ($existingWebService)
        {
            Write-Host "Stopping existing web service..." -ForegroundColor Gray
            Stop-Service -Name $WebServiceName -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 1
        }
        if ($existingHostService)
        {
            Write-Host "Stopping existing host service..." -ForegroundColor Gray
            Stop-Service -Name $HostServiceName -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 2
        }
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

    # Copy both binaries
    $sourceWebBinary = Join-Path $tempExtract $WebBinaryName
    $sourceHostBinary = Join-Path $tempExtract $HostBinaryName
    $destWebBinary = Join-Path $installDir $WebBinaryName
    $destHostBinary = Join-Path $installDir $HostBinaryName

    Copy-Item $sourceWebBinary $destWebBinary -Force
    if (Test-Path $sourceHostBinary)
    {
        Copy-Item $sourceHostBinary $destHostBinary -Force
    }

    # Copy version manifest
    $sourceVersionJson = Join-Path $tempExtract "version.json"
    if (Test-Path $sourceVersionJson)
    {
        Copy-Item $sourceVersionJson (Join-Path $installDir "version.json") -Force
    }

    # Cleanup temp files
    Remove-Item $tempZip -Force -ErrorAction SilentlyContinue
    Remove-Item $tempExtract -Recurse -Force -ErrorAction SilentlyContinue

    if ($AsService)
    {
        # Write settings with runAsUser info
        if ($RunAsUser -and $RunAsUserSid)
        {
            Write-ServiceSettings -Username $RunAsUser -UserSid $RunAsUserSid
        }

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

    $webBinaryPath = Join-Path $InstallDir $WebBinaryName
    $hostBinaryPath = Join-Path $InstallDir $HostBinaryName

    # Remove existing services if present
    $existingWebService = Get-Service -Name $WebServiceName -ErrorAction SilentlyContinue
    if ($existingWebService)
    {
        Write-Host "Removing existing web service..." -ForegroundColor Gray
        Stop-Service -Name $WebServiceName -Force -ErrorAction SilentlyContinue
        sc.exe delete $WebServiceName | Out-Null
        Start-Sleep -Seconds 1
    }

    $existingHostService = Get-Service -Name $HostServiceName -ErrorAction SilentlyContinue
    if ($existingHostService)
    {
        Write-Host "Removing existing host service..." -ForegroundColor Gray
        Stop-Service -Name $HostServiceName -Force -ErrorAction SilentlyContinue
        sc.exe delete $HostServiceName | Out-Null
        Start-Sleep -Seconds 2
    }

    # Create host service first (web server depends on it)
    if (Test-Path $hostBinaryPath)
    {
        Write-Host "Creating PTY host service..." -ForegroundColor Gray
        sc.exe create $HostServiceName binPath= "`"$hostBinaryPath`"" start= auto DisplayName= "$HostDisplayName" | Out-Null
        sc.exe description $HostServiceName "PTY session host for MiddleManager (persists terminal sessions)" | Out-Null

        # Start host service
        Write-Host "Starting host service..." -ForegroundColor Gray
        Start-Service -Name $HostServiceName
        Start-Sleep -Seconds 1
    }

    # Create web service with dependency on host service
    Write-Host "Creating web service..." -ForegroundColor Gray
    if (Test-Path $hostBinaryPath)
    {
        # Use New-Service first, then sc.exe config to add dependency and --sidecar arg
        New-Service -Name $WebServiceName -BinaryPathName "`"$webBinaryPath`"" -DisplayName $WebDisplayName -StartupType Automatic | Out-Null
        # sc.exe requires very specific quoting - update binPath and depend separately
        $binPathValue = """$webBinaryPath"" --sidecar"
        sc.exe config $WebServiceName binPath= $binPathValue | Out-Null
        sc.exe config $WebServiceName depend= $HostServiceName | Out-Null
    }
    else
    {
        sc.exe create $WebServiceName binPath= "`"$webBinaryPath`"" start= auto DisplayName= "$WebDisplayName" | Out-Null
    }
    sc.exe description $WebServiceName "Web-based terminal multiplexer for AI coding agents and TUI apps" | Out-Null

    # Start web service
    Write-Host "Starting web service..." -ForegroundColor Gray
    Start-Service -Name $WebServiceName

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
        DisplayName = $WebDisplayName
        DisplayVersion = $Version
        Publisher = $Publisher
        InstallLocation = $InstallDir
        UninstallString = "pwsh -ExecutionPolicy Bypass -File `"$uninstallScript`""
        DisplayIcon = Join-Path $InstallDir $WebBinaryName
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

# Stop and remove web service first (depends on host)
Stop-Service -Name "$WebServiceName" -Force -ErrorAction SilentlyContinue
sc.exe delete "$WebServiceName" | Out-Null

# Stop and remove host service
Stop-Service -Name "$HostServiceName" -Force -ErrorAction SilentlyContinue
sc.exe delete "$HostServiceName" | Out-Null

# Remove registry entry
Remove-Item -Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\MiddleManager" -Force -ErrorAction SilentlyContinue

# Remove settings
Remove-Item -Path "`$env:ProgramData\MiddleManager" -Recurse -Force -ErrorAction SilentlyContinue

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

# If we're being called with ServiceMode flag, we're the elevated process
if ($ServiceMode)
{
    Write-Header
    $script:release = Get-LatestRelease
    $version = $script:release.tag_name -replace "^v", ""
    Write-Host "  Latest version: $version" -ForegroundColor White
    Write-Host ""
    Install-MiddleManager -AsService $true -Version $version -RunAsUser $RunAsUser -RunAsUserSid $RunAsUserSid
    exit
}

# Capture current user info BEFORE any potential elevation
$currentUser = Get-CurrentUserInfo

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
Write-Host "      - Terminals run as: $($currentUser.Name)" -ForegroundColor Gray
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

        # Download script to temp file and run elevated with parameters
        $tempScript = Join-Path $env:TEMP "mm-install-elevated.ps1"
        $scriptUrl = "https://raw.githubusercontent.com/$RepoOwner/$RepoName/main/install.ps1"
        Invoke-WebRequest -Uri $scriptUrl -OutFile $tempScript

        # Run elevated with user info passed as parameters
        $arguments = @(
            "-NoProfile"
            "-ExecutionPolicy", "Bypass"
            "-File", $tempScript
            "-ServiceMode"
            "-RunAsUser", $currentUser.Name
            "-RunAsUserSid", $currentUser.Sid
        )

        Start-Process pwsh -ArgumentList $arguments -Verb RunAs -Wait
        Remove-Item $tempScript -Force -ErrorAction SilentlyContinue
        exit
    }

    # Already admin, proceed with install
    Install-MiddleManager -AsService $true -Version $version -RunAsUser $currentUser.Name -RunAsUserSid $currentUser.Sid
}
else
{
    Install-MiddleManager -AsService $false -Version $version -RunAsUser "" -RunAsUserSid ""
}
