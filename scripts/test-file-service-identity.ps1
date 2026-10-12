param([string]$Configuration = 'Release', [string]$ArtifactRoot = '.dev/file-service-identity')
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This acceptance requires Windows.' }
$ownerIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
try {
    if (-not [Security.Principal.WindowsPrincipal]::new($ownerIdentity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'This acceptance requires an elevated runner to create its isolated LocalSystem task.'
    }
    $repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $artifactDirectory = [IO.Path]::GetFullPath((Join-Path $repoRoot $ArtifactRoot))
    if (-not $artifactDirectory.StartsWith($repoRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Artifacts must stay inside the checkout.' }
    [IO.Directory]::CreateDirectory($artifactDirectory) | Out-Null
    $fixtureRoot = Join-Path $artifactDirectory ('owned-' + [guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($fixtureRoot) | Out-Null
    & git -C $fixtureRoot init --quiet
    if ($LASTEXITCODE -ne 0) { throw 'Fixture git initialization failed.' }
    [IO.File]::WriteAllText((Join-Path $fixtureRoot 'caller.txt'), 'caller data')
    [IO.File]::WriteAllText((Join-Path $fixtureRoot '.gitignore'), "*.tmp`n")
    [IO.File]::WriteAllText((Join-Path $fixtureRoot 'ignored.tmp'), 'ignored')
    $security = [Security.AccessControl.DirectorySecurity]::new()
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner($ownerIdentity.User)
    $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($ownerIdentity.User, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    Set-Acl -LiteralPath $fixtureRoot -AclObject $security
    $outside = Join-Path $artifactDirectory 'outside.txt'
    [IO.File]::WriteAllText($outside, 'outside scope')
    $configPath = Join-Path $artifactDirectory 'fixture.json'
    $exitPath = Join-Path $artifactDirectory 'exit.json'
    if (Test-Path -LiteralPath $exitPath) { Remove-Item -LiteralPath $exitPath }
    $config = @{ root=$fixtureRoot; sid=$ownerIdentity.User.Value; pid=$PID; started=(Get-Process -Id $PID).StartTime.ToFileTimeUtc(); storage=(Join-Path $artifactDirectory 'state'); outside=$outside }
    [IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Compress))
    $dotnetPath = (Get-Command dotnet -CommandType Application).Source
    $project = Join-Path $repoRoot 'src/Ai.Tlbx.MidTerm.UnitTests/Ai.Tlbx.MidTerm.UnitTests.csproj'
    $workerPath = Join-Path $artifactDirectory 'worker.ps1'
    $worker = @'
$ErrorActionPreference = 'Stop'
$env:TLBX_FILE_IDENTITY_FIXTURE = '__CONFIG__'
try {
    & '__DOTNET__' test '__PROJECT__' -c '__CONFIGURATION__' --no-build --no-restore --filter 'FullyQualifiedName~FileServiceIdentityTests' --logger 'trx;LogFileName=service-identity.trx' --results-directory '__ARTIFACTS__' 1> '__STDOUT__' 2> '__STDERR__'
    $testCode = $LASTEXITCODE
} catch { $_ | Out-String | Add-Content -LiteralPath '__STDERR__'; $testCode = 1 }
[IO.File]::WriteAllText('__EXIT__', (@{ exitCode=$testCode } | ConvertTo-Json -Compress))
exit $testCode
'@
    $substitutions = @{ CONFIG=$configPath; DOTNET=$dotnetPath; PROJECT=$project; CONFIGURATION=$Configuration; ARTIFACTS=$artifactDirectory; STDOUT=(Join-Path $artifactDirectory 'stdout.log'); STDERR=(Join-Path $artifactDirectory 'stderr.log'); EXIT=$exitPath }
    foreach ($key in $substitutions.Keys) { $worker = $worker.Replace('__' + $key + '__', $substitutions[$key].Replace("'", "''")) }
    [IO.File]::WriteAllText($workerPath, $worker)
    $taskName = 'tlbx-files-identity-' + [guid]::NewGuid().ToString('N')
    $shellPath = (Get-Command pwsh -CommandType Application).Source
    $action = New-ScheduledTaskAction -Execute $shellPath -Argument ('-NoProfile -NonInteractive -File "' + $workerPath + '"') -WorkingDirectory $repoRoot
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
    try {
        Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings | Out-Null
        Start-ScheduledTask -TaskName $taskName
        $deadline = [DateTime]::UtcNow.AddMinutes(4)
        while (-not (Test-Path -LiteralPath $exitPath)) {
            if ([DateTime]::UtcNow -gt $deadline) { throw 'LocalSystem acceptance did not produce its result before the deadline.' }
            Start-Sleep -Seconds 2
        }
        $result = Get-Content -LiteralPath $exitPath -Raw | ConvertFrom-Json
        if ($result.exitCode -ne 0) { Get-Content -LiteralPath (Join-Path $artifactDirectory 'stdout.log') -Tail 35; Get-Content -LiteralPath (Join-Path $artifactDirectory 'stderr.log') -Tail 15; throw 'LocalSystem file identity acceptance failed.' }
        [xml]$trx = Get-Content -LiteralPath (Join-Path $artifactDirectory 'service-identity.trx') -Raw
        if ([int]$trx.TestRun.ResultSummary.Counters.passed -ne 1 -or [int]$trx.TestRun.ResultSummary.Counters.failed -ne 0) { throw 'The real LocalSystem test did not pass; a skip is not acceptance.' }
        Write-Output "LocalSystem file/Git identity passed. Artifacts: $artifactDirectory"
    } finally {
        $ownedTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($ownedTask) { if ($ownedTask.State -eq 'Running') { Stop-ScheduledTask -TaskName $taskName }; Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
    }
} finally { $ownerIdentity.Dispose() }
