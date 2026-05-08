param(
    [string]$Url = 'https://100.91.240.65:2000/',
    [int]$Runs = 10,
    [string]$CookieHeader = '',
    [string]$ProfilerPath = "$env:USERPROFILE\.codex\skills\chrome-perf\scripts\Invoke-ChromePerfProfile.ps1",
    [string]$ScenarioPath = "$PSScriptRoot\midterm-terminal-stress.js",
    [string]$ArtifactRoot = "$env:USERPROFILE\.codex\artifacts\chrome-perf",
    [int]$DurationSeconds = 1,
    [int]$FreezeSeconds = 1,
    [double]$MaxHeapGrowthMB = 100,
    [int]$MaxDomNodeGrowth = 3000,
    [switch]$IgnoreCertificateErrors
)

$ErrorActionPreference = 'Stop'

if ($Runs -lt 1) {
    throw 'Runs must be at least 1.'
}

if (-not (Test-Path -LiteralPath $ProfilerPath)) {
    throw "Profiler script not found: $ProfilerPath"
}

if (-not (Test-Path -LiteralPath $ScenarioPath)) {
    throw "Scenario script not found: $ScenarioPath"
}

if ([string]::IsNullOrWhiteSpace($CookieHeader)) {
    $mtcliPath = 'Q:\repos\Jpa\.midterm\mtcli.ps1'
    if (Test-Path -LiteralPath $mtcliPath) {
        $mtcli = Get-Content -LiteralPath $mtcliPath -Raw
        $match = [regex]::Match($mtcli, '\$script:_MK = "([^"]+)"')
        if ($match.Success) {
            $CookieHeader = $match.Groups[1].Value
        }
    }
}

$campaignStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$campaignLabel = "midterm-outer-shell-10run-$campaignStamp"
$campaignDir = Join-Path $ArtifactRoot $campaignLabel
New-Item -ItemType Directory -Force -Path $campaignDir | Out-Null

$results = [System.Collections.Generic.List[object]]::new()
$failures = [System.Collections.Generic.List[object]]::new()

for ($i = 1; $i -le $Runs; $i += 1) {
    $label = "$campaignLabel-run-$('{0:D2}' -f $i)"
    $started = Get-Date
    try {
        $json = & $ProfilerPath `
            -Url $Url `
            -Scenario script `
            -ActionScriptPath $ScenarioPath `
            -DurationSeconds $DurationSeconds `
            -FreezeSeconds $FreezeSeconds `
            -Label $label `
            -CookieHeader $CookieHeader `
            -MaxHeapGrowthMB $MaxHeapGrowthMB `
            -MaxDomNodeGrowth $MaxDomNodeGrowth `
            -IgnoreCertificateErrors:$IgnoreCertificateErrors

        $summary = $json | ConvertFrom-Json -Depth 100
        $summary | Add-Member -NotePropertyName runIndex -NotePropertyValue $i -Force
        $summary | Add-Member -NotePropertyName campaignLabel -NotePropertyValue $campaignLabel -Force
        $summary | Add-Member -NotePropertyName wallClockSeconds -NotePropertyValue ([Math]::Round(((Get-Date) - $started).TotalSeconds, 2)) -Force
        [void]$results.Add($summary)

        if (-not $summary.ok) {
            [void]$failures.Add([pscustomobject]@{
                runIndex = $i
                runDir = $summary.runDir
                budgetFailures = $summary.budgetFailures
            })
        }
    }
    catch {
        [void]$failures.Add([pscustomobject]@{
            runIndex = $i
            error = $_.Exception.Message
        })
    }
}

function Get-Stats {
    param([double[]]$Values)
    if ($Values.Count -eq 0) { return $null }
    $sorted = @($Values | Sort-Object)
    $percentile = {
        param([double]$p)
        $index = [Math]::Min($sorted.Count - 1, [Math]::Floor($sorted.Count * $p))
        [double]$sorted[$index]
    }
    [pscustomobject]@{
        min = [Math]::Round([double]$sorted[0], 2)
        p50 = [Math]::Round((& $percentile 0.50), 2)
        p95 = [Math]::Round((& $percentile 0.95), 2)
        max = [Math]::Round([double]$sorted[$sorted.Count - 1], 2)
        average = [Math]::Round(([double]($Values | Measure-Object -Average).Average), 2)
    }
}

$aggregate = [pscustomobject]@{
    campaignLabel = $campaignLabel
    url = $Url
    runsRequested = $Runs
    runsCompleted = $results.Count
    failures = $failures
    artifactDir = $campaignDir
    metrics = [pscustomobject]@{
        heapDeltaMB = Get-Stats @($results | ForEach-Object { [double]$_.heap.deltaMB })
        domNodeDelta = Get-Stats @($results | ForEach-Object { [double]$_.dom.nodesDelta })
        eventListenerDelta = Get-Stats @($results | ForEach-Object { [double]$_.dom.eventListenersDelta })
        maxLongTaskMs = Get-Stats @($results | ForEach-Object { [double]$_.browserPerf.maxLongTaskMs })
        frameP95Ms = Get-Stats @($results | ForEach-Object { [double]$_.browserPerf.frameP95Ms })
        switchP95Ms = Get-Stats @($results | ForEach-Object { [double]$_.browserPerf.scenario.switchStats.p95Ms })
        resumeTwoRafMs = Get-Stats @($results | ForEach-Object { [double]$_.browserPerf.backgroundResume.resumeTwoRafMs })
    }
    runs = @($results | ForEach-Object {
        $initialCounts = $_.browserPerf.scenario.initialDomCounts
        $finalCounts = $_.browserPerf.scenario.finalDomCounts
        [pscustomobject]@{
            runIndex = $_.runIndex
            ok = $_.ok
            runDir = $_.runDir
            href = $_.browserPerf.scenario.href
            serviceVersion = $_.browserPerf.scenario.serviceVersion
            appVersionText = $_.browserPerf.scenario.appVersionText
            heapDeltaMB = $_.heap.deltaMB
            domNodeDelta = $_.dom.nodesDelta
            eventListenerDelta = $_.dom.eventListenersDelta
            maxLongTaskMs = $_.browserPerf.maxLongTaskMs
            frameP95Ms = $_.browserPerf.frameP95Ms
            switchP95Ms = $_.browserPerf.scenario.switchStats.p95Ms
            resumeTwoRafMs = $_.browserPerf.backgroundResume.resumeTwoRafMs
            cleanupDeleted = $_.browserPerf.scenario.cleanupDeleted
            sessionTabBarsBefore = $initialCounts.'.session-tab-bar'
            sessionTabBarsAfter = $finalCounts.'.session-tab-bar'
            dataSessionNodesBefore = $initialCounts.'[data-session-id]'
            dataSessionNodesAfter = $finalCounts.'[data-session-id]'
            xtermsBefore = $initialCounts.'.xterm'
            xtermsAfter = $finalCounts.'.xterm'
        }
    })
}

$aggregatePath = Join-Path $campaignDir 'aggregate-summary.json'
$aggregate | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $aggregatePath -Encoding UTF8
$aggregate | ConvertTo-Json -Depth 100

if ($failures.Count -gt 0 -or $results.Count -ne $Runs) {
    exit 2
}
