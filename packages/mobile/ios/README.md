# Girru for iPhone

The iOS shell of the Girru phone app. It is a small native app (SwiftUI and
UIKit, iOS 17+) that shows the same screens as Girru on your computer, plus the
parts only a phone can do: pairing by QR code, the app lock, keys in the
Secure Enclave, and push notifications you can approve from the lock screen.

**Status: unverified until built.** This code has not yet been built in Xcode
or run on an iPhone. The pure-Swift core (protocol, pairing, lock rules) is
built and checked on a Mac with the Command Line Tools, and it talks to the
computer's reference code (see "Checks" below). Everything that needs UIKit,
the camera or the iOS SDK is checked only by careful review until the first
Xcode build.

Only Apple frameworks are used: no CocoaPods, no Swift packages from outside
this folder.

## How it works

- **App lock, always on.** Every launch, and every return after a short time in
  the background, asks for Face ID or Touch ID, with the phone passcode as
  fallback. The owner can shorten the re-lock time (immediately, 15 s, 30 s,
  1 min) but there is no way to turn the lock off. A phone without a passcode
  cannot open Girru. The app is covered in the app switcher.
- **Pairing.** Scan the QR code from Settings › Phone on the computer, check
  that both screens show the same 6-digit code, pick how long the pairing
  lasts without use (30, 60, 90 or 120 days, or never expires, shown with a
  warning), then click Approve on the computer. Scan once, stay paired: each
  use starts the time again, and the app never asks to scan while the pairing
  is valid. The computer is the final authority; if it refuses this phone
  (expired or removed), the app shows the pairing screen with a short reason.
- **Keys.** The phone's identity key is a P-256 key created inside the Secure
  Enclave: it cannot be copied off the phone and signs only while the app is
  unlocked. Sensitive actions ask for Face ID again before the key signs.
- **Your computer's screens.** A web view shows the computer's own screens.
  Only the paired computer's pages load inside the app; links to other sites
  open in Safari, and nothing is cached on the phone.
- **Notifications.** The computer sends sealed, signed notices. A Notification
  Service Extension opens them on the phone and shows the real text; Apple and
  the relay see only a sealed blob. Anything that does not verify is shown as
  a neutral line. Approvals have Deny / Approve buttons; both need the phone
  unlocked, open Girru, and are signed behind the app lock.

The protocol is described in `packages/relay/PROTOCOL.md` (suite g1: ECDSA
P-256, ECDH P-256, HKDF-SHA-256, AES-256-GCM).

## Folder layout

| Folder | What is in it |
|---|---|
| `Sources/GirruCore` | Pure Swift, no UIKit: suite g1 crypto behind the `PairingCrypto` protocol, session handshake and envelopes, signed commands with counter, QR payload parser, pairing request / welcome / check code, pairing lifetime, push notices, replay window, lock policy, web bridge and navigation rules. Built by both app targets and by `Package.swift`. |
| `App` | App entry, app delegate (push token, notification buttons), root view, app model, colors, Info.plist, entitlements, privacy manifest. |
| `Lock` | The app lock and the unlock screen (board P2), the app-switcher cover. |
| `Pairing` | Pairing screen (board P1), QR camera, typed-code sheet, pairing flow. |
| `Web` | The web host (`WKWebView`), the JavaScript bridge, the "Not paired yet" page. |
| `Push` | Push registration and the Approve / Deny notification categories. |
| `Storage` | Keychain wrapper, Secure Enclave identity, pairing store. |
| `NotificationService` | The Notification Service Extension target. |
| `Tests/CoreChecks` | Checks for `GirruCore`, runnable without Xcode. |
| `Tests/interop` | Runs a real handshake against the computer's reference code. |

## Generate the project

The Xcode project is generated from `project.yml` with
[XcodeGen](https://github.com/yonaskolb/XcodeGen) and is not committed. This
keeps the project readable and reviewable as text. XcodeGen is a build-time
tool only; nothing from it ends up in the app.

On a Mac with Xcode 15 or later:

```sh
cd packages/mobile/ios
xcodegen generate          # writes Girru.xcodeproj
open Girru.xcodeproj
```

Without XcodeGen: create an iOS App project named Girru in Xcode, add the
folders above to it, add a Notification Service Extension target named
GirruNotificationService with the files listed under that target in
`project.yml`, and copy the build settings from `project.yml` (Info.plist and
entitlements paths, bundle ids, `GIRRU_KEYCHAIN_GROUP`).

Then in Xcode › Signing & Capabilities pick your team for both targets (never
commit the team id). Push Notifications and Keychain Sharing are already in the
entitlements files.

## Build and run

- Simulator: build and run the Girru scheme. The simulator has no Secure
  Enclave, so the app falls back to a software key kept in the Keychain behind
  user presence. Push notifications need a real iPhone.
- iPhone: pick the device and run. The first build asks for the team and
  creates the app ids.

## Checks (no Xcode needed)

```sh
cd packages/mobile/ios
swift run CoreChecks                       # all GirruCore checks
swiftc -typecheck Sources/GirruCore/*.swift Storage/*.swift   # quick type-check
```

`CoreChecks` is a plain executable because the Command Line Tools ship neither
XCTest nor the Swift Testing macros.

Interop with the computer's reference code (after `npm run build` in
`packages/relay`):

