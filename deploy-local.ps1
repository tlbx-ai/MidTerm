#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Deploy local release to MidTerm service. Run as admin.
#>
$ErrorActionPreference = 'Stop'

$Source = 'C:\temp\mtlocalrelease'
$Dest = 'C:\Program Files\MidTerm'

if (-not (Test-Path "$Source\mt.exe")) {
    Write-Host "No local release found at $Source" -ForegroundColor Red
    exit 1
}

Write-Host "Stopping MidTerm service..." -ForegroundColor Gray
Stop-Service MidTerm -ErrorAction SilentlyContinue

Write-Host "Killing mthost processes..." -ForegroundColor Gray
Get-Process mthost -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep 1

Write-Host "Copying files..." -ForegroundColor Gray
Copy-Item "$Source\mt.exe" "$Dest\mt.exe" -Force
Copy-Item "$Source\mthost.exe" "$Dest\mthost.exe" -Force

Write-Host "Starting MidTerm service..." -ForegroundColor Gray
Start-Service MidTerm
Start-Sleep 2

$version = Invoke-RestMethod -Uri 'https://localhost:2000/api/version' -SkipCertificateCheck -ErrorAction SilentlyContinue
Write-Host "Deployed: $version" -ForegroundColor Green
