#!/usr/bin/env pwsh
# Frontend build script - handles TypeScript, bundling, asset copying, and compression
# Cross-platform: Windows, macOS, Linux
#
# IMPORTANT FOR PUBLISH BUILDS:
#   This script MUST run BEFORE 'dotnet publish' starts!
#   The csproj uses static ItemGroups for EmbeddedResource which are evaluated
#   when MSBuild loads the project. If files don't exist at that moment,
#   they won't be embedded and you'll get 404 errors.
#
#   Correct order in release scripts:
#     1. frontend-build.ps1 -Publish    <-- Creates wwwroot with compressed files
#     2. dotnet publish                  <-- Embeds existing files
#
# Usage:
#   ./frontend-build.ps1                    # Debug build (TypeScript + assets)
#   ./frontend-build.ps1 -Publish           # Publish build (+ Brotli compression)
#   ./frontend-build.ps1 -Version "1.2.3"   # With version injection

param(
    [switch]$Publish,        # Enable Brotli compression for publish builds
    [string]$Version = "dev" # Version to inject into BUILD_VERSION
)

$ErrorActionPreference = "Stop"
$WwwRoot = Join-Path $PSScriptRoot "wwwroot"
$TsSource = Join-Path $PSScriptRoot "src/ts"
$StaticSource = Join-Path $PSScriptRoot "src/static"
$OutFile = Join-Path $WwwRoot "js/terminal.min.js"

# ===========================================
# PHASE 0: Prepare wwwroot output directory
# ===========================================
if ($Publish) {
    Write-Host "Cleaning wwwroot for fresh publish build..." -ForegroundColor Cyan
    Remove-Item -Path $WwwRoot -Recurse -Force -ErrorAction SilentlyContinue
}

# Create output directories
@('', 'js', 'css', 'fonts', 'img') | ForEach-Object {
    $dir = Join-Path $WwwRoot $_
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
}

# ===========================================
# PHASE 1: TypeScript type-check
# ===========================================
Write-Host "Type-checking TypeScript..." -ForegroundColor Cyan

# Use --pretty false for MSBuild-compatible error format
# Format: file(line,col): error CODE: message
# This allows VS Error List to pick up TypeScript errors
$tscPath = Join-Path $PSScriptRoot "../node_modules/typescript/lib/tsc.js"
$tsconfigPath = Join-Path $PSScriptRoot "tsconfig.json"
& node $tscPath --noEmit --pretty false --project $tsconfigPath
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

# ===========================================
# PHASE 2: ESLint (includes Prettier via plugin)
# ===========================================
Write-Host "Linting with ESLint..." -ForegroundColor Cyan
& npx eslint $TsSource
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

# ===========================================
# PHASE 3: Bundle with esbuild
# ===========================================
Write-Host "Bundling with esbuild (version: $Version)..." -ForegroundColor Cyan

$mainTs = Join-Path $TsSource "main.ts"
$jsonVersion = "'""$Version""'"
& npx esbuild $mainTs `
    --bundle `
    --minify `
    --sourcemap=linked `
    --outfile=$OutFile `
    --target=es2020 `
    "--define:BUILD_VERSION=$jsonVersion"

if ($LASTEXITCODE -ne 0) {
    Write-Error "esbuild failed"
    exit $LASTEXITCODE
}

$jsSize = (Get-Item $OutFile).Length
Write-Host "  terminal.min.js ($([math]::Round($jsSize/1KB, 1)) KB)" -ForegroundColor DarkGray

# ===========================================
# PHASE 4: Copy binary assets (no compression)
# ===========================================
Write-Host "Copying static assets..." -ForegroundColor Cyan

# Fonts -> wwwroot/fonts/
$fontsSource = Join-Path $StaticSource "fonts"
Get-ChildItem -Path "$fontsSource\*" -Include @('*.woff', '*.woff2') | ForEach-Object {
    Copy-Item $_.FullName -Destination (Join-Path $WwwRoot "fonts") -Force
    Write-Host "  fonts/$($_.Name)" -ForegroundColor DarkGray
}

# Images -> wwwroot/img/
$imgSource = Join-Path $StaticSource "img"
Get-ChildItem -Path "$imgSource\*" -Include @('*.png', '*.jpg', '*.gif', '*.svg', '*.webp') | ForEach-Object {
    Copy-Item $_.FullName -Destination (Join-Path $WwwRoot "img") -Force
    Write-Host "  img/$($_.Name)" -ForegroundColor DarkGray
}

# Favicons -> wwwroot/ (flattened)
$faviconSource = Join-Path $StaticSource "favicon"
Get-ChildItem -Path "$faviconSource\*" -Include @('*.png', '*.ico') | ForEach-Object {
    Copy-Item $_.FullName -Destination $WwwRoot -Force
    Write-Host "  $($_.Name)" -ForegroundColor DarkGray
}

# ===========================================
# PHASE 5: Process text assets
# ===========================================
# Text files to process (compress for publish, copy for debug)
$textExtensions = @('*.html', '*.css', '*.txt', '*.json', '*.webmanifest')
$totalSaved = 0

