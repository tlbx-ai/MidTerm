#!/usr/bin/env pwsh
# Fast development loop for MidTerm (Windows)
#
# Stops the production MidTerm service, runs esbuild watch + dotnet watch,
# and restarts the service when done.
#
# Usage:
#   ./scripts/dev.ps1              # Full flow: stop service, build, watch, restart
#   ./scripts/dev.ps1 -NoBuild     # Skip initial frontend build (wwwroot must exist)
#   ./scripts/dev.ps1 -Port 3000   # Use a custom dev port

param(
    [switch]$NoBuild,
    [int]$Port = 2001
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$ProjectDir = Join-Path $RepoRoot "src/Ai.Tlbx.MidTerm"
$ProjectFile = Join-Path $ProjectDir "Ai.Tlbx.MidTerm.csproj"
$ServiceName = "MidTerm"
$ProductionPort = 2000
$ServiceWasStopped = $false

Write-Host ""
Write-Host "  MidTerm Dev Mode" -ForegroundColor Cyan
Write-Host "  ───────────────────────────────────────────" -ForegroundColor DarkGray
Write-Host "  TS changes  : esbuild rebuilds (~5ms), refresh browser" -ForegroundColor DarkGray
Write-Host "  CSS changes : copy file to wwwroot/css/, refresh browser" -ForegroundColor DarkGray
Write-Host "  C# changes  : dotnet watch auto-restarts server" -ForegroundColor DarkGray
Write-Host "  URL         : https://localhost:$Port" -ForegroundColor DarkGray
Write-Host ""

# --- Step 0: Stop production MidTerm service ---
Write-Host "[0/3] Stopping production MidTerm..." -ForegroundColor Cyan

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($service -and $service.Status -eq 'Running') {
    # Use the shutdown API endpoint (no admin required, loopback-only)
    try {
        # -SkipCertificateCheck because production uses self-signed cert
        $null = Invoke-WebRequest -Uri "https://localhost:$ProductionPort/api/shutdown" `
            -Method POST -SkipCertificateCheck -TimeoutSec 5 -ErrorAction Stop
        Write-Host "  Shutdown signal sent, waiting for service to stop..." -ForegroundColor DarkGray

        # Wait for the service to actually stop
        $timeout = 15
        for ($i = 0; $i -lt $timeout; $i++) {
            Start-Sleep -Seconds 1
            $service.Refresh()
            if ($service.Status -eq 'Stopped') { break }
        }

        if ($service.Status -eq 'Stopped') {
            $ServiceWasStopped = $true
            Write-Host "  Service stopped" -ForegroundColor DarkGray
        } else {
            Write-Host "  Service did not stop in time. Try running as admin." -ForegroundColor Yellow
            exit 1
        }
    } catch {
        Write-Host "  Could not reach service on port $ProductionPort ($($_.Exception.Message))" -ForegroundColor Yellow
        Write-Host "  Trying Stop-Service (requires admin)..." -ForegroundColor Yellow
        try {
            Stop-Service -Name $ServiceName -Force -ErrorAction Stop
            $ServiceWasStopped = $true
            Write-Host "  Service stopped via Stop-Service" -ForegroundColor DarkGray
        } catch {
            Write-Host "  Failed to stop service: $($_.Exception.Message)" -ForegroundColor Red
            exit 1
        }
    }
} else {
    # Maybe running in user mode — try shutdown API anyway
    try {
        $null = Invoke-WebRequest -Uri "https://localhost:$ProductionPort/api/shutdown" `
            -Method POST -SkipCertificateCheck -TimeoutSec 3 -ErrorAction Stop
        Write-Host "  User-mode instance shut down" -ForegroundColor DarkGray
        Start-Sleep -Seconds 2
    } catch {
        Write-Host "  No running instance found on port $ProductionPort" -ForegroundColor DarkGray
    }
}
Write-Host ""

# --- Step 1: Initial frontend build ---
if (-not $NoBuild) {
    Write-Host "[1/3] Building frontend..." -ForegroundColor Cyan
    & pwsh -NoProfile -ExecutionPolicy Bypass -File "$ProjectDir/frontend-build.ps1"
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Frontend build failed"
        exit $LASTEXITCODE
    }
    Write-Host ""
} else {
    $jsFile = Join-Path $ProjectDir "wwwroot/js/terminal.min.js"
    if (-not (Test-Path $jsFile)) {
        Write-Error "wwwroot/js/terminal.min.js not found. Run without -NoBuild first."
        exit 1
    }
    Write-Host "[1/3] Skipping frontend build (-NoBuild)" -ForegroundColor DarkGray
}

# --- Step 2: Start esbuild watch ---
Write-Host "[2/3] Starting esbuild watch..." -ForegroundColor Cyan

$mainTs = Join-Path $ProjectDir "src/ts/main.ts"
$outFile = Join-Path $ProjectDir "wwwroot/js/terminal.min.js"

$esbuildBin = Join-Path $RepoRoot "node_modules/.bin/esbuild.cmd"
$esbuildArgs = "$mainTs --bundle --sourcemap=linked --outfile=$outFile --target=es2020 --watch"
$esbuildProcess = Start-Process -FilePath $esbuildBin -ArgumentList $esbuildArgs `
    -WorkingDirectory $RepoRoot -PassThru -NoNewWindow

Start-Sleep -Milliseconds 500

if ($esbuildProcess.HasExited) {
    Write-Error "esbuild watch failed to start"
    exit 1
}
Write-Host "  esbuild watch running (PID: $($esbuildProcess.Id))" -ForegroundColor DarkGray
Write-Host ""

# --- Step 3: Start dotnet watch ---
try {
    Write-Host "[3/3] Starting dotnet watch on port $Port..." -ForegroundColor Green
    Write-Host ""
    & dotnet watch run --project $ProjectFile `
        --property:SkipFrontendBuild=true `
        --property:DevWatch=true `
        -- --port $Port
} finally {
    # Cleanup: stop esbuild
    if (-not $esbuildProcess.HasExited) {
        Write-Host "`nStopping esbuild watch..." -ForegroundColor Yellow
        Stop-Process -Id $esbuildProcess.Id -Force -ErrorAction SilentlyContinue
    }

    # Restart production service
    if ($ServiceWasStopped) {
        Write-Host "Restarting MidTerm service..." -ForegroundColor Cyan
        try {
            Start-Service -Name $ServiceName -ErrorAction Stop
            Write-Host "  Service restarted" -ForegroundColor Green
        } catch {
            Write-Host "  Could not restart service (requires admin): $($_.Exception.Message)" -ForegroundColor Yellow
            Write-Host "  Run manually: Start-Service MidTerm" -ForegroundColor Yellow
        }
    }
}
