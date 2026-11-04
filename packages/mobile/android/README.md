# Girru for Android (app shell)

The Android phone app for Girru. It is a small native Kotlin shell. The
screens are the same core-ui screens as on the computer, shown in a locked-down
web view. The native code owns the parts a web page must not do: the app lock,
the keys, pairing, notifications and the connection to your computer.

> **Status: unverified until built.** This source has not been compiled or run
> yet. It was written without an Android SDK and will first be built and
> tested on another machine. Expect small build fixes on the first build.
> Nothing here is released.

Protocol: [`packages/relay/PROTOCOL.md`](../../relay/PROTOCOL.md), suite **g1**
(ECDSA P-256, ECDH P-256, HKDF-SHA-256, AES-256-GCM).

## What it does

- **App lock, always on.** Every launch, and every return after a short time
  in the background, asks for a fingerprint, face or the phone's passcode
  (`BiometricPrompt`). The owner can shorten the re-lock time (immediately,
  15 s, 30 s, 60 s) but can never turn the lock off. App content is hidden in
  recent apps and from screenshots (`FLAG_SECURE`). A phone with no screen
  lock cannot use Girru: the app asks you to set one. The lock fails closed:
  leaving the app always starts the re-lock timer, even while a prompt is
  open; a fresh check before a sensitive action that is cancelled, fails, or
  during which the app was stopped locks the app (with the passcode instead of
  a fingerprint this means unlocking again afterwards); a prompt that vanishes
  without an answer locks too.
- **Scan once, stay paired.** You pair once with the code from Settings ›
  Phone on your computer. The code there renews every 2 minutes; a code that
  ran out before you sent it asks you to scan the new one. After sending, the
  phone shows the 6-digit check code only once the computer's signed check
  challenge arrived, and waits up to 10 minutes for Approve. You choose how long the pairing lasts without use:
  30, 60, 90 or 120 days, or never expires (with a warning). Every use renews
  it. Your computer has the final say and can remove the phone at any time;
  the app then shows the pairing screen with a short reason.
- **Keys stay on the phone.** The identity key is an Android Keystore key
  (StrongBox when the phone has it), never exportable, usable only for 30 s
  after you unlock. It signs and, once per pairing, does ECDH to unwrap the
  notification key from the welcome. Keystore ECDH needs Android 12 (API 31),
  so the app needs Android 12 or newer (`minSdk` 31). The pairing record, counters and notification key are kept
  in a file encrypted with a second Keystore key, in no-backup storage; app
  backup and device transfer are off.
- **Your computer's screens, safely.** The web view only shows pages from one
  virtual origin, `https://computer.girru.invalid`, and every request to it is
  answered by the app from the end-to-end session; nothing of the page travels
  over the network in clear. Other origins, plain http, file and content
  access, pop-ups, permission prompts and TLS errors are refused; external
  links open in your browser.
- **Notifications you can trust.** Pushes are data-only `g1.ntf` notices. The
  app checks the computer's signature, the addresses, the time, decrypts them
  on the phone, checks the content and the replay counter, and only then shows
  the real text. A notice that fails shows only a neutral line. Approve and
  Deny ask for your unlock and act only on approvals that arrived in a verified
  notice.

## Layout

```
packages/mobile/android/
  settings.gradle.kts, build.gradle.kts, gradle.properties, gradle/libs.versions.toml
  app/build.gradle.kts, app/proguard-rules.pro
  app/src/main/AndroidManifest.xml
  app/src/main/java/dev/girru/app/
    GirruApplication.kt        process-wide state (lock, store, keys, connector stubs)
    MainActivity.kt            the one window: unlock → pair → web host
    ConfirmActionActivity.kt   Approve / Deny from a notification
    crypto/   G1.kt, G1Session.kt, SignedCommand.kt, ReplayWindow.kt, FlatJson.kt   (pure Kotlin)
              PairingCrypto.kt (interface), KeystorePairingCrypto.kt (Android Keystore)
    pairing/  PairingPayload.kt, PairingMessages.kt, PairedComputer.kt, PairingLifetime.kt  (pure)
              PairingRepository.kt, QrScanner.kt
    push/     Notice.kt, ApprovalDecision.kt (pure); GirruMessagingService.kt, Notifier.kt, PushSetup.kt
    web/      WebOrigin.kt, BridgeCall.kt (pure); WebHost.kt, NativeBridge.kt
    lock/     LockPolicy.kt (pure); Authenticator.kt
    storage/  SecureStore.kt
    link/     Link.kt  — interfaces to the connector (MOB-LINK-01), with "not connected yet" stubs
  app/src/test/java/…          JUnit tests for the pure parts
```

"Pure" files import nothing from Android, so the protocol, pairing, lifetime,
lock and bridge rules run in plain JVM unit tests.

## What follows PROTOCOL.md, and what is still open