function Process-TextFile {
    param([string]$Source, [string]$Destination, [bool]$Compress)

    if ($Compress) {
        $dstPath = "$Destination.br"
        $srcStream = $null
        $dstStream = $null
        $brotli = $null

        try {
            $srcStream = [System.IO.File]::OpenRead($Source)
            $dstStream = [System.IO.File]::Create($dstPath)
            $brotli = [System.IO.Compression.BrotliStream]::new(
                $dstStream,
                [System.IO.Compression.CompressionLevel]::SmallestSize
            )
            $srcStream.CopyTo($brotli)
            $brotli.Flush()

            $srcSize = (Get-Item $Source).Length
            $dstSize = (Get-Item $dstPath).Length
            $reduction = [math]::Round((1 - $dstSize / $srcSize) * 100)

            return @{ Saved = ($srcSize - $dstSize); Reduction = $reduction }
        }
        finally {
            if ($null -ne $brotli) { $brotli.Dispose() }
            if ($null -ne $dstStream) { $dstStream.Dispose() }
            if ($null -ne $srcStream) { $srcStream.Dispose() }
        }
    }
    else {
        Copy-Item $Source -Destination $Destination -Force
        return @{ Saved = 0; Reduction = 0 }
    }
}

if ($Publish) {
    Write-Host "Compressing text assets with Brotli..." -ForegroundColor Cyan
}

# Root-level text files (HTML, manifest, etc.) -> wwwroot/
Get-ChildItem -Path "$StaticSource\*" -Include $textExtensions | ForEach-Object {
    $dstName = $_.Name
    $dstPath = Join-Path $WwwRoot $dstName
    $result = Process-TextFile -Source $_.FullName -Destination $dstPath -Compress $Publish

    if ($Publish) {
        $totalSaved += $result.Saved
        Write-Host "  $dstName -> $dstName.br ($($result.Reduction)% reduction)" -ForegroundColor DarkGray
    }
    else {
        Write-Host "  $dstName" -ForegroundColor DarkGray
    }
}

# CSS files -> wwwroot/css/
$cssSource = Join-Path $StaticSource "css"
Get-ChildItem -Path "$cssSource\*" -Include @('*.css') | ForEach-Object {
    $dstPath = Join-Path $WwwRoot "css/$($_.Name)"
    $result = Process-TextFile -Source $_.FullName -Destination $dstPath -Compress $Publish

    if ($Publish) {
        $totalSaved += $result.Saved
        Write-Host "  css/$($_.Name) -> css/$($_.Name).br ($($result.Reduction)% reduction)" -ForegroundColor DarkGray
    }
    else {
        Write-Host "  css/$($_.Name)" -ForegroundColor DarkGray
    }
}

# Fonts text files (OFL.txt license) -> wwwroot/fonts/
Get-ChildItem -Path "$fontsSource\*" -Include @('*.txt') | ForEach-Object {
    $dstPath = Join-Path $WwwRoot "fonts/$($_.Name)"
    $result = Process-TextFile -Source $_.FullName -Destination $dstPath -Compress $Publish

    if ($Publish) {
        $totalSaved += $result.Saved
        Write-Host "  fonts/$($_.Name) -> fonts/$($_.Name).br ($($result.Reduction)% reduction)" -ForegroundColor DarkGray
    }
    else {
        Write-Host "  fonts/$($_.Name)" -ForegroundColor DarkGray
    }
}

# ===========================================
# PHASE 6: Compress generated JS (publish only)
# ===========================================
if ($Publish) {
    Write-Host "Compressing generated JavaScript..." -ForegroundColor Cyan

    @($OutFile, "$OutFile.map") | Where-Object { Test-Path $_ } | ForEach-Object {
        $src = $_
        $dst = "$src.br"
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

            $srcSize = (Get-Item $src).Length
            $dstSize = (Get-Item $dst).Length
            $reduction = [math]::Round((1 - $dstSize / $srcSize) * 100)
            $totalSaved += ($srcSize - $dstSize)

            $fileName = Split-Path $src -Leaf
            Write-Host "  js/$fileName -> js/$fileName.br ($srcSize -> $dstSize bytes, $reduction% reduction)" -ForegroundColor DarkGray
        }
        finally {
            if ($null -ne $brotli) { $brotli.Dispose() }
            if ($null -ne $dstStream) { $dstStream.Dispose() }
            if ($null -ne $srcStream) { $srcStream.Dispose() }
        }
    }

    # Remove uncompressed JS files for publish (only .br embedded)
    Remove-Item $OutFile -Force -ErrorAction SilentlyContinue
    Remove-Item "$OutFile.map" -Force -ErrorAction SilentlyContinue

    Write-Host "  Total saved: $([math]::Round($totalSaved/1KB, 1)) KB" -ForegroundColor Green
}

Write-Host "Frontend build complete" -ForegroundColor Green
