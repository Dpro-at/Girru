# Building and testing the Girru phone app

This branch (`phone/app`) holds everything for the Girru phone app: the
computer side, the relay and the two phone apps. This page is for the computer
that builds and tests the phone apps (it needs Xcode and Android Studio). Read
it top to bottom once; each part says what is done, what is not, and how to
check it.

## What is in this branch

| Part | Folder | State |
|---|---|---|
| Relay (stateless pass-through, stores nothing) | `packages/relay` | Done. 29 tests. Deployed at `wss://relay.girru.net/v1`. Protocol and threat model: `packages/relay/PROTOCOL.md`. |
| Computer side of the link | `packages/backend/src/phone` | Done. Pairing with a QR code that renews every 2 minutes, 6-digit check code bound to a computer challenge, Allow / Don't allow, forget one / forget all, relay connection, signed phone commands (chats, send + live reply, stop, approvals with full view, tasks, schedules, team). 72 tests. See `packages/backend/src/phone/README.md`. |
| Pairing screens on the computer | `packages/core-ui/src/Phone*.tsx`, `phone.ts`, `qr-code.ts` | Done. Last setup step "Girru on your phone", the phone button next to your name in the sidebar, Settings › Phone, the Allow dialog, the new-phone notice. Own QR encoder (no library). |
| iPhone app | `packages/mobile/ios` | Builds for the simulator and the device (build Mac). Pairing over the relay works on the simulator. After pairing: four places (Chat is the computer's chat page through the session; Tasks, Approvals, Team are the app's own screens). Core checks: `swift run CoreChecks` 359. **Not run on a real iPhone yet.** |
| Android app | `packages/mobile/android` | Pairing over the relay works (build Mac). The session, the four places and the chat page through the session are written; **the newest code is not compiled yet** (no Android tools on the computer that wrote it). |

Both apps pair through the relay. Only the chat is the computer's own page
on the phone (`ui.get`, `api.call`, `api.stream`, PROTOCOL.md); every other
phone screen is the app's own. The "Only on this Wi-Fi" path is not built in
the apps yet. What to test now: `docs/handoff/NEXT.md`.

## Decisions already made

- App name **Girru**; app id **`dev.girru.app`** on both platforms (cannot change after store release). Android debug build: `dev.girru.app.debug`.
- App icon: the Girru mark on white, same as the desktop icon.
- iPhone: iOS 17 or newer. Android: **Android 12 or newer** (`minSdk` 31), because pairing needs Keystore ECDH and the phone's private key never leaves the Keystore.
- App lock is required on every open (Face ID / Touch ID / fingerprint, passcode fallback) and cannot be turned off.
- Pairing: scan once, stay paired 30 / 60 / 90 / 120 days after last use, or never. The QR code renews every 2 minutes and works for one phone. The owner compares 6 digits and chooses Allow on the computer.
- Two paths: **Anywhere** (through the relay, end-to-end encrypted, the relay keeps nothing) and **Only on this Wi-Fi** (never through the relay). The Wi-Fi listener on the computer is built but **off**; turning it on is an open decision.
- Relay address: `wss://relay.girru.net/v1` (changeable in Settings › Phone › ⋯ › Use your own relay).
- Notifications never flood; push needs Firebase (Android) and an APNs key (iPhone). Keys go on the relay server only, never in the repository or in chat.

## Tools to install (exact versions)

| Tool | Version | Why |
|---|---|---|
| macOS | 14 (Sonoma) or newer | Xcode 16 needs it |
| Xcode | 16 or newer, with the iOS 17+ SDK | builds the iPhone app (deployment target iOS 17.0, Swift 5) |
| XcodeGen | current (`brew install xcodegen`) | generates `Girru.xcodeproj` from `ios/project.yml` (the project is not committed) |
| Android Studio | Ladybug (2024.2) or newer | supports Android Gradle Plugin 8.7 |
| JDK | 17 (the one bundled with Android Studio is fine) | `sourceCompatibility` / `jvmTarget` 17 |
| Android SDK | Platform 35 (compile and target SDK 35), Build-Tools 35 | `compileSdk = 35`, `targetSdk = 35`, `minSdk = 31` |
| Gradle | 8.9 or newer (wrapper made once, see below) | Android Gradle Plugin 8.7.3 needs it |
| Node.js | 24, with npm | the computer side, the relay and the tests |
| Homebrew | current | to install XcodeGen (and Gradle if you make the wrapper from the command line) |

Android libraries are pinned in `android/gradle/libs.versions.toml` and come
from Google Maven / Maven Central when Gradle syncs (nothing to install by
hand): Android Gradle Plugin 8.7.3, Kotlin 2.0.21, AndroidX core-ktx 1.13.1,
appcompat 1.7.0, activity-ktx 1.9.3, webkit 1.12.1, biometric 1.1.0,
Firebase BoM 33.7.0 (messaging), Google Services plugin 4.4.2, JUnit 4.13.2.
The iPhone app uses Apple frameworks only (no CocoaPods, no outside Swift
packages).