Implemented as written in PROTOCOL.md: the QR code URI (`v, cid, ck, pid,
ps, exp, relay, lan, name`; `pid` is `p_` + 43 base64url; `relay` exactly
`wss://<host>/v1`, kept as written for comparison with the relay's
challenge), the pairing key (HKDF salt = the full `pid` text), `g1.preq`
(including the phone's `sig` over `"girru/v1/preq-sig\n" + pid + "\n" +
deviceId + "\n" + nonce`), the check challenge `g1.pchal` and the check code
that mixes it in (no code before a verified challenge), `g1.pwel` with the
wrapped 60-byte notification key (ECDH of the identity keys, HKDF with the
pairing key as salt, AES-256-GCM), the session handshake (`hs1`/`hs2`: a
fresh hello for every attempt, each pending handshake used once) and
`g1.msg` envelopes, signed commands, `g1.ntf` notices with the 64-wide replay
window, and the pairing lifetime rules.

Inside a session (`link/PhoneProtocol.kt`, `link/ApprovalReview.kt`): the
v1 command bodies (keys sorted), the computer's `reply`, `run`, `run.end` and
`approval.pending` frames, and what each refusal means for the owner. Approve
never signs blind: the phone fetches the approval from `approval.pending`,
fetches `approval.detail` when the preview was cut short, shows the
parameters, asks for a fresh unlock and signs `approval.decide` with the
`paramsHash` of what it showed. `full_view_required`, `full_view_unavailable`,
`too_large` and `verification_required` send the owner to the computer. A run
that ends `dropped` / `slow_link` (or `unknown`, or with a frame too large to
send) is read again with `chat.messages`; `internal_error` asks to try again.

The JVM tests check all of this against byte-exact vectors made by the
computer's reference code (`app/src/test/.../crypto/ReferenceVectors.kt`):
pairing key, `g1.pchal`, the check code, the wrapped notification key,
`g1.pwel`, a full handshake with envelopes both ways, a notice and a signed
`approval.decide`.

Still open, to align with the computer side:

- **FCM data key.** The app reads the `g1.ntf` text from the data field `g`
  (same name as on iPhone). PROTOCOL.md names it only for iPhone.
- **"Never expires" as a wish.** `g1.preq` can only ask for 30/60/90/120 days;
  when the owner picks "Never" on the phone, no wish is sent and the owner
  picks it on the computer at Approve. The welcome's lifetime is final.
- **Android 12 or newer.** Keystore has no ECDH before API 31 and the identity
  key never leaves it, so `minSdk` is 31 (owner decision, 2026-11-03).
- **Approval ids.** Approve / Deny buttons appear only for approval ids the
  computer accepts in commands (UUIDs); other notices show without buttons.

## Not built yet (TODOs, by task)

- **MOB-LINK-01 — the connection.** `PairingClient`, `CommandSender` and
  `ContentSource` in `link/Link.kt` are stubs: nothing leaves the phone yet.
  The pairing screen says so, the web host shows a static "cannot reach your
  computer yet" page, and Approve/Deny say "Not sent". When it lands: local →
  direct → relay, the relay hello, the handshake, `markUsed` after each
  authenticated use, `PairingClient.Events` for `g1.pchal` and `g1.pwel`
  (route them through the application, not one activity),
  `CommandSender.request` matching replies by the command nonce, run frames
  to `RunStream`, `onRefusedByComputer` for `expired`/`unknown_device`. Web-request interception carries no request
  bodies, so core-ui's API calls must go through the bridge to the session.
- **QR scanner.** Android has no built-in QR decoder. No decoder library was
  added (decision below); "Type the code instead" is the working path, and
  the camera permission is not requested.
- **MOB-PUSH-01.** Sending the push token to the computer inside the session;
  calm rules on the computer.
- **MOB-UI-01.** core-ui's phone layout and its use of the bridge; a file
  chooser for attachments.
- Launcher icon: the Girru mark on white, same as the desktop icon (adaptive icon with a themed-icon layer). The notification status-bar icon is still a placeholder.

## The page ↔ app bridge

The page gets `window.girruNative` only on the paired origin (main frame)
through `WebViewCompat.addWebMessageListener`, not `addJavascriptInterface`,
so the platform enforces the origin. Messages are JSON, at most 4096 chars:

```js
girruNative.onmessage = (e) => { const reply = JSON.parse(e.data); /* {id, ok, result | error} */ };
girruNative.postMessage(JSON.stringify({ id: "1", method: "lock.state", args: {} }));
```

| Method | Args | Result |
|---|---|---|
| `lock.state` | — | `{locked, relockSeconds, choices}` |
| `lock.setRelockSeconds` | `{seconds: 0\|15\|30\|60}` | `{relockSeconds}` |
| `auth.confirm` | `{reason}` (1–120 chars) | `{confirmed}` — fresh unlock before a sensitive action |
| `pair.scan` | — | `{available}` — whether this build can scan; scanning happens only on the native pairing screen, codes never reach the page |
| `notifications.permission` | — | `{granted}` |
| `pair.remove` | — | `{removed}` — the phone removes itself after a fresh unlock |

Unknown methods, extra arguments or bad values are refused. While the app is
locked, every call except `lock.state` is refused with `locked`.

## Dependencies (all official; nothing else)

| Dependency | Why |
|---|---|
| `androidx.core:core-ktx` | Notifications compat, insets, permission checks |
| `androidx.appcompat:appcompat` | Activity base and day/night theme (`BiometricPrompt` needs a `FragmentActivity`) |
| `androidx.activity:activity-ktx` | Back handling and the notification-permission request |
| `androidx.webkit:webkit` | Origin-checked bridge (`addWebMessageListener`) and service-worker interception |
| `androidx.biometric:biometric` | The system unlock prompt |
| `com.google.firebase:firebase-messaging` (via `firebase-bom`) | Push delivery (FCM). Off until the phone is paired; no analytics |
| `junit:junit` (tests only) | Unit tests |

Plugins: Android Gradle Plugin, Kotlin Android, and Google Services (applied
only when `app/google-services.json` exists). Versions are in
`gradle/libs.versions.toml`; bump them to the current stable releases on the
first build. Known: FCM itself sends delivery logs to Google; the manifest
turns off auto-init, analytics collection and BigQuery export, and removes the
advertising-id permission.

## Build (later, on a machine with Android Studio)

1. Open `packages/mobile/android` in Android Studio (JDK 17), or install
   Gradle 8.9+ and run `gradle wrapper` here once. The wrapper is not
   committed (it contains a binary jar); `gradlew` and `gradle/wrapper/` are
   git-ignored.
2. Optional, for push: create a Firebase project, add Android apps
   `dev.girru.app` and `dev.girru.app.debug`, and put its
   `google-services.json` in `app/`. It is git-ignored and never committed.
   Without it the app builds and runs without push.
3. `./gradlew :app:testDebugUnitTest` — the JVM tests. They have not been run
   yet.
4. `./gradlew :app:assembleDebug` and install on a test phone (Android 12+,
   with a screen lock).

Release signing keys live only on the build machine, never in the repo.

## Device test checklist

Lock
- [ ] Fresh start opens on "Girru is locked"; the prompt appears by itself.
- [ ] Cancel the prompt: content stays hidden; "Unlock" asks again.
- [ ] Background for longer than the re-lock time → locked; shorter → not.
- [ ] Recent apps show a blank preview; screenshots are blocked.
- [ ] A phone without a screen lock gets "Set a screen lock first".
- [ ] The passcode fallback unlocks the app.
- [ ] Leave the app (Home) while the unlock prompt is open: it stays locked.
- [ ] Cancel an `auth.confirm` prompt: the app locks. Confirm with the
      passcode: the action goes ahead and the app locks afterwards.

Pairing (after MOB-LINK-01, or with the test-build "Continue" button)
- [ ] A typed code with a wrong `ck`, a repeated field, `ws://` relay, an
      expired `exp`, or no route is refused with a short message.
- [ ] A valid code shows no check code until the computer's challenge
      arrives; then the same 6-digit code as the computer.
- [ ] A code left open past its 2 minutes asks to scan the new code.
- [ ] Approve on the computer more than 30 s after the phone's unlock: the
      phone shows "Finish pairing", asks for the unlock, then is paired.
- [ ] The identity key has the agree-key purpose (StrongBox or TEE).
- [ ] Lifetime choice: 30/60/90/120/Never; "Never" shows the warning.
- [ ] Pairing asks for the unlock, then waits for Approve on the computer.
- [ ] After approval the computer's lifetime is used; restarting the app does
      not ask to pair again.
- [ ] A pairing unused past its lifetime returns to the pairing screen with
      the reason; a refusal from the computer does the same.
- [ ] "Remove this phone" from the page removes keys and pairing.
- [ ] The identity key reports hardware-backed (`KeystorePairingCrypto.isHardwareBacked`).

Notifications (with a Firebase project)
- [ ] A valid `g1.ntf` approval shows its real text with Deny / Approve.
- [ ] A forged, misaddressed, stale or replayed notice shows no content.
- [ ] Approve asks for the unlock, shows the parameters (the full view for a
      cut-short preview), asks again, then sends `approval.decide` with that
      hash; the computer accepts it once and refuses a replay.
- [ ] A too-large or unavailable full view, or an owner with a second factor,
      says "Decide this one on your computer".
- [ ] An Approve intent for an id never seen in a verified notice does nothing.

Web host
- [ ] Only `https://computer.girru.invalid` loads; other links open in the browser.
- [ ] While locked, bridge calls other than `lock.state` answer `locked`.

## Open decisions for the owner

- **Application id.** `dev.girru.app` is a placeholder; it cannot change after
  the first store upload.
- **QR decoder.** Options: our own decoder on CameraX frames (more work, no
  new code from others), or an approved library. Until then, typing the code
  is the only way in.
- **Firebase project** for FCM, under the owner's account.
