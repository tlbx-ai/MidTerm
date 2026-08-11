param(
    [Parameter(Mandatory = $true)][string]$SourceDir,
    [Parameter(Mandatory = $true)][string]$DestinationDir,
    [Parameter(Mandatory = $true)][ValidateSet("win-x64", "win-x86")][string]$Rid
)

$ErrorActionPreference = "Stop"

$requiredFiles = @("conpty.dll", "x64\OpenConsole.exe", "arm64\OpenConsole.exe")
if ($Rid -eq "win-x86") {
    $requiredFiles += "x86\OpenConsole.exe"
}

foreach ($relativePath in $requiredFiles) {
    $source = Join-Path $SourceDir $relativePath
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "ConPTY runtime file missing from $Rid publish output: $source"
    }

    $destination = Join-Path $DestinationDir $relativePath
    $destinationDirectory = Split-Path -Parent $destination
    New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -Force
}
