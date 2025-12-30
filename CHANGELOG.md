# Changelog

## [1.3.6] - 2025-12-30

- Add settings migration on update (backup to .old, migrate user preferences)
- Install scripts now preserve user preferences across updates

## [1.3.5] - 2025-12-30

- Fix embedded static files not loading (wrong namespace for resource lookup)

## [1.3.4] - 2025-12-30

- Add application icon to Windows executable

## [1.3.3] - 2025-12-30

- Fix release artifact double-zipping (raw binaries now packaged in release job)

## [1.3.2] - 2025-12-30

- Fix cross-platform build (conditional compilation for Windows Service)

## [1.3.1] - 2025-12-30

- Fix Windows Service not starting (add UseWindowsService hosting)

## [1.3.0] - 2025-12-30

- Add terminal user de-elevation for service mode
- Terminals now spawn as the installing user instead of SYSTEM/root
- Add user picker in Settings UI under Security section
- Install scripts capture user identity before elevation
- Windows: Uses CreateProcessAsUser with WTSQueryUserToken
- Unix: Uses sudo -u wrapper when running as root
- Add /api/users endpoint for user enumeration

## [1.2.1] - 2025-12-30

- Improve install scripts with clearer service vs user install choice
- Update README with balanced explanation of install options

## [1.2.0] - 2025-12-30

- Add system service installation (launchd, systemd, Windows Service)
- Add auto-update from GitHub releases with UI notification
- Add one-liner install scripts for all platforms
- Add --check-update and --update CLI commands
- Add /api/update/check and /api/update/apply endpoints
- Add app icon to README

## [1.1.0] - 2025-12-30

- Add GitHub Actions release workflow and docs update
- readme update
- initial commit
