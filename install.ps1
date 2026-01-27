#!/usr/bin/env pwsh
# MidTerm Windows Installer
# Usage: irm https://tlbx-ai.github.io/MidTerm/install.ps1 | iex
# Dev:   & ([scriptblock]::Create((irm https://tlbx-ai.github.io/MidTerm/install.ps1))) -Dev

param(
    [string]$RunAsUser,
    [string]$RunAsUserSid,
    [string]$PasswordHash,
    [int]$Port = 2000,
    [string]$BindAddress = "",
    [switch]$ServiceMode,
    [switch]$TrustCert,
    [string]$LogFile,
    [switch]$Dev
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# Logging
$script:UpdateLogFile = $null
$script:LogInitialized = $false

function Initialize-Log
{
    param(
        [string]$Mode  # "service" or "user"
    )

    if ($Mode -eq "service")
    {
        $logDir = "$env:ProgramData\MidTerm"
    }
    else
    {
        $logDir = "$env:USERPROFILE\.MidTerm"
    }

    if (-not (Test-Path $logDir))
    {
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    }

    $script:UpdateLogFile = Join-Path $logDir "update.log"

    # Clear previous log
    "" | Set-Content $script:UpdateLogFile -Force -ErrorAction SilentlyContinue

    $script:LogInitialized = $true

    $channelLabel = if ($Dev) { "dev" } else { "stable" }
    Write-Log "=========================================="
    Write-Log "MidTerm Install Script Starting"
    Write-Log "Mode: $Mode"
    Write-Log "Channel: $channelLabel"
    Write-Log "Date: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
    Write-Log "Platform: Windows $([Environment]::OSVersion.Version)"
    Write-Log "User: $env:USERNAME"
    Write-Log "=========================================="
}

function Write-Log
{
    param(
        [string]$Message,
        [string]$Level = "INFO"
    )

    if ($script:LogInitialized -and $script:UpdateLogFile)
    {
        $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"
        $line = "[$timestamp] [$Level] $Message"
        Add-Content -Path $script:UpdateLogFile -Value $line -ErrorAction SilentlyContinue
    }
}

$ServiceName = "MidTerm"
$OldHostServiceName = "MidTermHost"
$DisplayName = "MidTerm"
$Publisher = "tlbx-ai"
$RepoOwner = "tlbx-ai"
$RepoName = "MidTerm"
$WebBinaryName = "mt.exe"
$TtyHostBinaryName = "mthost.exe"
$LegacyHostBinaryName = "mt-host.exe"
$AssetPattern = "mt-win-x64.zip"
# Certificate subject CN - must match CertificateGenerator.CertificateSubject in C#
$CertificateSubject = "CN=ai.tlbx.midterm"

# ============================================================================
# PATH CONSTANTS - SYNC: These paths MUST match:
#   - SettingsService.cs (GetSettingsPath method)
#   - LogPaths.cs (constants and GetSettingsDirectory method)
#   - UpdateScriptGenerator.cs (SettingsDir variable in generated scripts)
#   - install.sh (PATH_CONSTANTS section)
# ============================================================================
# Windows service mode: %ProgramData%\MidTerm (typically C:\ProgramData\MidTerm)
$WIN_SERVICE_SETTINGS_DIR = "$env:ProgramData\MidTerm"
$WIN_SERVICE_INSTALL_DIR = "$env:ProgramFiles\MidTerm"
# Windows user mode: %LOCALAPPDATA%\MidTerm and %USERPROFILE%\.midterm
$WIN_USER_INSTALL_DIR = "$env:LOCALAPPDATA\MidTerm"
$WIN_USER_SETTINGS_DIR = "$env:USERPROFILE\.midterm"
# Secrets file (secrets.bin on Windows, secrets.json on Unix)
$WIN_SECRETS_FILENAME = "secrets.bin"
# ============================================================================

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

function Test-ExistingPassword
{
    # Check if password exists in secure storage (secrets.bin)
    # Uses PATH_CONSTANTS defined above - keep in sync with SettingsService.cs!
    $secretsPath = "$WIN_SERVICE_SETTINGS_DIR\$WIN_SECRETS_FILENAME"
    if (Test-Path $secretsPath)
    {
        try
        {
            $secrets = Get-Content $secretsPath -Raw | ConvertFrom-Json
            if ($secrets.password_hash -and $secrets.password_hash.Length -gt 10)
            {
                return $true
            }
        }
        catch { }
    }

    # Legacy: check settings.json (old broken path - will be migrated)
    $settingsPath = "$WIN_SERVICE_SETTINGS_DIR\settings.json"
    if (Test-Path $settingsPath)
    {
        try
        {
            $settings = Get-Content $settingsPath -Raw | ConvertFrom-Json
            if ($settings.passwordHash -and $settings.passwordHash.Length -gt 10)
            {
                return $true
            }
        }
        catch { }
    }
    return $false
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

        # Hash the password using mt.exe --hash-password (password piped via stdin)
        $mmPath = Join-Path $InstallDir "mt.exe"
        if (Test-Path $mmPath)
        {
            try
            {
                $hash = $pwPlain | & $mmPath --hash-password 2>&1
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

function Test-ExistingCertificate
{
    param(
        [string]$SettingsDir
    )

    $certPath = Join-Path $SettingsDir "midterm.pem"
    $keyPath = Join-Path $SettingsDir "keys" "midterm.dpapi"

    # Check if both cert and key exist
    if (-not (Test-Path $certPath))
    {
        return $null
    }

    if (-not (Test-Path $keyPath))
    {
        Write-Host "  Warning: Certificate exists but private key is missing" -ForegroundColor Yellow
        return $null
    }

    try
    {
        # Load and validate the certificate
        $certContent = Get-Content $certPath -Raw
        $base64 = $certContent -replace "-----BEGIN CERTIFICATE-----", "" -replace "-----END CERTIFICATE-----", "" -replace "`n", "" -replace "`r", ""
        $certBytes = [Convert]::FromBase64String($base64)
        $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList @(,$certBytes)

        # Check if cert is still valid (not expired, and has at least 30 days left)
        $now = Get-Date
        if ($cert.NotAfter -lt $now)
        {
            Write-Host "  Warning: Existing certificate has expired" -ForegroundColor Yellow
            return $null
        }

        if ($cert.NotAfter -lt $now.AddDays(30))
        {
            Write-Host "  Warning: Existing certificate expires in less than 30 days" -ForegroundColor Yellow
            return $null
        }

        return @{
            Path = $certPath
            Certificate = $cert
            Thumbprint = $cert.Thumbprint
            NotAfter = $cert.NotAfter
        }
    }
    catch
    {
        Write-Host "  Warning: Could not validate existing certificate: $_" -ForegroundColor Yellow
        return $null
    }
}

function Remove-OldMidTermCertificates
{
    param(
        [string]$ExceptThumbprint = $null
    )

    try
    {
        $rootStore = New-Object System.Security.Cryptography.X509Certificates.X509Store("Root", "LocalMachine")
        $rootStore.Open("ReadWrite")

        $oldCerts = $rootStore.Certificates | Where-Object { $_.Subject -eq $CertificateSubject }
        $removed = 0

        foreach ($old in $oldCerts)
        {
            if ($ExceptThumbprint -and $old.Thumbprint -eq $ExceptThumbprint)
            {
                continue  # Keep the current cert
            }

            try
            {
                $rootStore.Remove($old)
                $removed++
                Write-Host "  Removed old certificate: $($old.Thumbprint.Substring(0, 8))..." -ForegroundColor Gray
            }
            catch
            {
                Write-Host "  Warning: Could not remove old certificate: $_" -ForegroundColor Yellow
            }
        }

        $rootStore.Close()

        if ($removed -gt 0)
        {
            Write-Host "  Cleaned up $removed old MidTerm certificate(s) from trusted store" -ForegroundColor Green
        }
    }
    catch
    {
        Write-Host "  Warning: Could not clean up old certificates: $_" -ForegroundColor Yellow
    }
}

function Show-CertificateFingerprint
{
    param(
        [string]$CertPath
    )

    if (-not $CertPath -or -not (Test-Path $CertPath))
    {
        return
    }

    try
    {
        # Load the PEM certificate
        $certContent = Get-Content $CertPath -Raw
        $base64 = $certContent -replace "-----BEGIN CERTIFICATE-----", "" -replace "-----END CERTIFICATE-----", "" -replace "`n", "" -replace "`r", ""
        $certBytes = [Convert]::FromBase64String($base64)

        # Compute SHA-256 fingerprint
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        $hash = $sha256.ComputeHash($certBytes)
        $fingerprint = [BitConverter]::ToString($hash) -replace "-", ":"

        Write-Host ""
        Write-Host "  ================================================" -ForegroundColor Cyan
        Write-Host "  CERTIFICATE FINGERPRINT - SAVE THIS!" -ForegroundColor Cyan
        Write-Host "  ================================================" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "  $fingerprint" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "  When connecting from other devices, verify the" -ForegroundColor Gray
        Write-Host "  fingerprint in your browser matches this one." -ForegroundColor Gray
        Write-Host "  (Click padlock icon > Certificate > SHA-256)" -ForegroundColor Gray
        Write-Host ""
        Write-Host "  Never enter passwords if fingerprints don't match." -ForegroundColor White
        Write-Host ""
    }
    catch
    {
        Write-Host "  Could not compute certificate fingerprint: $_" -ForegroundColor Yellow
    }
}

function Generate-Certificate
{
    param(
        [string]$InstallDir,
        [string]$SettingsDir,
        [bool]$IsService = $false,
        [bool]$TrustCert = $false
    )

    Write-Log "Generating certificate: InstallDir=$InstallDir, SettingsDir=$SettingsDir, IsService=$IsService"

    # First check if a valid certificate already exists
    $existingCert = Test-ExistingCertificate -SettingsDir $SettingsDir
    if ($existingCert)
    {
        Write-Log "Existing valid certificate found: $($existingCert.Path), expires $($existingCert.NotAfter)"
        Write-Host "  Existing valid certificate found (expires $($existingCert.NotAfter.ToString('yyyy-MM-dd')))" -ForegroundColor Green
        $certPath = $existingCert.Path
        $certThumbprint = $existingCert.Thumbprint
        $wasGenerated = $false
    }
    else
    {
        Write-Log "No valid certificate found, generating new one..."
        Write-Host "  Generating HTTPS certificate with OS-protected private key..." -ForegroundColor Gray

        $mtPath = Join-Path $InstallDir "mt.exe"
        if (-not (Test-Path $mtPath))
        {
            Write-Log "mt.exe not found at $mtPath" "ERROR"
            Write-Host "  Error: mt.exe not found at $mtPath" -ForegroundColor Red
            return $null
        }

        try
        {
            # Use mt.exe --generate-cert to generate certificate with DPAPI-protected key
            # Pass --service-mode for service installs so it uses ProgramData instead of user profile
            # Pass --force to regenerate since we already checked validity above
            $certArgs = if ($IsService) { @("--generate-cert", "--service-mode", "--force") } else { @("--generate-cert", "--force") }
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
            $wasGenerated = $true

            # Get the thumbprint of the new cert
            $certContent = Get-Content $certPath -Raw
            $base64 = $certContent -replace "-----BEGIN CERTIFICATE-----", "" -replace "-----END CERTIFICATE-----", "" -replace "`n", "" -replace "`r", ""
            $certBytes = [Convert]::FromBase64String($base64)
            $newCert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList @(,$certBytes)
            $certThumbprint = $newCert.Thumbprint
        }
        catch
        {
            Write-Host "  Failed to generate certificate: $_" -ForegroundColor Red
            return $null
        }
    }

    # Trust the certificate if requested (decision made before elevation)
    if ($TrustCert)
    {
        # First, remove ALL old MidTerm certs from trusted store to avoid accumulation
        Remove-OldMidTermCertificates -ExceptThumbprint $null  # Remove all, we'll add the current one

        Write-Host "  Adding certificate to trusted root store..." -ForegroundColor Gray
        try
        {
            # Load the PEM certificate - extract base64 and create cert via constructor (not Import)
            $certContent = Get-Content $certPath -Raw
            $base64 = $certContent -replace "-----BEGIN CERTIFICATE-----", "" -replace "-----END CERTIFICATE-----", "" -replace "`n", "" -replace "`r", ""
            $certBytes = [Convert]::FromBase64String($base64)
            $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList @(,$certBytes)

            # Import to Trusted Root - requires admin
            $rootStore = New-Object System.Security.Cryptography.X509Certificates.X509Store("Root", "LocalMachine")
            $rootStore.Open("ReadWrite")
            $rootStore.Add($cert)
            $rootStore.Close()
            Write-Host "  Certificate trusted successfully" -ForegroundColor Green
        }
        catch
        {
            Write-Host "  Could not trust certificate: $_" -ForegroundColor Yellow
            Write-Host "  You may see browser warnings until manually trusted" -ForegroundColor Gray
        }
    }

    return $certPath
}

function Prompt-NetworkConfig
{
    Write-Host ""
    Write-Host "  Network Configuration:" -ForegroundColor Cyan
    Write-Host ""

    # Port configuration with validation and retry
    $maxAttempts = 3
    $port = 2000
    for ($i = 0; $i -lt $maxAttempts; $i++)
    {
        $portInput = Read-Host "  Port number [2000]"
        if ([string]::IsNullOrWhiteSpace($portInput))
        {
            $port = 2000
            break
        }

        if ($portInput -match '^\d+$')
        {
            $portNum = [int]$portInput
            if ($portNum -ge 1 -and $portNum -le 65535)
            {
                $port = $portNum
                break
            }
            else
            {
                Write-Host "  Error: Port must be between 1 and 65535." -ForegroundColor Red
            }
        }
        else
        {
            Write-Host "  Error: Port must be a number." -ForegroundColor Red
        }

        if ($i -lt $maxAttempts - 1)
        {
            Write-Host "  Please try again." -ForegroundColor Yellow
        }
        else
        {
            Write-Host "  Using default port 2000." -ForegroundColor Yellow
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

    # Binding choice with validation and retry
    $bindAddress = "*"
    for ($i = 0; $i -lt $maxAttempts; $i++)
    {
        $bindChoice = Read-Host "  Your choice [1/2]"

        if ([string]::IsNullOrWhiteSpace($bindChoice) -or $bindChoice -eq "1")
        {
            $bindAddress = "*"
            Write-Host ""
            Write-Host "  Security Warning:" -ForegroundColor Yellow
            Write-Host "  MidTerm will accept connections from any device on your network." -ForegroundColor Yellow
            Write-Host "  Ensure your password is strong and consider firewall rules." -ForegroundColor Yellow
            break
        }
        elseif ($bindChoice -eq "2")
        {
            $bindAddress = "localhost"
            Write-Host "  Binding to localhost only" -ForegroundColor Gray
            break
        }
        else
        {
            Write-Host "  Error: Please enter 1 or 2." -ForegroundColor Red
            if ($i -lt $maxAttempts - 1)
            {
                Write-Host "  Please try again." -ForegroundColor Yellow
            }
            else
            {
                Write-Host "  Using default: accept connections from anywhere." -ForegroundColor Yellow
                $bindAddress = "*"
            }
        }
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
    param(
        [bool]$DevChannel = $false
    )

    if ($DevChannel)
    {
        Write-Host "Fetching latest dev release..." -ForegroundColor Gray
        $apiUrl = "https://api.github.com/repos/$RepoOwner/$RepoName/releases"
        $releases = Invoke-RestMethod -Uri $apiUrl -Headers @{ "User-Agent" = "MidTerm-Installer" }

        # Find the first prerelease
        $release = $releases | Where-Object { $_.prerelease -eq $true } | Select-Object -First 1

        if (-not $release)
        {
            Write-Host "  No dev releases found, falling back to latest stable..." -ForegroundColor Yellow
            $apiUrl = "https://api.github.com/repos/$RepoOwner/$RepoName/releases/latest"
            $release = Invoke-RestMethod -Uri $apiUrl -Headers @{ "User-Agent" = "MidTerm-Installer" }
        }

        return $release
    }
    else
    {
        Write-Host "Fetching latest release..." -ForegroundColor Gray
        $apiUrl = "https://api.github.com/repos/$RepoOwner/$RepoName/releases/latest"
        $release = Invoke-RestMethod -Uri $apiUrl -Headers @{ "User-Agent" = "MidTerm-Installer" }
        return $release
    }
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
        [string]$InstallDir,
        [string]$Username,
        [string]$UserSid,
        [string]$PasswordHash,
        [int]$Port = 2000,
        [string]$BindAddress = "*",
        [string]$CertPath = $null
    )

    # Uses PATH_CONSTANTS defined above - keep in sync with SettingsService.cs!
    $configDir = $WIN_SERVICE_SETTINGS_DIR
    $settingsPath = Join-Path $configDir "settings.json"
    $oldSettingsPath = Join-Path $configDir "settings.json.old"

    if (-not (Test-Path $configDir))
    {
        New-Item -ItemType Directory -Path $configDir -Force | Out-Null
    }

    # Read updateChannel from existing settings before backup (preserve dev channel users)
    $existingUpdateChannel = $null
    if (Test-Path $settingsPath)
    {
        try
        {
            $existingSettings = Get-Content -Path $settingsPath -Raw | ConvertFrom-Json
            if ($existingSettings.updateChannel)
            {
                $existingUpdateChannel = $existingSettings.updateChannel
            }
        }
        catch { }
    }

    # Backup existing settings for migration by the app
    if (Test-Path $settingsPath)
    {
        Write-Host "  Backing up existing settings..." -ForegroundColor Gray
        Move-Item -Path $settingsPath -Destination $oldSettingsPath -Force
    }

    # Write minimal bootstrap settings - app will migrate user preferences from .old
    # Note: port/bind are passed via service command line args, not settings.json
    # Note: passwordHash is NOT written here - it must go to secure storage via --write-secret
    $settings = @{
        runAsUser = $Username
        runAsUserSid = $UserSid
        authenticationEnabled = $true
        isServiceInstall = $true
    }

    # HTTPS settings - always HTTPS, use OS-level key protection
    if ($CertPath)
    {
        $settings.certificatePath = $CertPath
        $settings.keyProtection = "osProtected"
    }

    # Preserve updateChannel if it existed (keep dev channel users on dev)
    if ($existingUpdateChannel)
    {
        $settings.updateChannel = $existingUpdateChannel
    }

    $json = $settings | ConvertTo-Json -Depth 10
    Set-Content -Path $settingsPath -Value $json -Encoding UTF8
    Write-Host "  Settings: $settingsPath" -ForegroundColor Gray

    # Store password hash in secure storage (DPAPI-protected secrets.bin)
    # Use --service-mode to ensure it writes to ProgramData, not user profile
    if ($PasswordHash)
    {
        $mtPath = Join-Path $InstallDir "mt.exe"
        $secretsPath = "$WIN_SERVICE_SETTINGS_DIR\$WIN_SECRETS_FILENAME"
        try
        {
            $PasswordHash | & $mtPath --write-secret password_hash --service-mode 2>&1 | Out-Null
            Write-Host "  Password: stored in $secretsPath" -ForegroundColor Gray
        }
        catch
        {
            Write-Host "  Warning: Failed to store password in secure storage: $_" -ForegroundColor Yellow
        }
    }

    Write-Host "  Terminal user: $Username" -ForegroundColor Gray
    Write-Host "  Port: $Port" -ForegroundColor Gray
    Write-Host "  Binding: $(if ($BindAddress -eq 'localhost') { 'localhost only' } else { 'all interfaces' })" -ForegroundColor Gray
    if ($CertPath) { Write-Host "  Certificate: $CertPath" -ForegroundColor Gray }
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
        [string]$BindAddress = "*",
        [bool]$TrustCert = $false
    )

    # Initialize logging
    $mode = if ($AsService) { "service" } else { "user" }
    Initialize-Log -Mode $mode
    Write-Log "Starting installation: Version=$Version, AsService=$AsService, RunAsUser=$RunAsUser"

    if ($AsService)
    {
        # Uses PATH_CONSTANTS defined above - keep in sync with SettingsService.cs!
        $installDir = $WIN_SERVICE_INSTALL_DIR
        Write-Log "Install directory: $installDir"

        # Stop and remove old two-service architecture if present
        $existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        $oldHostService = Get-Service -Name $OldHostServiceName -ErrorAction SilentlyContinue

        if ($existingService)
        {
            Write-Host "Stopping existing service..." -ForegroundColor Gray
            Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue

            # Kill any remaining processes
            Get-Process -Name "mt-host", "mthost", "mt" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

            # Wait for processes to fully exit (file handles released)
            $maxWait = 10
            $waited = 0
            while ($waited -lt $maxWait)
            {
                $procs = Get-Process -Name "mt-host", "mthost", "mt" -ErrorAction SilentlyContinue
                if (-not $procs) { break }
                Start-Sleep -Milliseconds 500
                $waited++
            }

            if ($waited -ge $maxWait)
            {
                Write-Host "  Warning: Some processes may still be running" -ForegroundColor Yellow
            }
        }

        # Migration: remove old MidTermHost service from v2.1.x
        if ($oldHostService)
        {
            Write-Host "Migrating from old two-service architecture..." -ForegroundColor Yellow
            Stop-Service -Name $OldHostServiceName -Force -ErrorAction SilentlyContinue
            Get-Process -Name "mt-host" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 1
            sc.exe delete $OldHostServiceName | Out-Null
        }
    }
    else
    {
        # Uses PATH_CONSTANTS defined above
        $installDir = $WIN_USER_INSTALL_DIR
    }

    # Create install directory
    if (-not (Test-Path $installDir))
    {
        New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    }

    # Download and extract
    $tempZip = Join-Path $env:TEMP "mt-download.zip"
    $tempExtract = Join-Path $env:TEMP "mt-extract"

    Write-Log "=== PHASE 1: Downloading binaries ==="
    Write-Host "Downloading..." -ForegroundColor Gray
    $assetUrl = Get-AssetUrl -Release $script:release
    Write-Log "Downloading from: $assetUrl"
    Invoke-WebRequest -Uri $assetUrl -OutFile $tempZip
    Write-Log "Download complete"

    Write-Host "Extracting..." -ForegroundColor Gray
    Write-Log "Extracting to: $tempExtract"
    if (Test-Path $tempExtract) { Remove-Item $tempExtract -Recurse -Force }
    Expand-Archive -Path $tempZip -DestinationPath $tempExtract
    Write-Log "Extraction complete"

    Write-Log "=== PHASE 2: Installing binaries ==="
    # Copy binaries
    $sourceWebBinary = Join-Path $tempExtract $WebBinaryName
    $sourceConHostBinary = Join-Path $tempExtract $TtyHostBinaryName
    $destWebBinary = Join-Path $installDir $WebBinaryName
    $destConHostBinary = Join-Path $installDir $TtyHostBinaryName

    Write-Host "Installing binaries to $installDir..." -ForegroundColor Gray
    Write-Log "Installing binaries to $installDir"

    # Retry logic for file copy (handles may take time to release)
    $maxRetries = 15
    $retryDelay = 500

    # Copy mt.exe with retry
    $copied = $false
    for ($i = 0; $i -lt $maxRetries; $i++)
    {
        try
        {
            Copy-Item $sourceWebBinary $destWebBinary -Force -ErrorAction Stop
            Write-Host "  Installed: $destWebBinary" -ForegroundColor Gray
            $copied = $true
            break
        }
        catch
        {
            if ($i -eq 0)
            {
                Write-Host "  Waiting for $WebBinaryName to be released..." -ForegroundColor Yellow
            }
            Start-Sleep -Milliseconds $retryDelay
        }
    }
    if (-not $copied)
    {
        Write-Host "  Failed to copy $WebBinaryName after $maxRetries attempts - file is locked" -ForegroundColor Red
        Write-Host "  Try manually stopping the MidTerm service or process" -ForegroundColor Red
        throw "Failed to install $WebBinaryName - file locked"
    }

    # Copy mthost.exe with retry
    if (Test-Path $sourceConHostBinary)
    {
        $copied = $false
        for ($i = 0; $i -lt $maxRetries; $i++)
        {
            try
            {
                Copy-Item $sourceConHostBinary $destConHostBinary -Force -ErrorAction Stop
                Write-Host "  Installed: $destConHostBinary" -ForegroundColor Gray
                $copied = $true
                break
            }
            catch
            {
                if ($i -eq 0)
                {
                    Write-Host "  Waiting for $TtyHostBinaryName to be released..." -ForegroundColor Yellow
                }
                Start-Sleep -Milliseconds $retryDelay
            }
        }
        if (-not $copied)
        {
            Write-Host "  Failed to copy $TtyHostBinaryName after $maxRetries attempts - file is locked" -ForegroundColor Red
            throw "Failed to install $TtyHostBinaryName - file locked"
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

    Write-Log "=== PHASE 3: Password configuration ==="
    # Hash pending password now that mt.exe is installed
    if ($PasswordHash -and $PasswordHash.StartsWith("__PENDING__:"))
    {
        Write-Log "Hashing pending password..."
        $plainPassword = $PasswordHash.Substring(12)
        try
        {
            $hash = $plainPassword | & $destWebBinary --hash-password 2>&1
            if ($hash -match '^\$PBKDF2\$')
            {
                $PasswordHash = $hash
                Write-Log "Password hashed successfully"
                Write-Host "  Password: hashed" -ForegroundColor Gray
            }
            else
            {
                Write-Log "Password hashing failed, using fallback" "WARN"
                Write-Host "  Warning: Password hashing failed, using fallback" -ForegroundColor Yellow
            }
        }
        catch
        {
            Write-Log "Could not hash password: $_" "WARN"
            Write-Host "  Warning: Could not hash password: $_" -ForegroundColor Yellow
        }
    }
    elseif ($PasswordHash)
    {
        Write-Log "Using existing password hash"
    }
    else
    {
        Write-Log "No password hash provided (existing password will be preserved)"
    }

    Write-Log "=== PHASE 4: Certificate configuration ==="
    # Always generate certificate now that mt.exe is installed (always HTTPS)
    # Uses PATH_CONSTANTS defined above - keep in sync with SettingsService.cs!
    $settingsDir = if ($AsService) { $WIN_SERVICE_SETTINGS_DIR } else { $WIN_USER_SETTINGS_DIR }
    Write-Log "Settings directory: $settingsDir"
    $CertPath = Generate-Certificate -InstallDir $installDir -SettingsDir $settingsDir -IsService $AsService -TrustCert $TrustCert
    if (-not $CertPath)
    {
        Write-Host "  Warning: Certificate generation failed. App will use fallback certificate." -ForegroundColor Yellow
    }
    else
    {
        # Show fingerprint so user can verify connections from other devices
        Show-CertificateFingerprint -CertPath $CertPath
    }

    Write-Log "=== PHASE 5: Service/App installation ==="
    if ($AsService)
    {
        # Write settings with runAsUser info and password
        if ($RunAsUser -and $RunAsUserSid)
        {
            Write-Log "Writing service settings..."
            Write-ServiceSettings -InstallDir $installDir -Username $RunAsUser -UserSid $RunAsUserSid -PasswordHash $PasswordHash -Port $Port -BindAddress $BindAddress -CertPath $CertPath
        }

        Write-Log "Installing as Windows service..."
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
        # Uses PATH_CONSTANTS defined above - keep in sync with SettingsService.cs!
        $userSettingsDir = $WIN_USER_SETTINGS_DIR
        $userSettingsPath = Join-Path $userSettingsDir "settings.json"
        if (-not (Test-Path $userSettingsDir)) { New-Item -ItemType Directory -Path $userSettingsDir -Force | Out-Null }

        # Note: passwordHash goes to secure storage, not settings.json
        $userSettings = @{
            authenticationEnabled = $true
            isServiceInstall = $false
        }
        if ($CertPath) {
            $userSettings.certificatePath = $CertPath
            $userSettings.keyProtection = "osProtected"
        }
        $userSettings | ConvertTo-Json | Set-Content -Path $userSettingsPath -Encoding UTF8
        Write-Host "  Settings: $userSettingsPath" -ForegroundColor Gray

        # Store password hash in secure storage (DPAPI-protected secrets.bin)
        # User mode - no --service-mode flag, stores in user profile
        if ($PasswordHash)
        {
            $mtPath = Join-Path $installDir "mt.exe"
            try
            {
                $PasswordHash | & $mtPath --write-secret password_hash 2>&1 | Out-Null
                Write-Host "  Password: stored in secure storage ($userSettingsDir\secrets.bin)" -ForegroundColor Gray
            }
            catch
            {
                Write-Host "  Warning: Failed to store password in secure storage: $_" -ForegroundColor Yellow
            }
        }

        Install-AsUserApp -InstallDir $installDir -Version $Version
    }

    Write-Log "=========================================="
    Write-Log "INSTALLATION COMPLETE"
    Write-Log "  Location: $installDir"
    Write-Log "  URL: https://localhost:$Port"
    Write-Log "  Settings: $settingsDir"
    Write-Log "=========================================="

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
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
        Get-Process -Name "mt-host", "mthost", "mt" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

        # Wait for processes to exit
        $maxWait = 10
        for ($i = 0; $i -lt $maxWait; $i++)
        {
            $procs = Get-Process -Name "mt-host", "mthost", "mt" -ErrorAction SilentlyContinue
            if (-not $procs) { break }
            Start-Sleep -Milliseconds 500
        }

        sc.exe delete $ServiceName | Out-Null
        Start-Sleep -Milliseconds 500
    }

    # Convert bind address for command line
    $bindArg = if ($BindAddress -eq "localhost") { "127.0.0.1" } else { "0.0.0.0" }

    # Create service - mt.exe spawns mthost per terminal session
    Write-Log "Creating Windows service..."
    Write-Host "Creating MidTerm service..." -ForegroundColor Gray
    $binPath = "`"$webBinaryPath`" --port $Port --bind $bindArg"
    Write-Log "Service binPath: $binPath"
    $scCreateOutput = sc.exe create $ServiceName binPath= $binPath start= auto DisplayName= "$DisplayName" 2>&1
    Write-Log "sc.exe create output: $scCreateOutput"
    sc.exe description $ServiceName "Web-based terminal multiplexer for AI coding agents and TUI apps" | Out-Null

    # Start service
    Write-Log "Starting service..."
    Write-Host "Starting service..." -ForegroundColor Gray
    try
    {
        Start-Service -Name $ServiceName -ErrorAction Stop
        Write-Log "Service started successfully"
    }
    catch
    {
        Write-Log "Failed to start service: $_" "ERROR"
        throw
    }

    # Verify service is running
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($svc)
    {
        Write-Log "Service status: $($svc.Status)"
    }

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

# If we're being called with ServiceMode flag, we're the elevated process (runs hidden)
if ($ServiceMode)
{
    # If log file specified, redirect all output there for streaming to original terminal
    if ($LogFile)
    {
        # Clear log file
        "" | Set-Content $LogFile -Force

        # Run the install with all output captured to file
        & {
            Write-Host ""
            Write-Host "  Running with administrator privileges..." -ForegroundColor Cyan
            Write-Host ""
            $script:release = Get-LatestRelease -DevChannel $Dev
            $version = $script:release.tag_name -replace "^v", ""
            $channelLabel = if ($Dev) { "dev" } else { "stable" }
            Write-Host "  Latest $channelLabel version: $version" -ForegroundColor White
            Write-Host ""
            Install-MidTerm -AsService $true -Version $version -RunAsUser $RunAsUser -RunAsUserSid $RunAsUserSid -PasswordHash $PasswordHash -Port $Port -BindAddress $BindAddress -TrustCert:$TrustCert
        } *>&1 | ForEach-Object {
            $line = $_.ToString()
            Write-Host $_
            Add-Content -Path $LogFile -Value $line
        }
    }
    else
    {
        Write-Host ""
        Write-Host "  Running with administrator privileges..." -ForegroundColor Cyan
        Write-Host ""
        $script:release = Get-LatestRelease -DevChannel $Dev
        $version = $script:release.tag_name -replace "^v", ""
        $channelLabel = if ($Dev) { "dev" } else { "stable" }
        Write-Host "  Latest $channelLabel version: $version" -ForegroundColor White
        Write-Host ""
        Install-MidTerm -AsService $true -Version $version -RunAsUser $RunAsUser -RunAsUserSid $RunAsUserSid -PasswordHash $PasswordHash -Port $Port -BindAddress $BindAddress -TrustCert:$TrustCert
    }
    return
}

# Capture current user info BEFORE any potential elevation
$currentUser = Get-CurrentUserInfo

Write-Header

# Show channel info
if ($Dev)
{
    Write-Host "  Channel: dev (prereleases)" -ForegroundColor Yellow
    Write-Host ""
}

# Fetch release info first
$script:release = Get-LatestRelease -DevChannel $Dev
$version = $script:release.tag_name -replace "^v", ""
$channelLabel = if ($Dev) { "dev" } else { "stable" }

Write-Host "  Latest $channelLabel version: $version" -ForegroundColor White
Write-Host ""

# Prompt for install mode with validation
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

$asService = $null
$maxAttempts = 3
for ($i = 0; $i -lt $maxAttempts; $i++)
{
    $choice = Read-Host "  Your choice [1/2]"

    if ([string]::IsNullOrWhiteSpace($choice) -or $choice -eq "1")
    {
        $asService = $true
        break
    }
    elseif ($choice -eq "2")
    {
        $asService = $false
        break
    }
    else
    {
        Write-Host "  Error: Please enter 1 or 2." -ForegroundColor Red
        if ($i -lt $maxAttempts - 1)
        {
            Write-Host "  Please try again." -ForegroundColor Yellow
        }
        else
        {
            Write-Host "  Using default: System service." -ForegroundColor Yellow
            $asService = $true
        }
    }
}

if ($asService)
{
    # Uses PATH_CONSTANTS defined above - keep in sync with SettingsService.cs!
    $installDir = $WIN_SERVICE_INSTALL_DIR

    # Check for existing password in secure storage (preserve on update)
    if (Test-ExistingPassword)
    {
        Write-Host ""
        Write-Host "  Existing password found in secure storage - preserving..." -ForegroundColor Green
        $passwordHash = $null  # Don't overwrite - existing secrets.bin will be preserved
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

    # Ask about certificate trust BEFORE elevation (all interactive prompts in original terminal)
    Write-Host ""
    Write-Host "  Certificate Trust:" -ForegroundColor Cyan
    Write-Host "  Trust the certificate to remove browser warnings?" -ForegroundColor Yellow
    Write-Host "  (Adds self-signed certificate to Windows trusted root store)" -ForegroundColor Gray
    $trustChoice = Read-Host "  Trust certificate? [Y/n]"
    $trustCert = ($trustChoice -ne "n" -and $trustChoice -ne "N")

    # Check if we need to elevate
    if (-not (Test-Administrator))
    {
        Write-Host ""
        Write-Host "Requesting administrator privileges..." -ForegroundColor Yellow
        Write-Host ""

        # Download script to temp file and run elevated with parameters
        $tempScript = Join-Path $env:TEMP "mt-install-elevated.ps1"
        $tempLogFile = Join-Path $env:TEMP "mt-install-log.txt"
        $scriptUrl = "https://raw.githubusercontent.com/tlbx-ai/MidTerm/main/install.ps1"
        Invoke-WebRequest -Uri $scriptUrl -OutFile $tempScript

        # Clear any existing log file
        if (Test-Path $tempLogFile) { Remove-Item $tempLogFile -Force }

        # Run elevated with user info passed as parameters (hidden window, output to log file)
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
            "-LogFile", $tempLogFile
        )
        if ($trustCert) { $arguments += "-TrustCert" }
        if ($Dev) { $arguments += "-Dev" }

        # Start elevated process hidden
        $elevatedProcess = Start-Process pwsh -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -PassThru

        # Stream output from log file to original terminal
        $linesRead = 0
        while (-not $elevatedProcess.HasExited)
        {
            Start-Sleep -Milliseconds 200
            if (Test-Path $tempLogFile)
            {
                $lines = Get-Content $tempLogFile -ErrorAction SilentlyContinue
                if ($lines -and $lines.Count -gt $linesRead)
                {
                    $lines[$linesRead..($lines.Count - 1)] | ForEach-Object { Write-Host $_ }
                    $linesRead = $lines.Count
                }
            }
        }

        # Final read to catch any remaining output
        Start-Sleep -Milliseconds 300
        if (Test-Path $tempLogFile)
        {
            $lines = Get-Content $tempLogFile -ErrorAction SilentlyContinue
            if ($lines -and $lines.Count -gt $linesRead)
            {
                $lines[$linesRead..($lines.Count - 1)] | ForEach-Object { Write-Host $_ }
            }
        }

        # Cleanup
        Remove-Item $tempScript -Force -ErrorAction SilentlyContinue
        Remove-Item $tempLogFile -Force -ErrorAction SilentlyContinue
        return
    }

    # Already admin, proceed with install
    Install-MidTerm -AsService $true -Version $version -RunAsUser $currentUser.Name -RunAsUserSid $currentUser.Sid -PasswordHash $passwordHash -Port $port -BindAddress $bindAddress -TrustCert $trustCert
}
else
{
    # User install - still require password
    # Uses PATH_CONSTANTS defined above - keep in sync with SettingsService.cs!
    $userSettingsDir = $WIN_USER_SETTINGS_DIR
    $userSecretsPath = Join-Path $userSettingsDir $WIN_SECRETS_FILENAME

    # Check for existing password in secure storage
    $hasExistingPassword = $false
    if (Test-Path $userSecretsPath)
    {
        try
        {
            $secrets = Get-Content $userSecretsPath -Raw | ConvertFrom-Json
            if ($secrets.password_hash -and $secrets.password_hash.Length -gt 10)
            {
                $hasExistingPassword = $true
            }
        }
        catch { }
    }

    if ($hasExistingPassword)
    {
        Write-Host ""
        Write-Host "  Existing password found in secure storage - preserving..." -ForegroundColor Green
        $passwordHash = $null  # Don't overwrite - existing secrets.bin will be preserved
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
