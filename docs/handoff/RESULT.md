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
- **Pairing with a typed code (owner's request).** The owner wants pairing to work by typing the code, not only by scanning. Today "Type the code instead" only checks the code's form. `PROTOCOL.md` has no typed-code exchange, and a 12-character code cannot carry the computer's key. This needs a protocol addition (for example, the code finds the computer's offer on the relay and the 6-digit check binds it) before both apps and the computer can build it. It should be designed with Task 4.
- **Store review access.** Apple App Review and Google Play review must be able to sign in and use the app, but the app only works paired to a computer the owner approves. What do the reviewers get: a review computer kept online with a typed code in the review notes, a demo mode, or a video plus notes? Decide before the store listing (BUILDING.md › Next tasks 5).

## Task 4: phone connector (started on the owner's go, 3 November 2026)

**Done: pairing over the relay, in both apps, tested against the real computer.**

| Part | iPhone | Android |
|---|---|---|
| Relay connection: challenge, hello signed by the identity key and bound to the QR code's relay, allow list with the computer only | `GirruCore/RelayClient.swift` (`URLSessionWebSocketTask`) | `link/RelayPairingClient.kt` (OkHttp) |
| `g1.preq` to the pairing id, `g1.pchal` and `g1.pwel` back to the phone | `GirruCore/RelayPairingLink.swift`, used by `PairingFlow` instead of the stub | `RelayPairingClient`, used by `GirruApplication` instead of `NotConnectedYet` |
| Hello rules (wrong relay refused, 32-byte nonce, signature) | `CoreChecks`: **309 passed** (8 new) | `RelayFramesTest`: **4 pass**; all unit tests **90 pass** |
| **End to end** with the backend's real phone link, through a TLS relay on 127.0.0.1 | `PairCheck`: **PASS**, the same check code on both sides, welcome checked, phone listed | `PairCheckTest`: **PASS**, same |

How to run the end-to-end checks (from `packages/backend`):

```bash
node --import tsx ../mobile/tools/pair-harness.mjs ../mobile/ios/.build/debug/PairCheck
node --import tsx ../mobile/tools/pair-harness.mjs ../mobile/tools/android-pair-check.sh
```

Build `PairCheck` first (`swift build --product PairCheck` in `packages/mobile/ios`)
and the Android test classes once (`./gradlew :app:testDebugUnitTest`).

- **New Android dependency: OkHttp 4.12.0** (Android has no WebSocket client of
  its own). It is pinned in `gradle/libs.versions.toml`. The iPhone still uses
  Apple frameworks only.
- Both apps still build: iPhone for the simulator and the device, Android `assembleDebug`.
- **Not done yet:** the "Only on this Wi-Fi" path (the code says so plainly),
  the session (hs1/hs2), signed commands and replies, live run frames, and
  pairing on a real phone with the real Girru app on a computer.
- The owner's feature requests (microphone, photos, files, share into Girru,
  quick actions, widget) and the typed-code proposal are in
  [`PHONE_FEATURES.md`](PHONE_FEATURES.md).

## Test round: Task 5 (3 November 2026, evening)

Tested `phone/app` at `a4e8f71a` on the build Mac (macOS 26.6.2, Xcode 27.2,
iPhone 18 Pro simulator with iOS 27.2, Node 24.22.2, JDK 17). This Mac did
testing only. The one code fix is a test-file escape, listed below.

### Test 1: shared checks

| Check | Result | Expected |
|---|---|---|
| relay | **29 pass** | 29 |
| backend `test/phone-*.test.mjs` | **43 pass** | 42 |
| core-ui `tests/phone-shell.test.cjs` | **3 pass** (after `npm ci` in core-ui) | 3 |
| `swift run CoreChecks` | **366 passed, 0 failed** | 359 |

### Test 2: builds

- iPhone simulator build: **BUILD SUCCEEDED**, no fixes needed.
- Android: `PageBridgeTest.kt:91` did not compile. The expected text had real
  line breaks and bare quotes where `\n` and `\"` were meant. I restored the
  escapes; the expected value is the same. Fix: `930177de` "Escape the expected
  event text in PageBridgeTest so the Android tests compile". After it:
  **100 unit tests pass** (new: PageBridgeTest 7, PhoneScreensTest 3), and `assembleDebug` builds.

