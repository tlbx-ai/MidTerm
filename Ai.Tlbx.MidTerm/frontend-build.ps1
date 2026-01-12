#!/usr/bin/env pwsh
# Frontend build script - handles TypeScript, bundling, and compression
# Cross-platform: Windows, macOS, Linux
#
# Usage:
#   ./frontend-build.ps1                    # Debug build (TypeScript + esbuild)
#   ./frontend-build.ps1 -Publish           # Publish build (+ Brotli compression)
#   ./frontend-build.ps1 -Version "1.2.3"   # With version injection

param(
    [switch]$Publish,        # Enable Brotli compression for publish builds
    [string]$Version = "dev" # Version to inject into BUILD_VERSION
)

$ErrorActionPreference = "Stop"
$WwwRoot = Join-Path $PSScriptRoot "wwwroot"
$TsSource = Join-Path $PSScriptRoot "src/ts"
$OutFile = Join-Path $WwwRoot "js/terminal.min.js"

# ===========================================
# PHASE 1: TypeScript type-check
# ===========================================
Write-Host "Type-checking TypeScript..." -ForegroundColor Cyan

# Use --pretty false for MSBuild-compatible error format
# Format: file(line,col): error CODE: message
# This allows VS Error List to pick up TypeScript errors
$tscPath = Join-Path $PSScriptRoot "../node_modules/typescript/lib/tsc.js"
& node $tscPath --noEmit --pretty false
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

# ===========================================
# PHASE 2: [placeholder] ESLint
# ===========================================
# TODO: Add eslint check here when ready
# & npx eslint $TsSource --format stylish
# if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# ===========================================
# PHASE 3: [placeholder] Prettier
# ===========================================
# TODO: Add prettier check here when ready
# & npx prettier --check "$TsSource/**/*.ts"
# if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# ===========================================
# PHASE 4: Bundle with esbuild
# ===========================================
Write-Host "Bundling with esbuild (version: $Version)..." -ForegroundColor Cyan

$mainTs = Join-Path $TsSource "main.ts"
& npx esbuild $mainTs `
    --bundle `
    --minify `
    --sourcemap=linked `
    --outfile=$OutFile `
    --target=es2020 `
    "--define:BUILD_VERSION=`"$Version`""

if ($LASTEXITCODE -ne 0) {
    Write-Error "esbuild failed"
    exit $LASTEXITCODE
}

$jsSize = (Get-Item $OutFile).Length
Write-Host "  terminal.min.js ($([math]::Round($jsSize/1KB, 1)) KB)" -ForegroundColor DarkGray

# ===========================================
# PHASE 5: Brotli compression (publish only)
# ===========================================
if ($Publish) {
    Write-Host "Compressing assets with Brotli..." -ForegroundColor Cyan

    $extensions = @('*.js', '*.css', '*.html', '*.txt', '*.json', '*.map', '*.svg')
    $totalSaved = 0

    Get-ChildItem -Path $WwwRoot -Recurse -Include $extensions | ForEach-Object {
        $src = $_.FullName
        $dst = "$src.br"

        # Incremental: skip if .br exists and is newer than source
        if ((Test-Path $dst) -and ((Get-Item $dst).LastWriteTime -gt $_.LastWriteTime)) {
            return
        }

        $srcStream = $null
        $dstStream = $null
        $brotli = $null

        try {
            $srcStream = [System.IO.File]::OpenRead($src)
            $dstStream = [System.IO.File]::Create($dst)
            $brotli = [System.IO.Compression.BrotliStream]::new(
                $dstStream,
                [System.IO.Compression.CompressionLevel]::SmallestSize
            )
            $srcStream.CopyTo($brotli)
            $brotli.Flush()

            $srcSize = $_.Length
            $dstSize = (Get-Item $dst).Length
            $reduction = [math]::Round((1 - $dstSize / $srcSize) * 100)
            $totalSaved += ($srcSize - $dstSize)

            Write-Host "  $($_.Name) -> $($_.Name).br ($srcSize -> $dstSize bytes, $reduction% reduction)" -ForegroundColor DarkGray
        }
        catch {
            if (Test-Path $dst) { Remove-Item $dst -Force }
            throw
        }
        finally {
            if ($null -ne $brotli) { $brotli.Dispose() }
            if ($null -ne $dstStream) { $dstStream.Dispose() }
            if ($null -ne $srcStream) { $srcStream.Dispose() }
        }
    }

    Write-Host "  Total saved: $([math]::Round($totalSaved/1KB, 1)) KB" -ForegroundColor Green
}

Write-Host "Frontend build complete" -ForegroundColor Green
