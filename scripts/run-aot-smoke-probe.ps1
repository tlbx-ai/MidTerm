#!/usr/bin/env pwsh
# Publishes the Native AOT mt binary and boots it once against a throwaway settings
# directory. Catches AOT-only startup crashes (trimming, reflection init, missing
# native libraries) that dotnet build and JIT test runs cannot see.

param(
    [string]$Configuration = "Release",
    [string]$Rid = "win-x64",
    [switch]$SkipPublish
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$projectPath = Join-Path $RepoRoot "src/Ai.Tlbx.MidTerm/Ai.Tlbx.MidTerm.csproj"
$wwwrootProbe = Join-Path $RepoRoot "src/Ai.Tlbx.MidTerm/wwwroot/js/terminal.min.js.br"
$exeName = if ($Rid.StartsWith("win")) { "mt.exe" } else { "mt" }
$publishDir = Join-Path $RepoRoot "src/Ai.Tlbx.MidTerm/bin/$Configuration/net10.0/$Rid/publish"
$exePath = Join-Path $publishDir $exeName

if (-not $SkipPublish) {
    # The release preflight builds the frontend in a temp snapshot, so the repo wwwroot
    # is usually in debug layout here — build the publish-mode frontend ourselves.
    if (-not (Test-Path $wwwrootProbe)) {
        $version = (Get-Content (Join-Path $RepoRoot 'src/version.json') -Raw | ConvertFrom-Json).web
        Write-Host "Building publish-mode frontend ($version) for smoke probe..." -ForegroundColor Cyan
        Push-Location (Join-Path $RepoRoot 'src/Ai.Tlbx.MidTerm')
        try {
            & pwsh -NoProfile -ExecutionPolicy Bypass -File frontend-build.ps1 -Version $version -Publish
            if ($LASTEXITCODE -ne 0) {
                throw "frontend publish build failed for smoke probe"
            }
        }
        finally {
            Pop-Location
        }
    }
    if (-not (Test-Path $wwwrootProbe)) {
        throw "AOT smoke probe still misses the publish frontend artifact: $wwwrootProbe"
    }
    Write-Host "Publishing Native AOT $Rid binary for smoke probe..." -ForegroundColor Cyan
    & dotnet publish $projectPath -c $Configuration -r $Rid -p:IsPublishing=true -p:SkipFrontendBuild=true -p:ContinuousIntegrationBuild=true --verbosity minimal
    if ($LASTEXITCODE -ne 0) {
        throw "AOT publish failed for $Rid"
    }
}

if (-not (Test-Path $exePath)) {
    throw "Published binary not found: $exePath"
}

$settingsDir = Join-Path ([System.IO.Path]::GetTempPath()) ("mt-aot-probe-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $settingsDir | Out-Null
$stdoutLog = Join-Path $settingsDir "probe-stdout.log"
$stderrLog = Join-Path $settingsDir "probe-stderr.log"
$port = Get-Random -Minimum 21000 -Maximum 29000

Write-Host "Booting $exeName on port $port (settings: $settingsDir)..." -ForegroundColor Cyan
$env:MIDTERM_SETTINGS_DIR = $settingsDir
$proc = $null
try {
    $proc = Start-Process -FilePath $exePath -ArgumentList "--port $port --bind 127.0.0.1" `
        -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru -WindowStyle Hidden

    $version = $null
    $deadline = (Get-Date).AddSeconds(45)
    while ((Get-Date) -lt $deadline) {
        if ($proc.HasExited) {
            break
        }
        try {
            $version = Invoke-RestMethod "https://127.0.0.1:$port/api/version" -SkipCertificateCheck -TimeoutSec 3
            break
        } catch {
            Start-Sleep -Milliseconds 750
        }
    }

    if ($proc.HasExited) {
        Get-Content $stdoutLog -ErrorAction SilentlyContinue | Select-Object -Last 20 | Write-Host
        Get-Content $stderrLog -ErrorAction SilentlyContinue | Select-Object -Last 20 | Write-Host
        throw "AOT smoke probe FAILED: $exeName exited with code $($proc.ExitCode) during startup. See $stdoutLog"
    }
    if (-not $version) {
        throw "AOT smoke probe FAILED: $exeName did not answer /api/version within 45s. See $stdoutLog"
    }
    Write-Host "  /api/version -> $version" -ForegroundColor Green

    $graphsStatus = 0
    try {
        $response = Invoke-WebRequest "https://127.0.0.1:$port/api/graphs" -SkipCertificateCheck -TimeoutSec 5
        $graphsStatus = [int]$response.StatusCode
    } catch {
        $graphsStatus = [int]$_.Exception.Response.StatusCode
    }
    if ($graphsStatus -ne 200 -and $graphsStatus -ne 401) {
        throw "AOT smoke probe FAILED: /api/graphs returned $graphsStatus"
    }
    Write-Host "  /api/graphs -> $graphsStatus" -ForegroundColor Green

    $dbPath = Join-Path $settingsDir "action-graphs.db"
    if (-not (Test-Path $dbPath)) {
        throw "AOT smoke probe FAILED: SQLite database was not created at $dbPath"
    }
    Write-Host "  action-graphs.db created ($((Get-Item $dbPath).Length) bytes)" -ForegroundColor Green
    Write-Host "AOT smoke probe PASSED." -ForegroundColor Green
}
finally {
    Remove-Item Env:\MIDTERM_SETTINGS_DIR -ErrorAction SilentlyContinue
    if ($proc -and -not $proc.HasExited) {
        try { $proc.Kill($true) } catch {}
        $proc.WaitForExit(5000) | Out-Null
    }
    Start-Sleep -Milliseconds 500
    try { Remove-Item -LiteralPath $settingsDir -Recurse -Force -ErrorAction SilentlyContinue } catch {}
}
