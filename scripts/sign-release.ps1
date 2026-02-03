#!/usr/bin/env pwsh
# Sign MidTerm release artifacts using openssl
# Updates version.json files with checksums and ECDSA P-256 signatures

param(
    [Parameter(Mandatory=$true)]
    [string]$ArtifactsPath
)

$ErrorActionPreference = "Stop"

# Check for signing key (base64-encoded PKCS#8 PEM)
$privateKeyB64 = $env:SIGNING_PRIVATE_KEY
if (-not $privateKeyB64) {
    Write-Host "Warning: SIGNING_PRIVATE_KEY not set, releases will be unsigned" -ForegroundColor Yellow
    exit 0
}

Write-Host "Signing release artifacts..."

# Write private key to temp file
$keyFile = [System.IO.Path]::GetTempFileName()
try {
    [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($privateKeyB64)) | Set-Content $keyFile -NoNewline

    # Process each platform
    $platforms = @("win-x64", "osx-arm64", "osx-x64", "linux-x64")

    foreach ($platform in $platforms) {
        $platformDir = Join-Path $ArtifactsPath $platform
        if (-not (Test-Path $platformDir)) {
            Write-Host "  Skipping $platform (not found)"
            continue
        }

        Write-Host "  Processing $platform..."

        $versionJsonPath = Join-Path $platformDir "version.json"
        if (-not (Test-Path $versionJsonPath)) {
            Write-Host "    Warning: version.json not found" -ForegroundColor Yellow
            continue
        }

        # Read version.json to check for web-only release
        $versionJson = Get-Content $versionJsonPath -Raw | ConvertFrom-Json
        $isWebOnly = $versionJson.webOnly -eq $true

        # Compute checksums for binaries (skip mthost for web-only releases)
        $checksums = @{}
        $binaries = if ($isWebOnly) { @("mt") } else { @("mt", "mthost") }
        $ext = if ($platform -eq "win-x64") { ".exe" } else { "" }

        if ($isWebOnly) {
            Write-Host "    Web-only release: skipping mthost checksum" -ForegroundColor Cyan
        }

        foreach ($binary in $binaries) {
            $binaryPath = Join-Path $platformDir "$binary$ext"
            if (Test-Path $binaryPath) {
                $hash = (Get-FileHash -Path $binaryPath -Algorithm SHA256).Hash.ToLower()
                $checksums["$binary$ext"] = $hash
                Write-Host "    $binary$ext = $hash"
            }
        }

        if ($checksums.Count -eq 0) {
            Write-Host "    Warning: No binaries found" -ForegroundColor Yellow
            continue
        }

        # Create sorted JSON of checksums (deterministic for signing)
        $sortedChecksums = [ordered]@{}
        foreach ($key in $checksums.Keys | Sort-Object) {
            $sortedChecksums[$key] = $checksums[$key]
        }
        $checksumJson = $sortedChecksums | ConvertTo-Json -Compress

        # Sign with openssl
        $msgFile = [System.IO.Path]::GetTempFileName()
        $sigFile = [System.IO.Path]::GetTempFileName()
        try {
            $checksumJson | Set-Content $msgFile -NoNewline -Encoding UTF8
            $opensslCmd = if (Get-Command openssl -ErrorAction SilentlyContinue) { 'openssl' }
                          elseif (Test-Path 'C:\Program Files\Git\usr\bin\openssl.exe') { 'C:\Program Files\Git\usr\bin\openssl.exe' }
                          else { throw 'openssl not found' }
            & $opensslCmd dgst -sha256 -sign $keyFile -out $sigFile $msgFile
            if ($LASTEXITCODE -ne 0) { throw "openssl signing failed" }
            $signature = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($sigFile))
        } finally {
            Remove-Item $msgFile -ErrorAction SilentlyContinue
            Remove-Item $sigFile -ErrorAction SilentlyContinue
        }

        # Update version.json with checksums and signature
        $versionJson | Add-Member -NotePropertyName "checksums" -NotePropertyValue $checksums -Force
        $versionJson | Add-Member -NotePropertyName "signature" -NotePropertyValue $signature -Force

        # Write updated version.json
        $versionJson | ConvertTo-Json -Depth 10 | Set-Content $versionJsonPath -Encoding UTF8
        Write-Host "    Signed version.json"
    }
} finally {
    Remove-Item $keyFile -ErrorAction SilentlyContinue
}

Write-Host "Release signing complete" -ForegroundColor Green
