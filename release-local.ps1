#!/usr/bin/env pwsh
# MidTerm Local Release Script
# Does everything release.ps1 does EXCEPT tagging (no GitHub Actions trigger)
# Uses 4th version component (5.8.1.x) for local builds
#
# Usage: .\release-local.ps1 -InfluencesTtyHost no
#        .\release-local.ps1 -InfluencesTtyHost yes

param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("yes", "no")]
    [string]$InfluencesTtyHost
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

# ===========================================
# PHASE 1: Git sync (like release.ps1)
# ===========================================
Write-Host "Checking remote status..." -ForegroundColor Gray
git fetch origin 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Warning: Could not fetch from remote" -ForegroundColor Yellow
}

$localCommit = git rev-parse HEAD 2>$null
$remoteCommit = git rev-parse origin/main 2>$null
$baseCommit = git merge-base HEAD origin/main 2>$null

if ($localCommit -ne $remoteCommit) {
    if ($baseCommit -eq $localCommit) {
        Write-Host "Local branch is behind remote. Pulling changes..." -ForegroundColor Yellow
        git pull origin main 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "ERROR: Git pull failed. Resolve manually." -ForegroundColor Red
            exit 1
        }
        Write-Host "Pull successful." -ForegroundColor Green
    } elseif ($baseCommit -eq $remoteCommit) {
        Write-Host "Local branch is ahead of remote (will push)." -ForegroundColor Gray
    } else {
        Write-Host "ERROR: Branches have diverged. Run: git pull origin main" -ForegroundColor Red
        exit 1
    }
}

# ===========================================
# PHASE 2: Compute local version (4th component)
# ===========================================
$versionJsonPath = "$PSScriptRoot\version.json"
$webCsprojPath = "$PSScriptRoot\Ai.Tlbx.MidTerm\Ai.Tlbx.MidTerm.csproj"
$ttyHostCsprojPath = "$PSScriptRoot\Ai.Tlbx.MidTerm.TtyHost\Ai.Tlbx.MidTerm.TtyHost.csproj"
$ttyHostProgramPath = "$PSScriptRoot\Ai.Tlbx.MidTerm.TtyHost\Program.cs"

$versionJson = Get-Content $versionJsonPath | ConvertFrom-Json
$baseWebVersion = $versionJson.web
$basePtyVersion = $versionJson.pty

# Parse base versions to strip any existing 4th component
$webParts = $baseWebVersion.Split('.')
$ptyParts = $basePtyVersion.Split('.')

if ($webParts.Count -eq 4) {
    # Already has 4th component - increment it
    $buildNum = [int]$webParts[3] + 1
    $baseWebVersion = "$($webParts[0]).$($webParts[1]).$($webParts[2])"
} else {
    # Check output folder for existing local version
    $localVersionFile = "$OutputDir\version.json"
    $buildNum = 1
    if (Test-Path $localVersionFile) {
        $localVersion = Get-Content $localVersionFile | ConvertFrom-Json
        $localParts = $localVersion.web.Split('.')
        if ($localParts.Count -eq 4 -and ($localParts[0..2] -join '.') -eq $baseWebVersion) {
            $buildNum = [int]$localParts[3] + 1
        }
    }
}

# Strip 4th component from PTY base version if present
if ($ptyParts.Count -eq 4) {
    $basePtyVersion = "$($ptyParts[0]).$($ptyParts[1]).$($ptyParts[2])"
}

$localWebVersion = "$baseWebVersion.$buildNum"
$localPtyVersion = if ($InfluencesTtyHost -eq "yes") { "$basePtyVersion.$buildNum" } else { $basePtyVersion }

$updateType = if ($InfluencesTtyHost -eq "yes") { "Full" } else { "WebOnly" }
Write-Host "  Base version: $baseWebVersion" -ForegroundColor Gray
Write-Host "  Local version: $localWebVersion ($updateType)" -ForegroundColor White
Write-Host ""

# ===========================================
# PHASE 3: Update version files
# ===========================================
Write-Host "Updating version files..." -ForegroundColor Gray

# Update version.json
$versionJson.web = $localWebVersion
if ($InfluencesTtyHost -eq "yes") {
    $versionJson.pty = $localPtyVersion
}
$versionJson | ConvertTo-Json | Set-Content $versionJsonPath
Write-Host "  Updated: version.json" -ForegroundColor DarkGray

# Update web csproj
$content = Get-Content $webCsprojPath -Raw
$content = $content -replace "<Version>\d+\.\d+\.\d+(\.\d+)?</Version>", "<Version>$localWebVersion</Version>"
Set-Content $webCsprojPath $content -NoNewline
Write-Host "  Updated: Ai.Tlbx.MidTerm.csproj" -ForegroundColor DarkGray

