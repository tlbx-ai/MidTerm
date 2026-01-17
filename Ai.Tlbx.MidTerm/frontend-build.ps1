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
# PHASE 4: Copy binary assets
# ===========================================
# Binary asset compression notes (tested 2025-01):
#   - woff2 files are already Brotli-compressed internally, so most don't benefit
#   - EXCEPT Terminus.woff2 which has 62% reduction (unoptimized metadata?)
#   - woff (older format, zlib) benefits ~49% from Brotli
#   - ico files benefit ~49% (contains BMP data, not PNG)
#   - png files don't benefit (already DEFLATE compressed)
#   - Properly optimized woff2 (CascadiaCode, JetBrains) show 0-1% reduction
#
# Files worth compressing for publish (saves ~195 KB total):
#   - Terminus.woff2: 297 KB -> 112 KB (62% reduction, 185 KB saved)
#   - midFont.woff:    15 KB ->   8 KB (49% reduction, 7 KB saved)
#   - favicon.ico:     15 KB ->   8 KB (49% reduction, 7 KB saved)

Write-Host "Copying static assets..." -ForegroundColor Cyan

# Binary files that benefit from Brotli compression (publish only)
# These get both the original (debug) and .br version (publish)
$compressibleBinaries = @(
    @{ Src = "fonts/Terminus.woff2"; Dst = "fonts/Terminus.woff2" },
    @{ Src = "fonts/midFont.woff"; Dst = "fonts/midFont.woff" },
    @{ Src = "favicon/favicon.ico"; Dst = "favicon.ico" }
)

# Binary files that don't benefit from compression (already optimized)
# woff2 uses Brotli internally, png uses DEFLATE
$nonCompressibleBinaries = @(
    @{ Pattern = "fonts/*.woff2"; Dst = "fonts"; Exclude = @("Terminus.woff2") },
    @{ Pattern = "img/*.png"; Dst = "img" },
    @{ Pattern = "favicon/*.png"; Dst = "" }
)

# Copy compressible binaries (always copy original, compress for publish)
foreach ($file in $compressibleBinaries) {
    $srcPath = Join-Path $StaticSource $file.Src
    $dstPath = Join-Path $WwwRoot $file.Dst
    $dstDir = Split-Path $dstPath -Parent
    if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Path $dstDir -Force | Out-Null }

    Copy-Item $srcPath -Destination $dstPath -Force
    Write-Host "  $($file.Dst)" -ForegroundColor DarkGray
}

# Copy non-compressible binaries
foreach ($spec in $nonCompressibleBinaries) {
    $pattern = Join-Path $StaticSource $spec.Pattern
    $exclude = if ($spec.Exclude) { $spec.Exclude } else { @() }

    Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue | Where-Object { $_.Name -notin $exclude } | ForEach-Object {
        $dstDir = if ($spec.Dst) { Join-Path $WwwRoot $spec.Dst } else { $WwwRoot }
        Copy-Item $_.FullName -Destination $dstDir -Force
        $relPath = if ($spec.Dst) { "$($spec.Dst)/$($_.Name)" } else { $_.Name }
        Write-Host "  $relPath" -ForegroundColor DarkGray
    }
}

# Compress select binary files for publish (see notes above for rationale)
if ($Publish) {
    Write-Host "Compressing select binary assets..." -ForegroundColor Cyan
    foreach ($file in $compressibleBinaries) {
        $srcPath = Join-Path $WwwRoot $file.Dst
        $dstPath = "$srcPath.br"

        $bytes = [System.IO.File]::ReadAllBytes($srcPath)
        $memStream = [System.IO.MemoryStream]::new()
        $brotli = [System.IO.Compression.BrotliStream]::new($memStream, [System.IO.Compression.CompressionLevel]::SmallestSize)
        $brotli.Write($bytes, 0, $bytes.Length)
        $brotli.Close()
        [System.IO.File]::WriteAllBytes($dstPath, $memStream.ToArray())

        $srcSize = $bytes.Length
        $dstSize = $memStream.ToArray().Length
        $reduction = [math]::Round((1 - $dstSize / $srcSize) * 100)

        Write-Host "  $($file.Dst) -> $($file.Dst).br ($srcSize -> $dstSize bytes, $reduction% reduction)" -ForegroundColor DarkGray

        # Remove original for publish (only .br embedded)
        Remove-Item $srcPath -Force
    }
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

# CSS files -> wwwroot/css/ (minified)
$cssSource = Join-Path $StaticSource "css"
Get-ChildItem -Path "$cssSource\*" -Include @('*.css') | ForEach-Object {
    $dstPath = Join-Path $WwwRoot "css/$($_.Name)"
    $srcSize = $_.Length

    # Minify with esbuild
    $null = & npx esbuild $_.FullName --minify --outfile=$dstPath 2>&1
    $minSize = (Get-Item $dstPath).Length

    if ($Publish) {
        # Brotli compress the minified file
        $brPath = "$dstPath.br"
        $srcStream = $null
        $dstStream = $null
        $brotli = $null
        try {
            $srcStream = [System.IO.File]::OpenRead($dstPath)
            $dstStream = [System.IO.File]::Create($brPath)
            $brotli = [System.IO.Compression.BrotliStream]::new($dstStream, [System.IO.Compression.CompressionLevel]::SmallestSize)
            $srcStream.CopyTo($brotli)
            $brotli.Flush()
        }
        finally {
            if ($null -ne $brotli) { $brotli.Dispose() }
            if ($null -ne $dstStream) { $dstStream.Dispose() }
            if ($null -ne $srcStream) { $srcStream.Dispose() }
        }
        Remove-Item $dstPath -Force
        $brSize = (Get-Item $brPath).Length
        $totalSaved += ($srcSize - $brSize)
        $reduction = [math]::Round((1 - $brSize / $srcSize) * 100)
        Write-Host "  css/$($_.Name) -> css/$($_.Name).br ($reduction% reduction)" -ForegroundColor DarkGray
    }
    else {
        Write-Host "  css/$($_.Name)" -ForegroundColor DarkGray
    }
}

# Fonts text files (OFL.txt license) -> wwwroot/fonts/
$fontsSource = Join-Path $StaticSource "fonts"
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
