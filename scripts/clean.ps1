#Requires -Version 7

Write-Host "#################################################"
Write-Host "# Clean build artifacts"
Write-Host "#################################################"
Write-Host ""

Stop-Process -Name MSBuild, VBCSCompiler, mt, mthost, mtagenthost -Force -ErrorAction SilentlyContinue

Remove-Item -Path .vs, TestResults -Recurse -Force -ErrorAction SilentlyContinue

Get-ChildItem -Path . -Include *.suo -Recurse -Force -Hidden -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem -Path . -Include *.user -Recurse -Force -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem -Path . -Include *.userprefs -Recurse -Force -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem -Path . -Include *.bak -Recurse -Force -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

Get-ChildItem -Path . -Include bin, obj -Recurse -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "Deleting `"$($_.FullName)`""
    Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Clean complete."
