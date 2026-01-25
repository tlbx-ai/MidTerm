using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Models.Update;

namespace Ai.Tlbx.MidTerm.Services;

/// <summary>
/// Generates bulletproof update scripts for Windows, Linux, and macOS.
/// Scripts include: aggressive process termination, file lock waiting,
/// copy verification, rollback on failure, and detailed logging.
/// </summary>
public static class UpdateScriptGenerator
{
    private const string ServiceName = "MidTerm";
    private const string LaunchdLabel = "ai.tlbx.midterm";
    private const string SystemdService = "midterm";
    private const int MaxRetries = 30;
    private const int RetryDelaySeconds = 1;

    public static string GenerateUpdateScript(
        string extractedDir,
        string currentBinaryPath,
        string settingsDirectory,
        UpdateType updateType = UpdateType.Full,
        bool deleteSourceAfter = true)
    {
        if (OperatingSystem.IsWindows())
        {
            return GenerateWindowsScript(extractedDir, currentBinaryPath, settingsDirectory, updateType, deleteSourceAfter);
        }

        return GenerateUnixScript(extractedDir, currentBinaryPath, settingsDirectory, updateType, deleteSourceAfter);
    }

    private static string GenerateWindowsScript(string extractedDir, string currentBinaryPath, string settingsDirectory, UpdateType updateType, bool deleteSourceAfter)
    {
        // IMPORTANT: Binary dir != Settings dir on Windows
        // Binaries: C:\Program Files\MidTerm (installDir)
        // Settings: C:\ProgramData\MidTerm (settingsDir) for service mode, or user profile for user mode
        var installDir = Path.GetDirectoryName(currentBinaryPath) ?? currentBinaryPath;
        var settingsDir = settingsDirectory;
        var newMtPath = Path.Combine(extractedDir, "mt.exe");
        var newMthostPath = Path.Combine(extractedDir, "mthost.exe");
        var newVersionJsonPath = Path.Combine(extractedDir, "version.json");
        var currentMthostPath = Path.Combine(installDir, "mthost.exe");
        var currentVersionJsonPath = Path.Combine(installDir, "version.json");
        // Log and result files go in settings directory so they're accessible after update
        var resultFilePath = Path.Combine(settingsDir, "update-result.json");
        var logFilePath = Path.Combine(settingsDir, "update.log");
        var scriptPath = Path.Combine(Path.GetTempPath(), $"mt-update-{Guid.NewGuid():N}.ps1");

        var isWebOnly = updateType == UpdateType.WebOnly;

        var script = $@"
# MidTerm Update Script (Windows)
# Type: {(isWebOnly ? "Web-only (sessions preserved)" : "Full (sessions will restart)")}
# Generated: {DateTime.UtcNow:O}
#
# IMPORTANT: InstallDir (binaries) != SettingsDir (config/certs)
# - InstallDir: C:\Program Files\MidTerm (or user install location)
# - SettingsDir: C:\ProgramData\MidTerm (service) or %APPDATA%\MidTerm (user)

$ErrorActionPreference = 'Stop'

# === Configuration ===
# IMPORTANT: These directories are DIFFERENT - don't confuse them!
$InstallDir = '{EscapeForPowerShell(installDir)}'           # Binaries: mt.exe, mthost.exe
$SettingsDir = '{EscapeForPowerShell(settingsDir)}'         # Settings, secrets, certs
$CurrentMt = '{EscapeForPowerShell(currentBinaryPath)}'
$CurrentMthost = '{EscapeForPowerShell(currentMthostPath)}'
$CurrentVersionJson = '{EscapeForPowerShell(currentVersionJsonPath)}'
$NewMt = '{EscapeForPowerShell(newMtPath)}'
$NewMthost = '{EscapeForPowerShell(newMthostPath)}'
$NewVersionJson = '{EscapeForPowerShell(newVersionJsonPath)}'
$ExtractedDir = '{EscapeForPowerShell(extractedDir)}'
$LogFile = '{EscapeForPowerShell(logFilePath)}'
$ResultFile = '{EscapeForPowerShell(resultFilePath)}'
$MaxRetries = {MaxRetries}
$IsWebOnly = ${(isWebOnly ? "true" : "false")}
$DeleteSource = ${(deleteSourceAfter ? "true" : "false")}

# === Helper Functions ===

function Log {{
    param([string]$Message, [string]$Level = 'INFO')
    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'
    $line = ""[$timestamp] [$Level] $Message""
    Write-Host $line
    try {{ Add-Content -Path $LogFile -Value $line -ErrorAction SilentlyContinue }} catch {{}}
}}

function WriteResult {{
    param([bool]$Success, [string]$Message, [string]$Details = '')
    $result = @{{
        success = $Success
        message = $Message
        details = $Details
        timestamp = (Get-Date -Format 'o')
        logFile = $LogFile
    }}
    try {{
        $result | ConvertTo-Json -Depth 3 | Set-Content -Path $ResultFile -Encoding UTF8
    }} catch {{
        Log ""Failed to write result file: $_"" 'ERROR'
    }}
}}

function WaitForFileWritable {{
    param([string]$Path, [int]$Retries = $MaxRetries)

    for ($i = 1; $i -le $Retries; $i++) {{
        if (-not (Test-Path $Path)) {{
            Log ""File does not exist (OK): $Path""
            return $true
        }}

        try {{
            $stream = [System.IO.File]::Open($Path, 'Open', 'ReadWrite', 'None')
            $stream.Close()
            $stream.Dispose()
            Log ""File is writable: $Path""
            return $true
        }} catch {{
            Log ""File locked (attempt $i/$Retries): $Path"" 'WARN'
            if ($i -lt $Retries) {{
                Start-Sleep -Seconds {RetryDelaySeconds}
            }}
        }}
    }}

    Log ""File still locked after $Retries attempts: $Path"" 'ERROR'
    return $false
}}

function KillProcessByName {{
    param([string]$Name)

    $procs = Get-Process -Name $Name -ErrorAction SilentlyContinue
    if ($procs) {{
        foreach ($proc in $procs) {{
            Log ""Killing $Name (PID: $($proc.Id))...""
            try {{
                $proc.Kill()
                $proc.WaitForExit(5000)
            }} catch {{
                Log ""Failed to kill $Name (PID: $($proc.Id)): $_"" 'WARN'
            }}
        }}
        Start-Sleep -Milliseconds 500
    }}

    # Double-check with taskkill
    $remaining = Get-Process -Name $Name -ErrorAction SilentlyContinue
    if ($remaining) {{
        Log ""Using taskkill for remaining $Name processes...""
        taskkill /F /IM ""$Name.exe"" 2>$null
        Start-Sleep -Seconds 1
    }}
}}

function VerifyCopy {{
    param([string]$Source, [string]$Dest)

    if (-not (Test-Path $Dest)) {{
        throw ""Copy verification failed: destination does not exist: $Dest""
    }}

    $srcSize = (Get-Item $Source).Length
    $dstSize = (Get-Item $Dest).Length

    if ($srcSize -ne $dstSize) {{
        throw ""Copy verification failed: size mismatch for $Dest (expected $srcSize bytes, got $dstSize bytes)""
    }}

    Log ""Verified: $Dest ($dstSize bytes)""
}}

function SafeCopy {{
    param([string]$Source, [string]$Dest, [string]$Description)

    Log ""Copying $Description...""
    Log ""  From: $Source""
    Log ""  To: $Dest""

    if (-not (Test-Path $Source)) {{
        throw ""Source file does not exist: $Source""
    }}

    Copy-Item -Path $Source -Destination $Dest -Force -ErrorAction Stop
    VerifyCopy $Source $Dest

    Log ""$Description copied successfully""
}}

# === Main Script ===

# Clear previous logs
Remove-Item $LogFile -Force -ErrorAction SilentlyContinue
Remove-Item $ResultFile -Force -ErrorAction SilentlyContinue

Log '=========================================='
Log 'MidTerm Update Script Starting'
Log ""Update type: $(if ($IsWebOnly) {{ 'Web-only' }} else {{ 'Full' }})""
Log '=========================================='

$rollbackNeeded = $false
$startedOk = $false

try {{
    # ============================================
    # PHASE 1: Stop all processes
    # ============================================
    Log ''
    Log '=== PHASE 1: Stopping processes ==='

    # Stop Windows service if running
    $service = Get-Service -Name '{ServiceName}' -ErrorAction SilentlyContinue
    if ($service -and $service.Status -eq 'Running') {{
        Log 'Stopping MidTerm service...'
        Stop-Service -Name '{ServiceName}' -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2

        # Verify service stopped
        $service = Get-Service -Name '{ServiceName}' -ErrorAction SilentlyContinue
        if ($service -and $service.Status -eq 'Running') {{
            Log 'Service did not stop gracefully, forcing...' 'WARN'
        }}
    }}

    # Kill mt.exe processes
    Log 'Killing mt.exe processes...'
    KillProcessByName 'mt'

    # Kill mthost.exe processes (only for full updates)
    if (-not $IsWebOnly) {{
        Log 'Killing mthost.exe processes...'
        KillProcessByName 'mthost'
    }}

    Log 'All processes stopped'

    # ============================================
    # PHASE 2: Wait for file handles to release
    # ============================================
    Log ''
    Log '=== PHASE 2: Waiting for file handles ==='

    if (-not (WaitForFileWritable $CurrentMt)) {{
        throw ""mt.exe is still locked after $MaxRetries retries. Another process may be using it.""
    }}

    if ((-not $IsWebOnly) -and (Test-Path $CurrentMthost)) {{
        if (-not (WaitForFileWritable $CurrentMthost)) {{
            throw ""mthost.exe is still locked after $MaxRetries retries. Another process may be using it.""
        }}
    }}

    Log 'All file handles released'

    # ============================================
    # PHASE 3: Create backups
    # ============================================
    Log ''
    Log '=== PHASE 3: Creating backups ==='

    if (Test-Path $CurrentMt) {{
        Log 'Backing up mt.exe...'
        Copy-Item $CurrentMt ""$CurrentMt.bak"" -Force -ErrorAction Stop
        Log 'mt.exe backed up'
    }}

    if ((-not $IsWebOnly) -and (Test-Path $CurrentMthost)) {{
        Log 'Backing up mthost.exe...'
        Copy-Item $CurrentMthost ""$CurrentMthost.bak"" -Force -ErrorAction Stop
        Log 'mthost.exe backed up'
    }}

    if (Test-Path $CurrentVersionJson) {{
        Log 'Backing up version.json...'
        Copy-Item $CurrentVersionJson ""$CurrentVersionJson.bak"" -Force -ErrorAction Stop
        Log 'version.json backed up'
    }}

    # Backup credential files (critical for security persistence)
    # IMPORTANT: These are in SettingsDir, NOT InstallDir!
    $settingsPath = Join-Path $SettingsDir 'settings.json'
    $secretsPath = Join-Path $SettingsDir 'secrets.bin'
    $certPath = Join-Path $SettingsDir 'midterm.pem'
    $keysDir = Join-Path $SettingsDir 'keys'

    if (Test-Path $settingsPath) {{
        Log 'Backing up settings.json...'
        Copy-Item $settingsPath ""$settingsPath.bak"" -Force -ErrorAction Stop
        Log 'settings.json backed up'
    }}
    if (Test-Path $secretsPath) {{
        Log 'Backing up secrets.bin...'
        Copy-Item $secretsPath ""$secretsPath.bak"" -Force -ErrorAction Stop
        Log 'secrets.bin backed up'
    }}
    if (Test-Path $certPath) {{
        Log 'Backing up midterm.pem...'
        Copy-Item $certPath ""$certPath.bak"" -Force -ErrorAction Stop
        Log 'midterm.pem backed up'
    }}
    if (Test-Path $keysDir) {{
        Log 'Backing up keys directory...'
        Copy-Item $keysDir ""$keysDir.bak"" -Recurse -Force -ErrorAction Stop
        Log 'keys directory backed up'
    }}

    $rollbackNeeded = $true
    Log 'All backups created (including credentials)'

    # === CERTIFICATE DIAGNOSTICS ===
    Log ''
    Log '=== Certificate Diagnostics ==='

    # Check cert file
    if (Test-Path $certPath) {{
        $certInfo = Get-Item $certPath
        Log ""  midterm.pem: Size=$($certInfo.Length) bytes, Modified=$($certInfo.LastWriteTime)""

        # Get cert thumbprint
        try {{
            $content = Get-Content $certPath -Raw
            $base64 = $content -replace ""-----BEGIN CERTIFICATE-----"","""" -replace ""-----END CERTIFICATE-----"","""" -replace ""`n"","""" -replace ""`r"",""""
            $bytes = [Convert]::FromBase64String($base64)
            $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList @(,$bytes)
            Log ""  Thumbprint: $($cert.Thumbprint)""
            Log ""  Subject: $($cert.Subject)""
            Log ""  NotAfter: $($cert.NotAfter)""
            Log ""  NotBefore: $($cert.NotBefore)""
        }} catch {{
            Log ""  WARNING: Could not parse certificate: $_"" 'WARN'
        }}
    }} else {{
        Log '  WARNING: midterm.pem does NOT exist!' 'WARN'
    }}

    # Check key file
    $keyFile = Join-Path $keysDir 'midterm.dpapi'
    if (Test-Path $keyFile) {{
        $keyInfo = Get-Item $keyFile
        Log ""  midterm.dpapi: Size=$($keyInfo.Length) bytes, Modified=$($keyInfo.LastWriteTime)""
    }} else {{
        Log '  WARNING: midterm.dpapi does NOT exist!' 'WARN'
    }}

    # Check settings.json for cert config
    if (Test-Path $settingsPath) {{
        try {{
            $settingsJson = Get-Content $settingsPath -Raw | ConvertFrom-Json
            Log ""  settings.certificatePath: $($settingsJson.certificatePath)""
            Log ""  settings.keyProtection: $($settingsJson.keyProtection)""
            Log ""  settings.isServiceInstall: $($settingsJson.isServiceInstall)""
            Log ""  settings.certificateThumbprint: $($settingsJson.certificateThumbprint)""
        }} catch {{
            Log ""  WARNING: Could not parse settings.json: $_"" 'WARN'
        }}
    }}

    # List MidTerm certs in Root store
    Log '  Trusted MidTerm certificates in Root store:'
    try {{
        $store = New-Object System.Security.Cryptography.X509Certificates.X509Store(""Root"",""LocalMachine"")
        $store.Open(""ReadOnly"")
        $midtermCerts = $store.Certificates | Where-Object {{ $_.Subject -eq ""{CertificateGenerator.CertificateSubject}"" }}
        foreach ($c in $midtermCerts) {{
            Log ""    - $($c.Thumbprint.Substring(0,8))... Expires: $($c.NotAfter)""
        }}
        if ($midtermCerts.Count -eq 0) {{
            Log '    (none found)'
        }}
        $store.Close()
    }} catch {{
        Log ""  WARNING: Could not enumerate Root store: $_"" 'WARN'
    }}

    # ============================================
    # PHASE 4: Install new files
    # ============================================
    Log ''
    Log '=== PHASE 4: Installing new files ==='

    SafeCopy $NewMt $CurrentMt 'mt.exe'

    if ((-not $IsWebOnly) -and (Test-Path $NewMthost)) {{
        SafeCopy $NewMthost $CurrentMthost 'mthost.exe'
    }}

    if (Test-Path $NewVersionJson) {{
        SafeCopy $NewVersionJson $CurrentVersionJson 'version.json'
    }}

    Log 'All files installed'

    # ============================================
    # PHASE 5: Start the new version
    # ============================================
    Log ''
    Log '=== PHASE 5: Starting new version ==='

    $service = Get-Service -Name '{ServiceName}' -ErrorAction SilentlyContinue
    if ($service) {{
        Log 'Starting MidTerm service...'
        Start-Service -Name '{ServiceName}' -ErrorAction Stop
        Start-Sleep -Seconds 8

        $service = Get-Service -Name '{ServiceName}'
        if ($service.Status -ne 'Running') {{
            throw ""Service failed to start. Status: $($service.Status)""
        }}
        Log ""Service started successfully (Status: $($service.Status))""
        $startedOk = $true
    }} else {{
        Log 'Starting mt.exe directly...'
        $proc = Start-Process -FilePath $CurrentMt -WindowStyle Hidden -PassThru
        Start-Sleep -Seconds 8

        # Verify process is running
        $running = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
        if (-not $running -or $running.HasExited) {{
            throw 'mt.exe started but exited immediately'
        }}
        Log ""mt.exe started successfully (PID: $($proc.Id))""
        $startedOk = $true
    }}

    # === POST-UPDATE CERTIFICATE VERIFICATION ===
    Log ''
    Log '=== Post-Update Certificate Verification ==='

    # Check if cert file still exists and is valid
    if (Test-Path $certPath) {{
        try {{
            $content = Get-Content $certPath -Raw
            $base64 = $content -replace ""-----BEGIN CERTIFICATE-----"","""" -replace ""-----END CERTIFICATE-----"","""" -replace ""`n"","""" -replace ""`r"",""""
            $bytes = [Convert]::FromBase64String($base64)
            $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList @(,$bytes)
            Log ""  Certificate OK: $($cert.Thumbprint.Substring(0,8))... expires $($cert.NotAfter)""
        }} catch {{
            Log ""  WARNING: Certificate verification failed: $_"" 'WARN'
        }}
    }} else {{
        Log '  WARNING: Certificate file missing after update!' 'WARN'
    }}

    # Check if key file still exists
    if (Test-Path $keyFile) {{
        $keyInfo = Get-Item $keyFile
        Log ""  Key file OK: $($keyInfo.Length) bytes""
    }} else {{
        Log '  WARNING: Key file missing after update!' 'WARN'
    }}

    # ============================================
    # PHASE 6: Cleanup
    # ============================================
    Log ''
    Log '=== PHASE 6: Cleanup ==='

    Remove-Item ""$CurrentMt.bak"" -Force -ErrorAction SilentlyContinue
    Remove-Item ""$CurrentMthost.bak"" -Force -ErrorAction SilentlyContinue
    Remove-Item ""$CurrentVersionJson.bak"" -Force -ErrorAction SilentlyContinue

    # Clean up credential backups (in SettingsDir, not InstallDir!)
    $settingsPath = Join-Path $SettingsDir 'settings.json'
    $secretsPath = Join-Path $SettingsDir 'secrets.bin'
    $certPath = Join-Path $SettingsDir 'midterm.pem'
    $keysDir = Join-Path $SettingsDir 'keys'
    Remove-Item ""$settingsPath.bak"" -Force -ErrorAction SilentlyContinue
    Remove-Item ""$secretsPath.bak"" -Force -ErrorAction SilentlyContinue
    Remove-Item ""$certPath.bak"" -Force -ErrorAction SilentlyContinue
    Remove-Item ""$keysDir.bak"" -Recurse -Force -ErrorAction SilentlyContinue

    if ($DeleteSource) {{
        Remove-Item -Path $ExtractedDir -Recurse -Force -ErrorAction SilentlyContinue
    }}

    Log 'Cleanup complete'

    # ============================================
    # SUCCESS
    # ============================================
    Log ''
    Log '=========================================='
    Log 'UPDATE COMPLETED SUCCESSFULLY'
    Log '=========================================='

    WriteResult $true 'Update completed successfully'

}} catch {{
    $errorMessage = $_.Exception.Message
    Log '' 'ERROR'
    Log '==========================================' 'ERROR'
    Log ""UPDATE FAILED: $errorMessage"" 'ERROR'
    Log '==========================================' 'ERROR'

    if ($rollbackNeeded -and -not $startedOk) {{
        Log ''
        Log '=== ROLLBACK ===' 'WARN'

        # Stop any partially started process
        KillProcessByName 'mt'

        # Restore backups
        if (Test-Path ""$CurrentMt.bak"") {{
            Log 'Restoring mt.exe from backup...'
            try {{
                Copy-Item ""$CurrentMt.bak"" $CurrentMt -Force -ErrorAction Stop
                Log 'mt.exe restored'
            }} catch {{
                Log ""Failed to restore mt.exe: $_"" 'ERROR'
            }}
        }}

        if (Test-Path ""$CurrentMthost.bak"") {{
            Log 'Restoring mthost.exe from backup...'
            try {{
                Copy-Item ""$CurrentMthost.bak"" $CurrentMthost -Force -ErrorAction Stop
                Log 'mthost.exe restored'
            }} catch {{
                Log ""Failed to restore mthost.exe: $_"" 'ERROR'
            }}
        }}

        if (Test-Path ""$CurrentVersionJson.bak"") {{
            Log 'Restoring version.json from backup...'
            try {{
                Copy-Item ""$CurrentVersionJson.bak"" $CurrentVersionJson -Force -ErrorAction Stop
                Log 'version.json restored'
            }} catch {{
                Log ""Failed to restore version.json: $_"" 'ERROR'
            }}
        }}

        # Restore credential files from SettingsDir (not InstallDir!)
        $settingsPath = Join-Path $SettingsDir 'settings.json'
        $secretsPath = Join-Path $SettingsDir 'secrets.bin'
        $certPath = Join-Path $SettingsDir 'midterm.pem'
        $keysDir = Join-Path $SettingsDir 'keys'

        if (Test-Path ""$settingsPath.bak"") {{
            Log 'Restoring settings.json from backup...'
            try {{
                Copy-Item ""$settingsPath.bak"" $settingsPath -Force -ErrorAction Stop
                Log 'settings.json restored'
            }} catch {{
                Log ""Failed to restore settings.json: $_"" 'ERROR'
            }}
        }}
        if (Test-Path ""$secretsPath.bak"") {{
            Log 'Restoring secrets.bin from backup...'
            try {{
                Copy-Item ""$secretsPath.bak"" $secretsPath -Force -ErrorAction Stop
                Log 'secrets.bin restored'
            }} catch {{
                Log ""Failed to restore secrets.bin: $_"" 'ERROR'
            }}
        }}
        if (Test-Path ""$certPath.bak"") {{
            Log 'Restoring midterm.pem from backup...'
            try {{
                Copy-Item ""$certPath.bak"" $certPath -Force -ErrorAction Stop
                Log 'midterm.pem restored'
            }} catch {{
                Log ""Failed to restore midterm.pem: $_"" 'ERROR'
            }}
        }}
        if (Test-Path ""$keysDir.bak"") {{
            Log 'Restoring keys directory from backup...'
            try {{
                Remove-Item $keysDir -Recurse -Force -ErrorAction SilentlyContinue
                Copy-Item ""$keysDir.bak"" $keysDir -Recurse -Force -ErrorAction Stop
                Log 'keys directory restored'
            }} catch {{
                Log ""Failed to restore keys directory: $_"" 'ERROR'
            }}
        }}

        # Try to restart previous version
        Log 'Attempting to restart previous version...'
        $service = Get-Service -Name '{ServiceName}' -ErrorAction SilentlyContinue
        if ($service) {{
            try {{
                Start-Service -Name '{ServiceName}' -ErrorAction Stop
                Log 'Previous version service started'
            }} catch {{
                Log ""Failed to start service: $_"" 'ERROR'
            }}
        }} else {{
            try {{
                Start-Process -FilePath $CurrentMt -WindowStyle Hidden
                Log 'Previous version started'
            }} catch {{
                Log ""Failed to start mt.exe: $_"" 'ERROR'
            }}
        }}

        Log 'Rollback complete'
    }}

    WriteResult $false $errorMessage
}}

# Self-cleanup
Start-Sleep -Seconds 1
Remove-Item $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue
";

        File.WriteAllText(scriptPath, script);
        return scriptPath;
    }

