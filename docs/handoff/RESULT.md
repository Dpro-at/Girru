# Result: build and test the phone app on the build Mac

Answers [`NEXT.md`](NEXT.md). Tested at commit `1ef8893d` on `phone/app`
(3 November 2026). **No code fixes were needed: no fix commits.** Task 4 was
not started (it waits for the owner's go).

## Build Mac

| Tool | Version |
|---|---|
| macOS | 26.6.2 (25G83), Apple Silicon |
| Xcode | 27.2 (27B52), iOS 27.2 SDK |
| iOS Simulator runtime | iOS 27.2 (24B8117), device iPhone 18 Pro |
| XcodeGen | 2.46.0 |
| Swift (Command Line Tools, for `CoreChecks`) | 6.1.2 |
| Android Studio | 2026.2.2 (Rabbit 2) |
| JDK | OpenJDK 17.0.21 (Homebrew `openjdk@17`) |
| Android SDK | Platform 35 (downloaded by Gradle), Build-Tools 34.0.0 and 36.0.0 |
| Gradle | wrapper 8.9 (made with Homebrew Gradle 9.8.2, not committed) |
| Node.js | 24.22.2 (Homebrew `node@24`) |

## Task 1: shared parts

| Check | Result | Expected |
|---|---|---|
| `packages/relay`: `node --import tsx --test test/*.test.mjs` | **29 pass, 0 fail** | 29 |
| `packages/backend`: `phone-protocol`, `phone-api`, `phone-link-e2e` | **33 pass, 0 fail** | 24+ |
| `packages/mobile/ios`: `swift run CoreChecks` | **301 passed, 0 failed** | 301 |

## Task 2: iPhone

- `xcodegen generate` made `Girru.xcodeproj`; it stays untracked.
- **Simulator build** (`-sdk iphonesimulator`): **BUILD SUCCEEDED**, no compile errors.
- **Device build** (`-sdk iphoneos`, `CODE_SIGNING_ALLOWED=NO`): **BUILD SUCCEEDED**, no compile errors.
- Warnings: two from Xcode's `appintentsmetadataprocessor` (no AppIntents, harmless) and one on the device build: *"All interface orientations must be supported unless the app requires full screen."* Left as is (see open questions).

Checked on the iPhone 18 Pro simulator (iOS 27.2), app signed ad hoc for the simulator:

| Check | Result |
|---|---|
| Lock on open: content hidden, lock shown, passcode / Face ID asked | ✅ ([lock](result/ios-lock.png), [Face ID](result/ios-face-id.png)) |
| Face ID enrolled in the simulator, matching face unlocks the app | ✅ |
| Pairing screen: "Pair with your computer", Scan the code, Type the code instead | ✅ ([pairing](result/ios-pairing.png)) |
| "Type the code" sheet opens with the `ABCD-EFGH-JKMN` field | ✅ ([type the code](result/ios-type-code.png)) |
| App icon: Girru mark on white | ✅ ([icon](result/ios-home-icon.png)) |

**Not checked yet. These need a real iPhone with signing (no device was connected):**
- **Secure Enclave key.** The simulator has no Secure Enclave, so the most important check (one key opens for signing and key agreement with the same public key) is still open.
- The app switcher shows no content.
- The waiting, 6-digit, code-expired and approval full-view screens. Reaching them needs a scanned code, and so the connector (Task 4).

## Task 3: Android

| Check | Result |
|---|---|
| `./gradlew :app:testDebugUnitTest` (first run ever) | **85 pass, 0 fail, 0 skipped** in 14 classes |
| `ReferenceVectorsTest` | **6 / 6 pass** (no vector changed) |
| `./gradlew :app:assembleDebug` | **BUILD SUCCESSFUL**, `app-debug.apk` 9.5 MB |

Per class: FlatJson 3, ReferenceVectors 6, ReplayWindow 3, G1 5, Session 5,
LockPolicy 10, PairingLifetime 6, PairedComputer 4, PairingPayload 9,
PhoneProtocol 10, Notice 4, PairingVectors 11, PairingMessages 6, Web 3.

**Not checked yet. These need a real Android 12+ phone (none was connected):** the
identity key's agree-key purpose (StrongBox / TEE), the lock on every open,
blocked screenshots and recent-apps preview, the launcher icon (and themed
icon), and the pairing and approval screens on the device.

## What blocked or slowed the run (no code changed)

- **The relay tests do not find `tsx` on their own.** `packages/relay/package.json` has no `tsx` devDependency. The tests (`--import tsx` and `import.meta.resolve('tsx')` in `no-content-written.test.mjs`) only work when `tsx` comes from the root `node_modules`. Here I put it in place with `npm install --no-save tsx@^4.21.0` in `packages/relay`. Suggestion: add `tsx` to the relay's devDependencies.
- **The root `npm install` fails** with `ERESOLVE`: `@readyplayerme/visage@6.16.0` wants peer `@react-three/drei@9.108.4`, and the root has `10.7.9`. This has nothing to do with the phone work, but the guide says to install the root.
- The Mac's Homebrew Node 25.6.1 was broken (it links `libsimdjson.29`, but Homebrew has moved to simdjson 5). I used `node@24`, as the guide asks.
- **The Android SDK installed by Android Studio was Platform 37 only.** Gradle downloaded Platform 35 itself once the licenses were accepted.

## Open questions (new ones only; the four in NEXT.md still stand)

- The iPhone device build warns that all interface orientations must be supported unless the app requires full screen. Should the app set `UIRequiresFullScreen`, or support all orientations?
