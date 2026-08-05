#!/usr/bin/env pwsh
# Sign tlbx release artifacts using openssl.
# Updates version.json with a metadata-bound ECDSA P-384 signature and a
# transitional checksum-only signature for clients predating manifest v2.

param(
    [Parameter(Mandatory=$true)]
    [string]$ArtifactsPath
)

$ErrorActionPreference = "Stop"

# Check for signing key (base64-encoded PKCS#8 PEM)
$privateKeyB64 = $env:SIGNING_PRIVATE_KEY
if (-not $privateKeyB64) {
    throw "SIGNING_PRIVATE_KEY is required; refusing to produce an unsigned release"
}

Write-Host "Signing release artifacts..."

function New-EcdsaSignature {
    param(
        [Parameter(Mandatory=$true)]
        [byte[]]$Payload,

        [Parameter(Mandatory=$true)]
        [string]$PrivateKeyPath
    )

    $msgFile = [System.IO.Path]::GetTempFileName()
    $sigFile = [System.IO.Path]::GetTempFileName()
    try {
        [System.IO.File]::WriteAllBytes($msgFile, $Payload)
        $opensslCmd = if (Get-Command openssl -ErrorAction SilentlyContinue) { 'openssl' }
                      elseif (Test-Path 'C:\Program Files\Git\usr\bin\openssl.exe') { 'C:\Program Files\Git\usr\bin\openssl.exe' }
                      else { throw 'openssl not found' }
        & $opensslCmd dgst -sha256 -sign $PrivateKeyPath -out $sigFile $msgFile
        if ($LASTEXITCODE -ne 0) { throw "openssl signing failed" }
        return [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($sigFile))
    } finally {
        Remove-Item $msgFile -ErrorAction SilentlyContinue
        Remove-Item $sigFile -ErrorAction SilentlyContinue
    }
}

# Write private key to temp file
$keyFile = [System.IO.Path]::GetTempFileName()
try {
    [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($privateKeyB64)) | Set-Content $keyFile -NoNewline

    # Process each platform
    $platforms = @("win-x64", "win-x86", "osx-arm64", "osx-x64", "linux-x64", "linux-arm64")

    $signedPlatformCount = 0
    foreach ($platform in $platforms) {
        $platformDir = Join-Path $ArtifactsPath $platform
        if (-not (Test-Path $platformDir)) {
            Write-Host "  Skipping $platform (not found)"
            continue
        }

        Write-Host "  Processing $platform..."

        $versionJsonPath = Join-Path $platformDir "version.json"
        if (-not (Test-Path $versionJsonPath)) {
            throw "version.json not found for $platform"
        }

        # Read version.json to check for web-only release
        $versionJson = Get-Content $versionJsonPath -Raw | ConvertFrom-Json
        $isWebOnly = $versionJson.webOnly -eq $true

        # Authenticate every executable shipped in the archive. Web-only controls which
        # installed binaries are replaced; it must not leave fresh-install payloads unsigned.
        $checksums = @{}
        $binaries = @("mt", "mthost", "mtagenthost")
        if ($platform.StartsWith("win-")) {
            $binaries += "mttmux"
        }
        $ext = if ($platform.StartsWith("win-")) { ".exe" } else { "" }
        $expectedFiles = $binaries | ForEach-Object { "$_$ext" }

        if ($isWebOnly) {
            Write-Host "    Web-only release: authenticating the full archive; running installs still preserve mthost + mtagenthost" -ForegroundColor Cyan
        }

        foreach ($fileName in $expectedFiles) {
            $binaryPath = Join-Path $platformDir $fileName
            if (-not (Test-Path -LiteralPath $binaryPath -PathType Leaf)) {
                throw "Expected release binary $fileName not found for $platform"
            }

            $hash = (Get-FileHash -LiteralPath $binaryPath -Algorithm SHA256).Hash.ToLowerInvariant()
            $checksums[$fileName] = $hash
            Write-Host "    $fileName = $hash"
        }

        # Create sorted JSON of checksums (deterministic for signing)
        $sortedChecksums = [ordered]@{}
        foreach ($key in $checksums.Keys | Sort-Object) {
            $sortedChecksums[$key] = $checksums[$key]
        }
        $checksumJson = $sortedChecksums | ConvertTo-Json -Compress

        # Keep the checksum-only signature for one migration release so older
        # installed clients can authenticate and install the manifest-v2 updater.
        $legacyPayloadBytes = [System.Text.Encoding]::UTF8.GetBytes($checksumJson)
        $signature = New-EcdsaSignature -Payload $legacyPayloadBytes -PrivateKeyPath $keyFile

        $channel = if ([string]$versionJson.web -match '-dev(?:\.|$)') { 'dev' } else { 'stable' }
        $signedPayloadObject = [ordered]@{
            signatureVersion = 2
            web = [string]$versionJson.web
            pty = [string]$versionJson.pty
            protocol = [int]$versionJson.protocol
            minCompatiblePty = [string]$versionJson.minCompatiblePty
            webOnly = [bool]$versionJson.webOnly
            platform = $platform
            channel = $channel
            checksums = $sortedChecksums
        }
        $signedPayloadJson = $signedPayloadObject | ConvertTo-Json -Compress -Depth 10
        $signedPayloadBytes = [System.Text.Encoding]::UTF8.GetBytes($signedPayloadJson)
        $signedPayload = [Convert]::ToBase64String($signedPayloadBytes)
        $metadataSignature = New-EcdsaSignature -Payload $signedPayloadBytes -PrivateKeyPath $keyFile

        # Update version.json with checksums and signature
        $versionJson | Add-Member -NotePropertyName "signatureVersion" -NotePropertyValue 2 -Force
        $versionJson | Add-Member -NotePropertyName "platform" -NotePropertyValue $platform -Force
        $versionJson | Add-Member -NotePropertyName "channel" -NotePropertyValue $channel -Force
        $versionJson | Add-Member -NotePropertyName "checksums" -NotePropertyValue $checksums -Force
        $versionJson | Add-Member -NotePropertyName "signature" -NotePropertyValue $signature -Force
        $versionJson | Add-Member -NotePropertyName "signedPayload" -NotePropertyValue $signedPayload -Force
        $versionJson | Add-Member -NotePropertyName "metadataSignature" -NotePropertyValue $metadataSignature -Force

        # Write updated version.json
        $versionJson | ConvertTo-Json -Depth 10 | Set-Content $versionJsonPath -Encoding UTF8
        $signedPlatformCount++
        Write-Host "    Signed version.json (manifest v2, metadata bound)"
    }

    if ($signedPlatformCount -eq 0) {
        throw "No platform directories were signed under $ArtifactsPath"
    }
} finally {
    Remove-Item $keyFile -ErrorAction SilentlyContinue
}

Write-Host "Release signing complete" -ForegroundColor Green