Test phones: an **iPhone with iOS 17 or newer** and an **Android phone with
Android 12 (API 31) or newer**, each with a screen lock (passcode / PIN) and,
ideally, Face ID / Touch ID or a fingerprint.

## Get the code

```bash
git clone https://github.com/Dpro-at/Girru.git
cd Girru
git checkout phone/app
```

Install the JavaScript packages the usual way for this repository (root,
`packages/backend` and `packages/core-ui`).

## 1. Check the shared parts first (no phone needed)

```bash
cd packages/relay && node --import tsx --test test/*.test.mjs        # 29 pass
cd ../backend && node --import tsx --test test/phone-protocol.test.mjs test/phone-api.test.mjs test/phone-link-e2e.test.mjs   # phone link
cd ../mobile/ios && swift run CoreChecks                              # 301 pass
```

`phone-link-e2e` starts a relay on 127.0.0.1 and a fake phone made from the
reference code: scan → request → challenge → Allow → welcome → signed
commands. It is the best description of what a real phone must do.

## 2. iPhone

```bash
cd packages/mobile/ios
xcodegen generate
open Girru.xcodeproj
```

1. In Xcode select the `Girru` target › Signing & Capabilities › choose your team (never commit `DEVELOPMENT_TEAM`).
2. Pick your iPhone and press Run. Expect small compile fixes the first time: the SwiftUI screens were reviewed but never compiled against the iOS SDK.
3. Check on the device (details in `ios/README.md`):
   - The app asks for Face ID / passcode on every open; content is hidden in the app switcher.
   - The identity key is created in the Secure Enclave and opens both for signing and for key agreement with the same public key (pairing refuses with a clear message if not). **This is the most important thing to confirm on a real iPhone.**
   - Pairing screens: scan, "Connecting…", the 6 digits, code expired, "Finish pairing".
   - Approval full-view sheet and "Approve on your computer".

## 3. Android

1. Android Studio › Open › `packages/mobile/android`. The Gradle wrapper is not committed (it holds a binary jar): make it once with Gradle 8.9+ installed (`brew install gradle`), from `packages/mobile/android`:

   ```bash
   gradle wrapper --gradle-version 8.9
   ```

   (or let Android Studio offer to create it). Do not commit `gradlew`, `gradlew.bat` or `gradle/wrapper/`.
2. Without `app/google-services.json` the app builds and runs without push (the file is git-ignored; it comes from the Firebase project later).
3. Run the unit tests: `./gradlew :app:testDebugUnitTest` (byte-exact vectors from the computer's reference code). They have never run: fix what fails.
4. `./gradlew :app:assembleDebug` and install on an Android 12+ phone with a screen lock.
5. Check on the device (details in `android/README.md`): the identity key has the agree-key purpose (StrongBox, or the TEE when StrongBox refuses), the lock fails closed, screenshots are blocked, the pairing and approval screens.

## 4. The computer side

Run Girru from this branch with a test data folder (never your real data), as
the owner. Then:

- Setup ends with "Girru on your phone"; Skip works; the phone button next to your name opens the QR; Settings › Phone lists phones.
- The phone link only runs when the backend's background work is on; with it off (test setups) the screens work but no relay connection is made.
- The QR text is a `girru://pair?...` link; scanning it on a phone needs the phone connector (below).

## Next tasks (in order)

1. **Phone connector, both apps.** WebSocket to the relay (signed hello bound to the relay address), and later the same-Wi-Fi path; send `g1.preq`, receive `g1.pchal` and `g1.pwel`, handshake, sealed commands and replies, live `run` frames. Follow `PROTOCOL.md` and copy the behaviour of the fake phone in `packages/backend/test/phone-link-e2e.test.mjs`.
2. **First real pairing:** iPhone ⇄ computer through `relay.girru.net`, then Android.
3. **Phone screens with the shared chat:** the phone app hosts the same chat screens as the desktop (approved phone design boards P1–P23).
4. **Push notifications:** Firebase project (Android), APNs key (iPhone), relay sends encrypted notices; calm rules (no flood).
5. **Store accounts and listing:** Apple Developer, Google Play Console, privacy policy page on girru.dev.

## Open questions for the owner

- May the "Only on this Wi-Fi" listener listen on the home network address (today every service listens on 127.0.0.1 only)?
- A 2FA owner approving from the phone: phone biometric plus a receipt from the computer, or always on the computer? (Today: always on the computer.)
- Should "Forget this phone" in the new-phone notice ask for confirmation? (Today: acts at once.)
- Real App Store and Google Play links (today both point to `https://girru.dev/app`).

## Where to read more

- `packages/relay/PROTOCOL.md` — protocol, threat model, every message.
- `packages/backend/src/phone/README.md` — the computer side.
- `packages/mobile/ios/README.md`, `packages/mobile/android/README.md` — each app, with a device checklist.
