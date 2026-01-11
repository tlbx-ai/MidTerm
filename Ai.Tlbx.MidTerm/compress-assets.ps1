#Requires -Version 7
<#
.SYNOPSIS
    Pre-compress web assets with Brotli for embedding in release builds.
#>
param(
    [string]$WwwRoot = "wwwroot"
)

$ErrorActionPreference = 'Stop'
$extensions = @('*.js', '*.css', '*.html', '*.txt', '*.json', '*.map', '*.svg')

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
        $brotli = [System.IO.Compression.BrotliStream]::new($dstStream, [System.IO.Compression.CompressionLevel]::SmallestSize)

        $srcStream.CopyTo($brotli)

        # Flush before dispose to ensure all data is written
        $brotli.Flush()
    }
    catch {
        # Delete partial .br file on error
        if ($null -ne $brotli) { $brotli.Dispose() }
        if ($null -ne $dstStream) { $dstStream.Dispose() }
        if ($null -ne $srcStream) { $srcStream.Dispose() }
        if (Test-Path $dst) { Remove-Item $dst -Force }
        throw
    }
    finally {
        if ($null -ne $brotli) { $brotli.Dispose() }
        if ($null -ne $dstStream) { $dstStream.Dispose() }
        if ($null -ne $srcStream) { $srcStream.Dispose() }
    }

    $srcSize = (Get-Item $src).Length
    $dstSize = (Get-Item $dst).Length
    $ratio = [math]::Round((1 - $dstSize / $srcSize) * 100)

    Write-Host "  $($_.Name) -> $($_.Name).br ($srcSize -> $dstSize bytes, $ratio% reduction)"
}