# Update TtyHost files if needed
if ($InfluencesTtyHost -eq "yes") {
    $content = Get-Content $ttyHostCsprojPath -Raw
    $content = $content -replace "<Version>\d+\.\d+\.\d+(\.\d+)?</Version>", "<Version>$localPtyVersion</Version>"
    # Local versions are 4-part, FileVersion must be exactly 4 parts
    $content = $content -replace "<FileVersion>\d+(\.\d+){2,4}</FileVersion>", "<FileVersion>$localPtyVersion</FileVersion>"
    Set-Content $ttyHostCsprojPath $content -NoNewline
    Write-Host "  Updated: Ai.Tlbx.MidTerm.TtyHost.csproj" -ForegroundColor DarkGray

    $content = Get-Content $ttyHostProgramPath -Raw
    $content = $content -replace 'public const string Version = "\d+\.\d+\.\d+(\.\d+)?"', "public const string Version = `"$localPtyVersion`""
    Set-Content $ttyHostProgramPath $content -NoNewline
    Write-Host "  Updated: Ai.Tlbx.MidTerm.TtyHost\Program.cs" -ForegroundColor DarkGray
}

# ===========================================
# PHASE 4: Build TypeScript with version
# ===========================================
Write-Host ""
Write-Host "Building TypeScript..." -ForegroundColor Gray
npm run typecheck
if ($LASTEXITCODE -ne 0) { throw "TypeScript typecheck failed" }
npx esbuild Ai.Tlbx.MidTerm/src/ts/main.ts --bundle --minify --sourcemap=external --outfile=Ai.Tlbx.MidTerm/wwwroot/js/terminal.min.js --target=es2020 "--define:BUILD_VERSION=`"$localWebVersion`""
if ($LASTEXITCODE -ne 0) { throw "TypeScript build failed" }

# ===========================================
# PHASE 5: AOT publish (parallel)
# ===========================================
Write-Host "Publishing mt.exe and mthost.exe..." -ForegroundColor Gray

$mtJob = Start-Job -ScriptBlock {
    param($rid, $path, $ver, $envPath)
    $env:PATH = $envPath
    Set-Location $path
    dotnet publish Ai.Tlbx.MidTerm/Ai.Tlbx.MidTerm.csproj -c Release -r $rid "-p:IsPublishing=true" "-p:Version=$ver" --verbosity quiet 2>&1
    $LASTEXITCODE
} -ArgumentList $RID, $PWD, $localWebVersion, $env:PATH

$mthostJob = Start-Job -ScriptBlock {
    param($rid, $path, $ver, $envPath)
    $env:PATH = $envPath
    Set-Location $path
    dotnet publish Ai.Tlbx.MidTerm.TtyHost/Ai.Tlbx.MidTerm.TtyHost.csproj -c Release -r $rid "-p:IsPublishing=true" "-p:Version=$ver" --verbosity quiet 2>&1
    $LASTEXITCODE
} -ArgumentList $RID, $PWD, $localPtyVersion, $env:PATH

$mtResult = Receive-Job -Job $mtJob -Wait
$mthostResult = Receive-Job -Job $mthostJob -Wait
Remove-Job -Job $mtJob, $mthostJob

if ($mtResult[-1] -ne 0) { throw "mt publish failed" }
if ($mthostResult[-1] -ne 0) { throw "mthost publish failed" }

# ===========================================
# PHASE 6: Copy to output
# ===========================================
Write-Host "Copying to $OutputDir..." -ForegroundColor Gray
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
Copy-Item "Ai.Tlbx.MidTerm/bin/Release/net10.0/$RID/publish/mt.exe" $OutputDir -Force
Copy-Item "Ai.Tlbx.MidTerm.TtyHost/bin/Release/net10.0/$RID/publish/mthost.exe" $OutputDir -Force

# Write version.json to output (for update detection)
@{
    web = $localWebVersion
    pty = $localPtyVersion
    protocol = $versionJson.protocol
    minCompatiblePty = $versionJson.minCompatiblePty
} | ConvertTo-Json | Set-Content "$OutputDir\version.json"

# ===========================================
# PHASE 7: Git commit and push (NO TAG)
# ===========================================
Write-Host ""
Write-Host "Committing and pushing (no tag)..." -ForegroundColor Gray

git add -A
if ($LASTEXITCODE -ne 0) { throw "git add failed" }

$commitMsg = "Local release $localWebVersion ($updateType)"
git commit -m $commitMsg
if ($LASTEXITCODE -ne 0) {
    Write-Host "  No changes to commit (or commit failed)" -ForegroundColor Yellow
} else {
    git push origin main
    if ($LASTEXITCODE -ne 0) { throw "git push failed" }
    Write-Host "  Pushed to origin/main" -ForegroundColor DarkGray
}

# ===========================================
# DONE
# ===========================================
Write-Host ""
Write-Host "Local release ready!" -ForegroundColor Green
Write-Host "  Output: $OutputDir" -ForegroundColor Gray
Write-Host "  Version: $localWebVersion" -ForegroundColor Gray
Write-Host "  Type: $updateType" -ForegroundColor Gray
Write-Host ""
Write-Host "To test: set MIDTERM_ENVIRONMENT=THELAIR and apply local update in MidTerm" -ForegroundColor Yellow
Write-Host ""
