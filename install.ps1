#!/usr/bin/env pwsh
# MidTerm Windows Installer
# Usage: irm https://raw.githubusercontent.com/AiTlbx/MidTerm/main/install.ps1 | iex

param(
    [string]$RunAsUser,
    [string]$RunAsUserSid,
    [string]$PasswordHash,
    [int]$Port = 2000,
    [string]$BindAddress = "",
    [switch]$ServiceMode
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ServiceName = "MidTerm"
$OldHostServiceName = "MidTermHost"
$DisplayName = "MidTerm"
$Publisher = "AiTlbx"
$RepoOwner = "AiTlbx"
$RepoName = "MidTerm"
$WebBinaryName = "mt.exe"
$TtyHostBinaryName = "mthost.exe"
$LegacyHostBinaryName = "mt-host.exe"
$AssetPattern = "mt-win-x64.zip"

function Write-Header
{
    Write-Host ""
    Write-Host "  MidTerm Installer" -ForegroundColor Cyan
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

function Get-ExistingPasswordHash
{
    $settingsPath = "$env:ProgramData\MidTerm\settings.json"
    if (Test-Path $settingsPath)
    {
        try
        {
            $settings = Get-Content $settingsPath -Raw | ConvertFrom-Json
            if ($settings.passwordHash -and $settings.passwordHash.Length -gt 10)
            {
                return $settings.passwordHash
            }
        }
        catch { }
    }
    return $null
}

function Prompt-Password
{
    param(
        [string]$InstallDir
    )

    Write-Host ""
    Write-Host "  Security Notice:" -ForegroundColor Yellow
    Write-Host "  MidTerm exposes terminal access over the network." -ForegroundColor Gray
    Write-Host "  A password is required to prevent unauthorized access." -ForegroundColor Gray
    Write-Host ""

    $maxAttempts = 3
    for ($i = 0; $i -lt $maxAttempts; $i++)
    {
        $password = Read-Host "  Enter password" -AsSecureString
        $confirm = Read-Host "  Confirm password" -AsSecureString

        $pwPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($password))
        $confirmPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($confirm))

        if ($pwPlain -ne $confirmPlain)
        {
            Write-Host "  Passwords do not match. Try again." -ForegroundColor Red
            continue
        }

        if ($pwPlain.Length -lt 4)
        {
            Write-Host "  Password must be at least 4 characters." -ForegroundColor Red
            continue
        }

        # Hash the password using mt.exe --hash-password
        $mmPath = Join-Path $InstallDir "mt.exe"
        if (Test-Path $mmPath)
        {
            try
            {
                $hash = & $mmPath --hash-password $pwPlain 2>&1
                if ($hash -match '^\$PBKDF2\$')
                {
                    return $hash
                }
            }
            catch { }
        }

        # Fallback: Return plaintext marker (will be hashed on first run)
        Write-Host "  Warning: Could not hash password, will be set on first access." -ForegroundColor Yellow
        return "__PENDING__:$pwPlain"
    }

    Write-Host "  Too many failed attempts. Exiting." -ForegroundColor Red
    exit 1
}

