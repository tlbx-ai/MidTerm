# Quick local deploy - run as admin
$ErrorActionPreference = "Stop"
$repoRoot = "Q:\repos\MiddleManager"

# Bump patch version
Write-Host "Bumping version..." -ForegroundColor Yellow
$hostCsproj = "$repoRoot\Ai.Tlbx.MiddleManager.Host\Ai.Tlbx.MiddleManager.Host.csproj"
$webCsproj = "$repoRoot\Ai.Tlbx.MiddleManager\Ai.Tlbx.MiddleManager.csproj"
$hostProgram = "$repoRoot\Ai.Tlbx.MiddleManager.Host\Program.cs"

# Read current version from web csproj
$webContent = Get-Content $webCsproj -Raw
if ($webContent -match '<Version>(\d+)\.(\d+)\.(\d+)</Version>') {
    $major = [int]$Matches[1]
    $minor = [int]$Matches[2]
    $patch = [int]$Matches[3] + 1
    $newVersion = "$major.$minor.$patch"
    Write-Host "  Version: $major.$minor.$($patch-1) -> $newVersion" -ForegroundColor Cyan

    # Update web csproj
    $webContent = $webContent -replace '<Version>\d+\.\d+\.\d+</Version>', "<Version>$newVersion</Version>"
    Set-Content $webCsproj $webContent -NoNewline

    # Update host csproj
    $hostCsprojContent = Get-Content $hostCsproj -Raw
    $hostCsprojContent = $hostCsprojContent -replace '<Version>\d+\.\d+\.\d+</Version>', "<Version>$newVersion</Version>"
    Set-Content $hostCsproj $hostCsprojContent -NoNewline

    # Update host Program.cs version constant
    $hostProgramContent = Get-Content $hostProgram -Raw
    $hostProgramContent = $hostProgramContent -replace 'Version = "\d+\.\d+\.\d+"', "Version = `"$newVersion`""
    Set-Content $hostProgram $hostProgramContent -NoNewline
} else {
    Write-Host "  Could not parse version from csproj" -ForegroundColor Red
    exit 1
}

# Build all projects (single-file self-contained)
Write-Host "Building..." -ForegroundColor Yellow
$conHostCsproj = "$repoRoot\Ai.Tlbx.MiddleManager.ConHost\Ai.Tlbx.MiddleManager.ConHost.csproj"

dotnet publish "$hostCsproj" -c Release -r win-x64 --self-contained -p:PublishAot=false -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o "$repoRoot\Ai.Tlbx.MiddleManager.Host\bin\Release\net10.0\win-x64\publish" -v q
if ($LASTEXITCODE -ne 0) { Write-Host "  mm-host build failed" -ForegroundColor Red; exit 1 }
Write-Host "  Built mm-host.exe ($newVersion)" -ForegroundColor Gray

dotnet publish "$webCsproj" -c Release -r win-x64 --self-contained -p:PublishAot=false -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o "$repoRoot\Ai.Tlbx.MiddleManager\bin\Release\net10.0\win-x64\publish" -v q
if ($LASTEXITCODE -ne 0) { Write-Host "  mm build failed" -ForegroundColor Red; exit 1 }
Write-Host "  Built mm.exe ($newVersion)" -ForegroundColor Gray

dotnet publish "$conHostCsproj" -c Release -r win-x64 --self-contained -p:PublishAot=false -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o "$repoRoot\Ai.Tlbx.MiddleManager.ConHost\bin\Release\net10.0\win-x64\publish" -v q
if ($LASTEXITCODE -ne 0) { Write-Host "  mm-con-host build failed" -ForegroundColor Red; exit 1 }
Write-Host "  Built mm-con-host.exe ($newVersion)" -ForegroundColor Gray

Write-Host "Stopping service..." -ForegroundColor Yellow
Stop-Service -Name MiddleManager -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# Kill any remaining processes
Get-Process -Name 'mm-host','mm' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

Write-Host "Copying new binaries..." -ForegroundColor Yellow
$srcHost = "$repoRoot\Ai.Tlbx.MiddleManager.Host\bin\Release\net10.0\win-x64\publish\mm-host.exe"
$srcWeb = "$repoRoot\Ai.Tlbx.MiddleManager\bin\Release\net10.0\win-x64\publish\mm.exe"
$srcConHost = "$repoRoot\Ai.Tlbx.MiddleManager.ConHost\bin\Release\net10.0\win-x64\publish\mm-con-host.exe"
$dstHost = "C:\Program Files\MiddleManager\mm-host.exe"
$dstWeb = "C:\Program Files\MiddleManager\mm.exe"
$dstConHost = "C:\Program Files\MiddleManager\mm-con-host.exe"

Copy-Item $srcHost $dstHost -Force
Write-Host "  Copied mm-host.exe" -ForegroundColor Gray
Copy-Item $srcWeb $dstWeb -Force
Write-Host "  Copied mm.exe" -ForegroundColor Gray
Copy-Item $srcConHost $dstConHost -Force
Write-Host "  Copied mm-con-host.exe" -ForegroundColor Gray

# Clear old logs
$logDir = "C:\ProgramData\MiddleManager\logs"
Remove-Item "$logDir\mm-host.log" -Force -ErrorAction SilentlyContinue
Remove-Item "$logDir\mm-client.log" -Force -ErrorAction SilentlyContinue

Write-Host "Starting service..." -ForegroundColor Yellow
Start-Service -Name MiddleManager
Start-Sleep -Seconds 3

# Check status
Write-Host ""
Write-Host "Process Status:" -ForegroundColor Cyan
$mmHostProc = Get-Process -Name "mm-host" -ErrorAction SilentlyContinue
$mmProc = Get-Process -Name "mm" -ErrorAction SilentlyContinue

if ($mmHostProc) { Write-Host "  mm-host    : Running (PID $($mmHostProc.Id))" -ForegroundColor Green }
else { Write-Host "  mm-host    : Not running" -ForegroundColor Red }

if ($mmProc) { Write-Host "  mm (web)   : Running (PID $($mmProc.Id))" -ForegroundColor Green }
else { Write-Host "  mm (web)   : Not running" -ForegroundColor Yellow }

# Check logs
Start-Sleep -Seconds 2
Write-Host ""
Write-Host "mm-host log:" -ForegroundColor Cyan
if (Test-Path "$logDir\mm-host.log") {
    Get-Content "$logDir\mm-host.log"
} else {
    Write-Host "  (no log file yet)" -ForegroundColor Gray
}

Write-Host ""
Write-Host "mm-client log:" -ForegroundColor Cyan
if (Test-Path "$logDir\mm-client.log") {
    Get-Content "$logDir\mm-client.log"
} else {
    Write-Host "  (no log file yet)" -ForegroundColor Gray
}

# Check health
Write-Host ""
Write-Host "Health check:" -ForegroundColor Cyan
try {
    $health = Invoke-RestMethod -Uri "http://localhost:2000/api/health" -TimeoutSec 5
    if ($health.healthy) { Write-Host "  Status: Healthy" -ForegroundColor Green }
    else {
        Write-Host "  Status: Unhealthy" -ForegroundColor Red
        if ($health.hostError) { Write-Host "  Error: $($health.hostError)" -ForegroundColor Red }
    }
    Write-Host "  Version: $($health.version)" -ForegroundColor Gray
    Write-Host "  Heartbeat: $($health.lastHeartbeatMs)ms ago" -ForegroundColor Gray
} catch {
    Write-Host "  Could not connect" -ForegroundColor Red
}
