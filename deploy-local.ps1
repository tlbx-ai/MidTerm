# Quick local deploy - run as admin
$ErrorActionPreference = "Stop"
$repoRoot = "Q:\repos\MidTerm"

# Bump patch version
Write-Host "Bumping version..." -ForegroundColor Yellow
$webCsproj = "$repoRoot\Ai.Tlbx.MidTerm\Ai.Tlbx.MidTerm.csproj"
$conHostCsproj = "$repoRoot\Ai.Tlbx.MidTerm.TtyHost\Ai.Tlbx.MidTerm.TtyHost.csproj"

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

    # Update con-host csproj
    $conHostContent = Get-Content $conHostCsproj -Raw
    $conHostContent = $conHostContent -replace '<Version>\d+\.\d+\.\d+</Version>', "<Version>$newVersion</Version>"
    Set-Content $conHostCsproj $conHostContent -NoNewline
} else {
    Write-Host "  Could not parse version from csproj" -ForegroundColor Red
    exit 1
}

# Build all projects (single-file self-contained)
Write-Host "Building..." -ForegroundColor Yellow

dotnet publish "$webCsproj" -c Release -r win-x64 --self-contained -p:PublishAot=false -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o "$repoRoot\Ai.Tlbx.MidTerm\bin\Release\net10.0\win-x64\publish" -v q
if ($LASTEXITCODE -ne 0) { Write-Host "  mt build failed" -ForegroundColor Red; exit 1 }
Write-Host "  Built mt.exe ($newVersion)" -ForegroundColor Gray

dotnet publish "$conHostCsproj" -c Release -r win-x64 --self-contained -p:PublishAot=false -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o "$repoRoot\Ai.Tlbx.MidTerm.TtyHost\bin\Release\net10.0\win-x64\publish" -v q
if ($LASTEXITCODE -ne 0) { Write-Host "  mthost build failed" -ForegroundColor Red; exit 1 }
Write-Host "  Built mthost.exe ($newVersion)" -ForegroundColor Gray

Write-Host "Stopping service..." -ForegroundColor Yellow
Stop-Service -Name MidTerm -Force -NoWait -ErrorAction SilentlyContinue
Get-Process -Name 'mt','mthost' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

Write-Host "Copying new binaries..." -ForegroundColor Yellow
$srcWeb = "$repoRoot\Ai.Tlbx.MidTerm\bin\Release\net10.0\win-x64\publish\mt.exe"
$srcConHost = "$repoRoot\Ai.Tlbx.MidTerm.TtyHost\bin\Release\net10.0\win-x64\publish\mthost.exe"
$dstWeb = "C:\Program Files\MidTerm\mt.exe"
$dstConHost = "C:\Program Files\MidTerm\mthost.exe"

Copy-Item $srcWeb $dstWeb -Force
Write-Host "  Copied mt.exe" -ForegroundColor Gray
Copy-Item $srcConHost $dstConHost -Force
Write-Host "  Copied mthost.exe" -ForegroundColor Gray

Write-Host "Starting service..." -ForegroundColor Yellow
Start-Service -Name MidTerm
Start-Sleep -Seconds 3

# Check status
Write-Host ""
Write-Host "Process Status:" -ForegroundColor Cyan
$mtProc = Get-Process -Name "mt" -ErrorAction SilentlyContinue

if ($mtProc) { Write-Host "  mt         : Running (PID $($mtProc.Id))" -ForegroundColor Green }
else { Write-Host "  mt         : Not running" -ForegroundColor Red }

# Check health
Write-Host ""
Write-Host "Health check:" -ForegroundColor Cyan
try {
    $health = Invoke-RestMethod -Uri "http://localhost:2000/api/health" -TimeoutSec 5
    if ($health.healthy) { Write-Host "  Status: Healthy" -ForegroundColor Green }
    else { Write-Host "  Status: Unhealthy" -ForegroundColor Red }
    Write-Host "  Version: $($health.version)" -ForegroundColor Gray
    Write-Host "  Mode: $($health.mode)" -ForegroundColor Gray
} catch {
    Write-Host "  Could not connect" -ForegroundColor Red
}