function Generate-Certificate
{
    param(
        [string]$InstallDir,
        [string]$SettingsDir,
        [bool]$IsService = $false
    )

    Write-Host "  Generating HTTPS certificate with OS-protected private key..." -ForegroundColor Gray

    $mtPath = Join-Path $InstallDir "mt.exe"
    if (-not (Test-Path $mtPath))
    {
        Write-Host "  Error: mt.exe not found at $mtPath" -ForegroundColor Red
        return $null
    }

    try
    {
        # Use mt.exe --generate-cert to generate certificate with DPAPI-protected key
        # Pass --service-mode for service installs so it uses ProgramData instead of user profile
        $certArgs = if ($IsService) { @("--generate-cert", "--service-mode") } else { @("--generate-cert") }
        $output = & $mtPath @certArgs 2>&1
        $exitCode = $LASTEXITCODE

        if ($exitCode -ne 0)
        {
            Write-Host "  Failed to generate certificate: $output" -ForegroundColor Red
            return $null
        }

        # Parse output for certificate path
        $certPath = $null
        foreach ($line in $output)
        {
            if ($line -match "Location:\s*(.+\.pem)")
            {
                $certPath = $Matches[1].Trim()
            }
        }

        if (-not $certPath)
        {
            # Default path (matches what mt.exe generates)
            $certPath = Join-Path $SettingsDir "midterm.pem"
        }

        Write-Host "  Certificate generated with DPAPI-protected private key" -ForegroundColor Green
        Write-Host ""

        # Offer to trust the certificate
        Write-Host "  Trust certificate? (Removes browser warnings)" -ForegroundColor Yellow
        Write-Host "  This requires administrator privileges." -ForegroundColor Gray
        $trustChoice = Read-Host "  Trust certificate? [Y/n]"

        if ($trustChoice -ne "n" -and $trustChoice -ne "N")
        {
            try
            {
                # Load the PEM certificate
                $certContent = Get-Content $certPath -Raw
                $certBytes = [System.Text.Encoding]::UTF8.GetBytes($certContent)
                $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2
                $cert.Import([Convert]::FromBase64String(($certContent -replace "-----BEGIN CERTIFICATE-----", "" -replace "-----END CERTIFICATE-----", "" -replace "`n", "" -replace "`r", "")))

                # Import to Trusted Root - requires admin
                $rootStore = New-Object System.Security.Cryptography.X509Certificates.X509Store("Root", "LocalMachine")
                $rootStore.Open("ReadWrite")
                $rootStore.Add($cert)
                $rootStore.Close()
                Write-Host "  Certificate trusted successfully" -ForegroundColor Green
            }
            catch
            {
                Write-Host "  Could not trust certificate (requires admin): $_" -ForegroundColor Yellow
                Write-Host "  You may see browser warnings until manually trusted" -ForegroundColor Gray
            }
        }

        return $certPath
    }
    catch
    {
        Write-Host "  Failed to generate certificate: $_" -ForegroundColor Red
        return $null
    }
}

function Prompt-NetworkConfig
{
    Write-Host ""
    Write-Host "  Network Configuration:" -ForegroundColor Cyan
    Write-Host ""

    # Port configuration
    $portInput = Read-Host "  Port number [2000]"
    if ([string]::IsNullOrWhiteSpace($portInput))
    {
        $port = 2000
    }
    else
    {
        $port = [int]$portInput
        if ($port -lt 1 -or $port -gt 65535)
        {
            Write-Host "  Invalid port, using default 2000" -ForegroundColor Yellow
            $port = 2000
        }
    }

    Write-Host ""
    Write-Host "  Network binding:" -ForegroundColor White
    Write-Host "  [1] Accept connections from anywhere (default)" -ForegroundColor Cyan
    Write-Host "      - Access from other devices on your network" -ForegroundColor Gray
    Write-Host "      - Required for remote access" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  [2] Localhost only" -ForegroundColor Cyan
    Write-Host "      - Only accessible from this computer" -ForegroundColor Gray
    Write-Host "      - More secure, no network exposure" -ForegroundColor Green
    Write-Host ""

    $bindChoice = Read-Host "  Your choice [1/2]"

    if ($bindChoice -eq "2")
    {
        $bindAddress = "localhost"
        Write-Host "  Binding to localhost only" -ForegroundColor Gray
    }
    else
    {
        $bindAddress = "*"
        Write-Host ""
        Write-Host "  Security Warning:" -ForegroundColor Yellow
        Write-Host "  MidTerm will accept connections from any device on your network." -ForegroundColor Yellow
        Write-Host "  Ensure your password is strong and consider firewall rules." -ForegroundColor Yellow
    }

    # Always HTTPS - certificate will be generated after binary install
    Write-Host ""
    Write-Host "  HTTPS: Enabled (self-signed certificate with OS-protected key)" -ForegroundColor Green

    return @{
        Port = $port
        BindAddress = $bindAddress
    }
}

