Set-Location Q:\repos\MidTermWorkspace2
.\scripts\release.ps1 -Bump patch -ReleaseTitle "Enable voice server in CSP for production" -ReleaseNotes @("Allow connections to MidTerm.Voice server (port 2010) in Content-Security-Policy for all environments, not just dev mode") -mthostUpdate no
