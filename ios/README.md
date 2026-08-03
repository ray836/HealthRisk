# HealthRisk for iOS

The native app uses SwiftUI, URLSession, async/await, and the server's bearer-token API. The server remains authoritative: this target does not contain database access or gameplay validation.

## Open and run

From the repository root, open `ios/HealthRisk.xcodeproj` in Xcode 26.3 or newer. Opening the repository root itself shows a plain folder rather than the Xcode project editor.

- Debug and Release use `https://health-risk-ecru.vercel.app` by default, so either configuration works on a simulator or physical device.
- Override either configuration at launch with the `HEALTHRISK_API_BASE_URL` environment variable.
- For a local simulator API, set the override to `http://127.0.0.1:3000`. On a physical device, `127.0.0.1` is the phone itself; use a reachable HTTPS development host or the Mac's LAN address instead.

Start the local API from the repository root with `npm run serve`. Tokens are stored as a generic-password item in Keychain; they are never written to UserDefaults.

## Implemented native flows

- Login, signup, secure session restoration, and logout.
- My Games, multiplayer/practice creation, invite sharing, and link copying.
- Multiplayer waiting rooms with player status, health-goal review and selection, and creator-only editing of goal rewards and daily caps.

The server remains authoritative for lobby revisions and health-rule validation. Full board gameplay is not implemented in the native client yet.

## Apple identity and deferred capabilities

The project uses Apple Team `64P27T3SKW` and the permanent bundle ID `com.raygrant.healthrisk`. The explicit App ID is registered and allows HealthKit at the developer-account level. Automatic signing is selected. There is still no app entitlements file, so HealthKit, Push Notifications, and Associated Domains are not currently embedded in the app.

Before enabling push delivery, create an APNs token-signing key in the Apple Developer portal and record its Key ID. Download the `.p8` once and store its content only in Vercel's encrypted `APNS_PRIVATE_KEY` environment variable—never in this repository.

Remaining Apple setup sequence:

1. When implementing HealthKit, add only the HealthKit target entitlements and usage descriptions needed for workouts and step counts.
2. Enable Push Notifications on the App ID and add the Xcode Push Notifications capability.
3. Enable Associated Domains on the App ID and add `applinks:health-risk-ecru.vercel.app` to the Xcode target.
4. Set Vercel Production values: `PUBLIC_APP_URL=https://health-risk-ecru.vercel.app`, `APPLE_TEAM_ID`, `IOS_BUNDLE_ID`, `APNS_KEY_ID`, and `APNS_PRIVATE_KEY`.
5. Redeploy and verify `/api/meta` reports `apnsConfigured: true` and the Apple association file lists `<TEAM_ID>.<BUNDLE_ID>`.

Push notifications and universal-link entitlements stay disabled until these values are final.