function Get-LatestRelease
{
    Write-Host "Fetching latest release..." -ForegroundColor Gray
    $apiUrl = "https://api.github.com/repos/$RepoOwner/$RepoName/releases/latest"
    $release = Invoke-RestMethod -Uri $apiUrl -Headers @{ "User-Agent" = "MidTerm-Installer" }
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
        [string]$UserSid,
        [string]$PasswordHash,
        [int]$Port = 2000,
        [string]$BindAddress = "*",
        [string]$CertPath = $null
    )

    $configDir = "$env:ProgramData\MidTerm"
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
    # Note: port/bind are passed via service command line args, not settings.json
    $settings = @{
        runAsUser = $Username
        runAsUserSid = $UserSid
        authenticationEnabled = $true
    }

    if ($PasswordHash)
    {
        $settings.passwordHash = $PasswordHash
    }

    # HTTPS settings - always HTTPS, use OS-level key protection
    if ($CertPath)
    {
        $settings.certificatePath = $CertPath
        $settings.keyProtection = "osProtected"
    }

    $json = $settings | ConvertTo-Json -Depth 10
    Set-Content -Path $settingsPath -Value $json -Encoding UTF8

    Write-Host "  Terminal user: $Username" -ForegroundColor Gray
    Write-Host "  Port: $Port" -ForegroundColor Gray
    Write-Host "  Binding: $(if ($BindAddress -eq 'localhost') { 'localhost only' } else { 'all interfaces' })" -ForegroundColor Gray
    if ($CertPath) { Write-Host "  HTTPS: enabled (OS-protected key)" -ForegroundColor Green }
    if ($PasswordHash) { Write-Host "  Password: configured" -ForegroundColor Gray }
}

