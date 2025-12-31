# Run MiddleManager in direct mode (no sidecar) for TUI app compatibility
# This bypasses the service and runs mm.exe in user context

$repoRoot = $PSScriptRoot

Write-Host "Building mm.exe..." -ForegroundColor Yellow
dotnet build "$repoRoot\Ai.Tlbx.MiddleManager\Ai.Tlbx.MiddleManager.csproj" -c Release
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Build failed" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Stopping MiddleManager service and killing processes..." -ForegroundColor Yellow
Write-Host "(May require running as Administrator)" -ForegroundColor Gray

# Try to stop service (requires admin)
Start-Process -FilePath "sc.exe" -ArgumentList "stop", "MiddleManager" -Verb RunAs -Wait -WindowStyle Hidden -ErrorAction SilentlyContinue

# Force kill any mm/mm-host processes (requires admin for service processes)
Start-Process -FilePath "taskkill" -ArgumentList "/F", "/IM", "mm.exe" -Verb RunAs -Wait -WindowStyle Hidden -ErrorAction SilentlyContinue
Start-Process -FilePath "taskkill" -ArgumentList "/F", "/IM", "mm-host.exe" -Verb RunAs -Wait -WindowStyle Hidden -ErrorAction SilentlyContinue

Start-Sleep -Milliseconds 1000

$mmPath = "$repoRoot\Ai.Tlbx.MiddleManager\bin\Release\net10.0\mm.exe"

if (-not (Test-Path $mmPath)) {
    Write-Host "ERROR: Could not find mm.exe at $mmPath" -ForegroundColor Red
    exit 1
}

Write-Host "Starting mm.exe in direct mode..." -ForegroundColor Green
Write-Host "Path: $mmPath" -ForegroundColor Gray
Write-Host ""

& $mmPath --no-sidecar
