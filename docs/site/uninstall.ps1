# MidTerm GitHub Pages bootstrap uninstaller
# Usage: irm https://tlbx-ai.github.io/MidTerm/uninstall.ps1 | iex

param(
    [switch]$Elevated,
    [string]$OriginalUserProfile,
    [string]$OriginalLocalAppData,
    [string]$OriginalTempRoot
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$scriptUrl = 'https://raw.githubusercontent.com/tlbx-ai/MidTerm/main/uninstall.ps1'
$scriptContent = Invoke-RestMethod -Uri $scriptUrl
$scriptBlock = [ScriptBlock]::Create($scriptContent)

& $scriptBlock @PSBoundParameters
