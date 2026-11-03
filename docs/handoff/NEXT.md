# Next: build and test the phone app on the build Mac

Tasks for the computer that has room for Xcode and Android Studio. Work on the
branch below, do the tasks in order, and report back as described at the end.
Background, decisions and the full step-by-step guide:
[`packages/mobile/BUILDING.md`](../../packages/mobile/BUILDING.md).

- **Branch:** `phone/app` (this file was added at the tip of it; the code to test is at or after commit `c1f835d3`).
- **Do not** push to `main`, merge, tag or release. Commit fixes on `phone/app` only.
- **Never commit** signing teams, `google-services.json`, keys, tokens or `.env` files.

## Task 1 — shared parts (no phone needed)

```bash
git fetch origin && git checkout phone/app && git pull
cd packages/relay && node --import tsx --test test/*.test.mjs
cd ../backend && node --import tsx --test test/phone-protocol.test.mjs test/phone-api.test.mjs test/phone-link-e2e.test.mjs
cd ../mobile/ios && swift run CoreChecks
```

Expected: relay 29 pass; the three backend phone files pass (24+ tests); `CoreChecks` ends with `301 passed, 0 failed`.

## Task 2 — iPhone build and device checks

```bash
brew install xcodegen      # once
cd packages/mobile/ios
xcodegen generate
open Girru.xcodeproj
```

1. Target `Girru` › Signing & Capabilities › choose your own team (do not commit it).
2. Build for an iPhone with iOS 17+ and a passcode. The SwiftUI screens were never compiled against the iOS SDK: fix compile errors with the smallest change, one commit per fix.
3. On the device, check and write down the result of each:
   - Face ID / passcode is asked on every open; the app switcher shows no content.
   - **Secure Enclave key:** first launch creates the identity key; it opens both for signing and for key agreement with the same public key. If pairing shows "This iPhone cannot finish pairing with its secure key", report it — do not weaken the key.
   - The app icon shows the Girru mark on white.
   - Screens: pairing (scan / waiting / 6 digits / code expired), approval full view, "Approve on your computer".
4. Pairing with a computer cannot finish yet: the phone's network connector is a stub (Task 4).

## Task 3 — Android build and tests

1. Android Studio › Open › `packages/mobile/android` (JDK 17, SDK 35).
2. Run the unit tests (they were written but never run):

   ```bash
   cd packages/mobile/android
   ./gradlew :app:testDebugUnitTest
   ```

   Fix failures with the smallest change. The vectors in `ReferenceVectorsTest` come from the computer's reference code: if a vector test fails, fix the Kotlin code, not the vector.
3. `./gradlew :app:assembleDebug`, install on an Android 12+ phone with a screen lock, and check:
   - The identity key is created with the agree-key purpose (StrongBox, or the TEE if StrongBox refuses).
   - The lock asks on every open; screenshots and the recent-apps preview are blocked.
   - The launcher icon shows the Girru mark on white; with themed icons on, it takes the theme colour.
   - Pairing and approval screens open.

## Task 4 — only after Tasks 1–3 report back

Build the phone network connector in both apps (WebSocket to `wss://relay.girru.net/v1`, signed hello, `g1.preq` → `g1.pchal` → `g1.pwel`, handshake, sealed commands and replies, live run frames). Follow `packages/relay/PROTOCOL.md` and copy the behaviour of the fake phone in `packages/backend/test/phone-link-e2e.test.mjs`. Then pair a real iPhone and a real Android phone with Girru on a computer. Wait for the owner's go before starting this task.

## How to report back

Add `docs/handoff/RESULT.md` on `phone/app` with, for each task: what ran, pass/fail counts, the device and OS version, every fix commit (hash + one line), screenshots of the icon and the pairing screens if possible, and anything that blocked you. Commit as the repository owner, push `phone/app`, and stop.

## Open questions (do not decide them; list anything new you find)

- May the "Only on this Wi-Fi" path listen on the home network address of the computer (today everything listens on 127.0.0.1 only)?
- An owner with two-step sign-in approving from the phone: phone biometric plus a computer receipt, or always on the computer (today: on the computer)?
- Should "Forget this phone" in the new-phone notice ask for confirmation (today: no)?
- Real App Store and Google Play links (today both point to `https://girru.dev/app`).