### Test 3: the simulator through `wss://relay.girru.net/v1`

Pairing always worked (the same check code on both screens, every time).
The rest of this round ran against `pair-harness.mjs --manual`, which is
**not the full app**. The owner then had me start the real desktop app
(`packages/desktop`, `npm start`, `AGENT_TERMINAL=true`), but pairing with it
did not finish before the session ended. **Redo Test 3 against the real app.**

**Findings (in order of importance):**

1. **Page files over about 600 KiB never reach the phone. The chat page stays
   blank.** `ui-bridge.ts` sends 600 KiB parts (`UI_PART_BYTES`). In a part,
   the base64 inside the JSON is about 800 KiB, and after sealing and the
   envelope's own base64 it is **about 1,067 KiB**. That is over the relay's
   1 MiB envelope limit, so the relay refuses it. The phone logs
   `RelayError error 5` (refused). The computer's own size check
   (`service.ts` `reply()`, `MAX_ENVELOPE - 4096`) measures the JSON before
   sealing (800 KiB), so it does not catch this. The chat page's
   `index-*.js` is 2.5 MB and `index-*.css` 668 KB. With a local, uncommitted
   `UI_PART_BYTES = 512 * 1024` (envelope about 910 KiB) the page loaded.
   **Fix on the main computer:** a part size that fits after both base64 steps,
   and the size check on the sealed envelope.
2. **The chat page loads signed in and the chat works, but the layout does not
   fit the phone.** On the 402 pt screen the desktop side panel (Details /
   Changes / Files) fills the view and the chat column is off screen. A
   message sent from the page reached the computer, and the reply came back
   (`user: Hi from the phone simulator`, `assistant: Hello from the computer`
   in `chat_messages`). As NEXT.md says, the owner makes the pages responsive.
3. **The page asks for routes the phone list refuses**, and keeps asking:
   `GET /api/approvals?status=pending&limit=100` → 403, `GET /api/health` → 403.
   Either the page must not ask for them on the phone, or the list needs them.
4. **The terminal cannot start on a Mac after `npm ci`.** node-pty 1.1.0's
   `prebuilds/darwin-*/spawn-helper` is installed without execute permission,
   so `POST /api/terminal/sessions` answers 500 (`posix_spawnp failed`). With a
   local `chmod +x` it started ("zsh on your computer"). The installer or a
   postinstall step must set it, or every Mac install has no terminal.
5. **The terminal then lost its connection on the first command** (`echo hi;
   date`): "Lost the connection to the terminal. Start again". Not traced;
   it was on the harness, so check it on the real app.
6. **The keyboard's toolbar (⌃ ⌄ ✓) stays on top of the lock screen** when the
   app re-locks while the terminal keyboard is up.
7. My harness gap, fixed here: `pair-harness.mjs` did not call
   `bindPhoneApi(app)` as `server.ts` does, so every `api.call` answered
   `ui_unavailable` (503) and the page showed "Sign in · engine not answering".
   Fixed in the commit with this report.

**What worked as designed:** the bottom bar with Chat / Tasks / Approvals /
Team after pairing; Tasks (Now / Scheduled / Done, empty state, terminal
button, plus button); the terminal asks Face ID first; its slim header and
the key row (Paste, ^C, ^D, Esc, Tab, Ctrl, arrows) above a lowercase keyboard.

**Not tested yet:** Approvals, Team, dark mode, locking during use, the
paste check, ^C on `sleep 30`, the Android app on an emulator, and all of
Test 3 on the real desktop app.

### Notes for the next test round

- Start the real app from source: build core-ui with
  `node scripts/build.cjs --candidate --live-entry`, then run `npm ci` in
  `packages/desktop`. npm blocks install scripts, so run
  `node node_modules/electron/install.js` once. Then start it:
  `DPRO_DESKTOP_NODE=/opt/homebrew/opt/node@24/bin/node AGENT_TERMINAL=true npm start`.
- The simulator has no camera. Read the computer's QR from a screenshot
  (`screencapture`, then `zbarimg` on the QR area) and pass it with
  `-GirruPairLink`. A code lasts 2 minutes, so launch straight away.
- Inspect the phone's web view with `ios_webkit_debug_proxy` on the
  simulator's `webinspectord_sim.socket` (the view is inspectable in debug).