function Install-MidTerm
{
    param(
        [bool]$AsService,
        [string]$Version,
        [string]$RunAsUser,
        [string]$RunAsUserSid,
        [string]$PasswordHash,
        [int]$Port = 2000,
        [string]$BindAddress = "*"
    )

    if ($AsService)
    {
        $installDir = "$env:ProgramFiles\MidTerm"

        # Stop and remove old two-service architecture if present
        $existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        $oldHostService = Get-Service -Name $OldHostServiceName -ErrorAction SilentlyContinue

        if ($existingService)
        {
            Write-Host "Stopping existing service..." -ForegroundColor Gray
            # Don't wait for graceful shutdown - immediately kill processes
            Stop-Service -Name $ServiceName -Force -NoWait -ErrorAction SilentlyContinue
            Get-Process -Name "mt-host", "mthost", "mt" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 500
        }

        # Migration: remove old MidTermHost service from v2.1.x
        if ($oldHostService)
        {
            Write-Host "Migrating from old two-service architecture..." -ForegroundColor Yellow
            Stop-Service -Name $OldHostServiceName -Force -NoWait -ErrorAction SilentlyContinue
            Get-Process -Name "mt-host" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
            sc.exe delete $OldHostServiceName | Out-Null
            Start-Sleep -Milliseconds 500
        }
    }
    else
    {
        $installDir = "$env:LOCALAPPDATA\MidTerm"
    }

    # Create install directory
    if (-not (Test-Path $installDir))
    {
        New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    }

    # Download and extract
    $tempZip = Join-Path $env:TEMP "mt-download.zip"
    $tempExtract = Join-Path $env:TEMP "mt-extract"

    Write-Host "Downloading..." -ForegroundColor Gray
    $assetUrl = Get-AssetUrl -Release $script:release
    Invoke-WebRequest -Uri $assetUrl -OutFile $tempZip

    Write-Host "Extracting..." -ForegroundColor Gray
    if (Test-Path $tempExtract) { Remove-Item $tempExtract -Recurse -Force }
    Expand-Archive -Path $tempZip -DestinationPath $tempExtract

    # Copy binaries
    $sourceWebBinary = Join-Path $tempExtract $WebBinaryName
    $sourceConHostBinary = Join-Path $tempExtract $TtyHostBinaryName
    $destWebBinary = Join-Path $installDir $WebBinaryName
    $destConHostBinary = Join-Path $installDir $TtyHostBinaryName

    Write-Host "Installing binaries..." -ForegroundColor Gray
    try
    {
        Copy-Item $sourceWebBinary $destWebBinary -Force -ErrorAction Stop
        Write-Host "  Installed: $WebBinaryName" -ForegroundColor Gray
    }
    catch
    {
        Write-Host "  Failed to copy $WebBinaryName - file may be locked" -ForegroundColor Red
        Write-Host "  Error: $_" -ForegroundColor Red
        throw
    }

    if (Test-Path $sourceConHostBinary)
    {
        try
        {
            Copy-Item $sourceConHostBinary $destConHostBinary -Force -ErrorAction Stop
            Write-Host "  Installed: $TtyHostBinaryName" -ForegroundColor Gray
        }
        catch
        {
            Write-Host "  Failed to copy $TtyHostBinaryName - file may be locked" -ForegroundColor Red
            Write-Host "  Error: $_" -ForegroundColor Red
            throw
        }
    }

    # Remove legacy mt-host.exe if present from previous installs
    $legacyHostPath = Join-Path $installDir $LegacyHostBinaryName
    if (Test-Path $legacyHostPath)
    {
        Remove-Item $legacyHostPath -Force -ErrorAction SilentlyContinue
        Write-Host "  Removed legacy: $LegacyHostBinaryName" -ForegroundColor Gray
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

    # Hash pending password now that mt.exe is installed
    if ($PasswordHash -and $PasswordHash.StartsWith("__PENDING__:"))
    {
        $plainPassword = $PasswordHash.Substring(12)
        try
        {
            $hash = & $destWebBinary --hash-password $plainPassword 2>&1
            if ($hash -match '^\$PBKDF2\$')
            {
                $PasswordHash = $hash
                Write-Host "  Password: hashed" -ForegroundColor Gray
            }
            else
            {
                Write-Host "  Warning: Password hashing failed, using fallback" -ForegroundColor Yellow
            }
        }
        catch
        {
            Write-Host "  Warning: Could not hash password: $_" -ForegroundColor Yellow
        }
    }

    # Always generate certificate now that mt.exe is installed (always HTTPS)
    $settingsDir = if ($AsService) { "$env:ProgramData\MidTerm" } else { "$env:USERPROFILE\.MidTerm" }
    $CertPath = Generate-Certificate -InstallDir $installDir -SettingsDir $settingsDir -IsService $AsService
    if (-not $CertPath)
    {
        Write-Host "  Warning: Certificate generation failed. App will use fallback certificate." -ForegroundColor Yellow
    }

    if ($AsService)
    {
        # Write settings with runAsUser info and password
        if ($RunAsUser -and $RunAsUserSid)
        {
            Write-ServiceSettings -Username $RunAsUser -UserSid $RunAsUserSid -PasswordHash $PasswordHash -Port $Port -BindAddress $BindAddress -CertPath $CertPath
        }

        Install-AsService -InstallDir $installDir -Version $Version -Port $Port -BindAddress $BindAddress

        # Wait for mt.exe to spawn
        Start-Sleep -Seconds 2

        # Show final status
        Write-Host ""
        Write-Host "Process Status:" -ForegroundColor Cyan
        $serviceStatus = (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue).Status
        $mmProc = Get-Process -Name "mt" -ErrorAction SilentlyContinue

        if ($serviceStatus -eq "Running") { Write-Host "  Service    : Running" -ForegroundColor Green }
        else { Write-Host "  Service    : $serviceStatus" -ForegroundColor Red }

        if ($mmProc) { Write-Host "  mt (web)   : Running (PID $($mmProc.Id))" -ForegroundColor Green }
        else { Write-Host "  mt (web)   : Starting..." -ForegroundColor Yellow }

        # Check health endpoint (HTTPS with self-signed cert requires SkipCertificateCheck)
        try
        {
            $health = Invoke-RestMethod -Uri "https://localhost:$Port/api/health" -TimeoutSec 5 -SkipCertificateCheck -ErrorAction Stop
            Write-Host ""
            Write-Host "Health Check:" -ForegroundColor Cyan
            if ($health.healthy) { Write-Host "  Status     : Healthy" -ForegroundColor Green }
            else { Write-Host "  Status     : Unhealthy" -ForegroundColor Red; if ($health.hostError) { Write-Host "  Error      : $($health.hostError)" -ForegroundColor Red } }
            Write-Host "  Version    : $($health.version)" -ForegroundColor Gray
        }
        catch
        {
            Write-Host ""
            Write-Host "Health Check:" -ForegroundColor Cyan
            Write-Host "  Status     : Could not connect to https://localhost:$Port" -ForegroundColor Yellow
        }
    }
    else
    {
        # Write user settings
        $userSettingsDir = Join-Path $env:USERPROFILE ".MidTerm"
        $userSettingsPath = Join-Path $userSettingsDir "settings.json"
        if (-not (Test-Path $userSettingsDir)) { New-Item -ItemType Directory -Path $userSettingsDir -Force | Out-Null }

        $userSettings = @{ authenticationEnabled = $true }
        if ($PasswordHash) { $userSettings.passwordHash = $PasswordHash }
        if ($CertPath) {
            $userSettings.certificatePath = $CertPath
            $userSettings.keyProtection = "osProtected"
        }
        $userSettings | ConvertTo-Json | Set-Content -Path $userSettingsPath -Encoding UTF8
        Write-Host "  Settings: $userSettingsPath" -ForegroundColor Gray

        Install-AsUserApp -InstallDir $installDir -Version $Version
    }

    Write-Host ""
    Write-Host "Installation complete!" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Location: $installDir" -ForegroundColor Gray
    Write-Host "  URL:      https://localhost:$Port" -ForegroundColor Cyan
    Write-Host "  Note:     Browser may show certificate warning until trusted" -ForegroundColor Yellow
    Write-Host ""
}

function Install-AsService
{
    param(
        [string]$InstallDir,
        [string]$Version,
        [int]$Port = 2000,
        [string]$BindAddress = "*"
    )

    $webBinaryPath = Join-Path $InstallDir $WebBinaryName

    # Remove existing service if present
    $existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($existingService)
    {
        Write-Host "Removing existing service..." -ForegroundColor Gray
        Stop-Service -Name $ServiceName -Force -NoWait -ErrorAction SilentlyContinue
        Get-Process -Name "mt-host", "mthost", "mt" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
        sc.exe delete $ServiceName | Out-Null
        Start-Sleep -Milliseconds 500
    }

    # Convert bind address for command line
    $bindArg = if ($BindAddress -eq "localhost") { "127.0.0.1" } else { "0.0.0.0" }

    # Create service - mt.exe spawns mthost per terminal session
    Write-Host "Creating MidTerm service..." -ForegroundColor Gray
    $binPath = "`"$webBinaryPath`" --port $Port --bind $bindArg"
    sc.exe create $ServiceName binPath= $binPath start= auto DisplayName= "$DisplayName" | Out-Null
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
    Write-Host "Run 'mt' to start MidTerm" -ForegroundColor Yellow
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
        $regPath = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\MidTerm"
    }
    else
    {
        $regPath = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\MidTerm"
    }

    $regValues = @{
        DisplayName = $DisplayName
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
# MidTerm Uninstaller
`$ErrorActionPreference = "Stop"

Write-Host "Uninstalling MidTerm..." -ForegroundColor Cyan

# Stop and remove service
Stop-Service -Name "$ServiceName" -Force -ErrorAction SilentlyContinue
sc.exe delete "$ServiceName" | Out-Null

# Remove old host service if present (migration cleanup)
Stop-Service -Name "$OldHostServiceName" -Force -ErrorAction SilentlyContinue
sc.exe delete "$OldHostServiceName" 2>`$null | Out-Null

# Remove registry entry
Remove-Item -Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\MidTerm" -Force -ErrorAction SilentlyContinue

# Remove settings
Remove-Item -Path "`$env:ProgramData\MidTerm" -Recurse -Force -ErrorAction SilentlyContinue

# Remove install directory (schedule for next reboot if locked)
`$installDir = "$InstallDir"
Start-Sleep -Seconds 2
Remove-Item -Path `$installDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "MidTerm uninstalled." -ForegroundColor Green
"@
    }
    else
    {
        $content = @"
# MidTerm Uninstaller
`$ErrorActionPreference = "Stop"

Write-Host "Uninstalling MidTerm..." -ForegroundColor Cyan

# Remove from PATH
`$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
`$newPath = (`$userPath -split ";" | Where-Object { `$_ -ne "$InstallDir" }) -join ";"
[Environment]::SetEnvironmentVariable("Path", `$newPath, "User")

# Remove registry entry
Remove-Item -Path "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\MidTerm" -Force -ErrorAction SilentlyContinue

# Remove install directory
Remove-Item -Path "$InstallDir" -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "MidTerm uninstalled." -ForegroundColor Green
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
    Install-MidTerm -AsService $true -Version $version -RunAsUser $RunAsUser -RunAsUserSid $RunAsUserSid -PasswordHash $PasswordHash -Port $Port -BindAddress $BindAddress
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
Write-Host "  How would you like to install MidTerm?" -ForegroundColor White
Write-Host ""
Write-Host "  [1] System service (recommended for always-on access)" -ForegroundColor Cyan
Write-Host "      - Runs in background, starts on boot" -ForegroundColor Gray
Write-Host "      - Available before you log in" -ForegroundColor Gray
Write-Host "      - Installs to Program Files" -ForegroundColor Gray
Write-Host "      - Terminals run as: $($currentUser.Name)" -ForegroundColor Gray
Write-Host "      - Will prompt for admin elevation if needed" -ForegroundColor Yellow
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
    $installDir = "$env:ProgramFiles\MidTerm"

    # Check for existing password (preserve on update)
    $existingHash = Get-ExistingPasswordHash
    if ($existingHash)
    {
        Write-Host ""
        Write-Host "  Existing password found - preserving..." -ForegroundColor Green
        $passwordHash = $existingHash
    }
    else
    {
        # New install - prompt for password
        $passwordHash = Prompt-Password -InstallDir $installDir
    }

    # Prompt for network configuration
    $networkConfig = Prompt-NetworkConfig
    $port = $networkConfig.Port
    $bindAddress = $networkConfig.BindAddress

    # Check if we need to elevate
    if (-not (Test-Administrator))
    {
        Write-Host ""
        Write-Host "Requesting administrator privileges..." -ForegroundColor Yellow

        # Download script to temp file and run elevated with parameters
        $tempScript = Join-Path $env:TEMP "mt-install-elevated.ps1"
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
            "-PasswordHash", $passwordHash
            "-Port", $port
            "-BindAddress", $bindAddress
        )

        Start-Process pwsh -ArgumentList $arguments -Verb RunAs -Wait
        Remove-Item $tempScript -Force -ErrorAction SilentlyContinue
        exit
    }

    # Already admin, proceed with install
    Install-MidTerm -AsService $true -Version $version -RunAsUser $currentUser.Name -RunAsUserSid $currentUser.Sid -PasswordHash $passwordHash -Port $port -BindAddress $bindAddress
}
else
{
    # User install - still require password
    $userSettingsDir = Join-Path $env:USERPROFILE ".MidTerm"
    $userSettingsPath = Join-Path $userSettingsDir "settings.json"

    # Check for existing password
    $existingHash = $null
    if (Test-Path $userSettingsPath)
    {
        try
        {
            $settings = Get-Content $userSettingsPath -Raw | ConvertFrom-Json
            if ($settings.passwordHash -and $settings.passwordHash.Length -gt 10)
            {
                $existingHash = $settings.passwordHash
            }
        }
        catch { }
    }

    if ($existingHash)
    {
        Write-Host ""
        Write-Host "  Existing password found - preserving..." -ForegroundColor Green
        $passwordHash = $existingHash
    }
    else
    {
        # Prompt for password - need a temp location for mt.exe to hash
        $tempDir = Join-Path $env:TEMP "MidTerm-Install"
        $passwordHash = Prompt-Password -InstallDir $tempDir
    }

    # Prompt for network configuration
    $networkConfig = Prompt-NetworkConfig

    Install-MidTerm -AsService $false -Version $version -RunAsUser "" -RunAsUserSid "" -PasswordHash $passwordHash
}