    private static string GenerateUnixScript(string extractedDir, string currentBinaryPath, string settingsDirectory, UpdateType updateType, bool deleteSourceAfter)
    {
        // IMPORTANT: Binary and config directories are DIFFERENT on Unix:
        // - Binaries: /usr/local/bin/ (service) or ~/.local/bin/ (user)
        // - Config/secrets: /usr/local/etc/midterm/ (service) or ~/.midterm/ (user)
        // - Logs: /usr/local/var/log/ (service) or ~/.midterm/ (user)
        // The settingsDirectory parameter tells us which mode we're in.
        // Path logic is centralized in LogPaths.cs - shell scripts must match.
        var installDir = Path.GetDirectoryName(currentBinaryPath) ?? "/usr/local/bin";
        var configDir = settingsDirectory;

        // Determine log directory based on install mode using centralized LogPaths
        var isServiceMode = configDir.StartsWith("/usr/local", StringComparison.Ordinal);
        var logDir = LogPaths.GetLogDirectory(false, isServiceMode);
        var newMtPath = Path.Combine(extractedDir, "mt");
        var newMthostPath = Path.Combine(extractedDir, "mthost");
        var newVersionJsonPath = Path.Combine(extractedDir, "version.json");
        var currentMthostPath = Path.Combine(installDir, "mthost");
        var currentVersionJsonPath = Path.Combine(installDir, "version.json");
        var resultFilePath = Path.Combine(configDir, "update-result.json");
        var logFilePath = Path.Combine(logDir, "update.log");
        var scriptPath = Path.Combine(Path.GetTempPath(), $"mt-update-{Guid.NewGuid():N}.sh");

        var isMacOs = OperatingSystem.IsMacOS();
        var isWebOnly = updateType == UpdateType.WebOnly;

        // IMPORTANT: launchd service runs as user (not root) via UserName key in plist
        // This means the service user needs write access to config/log files
        var stopServiceCmd = isMacOs
            ? $"launchctl bootout system/{LaunchdLabel} 2>/dev/null || launchctl unload /Library/LaunchDaemons/{LaunchdLabel}.plist 2>/dev/null || true"
            : $"systemctl stop {SystemdService} 2>/dev/null || true";

        var startServiceCmd = isMacOs
            ? $"launchctl bootstrap system /Library/LaunchDaemons/{LaunchdLabel}.plist 2>/dev/null || launchctl load /Library/LaunchDaemons/{LaunchdLabel}.plist 2>/dev/null || true"
            : $"systemctl start {SystemdService} 2>/dev/null || true";

        var checkServiceCmd = isMacOs
            ? $"launchctl print system/{LaunchdLabel} >/dev/null 2>&1"
            : $"systemctl is-active --quiet {SystemdService}";

        var script = $@"#!/bin/bash
# MidTerm Update Script (Unix)
# Type: {(isWebOnly ? "Web-only (sessions preserved)" : "Full (sessions will restart)")}
# Generated: {DateTime.UtcNow:O}
#
# IMPORTANT NOTES:
# - macOS: launchd service runs as USER (not root) via UserName key in plist
# - Linux: systemd service runs as root (standard behavior)
# - Binary dir (/usr/local/bin) != Config dir (/usr/local/etc/midterm)
# - macOS requires codesign after binary copy to avoid SIGKILL on launch
# - File ownership must be preserved for user-mode service access

set -euo pipefail

# === Configuration ===
# IMPORTANT: These directories are DIFFERENT - don't confuse them!
INSTALL_DIR='{EscapeForBash(installDir)}'           # Binaries: mt, mthost
CONFIG_DIR='{EscapeForBash(configDir)}'             # Settings, secrets, certs
LOG_DIR='{EscapeForBash(logDir)}'                   # Log files
CURRENT_MT='{EscapeForBash(currentBinaryPath)}'
CURRENT_MTHOST='{EscapeForBash(currentMthostPath)}'
CURRENT_VERSION_JSON='{EscapeForBash(currentVersionJsonPath)}'
NEW_MT='{EscapeForBash(newMtPath)}'
NEW_MTHOST='{EscapeForBash(newMthostPath)}'
NEW_VERSION_JSON='{EscapeForBash(newVersionJsonPath)}'
EXTRACTED_DIR='{EscapeForBash(extractedDir)}'
LOG_FILE='{EscapeForBash(logFilePath)}'
RESULT_FILE='{EscapeForBash(resultFilePath)}'
MAX_RETRIES={MaxRetries}
IS_WEB_ONLY={( isWebOnly ? "true" : "false")}
IS_MACOS={( isMacOs ? "true" : "false")}
DELETE_SOURCE={( deleteSourceAfter ? "true" : "false")}

ROLLBACK_NEEDED=false
STARTED_OK=false

# Detect service user from existing config file ownership
# On macOS, launchd service runs as user (via UserName in plist), not root
# On Linux, systemd typically runs as root, but we preserve existing ownership
SERVICE_USER=""""
if [[ -f ""$CONFIG_DIR/settings.json"" ]]; then
    SERVICE_USER=$(stat -f '%Su' ""$CONFIG_DIR/settings.json"" 2>/dev/null || stat -c '%U' ""$CONFIG_DIR/settings.json"" 2>/dev/null || echo """")
fi

# === Helper Functions ===

log() {{
    local level=""${{2:-INFO}}""
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S.%3N')
    local message=""[$timestamp] [$level] $1""
    echo ""$message""
    echo ""$message"" >> ""$LOG_FILE"" 2>/dev/null || true
}}

write_result() {{
    local success=""$1""
    local message=""$2""
    local details=""${{3:-}}""
    cat > ""$RESULT_FILE"" << RESULT_EOF
{{
    ""success"": $success,
    ""message"": ""$message"",
    ""details"": ""$details"",
    ""timestamp"": ""$(date -u '+%Y-%m-%dT%H:%M:%SZ')"",
    ""logFile"": ""$LOG_FILE""
}}
RESULT_EOF
}}

wait_for_file_writable() {{
    local file_path=""$1""
    local retries=""${{2:-$MAX_RETRIES}}""

    if [[ ! -f ""$file_path"" ]]; then
        log ""File does not exist (OK): $file_path""
        return 0
    fi

    for ((i=1; i<=retries; i++)); do
        if [[ -w ""$file_path"" ]]; then
            # Try to actually open for write
            if ( exec 3>>""$file_path"" ) 2>/dev/null; then
                exec 3>&-
                log ""File is writable: $file_path""
                return 0
            fi
        fi
        log ""File locked (attempt $i/$retries): $file_path"" ""WARN""
        if [[ $i -lt $retries ]]; then
            sleep {RetryDelaySeconds}
        fi
    done

    log ""File still locked after $retries attempts: $file_path"" ""ERROR""
    return 1
}}

kill_process() {{
    local name=""$1""
    local pids

    pids=$(pgrep -f ""/$name\$"" 2>/dev/null || true)
    if [[ -n ""$pids"" ]]; then
        for pid in $pids; do
            log ""Killing $name (PID: $pid)...""
            kill -9 ""$pid"" 2>/dev/null || true
        done
        sleep 1
    fi

    # Double-check
    pids=$(pgrep -f ""/$name\$"" 2>/dev/null || true)
    if [[ -n ""$pids"" ]]; then
        log ""Force killing remaining $name processes..."" ""WARN""
        pkill -9 -f ""/$name\$"" 2>/dev/null || true
        sleep 1
    fi
}}

verify_copy() {{
    local src=""$1""
    local dst=""$2""

    if [[ ! -f ""$dst"" ]]; then
        echo ""Copy verification failed: destination does not exist: $dst""
        return 1
    fi

    local src_size=$(stat -f%z ""$src"" 2>/dev/null || stat -c%s ""$src"" 2>/dev/null)
    local dst_size=$(stat -f%z ""$dst"" 2>/dev/null || stat -c%s ""$dst"" 2>/dev/null)

    if [[ ""$src_size"" != ""$dst_size"" ]]; then
        echo ""Copy verification failed: size mismatch for $dst (expected $src_size bytes, got $dst_size bytes)""
        return 1
    fi

    log ""Verified: $dst ($dst_size bytes)""
    return 0
}}

safe_copy() {{
    local src=""$1""
    local dst=""$2""
    local desc=""$3""

    log ""Copying $desc...""
    log ""  From: $src""
    log ""  To: $dst""

    if [[ ! -f ""$src"" ]]; then
        echo ""Source file does not exist: $src""
        return 1
    fi

    # Atomic update: copy to temp, sign if needed, then mv (atomic rename)
    # This ensures the destination is never in a partial state.
    local tmp_dst=""$dst.new""
    cp ""$src"" ""$tmp_dst""
    chmod +x ""$tmp_dst""

    # macOS requires ad-hoc codesigning for binaries to run
    # Without this, the binary gets killed immediately with SIGKILL
    if $IS_MACOS; then
        log ""Signing $desc for macOS...""
        if ! codesign -s - ""$tmp_dst"" 2>/dev/null; then
            log ""WARNING: codesign failed for $tmp_dst"" ""WARN""
        fi
        if ! codesign --verify ""$tmp_dst"" 2>/dev/null; then
            log ""ERROR: Signature verification failed for $tmp_dst"" ""ERROR""
            rm -f ""$tmp_dst"" 2>/dev/null || true
            return 1
        fi
        log ""Signature verified for $desc""
    fi

    # Atomic rename - either succeeds completely or fails
    mv -f ""$tmp_dst"" ""$dst""

    if ! verify_copy ""$src"" ""$dst""; then
        return 1
    fi

    log ""$desc copied successfully""
    return 0
}}

cleanup() {{
    log """"
    if [[ ""$ROLLBACK_NEEDED"" == ""true"" ]] && [[ ""$STARTED_OK"" != ""true"" ]]; then
        log ""=== ROLLBACK ==="" ""WARN""

        # Stop any partially started process
        kill_process ""mt""

        # Restore backups
        if [[ -f ""$CURRENT_MT.bak"" ]]; then
            log ""Restoring mt from backup...""
            cp -f ""$CURRENT_MT.bak"" ""$CURRENT_MT"" 2>/dev/null || log ""Failed to restore mt"" ""ERROR""
            chmod +x ""$CURRENT_MT"" 2>/dev/null || true
        fi

        if [[ -f ""$CURRENT_MTHOST.bak"" ]]; then
            log ""Restoring mthost from backup...""
            cp -f ""$CURRENT_MTHOST.bak"" ""$CURRENT_MTHOST"" 2>/dev/null || log ""Failed to restore mthost"" ""ERROR""
            chmod +x ""$CURRENT_MTHOST"" 2>/dev/null || true
        fi

        if [[ -f ""$CURRENT_VERSION_JSON.bak"" ]]; then
            log ""Restoring version.json from backup...""
            cp -f ""$CURRENT_VERSION_JSON.bak"" ""$CURRENT_VERSION_JSON"" 2>/dev/null || log ""Failed to restore version.json"" ""ERROR""
        fi

        # Restore credential files from CONFIG_DIR (not INSTALL_DIR!)
        SETTINGS_PATH=""$CONFIG_DIR/settings.json""
        SECRETS_PATH=""$CONFIG_DIR/secrets.json""
        CERT_PATH=""$CONFIG_DIR/midterm.pem""
        KEY_ENC_PATH=""$CONFIG_DIR/midterm.key.enc""

        if [[ -f ""$SETTINGS_PATH.bak"" ]]; then
            log ""Restoring settings.json from backup...""
            cp -f ""$SETTINGS_PATH.bak"" ""$SETTINGS_PATH"" 2>/dev/null || log ""Failed to restore settings.json"" ""ERROR""
        fi
        if [[ -f ""$SECRETS_PATH.bak"" ]]; then
            log ""Restoring secrets.json from backup...""
            cp -f ""$SECRETS_PATH.bak"" ""$SECRETS_PATH"" 2>/dev/null || log ""Failed to restore secrets.json"" ""ERROR""
        fi
        if [[ -f ""$CERT_PATH.bak"" ]]; then
            log ""Restoring midterm.pem from backup...""
            cp -f ""$CERT_PATH.bak"" ""$CERT_PATH"" 2>/dev/null || log ""Failed to restore midterm.pem"" ""ERROR""
        fi
        if [[ -f ""$KEY_ENC_PATH.bak"" ]]; then
            log ""Restoring midterm.key.enc from backup...""
            cp -f ""$KEY_ENC_PATH.bak"" ""$KEY_ENC_PATH"" 2>/dev/null || log ""Failed to restore midterm.key.enc"" ""ERROR""
        fi

        # Try to restart previous version
        log ""Attempting to restart previous version...""
        if $IS_MACOS; then
            {startServiceCmd}
        else
            {startServiceCmd}
        fi

        if ! pgrep -f ""$CURRENT_MT"" > /dev/null 2>&1; then
            nohup ""$CURRENT_MT"" > /dev/null 2>&1 &
        fi

        log ""Rollback complete""
    fi

    # Self-cleanup
    sleep 1
    rm -f ""$0"" 2>/dev/null || true
}}

trap cleanup EXIT

# === Main Script ===

# Ensure log directory exists and has correct ownership
mkdir -p ""$LOG_DIR"" 2>/dev/null || true

# Clear previous logs
rm -f ""$LOG_FILE"" 2>/dev/null || true
rm -f ""$RESULT_FILE"" 2>/dev/null || true

# Create log file with correct ownership for service user
touch ""$LOG_FILE"" 2>/dev/null || true
if [[ -n ""$SERVICE_USER"" ]]; then
    chown ""$SERVICE_USER"" ""$LOG_FILE"" 2>/dev/null || true
fi

log '=========================================='
log 'MidTerm Update Script Starting'
log ""Service user: ${{SERVICE_USER:-unknown}}""
log ""Update type: $(if $IS_WEB_ONLY; then echo 'Web-only'; else echo 'Full'; fi)""
log ""Platform: $(if $IS_MACOS; then echo 'macOS'; else echo 'Linux'; fi)""
log '=========================================='

# ============================================
# PHASE 1: Stop all processes
# ============================================
log """"
log '=== PHASE 1: Stopping processes ==='

# Stop service
log ""Stopping service...""
{stopServiceCmd}
sleep 2

# Kill mt processes
log ""Killing mt processes...""
kill_process ""mt""

# Kill mthost processes (only for full updates)
if [[ ""$IS_WEB_ONLY"" != ""true"" ]]; then
    log ""Killing mthost processes...""
    kill_process ""mthost""
fi

log ""All processes stopped""

# ============================================
# PHASE 2: Wait for file handles to release
# ============================================
log """"
log '=== PHASE 2: Waiting for file handles ==='

if ! wait_for_file_writable ""$CURRENT_MT""; then
    log ""mt is still locked after $MAX_RETRIES retries"" ""ERROR""
    write_result false ""mt is still locked. Another process may be using it.""
    exit 1
fi

if [[ ""$IS_WEB_ONLY"" != ""true"" ]] && [[ -f ""$CURRENT_MTHOST"" ]]; then
    if ! wait_for_file_writable ""$CURRENT_MTHOST""; then
        log ""mthost is still locked after $MAX_RETRIES retries"" ""ERROR""
        write_result false ""mthost is still locked. Another process may be using it.""
        exit 1
    fi
fi

log ""All file handles released""

# ============================================
# PHASE 3: Create backups
# ============================================
log """"
log '=== PHASE 3: Creating backups ==='

if [[ -f ""$CURRENT_MT"" ]]; then
    log ""Backing up mt...""
    cp -f ""$CURRENT_MT"" ""$CURRENT_MT.bak""
    log ""mt backed up""
fi

if [[ ""$IS_WEB_ONLY"" != ""true"" ]] && [[ -f ""$CURRENT_MTHOST"" ]]; then
    log ""Backing up mthost...""
    cp -f ""$CURRENT_MTHOST"" ""$CURRENT_MTHOST.bak""
    log ""mthost backed up""
fi

if [[ -f ""$CURRENT_VERSION_JSON"" ]]; then
    log ""Backing up version.json...""
    cp -f ""$CURRENT_VERSION_JSON"" ""$CURRENT_VERSION_JSON.bak""
    log ""version.json backed up""
fi

# Backup credential files (critical for security persistence)
# IMPORTANT: These are in CONFIG_DIR (/usr/local/etc/midterm), NOT INSTALL_DIR!
# Common mistake: looking for settings in /usr/local/bin/ - that's wrong.
SETTINGS_PATH=""$CONFIG_DIR/settings.json""
SECRETS_PATH=""$CONFIG_DIR/secrets.json""
CERT_PATH=""$CONFIG_DIR/midterm.pem""
KEY_ENC_PATH=""$CONFIG_DIR/midterm.key.enc""

if [[ -f ""$SETTINGS_PATH"" ]]; then
    log ""Backing up settings.json...""
    cp -f ""$SETTINGS_PATH"" ""$SETTINGS_PATH.bak""
    log ""settings.json backed up""
fi
if [[ -f ""$SECRETS_PATH"" ]]; then
    log ""Backing up secrets.json...""
    cp -f ""$SECRETS_PATH"" ""$SECRETS_PATH.bak""
    log ""secrets.json backed up""
fi
if [[ -f ""$CERT_PATH"" ]]; then
    log ""Backing up midterm.pem...""
    cp -f ""$CERT_PATH"" ""$CERT_PATH.bak""
    log ""midterm.pem backed up""
fi
if [[ -f ""$KEY_ENC_PATH"" ]]; then
    log ""Backing up midterm.key.enc...""
    cp -f ""$KEY_ENC_PATH"" ""$KEY_ENC_PATH.bak""
    log ""midterm.key.enc backed up""
fi

ROLLBACK_NEEDED=true
log ""All backups created (including credentials)""

# === CERTIFICATE DIAGNOSTICS ===
log """"
log '=== Certificate Diagnostics ==='

# Check cert file
if [[ -f ""$CERT_PATH"" ]]; then
    cert_size=$(stat -f%z ""$CERT_PATH"" 2>/dev/null || stat -c%s ""$CERT_PATH"" 2>/dev/null)
    cert_mtime=$(stat -f%m ""$CERT_PATH"" 2>/dev/null || stat -c%Y ""$CERT_PATH"" 2>/dev/null)
    log ""  midterm.pem: Size=$cert_size bytes""

    # Get cert info using openssl
    if command -v openssl &> /dev/null; then
        thumbprint=$(openssl x509 -in ""$CERT_PATH"" -noout -fingerprint -sha1 2>/dev/null | cut -d= -f2 | tr -d ':')
        subject=$(openssl x509 -in ""$CERT_PATH"" -noout -subject 2>/dev/null)
        not_after=$(openssl x509 -in ""$CERT_PATH"" -noout -enddate 2>/dev/null | cut -d= -f2)
        not_before=$(openssl x509 -in ""$CERT_PATH"" -noout -startdate 2>/dev/null | cut -d= -f2)
        log ""  Thumbprint: $thumbprint""
        log ""  Subject: $subject""
        log ""  NotAfter: $not_after""
        log ""  NotBefore: $not_before""
    else
        log ""  WARNING: openssl not available for cert parsing"" ""WARN""
    fi
else
    log '  WARNING: midterm.pem does NOT exist!' ""WARN""
fi

# Check key file
if [[ -f ""$KEY_ENC_PATH"" ]]; then
    key_size=$(stat -f%z ""$KEY_ENC_PATH"" 2>/dev/null || stat -c%s ""$KEY_ENC_PATH"" 2>/dev/null)
    log ""  midterm.key.enc: Size=$key_size bytes""
else
    log '  WARNING: midterm.key.enc does NOT exist!' ""WARN""
fi

# Check settings.json for cert config
if [[ -f ""$SETTINGS_PATH"" ]]; then
    if command -v jq &> /dev/null; then
        cert_path_setting=$(jq -r '.certificatePath // empty' ""$SETTINGS_PATH"" 2>/dev/null)
        key_protection=$(jq -r '.keyProtection // empty' ""$SETTINGS_PATH"" 2>/dev/null)
        is_service=$(jq -r '.isServiceInstall // empty' ""$SETTINGS_PATH"" 2>/dev/null)
        cert_thumbprint=$(jq -r '.certificateThumbprint // empty' ""$SETTINGS_PATH"" 2>/dev/null)
        log ""  settings.certificatePath: $cert_path_setting""
        log ""  settings.keyProtection: $key_protection""
        log ""  settings.isServiceInstall: $is_service""
        log ""  settings.certificateThumbprint: $cert_thumbprint""
    else
        log ""  (jq not available for settings parsing)""
    fi
fi

# ============================================
# PHASE 4: Install new files
# ============================================
log """"
log '=== PHASE 4: Installing new files ==='

if ! safe_copy ""$NEW_MT"" ""$CURRENT_MT"" ""mt""; then
    write_result false ""Failed to install mt""
    exit 1
fi

if [[ ""$IS_WEB_ONLY"" != ""true"" ]] && [[ -f ""$NEW_MTHOST"" ]]; then
    if ! safe_copy ""$NEW_MTHOST"" ""$CURRENT_MTHOST"" ""mthost""; then
        write_result false ""Failed to install mthost""
        exit 1
    fi
fi

if [[ -f ""$NEW_VERSION_JSON"" ]]; then
    log ""Copying version.json...""
    cp -f ""$NEW_VERSION_JSON"" ""$CURRENT_VERSION_JSON""
    log ""version.json copied""
fi

log ""All files installed""

# ============================================
# PHASE 5: Start the new version
# ============================================
log """"
log '=== PHASE 5: Starting new version ==='

# Ensure main service log file has correct ownership BEFORE starting service
# Without this, the service (running as user) can't write to root-owned log
MAIN_LOG=""$LOG_DIR/MidTerm.log""
touch ""$MAIN_LOG"" 2>/dev/null || true
if [[ -n ""$SERVICE_USER"" ]]; then
    chown ""$SERVICE_USER"" ""$MAIN_LOG"" 2>/dev/null || true
    log ""Set $MAIN_LOG ownership to $SERVICE_USER""
fi

# Try to start service
log ""Starting service...""
{startServiceCmd}
sleep 8

# Check if service is running
if {checkServiceCmd}; then
    log ""Service started successfully""
    STARTED_OK=true
else
    # Service not running, start directly
    log ""Service not running, starting mt directly...""
    nohup ""$CURRENT_MT"" > /dev/null 2>&1 &
    sleep 8

    if pgrep -f ""$CURRENT_MT"" > /dev/null 2>&1; then
        log ""mt started successfully (PID: $(pgrep -f ""$CURRENT_MT"" | head -1))""
        STARTED_OK=true
    else
        log ""mt failed to start"" ""ERROR""
        write_result false ""mt failed to start after installation""
        exit 1
    fi
fi

# === POST-UPDATE CERTIFICATE VERIFICATION ===
log """"
log '=== Post-Update Certificate Verification ==='

# Check if cert file still exists and is valid
if [[ -f ""$CERT_PATH"" ]]; then
    if command -v openssl &> /dev/null; then
        thumbprint=$(openssl x509 -in ""$CERT_PATH"" -noout -fingerprint -sha1 2>/dev/null | cut -d= -f2 | tr -d ':')
        not_after=$(openssl x509 -in ""$CERT_PATH"" -noout -enddate 2>/dev/null | cut -d= -f2)
        log ""  Certificate OK: ${{thumbprint:0:8}}... expires $not_after""
    else
        log ""  Certificate exists (openssl not available for verification)""
    fi
else
    log '  WARNING: Certificate file missing after update!' ""WARN""
fi

# Check if key file still exists
if [[ -f ""$KEY_ENC_PATH"" ]]; then
    key_size=$(stat -f%z ""$KEY_ENC_PATH"" 2>/dev/null || stat -c%s ""$KEY_ENC_PATH"" 2>/dev/null)
    log ""  Key file OK: $key_size bytes""
else
    log '  WARNING: Key file missing after update!' ""WARN""
fi

# ============================================
# PHASE 6: Cleanup
# ============================================
log """"
log '=== PHASE 6: Cleanup ==='

rm -f ""$CURRENT_MT.bak"" 2>/dev/null || true
rm -f ""$CURRENT_MTHOST.bak"" 2>/dev/null || true
rm -f ""$CURRENT_VERSION_JSON.bak"" 2>/dev/null || true

# Clean up credential backups (in CONFIG_DIR, not INSTALL_DIR!)
rm -f ""$CONFIG_DIR/settings.json.bak"" 2>/dev/null || true
rm -f ""$CONFIG_DIR/secrets.json.bak"" 2>/dev/null || true
rm -f ""$CONFIG_DIR/midterm.pem.bak"" 2>/dev/null || true
rm -f ""$CONFIG_DIR/midterm.key.enc.bak"" 2>/dev/null || true

if [[ ""$DELETE_SOURCE"" == ""true"" ]]; then
    rm -rf ""$EXTRACTED_DIR"" 2>/dev/null || true
fi

log ""Cleanup complete""

# ============================================
# SUCCESS
# ============================================
log """"
log '=========================================='
log 'UPDATE COMPLETED SUCCESSFULLY'
log '=========================================='

write_result true ""Update completed successfully""
";

        File.WriteAllText(scriptPath, script);

        // Set executable permission (Unix only)
        if (!OperatingSystem.IsWindows())
        {
            try
            {
                File.SetUnixFileMode(scriptPath,
                    UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute |
                    UnixFileMode.GroupRead | UnixFileMode.GroupExecute |
                    UnixFileMode.OtherRead | UnixFileMode.OtherExecute);
            }
            catch
            {
            }
        }

        return scriptPath;
    }

    public static void ExecuteUpdateScript(string scriptPath)
    {
        if (OperatingSystem.IsWindows())
        {
            // Find pwsh.exe - check common locations
            var pwshPath = FindPowerShellPath();

            var psi = new System.Diagnostics.ProcessStartInfo
            {
                FileName = pwshPath,
                Arguments = $"-ExecutionPolicy Bypass -NoProfile -File \"{scriptPath}\"",
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = false,
                RedirectStandardError = false
            };

            System.Diagnostics.Process.Start(psi);
        }
        else
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
            {
                FileName = "/bin/bash",
                Arguments = $"\"{scriptPath}\"",
                UseShellExecute = false,
                CreateNoWindow = true
            });
        }
    }

    private static string FindPowerShellPath()
    {
        // Try pwsh first (PowerShell Core/7+)
        var pwshPaths = new[]
        {
            @"C:\Program Files\PowerShell\7\pwsh.exe",
            @"C:\Program Files\PowerShell\pwsh.exe",
            Environment.ExpandEnvironmentVariables(@"%ProgramFiles%\PowerShell\7\pwsh.exe")
        };

        foreach (var path in pwshPaths)
        {
            if (File.Exists(path))
            {
                return path;
            }
        }

        // Fall back to pwsh in PATH
        return "pwsh";
    }

    private static string EscapeForPowerShell(string value)
    {
        // Escape single quotes for PowerShell single-quoted strings
        return value.Replace("'", "''");
    }

    private static string EscapeForBash(string value)
    {
        // Escape single quotes for bash single-quoted strings
        return value.Replace("'", "'\\''");
    }
}
