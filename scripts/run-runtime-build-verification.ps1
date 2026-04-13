#!/usr/bin/env pwsh

param(
    [string]$Configuration = "Release",
    [switch]$WarnAsError
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")

$projects = @(
    @{
        Name = "Ai.Tlbx.MidTerm"
        Path = "src/Ai.Tlbx.MidTerm/Ai.Tlbx.MidTerm.csproj"
        ExtraArgs = @("-p:SkipFrontendBuild=true", "-p:ContinuousIntegrationBuild=true")
    },
    @{
        Name = "Ai.Tlbx.MidTerm.TtyHost"
        Path = "src/Ai.Tlbx.MidTerm.TtyHost/Ai.Tlbx.MidTerm.TtyHost.csproj"
        ExtraArgs = @("-p:ContinuousIntegrationBuild=true")
    },
    @{
        Name = "Ai.Tlbx.MidTerm.AgentHost"
        Path = "src/Ai.Tlbx.MidTerm.AgentHost/Ai.Tlbx.MidTerm.AgentHost.csproj"
        ExtraArgs = @("-p:ContinuousIntegrationBuild=true")
    }
)

Push-Location $RepoRoot
try {
    foreach ($project in $projects) {
        Write-Host ""
        Write-Host "Running build verification: $($project.Name)" -ForegroundColor Cyan
        $args = @(
            "build",
            $project.Path,
            "-c", $Configuration,
            "--nologo",
            "--verbosity", "minimal"
        ) + $project.ExtraArgs

        if ($WarnAsError) {
            $args += "-warnaserror"
        }

        & dotnet @args
        if ($LASTEXITCODE -ne 0) {
            throw "Build verification failed for $($project.Name)"
        }
    }
}
finally {
    Pop-Location
}
