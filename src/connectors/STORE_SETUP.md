# tlbx mobile app: manual store handoff

The source is ready for the manual signing and store-account steps below. The native app is a connection manager for multiple user-configured tlbx instances. It keeps the selected WebView and browser session in memory while the operating system permits, performs best-effort background health refreshes, and reconnects the page when the app returns to the foreground.

## Fixed application identity

- Store name: `tlbx`
- Android application ID: `ai.tlbx.midterm`
- Apple bundle ID: `ai.tlbx.midterm`
- Version: `1.0.0`
- Minimum Android: API 26 (Android 8)
- Android target/compile SDK: API 36 (Android 16)
- Minimum Apple OS: iOS/iPadOS 16

The `midterm` suffix is a retained technical identifier. It is not user-visible. Do not create a second store record with another identifier after signing or publication starts.

## What the app does natively

- saves, edits, removes, and switches between multiple tlbx instances;
- opens the last-used instance automatically after initial setup;
- isolates in-app navigation to the configured HTTPS origin and opens external links in the system browser;
- allows private/self-signed TLS only after an explicit per-instance opt-in;
- retains WebView cookies and local storage on the device;
- requests a periodic network health refresh and actively reconnects the page on foreground return;
- collects no analytics, advertising identifier, contacts, location, photos, or other native personal data.

Background execution is always best-effort. Android schedules periodic work no more often than every 15 minutes. iOS chooses whether and when to grant `BGAppRefreshTask` time. Neither store platform permits an ordinary WebView app to promise permanent background execution.

## Google Play: manual path

### 1. Create the app record

1. In Play Console, create an app named `tlbx` with default language English.
2. Use package name `ai.tlbx.midterm`.
3. Enable Play App Signing. Keep the upload key described below separate from Google's app-signing key.

New submissions after 31 August 2026 must target API 36. The project already does.

### 2. Generate and back up the upload key

Run once in a private directory outside the repository:

```powershell
keytool -genkeypair -v -keystore tlbx-upload.jks -keyalg RSA -keysize 4096 -validity 10000 -alias upload -dname "CN=tlbx, O=tlbx.ai, C=DE"
```

Back up the keystore and both passwords in the password manager. Never commit the keystore.

### 3. Build the signed Android artifacts

From `src/connectors/android`:

```powershell
$env:ANDROID_HOME = 'C:\Program Files (x86)\Android\android-sdk'
$env:KEYSTORE_PATH = 'C:\private\tlbx-upload.jks'
$env:KEYSTORE_PASSWORD = '<keystore password>'
$env:KEY_ALIAS = 'upload'
$env:KEY_PASSWORD = '<key password>'
.\gradlew.bat clean assembleRelease bundleRelease --no-daemon
```

Outputs:

- Play upload: `app/build/outputs/bundle/release/app-release.aab`
- Direct test install: `app/build/outputs/apk/release/app-release.apk`

Upload the AAB to Internal testing first. Add at least one tester, install from the Play-generated link, and verify initial setup, instance switching, login persistence, external links, background/foreground return, rotation, and the software keyboard.

### 4. Complete Play Console declarations

- App category: Tools
- Ads: No
- Target audience: adults/general productivity; do not target children
- Data safety: the native layer has no analytics or ad SDK and stores instance addresses locally. It transmits WebView traffic only to the instance selected by the user. Recheck the declaration against the actual tlbx server features and privacy policy before submitting.
- App access: provide a reachable review instance and test credentials in the review instructions. A reviewer cannot validate a blank user-supplied URL without them.
- Add the privacy-policy URL, support URL, screenshots, 512x512 icon, feature graphic, short description, full description, and content rating.

## Apple App Store: manual path

Apple has required uploads to use Xcode 26 and the iOS 26 SDK since 28 April 2026.

### 1. Register identity and signing

1. In Certificates, Identifiers & Profiles, register explicit App ID `ai.tlbx.midterm` with display name `tlbx`.
2. Open `src/connectors/ios/MidTermConnector.xcodeproj` in Xcode 26 or newer.
3. Select the `MidTermConnector` target, then Signing & Capabilities.
4. Select team `FK7G5C74WH` if it is still the correct developer team. Keep Automatically manage signing enabled for the shortest path.
5. For manual signing instead, create an Apple Distribution certificate and an App Store distribution profile for `ai.tlbx.midterm`, install both on the Mac, disable automatic signing for Release, and select that profile.

The project already contains the Background fetch mode, the permitted refresh-task identifier, the local-network usage description, and `PrivacyInfo.xcprivacy` for its local preferences access.

### 2. Archive and upload

1. Select `Any iOS Device (arm64)`.
2. Product -> Archive.
3. In Organizer, run Validate App.
4. Choose Distribute App -> App Store Connect -> Upload.
5. Resolve signing, entitlement, privacy-manifest, or validation errors before continuing.

### 3. Complete App Store Connect

- Name: `tlbx`
- Subtitle: `Your tlbx connections`
- Category: Developer Tools or Productivity
- Privacy: the native layer does not track and declares no collected data. Recheck this against the reachable tlbx instance and published privacy policy.
- Export compliance: answer for the standard HTTPS encryption used by WebKit; complete App Store Connect's current questionnaire rather than copying an old answer.
- EU distribution: complete the current DSA trader-status fields before submission.
- Age rating: complete the current questionnaire.
- App Review information: provide a reachable review instance, test credentials, and the notes below.

Suggested review note:

> tlbx is a native connection manager for user-owned tlbx terminal workspaces. The native UI stores and switches multiple HTTPS instances, constrains embedded navigation to the selected origin, manages private-certificate opt-in, preserves the authenticated WebView session, performs best-effort background health refresh, and reconnects on foreground return. Review URL and credentials are provided in App Review Information.

This native connection-management value is important for App Review guideline 4.2; do not describe the product as only a website wrapper.

## Store assets still requiring real devices

Capture final screenshots only after the signed builds run on a representative Android phone, iPhone, and iPad. Show:

1. the native multi-instance connection manager;
2. a connected tlbx terminal;
3. switching between two tlbx instances;
4. return from background with the session restored.

Do not submit placeholder servers, dead URLs, or fabricated review credentials.

## Optional CI automation later

The existing Android and iOS release workflows can automate signed uploads after the manual store records work. They require the keystore/certificate/profile and store API secrets. CI setup is optional and is not a prerequisite for the first manual archive/upload.