```sh
swift build --product CoreChecks
node Tests/interop/drive.mjs .build/debug/CoreChecks
```

It runs a full hs1 / hs2 handshake, sends a `g1.msg` envelope each way, and
has the computer's command gate accept a signed command from the Swift side
and refuse its replay.

## QR code payload

PROTOCOL.md lists what the QR code carries; the text form below is this app's
proposal until PROTOCOL.md fixes it:

```
girru://pair?v=1&cid=<computer device id>&ck=<computer public key>
            &pid=<pairing id>&ps=<pairing secret>&exp=<unix seconds>
            &relay=<wss or https url>&lan=<host:port>[,<host:port>…]&name=<computer name>
```

| Field | Meaning | Rule |
|---|---|---|
| `v` | protocol version | `1` |
| `cid` | computer device id | 43 characters base64url; must equal SHA-256 of `ck` |
| `ck` | computer identity public key | P-256 SPKI DER, base64url |
| `pid` | pairing id (relay mailbox) | 32 bytes, base64url |
| `ps` | pairing secret | 32 bytes, base64url |
| `exp` | expiry | at most 10 minutes ahead |
| `relay` | relay address | `wss://` or `https://` only; optional |
| `lan` | computer's local addresses | up to 4, private ranges or `.local` only; optional |
| `name` | computer name for display | up to 64 characters; optional |

At least one of `relay` and `lan` is required. Unknown fields are ignored,
repeated fields are refused.

Also proposed here and to be added to PROTOCOL.md before the computer side is
built: the pairing request `g1.preq.<nonce>.<box>`, the signed welcome
`g1.pwel.<payload>.<sig>`, the 6-digit check code formula and the notice form
`g1.ntf.<payload>.<sig>` (see `PairingMessages.swift` and `Notice.swift`).

## Web bridge

core-ui calls `window.webkit.messageHandlers.girru.postMessage({...})`, which
returns a Promise. Only the paired computer's main frame may call it, and only
these messages are accepted (extra fields are refused):

| Message | Reply |
|---|---|
| `{type: "lock.state"}` | `{locked, relockDelay}` |
| `{type: "auth.request", reason}` | `{ok}`, after a fresh Face ID / passcode check |
| `{type: "qr.scan"}` | `{text}` or `{cancelled: true}` |
| `{type: "push.permission", request?: true}` | `{status}`: `granted`, `denied` or `not-asked` |

`window.girruShell = {platform: "ios", bridge: 1}` is set before the page
loads, so core-ui can choose the phone layout.

## Device test checklist

Run on a real iPhone, with Girru on the computer on the same network and
through the relay:

1. **Lock.** Fresh install opens on the lock screen; Face ID unlocks; cancel
   keeps it locked; passcode works after a failed Face ID; with no passcode on
   the phone the app says so and does not open.
2. **Re-lock.** Background for less than the delay: no prompt. Longer: prompt.
   Set "immediately": prompt every time. The app switcher shows the cover,
   never content.
3. **Pair.** Scan the QR code, codes match on both screens, pick 30 days,
   approve on the computer; the computer's screens load. Kill and reopen:
   still paired, no scan. Reboot the phone: still paired.
4. **Expiry.** On the computer, set the lifetime short or expire the phone: the
   app shows the pairing screen with the reason.
5. **Navigation.** A link to another site opens Safari; the app stays on the
   computer's pages.
6. **Push approve.** Lock the phone, trigger an approval on the computer: the
   lock screen shows the real text; Approve asks to unlock, opens Girru, and
   the computer records the approval. A sensitive approval asks Face ID again.
   A notice not signed by the computer shows only the neutral line.
7. **Revoke.** Remove the phone on the computer: the next use shows the pairing
   screen; old commands are refused.
8. **Keys.** Delete and reinstall the app: pairing is gone and must be done
   again.

## What is not done yet

- The connection to the computer (local network, direct, relay) comes with the
  computer connector task. Until then `PairingTransport` and `ComputerLink`
  are stubs that say plainly that the phone cannot reach the computer yet.
- The web host loads the computer's screens from its first local address. The
  final design serves them through the end-to-end link inside the app.
- "Type the code instead" checks the code's form only; PROTOCOL.md has no
  typed-code exchange yet.
- No app icon yet.
