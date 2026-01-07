#!/usr/bin/env pwsh
# MidTerm Local Release Script
# Builds AOT binaries for local testing without git operations
# Usage: .\release-local.ps1
#        .\release-local.ps1 -InfluencesTtyHost yes

param(
    [ValidateSet("yes", "no")]
    [string]$InfluencesTtyHost = "no"
)

$ErrorActionPreference = "Stop"

$OutputDir = "C:\temp\mtlocalrelease"
$RID = "win-x64"

# Ensure vswhere is available (needed for AOT publish)
if (-not (Get-Command vswhere -ErrorAction SilentlyContinue))
{
    $vsWherePath = "C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path $vsWherePath)
    {
        $env:PATH = "$env:PATH;$(Split-Path $vsWherePath)"
    }
}

Write-Host ""
Write-Host "  MidTerm Local Release" -ForegroundColor Cyan
Write-Host "  =====================" -ForegroundColor Cyan
Write-Host ""

# 1. Build TypeScript
Write-Host "Building TypeScript..." -ForegroundColor Gray
npm run build
if ($LASTEXITCODE -ne 0) { throw "TypeScript build failed" }

# 2. Read version.json and compute local version
$repoVersion = Get-Content "version.json" | ConvertFrom-Json
$baseWebVersion = $repoVersion.web

# Check existing local version to determine next build number
$localVersionFile = "$OutputDir\version.json"
$buildNum = 1
if (Test-Path $localVersionFile)
{
    $localVersion = Get-Content $localVersionFile | ConvertFrom-Json
    $localParts = $localVersion.web.Split('.')
    if ($localParts.Count -eq 4 -and ($localParts[0..2] -join '.') -eq $baseWebVersion)
    {
        $buildNum = [int]$localParts[3] + 1
    }
}
$localWebVersion = "$baseWebVersion.$buildNum"

# Create output version manifest
$outputVersion = @{
    web = $localWebVersion
    pty = $repoVersion.pty
    protocol = $repoVersion.protocol
    minCompatiblePty = $repoVersion.minCompatiblePty
}

# Optionally bump PTY version (for full updates)
if ($InfluencesTtyHost -eq "yes")
{
    $basePtyVersion = $repoVersion.pty
    $outputVersion.pty = "$basePtyVersion.$buildNum"
}

$updateType = if ($InfluencesTtyHost -eq "yes") { "Full" } else { "WebOnly" }
Write-Host "  Version: $localWebVersion ($updateType)" -ForegroundColor White
Write-Host ""

# 3. AOT publish mt and mthost in parallel
Write-Host "Publishing mt.exe and mthost.exe..." -ForegroundColor Gray
$mtJob = Start-Job -ScriptBlock {
    param($rid, $path)
    Set-Location $path
    dotnet publish Ai.Tlbx.MidTerm/Ai.Tlbx.MidTerm.csproj -c Release -r $rid /p:IsPublishing=true --verbosity quiet 2>&1
    $LASTEXITCODE
} -ArgumentList $RID, $PWD

$mthostJob = Start-Job -ScriptBlock {
    param($rid, $path)
    Set-Location $path
    dotnet publish Ai.Tlbx.MidTerm.TtyHost/Ai.Tlbx.MidTerm.TtyHost.csproj -c Release -r $rid /p:IsPublishing=true --verbosity quiet 2>&1
    $LASTEXITCODE
} -ArgumentList $RID, $PWD

$mtResult = Receive-Job -Job $mtJob -Wait
$mthostResult = Receive-Job -Job $mthostJob -Wait
Remove-Job -Job $mtJob, $mthostJob

if ($mtResult[-1] -ne 0) { throw "mt publish failed" }
if ($mthostResult[-1] -ne 0) { throw "mthost publish failed" }

# 5. Copy to output
Write-Host "Copying to $OutputDir..." -ForegroundColor Gray
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
Copy-Item "Ai.Tlbx.MidTerm/bin/Release/net10.0/$RID/publish/mt.exe" $OutputDir -Force
Copy-Item "Ai.Tlbx.MidTerm.TtyHost/bin/Release/net10.0/$RID/publish/mthost.exe" $OutputDir -Force
$outputVersion | ConvertTo-Json | Set-Content "$OutputDir\version.json"

Write-Host ""
Write-Host "Local release ready!" -ForegroundColor Green
Write-Host "  Output: $OutputDir" -ForegroundColor Gray
Write-Host "  Version: $localWebVersion" -ForegroundColor Gray
Write-Host "  Type: $updateType" -ForegroundColor Gray
Write-Host ""
Write-Host "To test: set MIDTERM_ENVIRONMENT=THELAIR and check for updates in MidTerm" -ForegroundColor Yellow
Write-Host ""
