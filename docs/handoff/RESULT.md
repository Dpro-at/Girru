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

## Test round 2 (11 November 2026)

Tested this branch at `ca24980e` (it contains `phone/app` up to `804678dd`
"Hand test round 2 to the build Mac") on the build Mac: macOS 26.6.2,
Xcode 27.2, iPhone 18 Pro simulator with iOS 27.2, Node 24.22.2. Testing
only: **no code changed, no build fix needed.** Screenshots are
`result/r2-*.png`.

Installs: `npm ci` in `packages/backend` and `packages/core-ui`. The root and
`packages/relay` have no `package-lock.json`, so `npm ci` refuses there
(`EUSAGE`); the relay tests ran with the old workaround
(`npm install --no-save tsx@^4.21.0` in `packages/relay`).

### Test 1: shared checks

| Check | Result | Expected (NEXT.md) |
|---|---|---|
| relay | **29 pass** | 29 |
| backend `test/phone-*.test.mjs` | **43 pass** | 42 |
| core-ui `tests/phone-shell.test.cjs` | **3 pass** | 3 |
| `swift run CoreChecks` | **368 passed, 0 failed** | 359 |

### Test 2: iPhone build

`xcodegen generate` and `xcodebuild -scheme Girru -sdk iphonesimulator`:
**BUILD SUCCEEDED**, no fixes. Two warnings only (`AppModel.swift:240`
`try` without a throwing call; `DeviceIdentity.swift:67` "will never be
executed", the simulator-only branch). Android was not part of this round.

### Test 3: the simulator through `wss://relay.girru.net/v1`

Ran against `pair-harness.mjs --manual` with `AGENT_TERMINAL=true` (throwaway
database, stubbed model that answers "Hello from the computer"), with a core-ui
build from `node scripts/build.cjs --candidate --live-entry`. **Not** against
the owner's real desktop app: that app runs on this Mac against the main
checkout and was not to be touched. So the chat list, agents and messages are
test data, not the owner's.

Pairing: the same check code on both screens (148 152, `r2-01`), Allow, then the
bottom bar with Chat / Tasks / Approvals / Team.

**Findings (most important first):**

1. **The key row does not send its keys.** ^C, Ctrl and Tab do nothing: ^C
   does not stop `sleep 30` (the owner pressed it too, same result), Ctrl then
   `l` types a plain `l`, Tab does not complete `ech`. On the computer each tap
   on the key row arrives as a `POST …/resize` (31 resize rows in the audit
   log) and never as `…/input`. Typing from the keyboard does arrive.
2. **The chat page is the desktop layout squeezed into 402 pt** (`r2-02`,
   `r2-04`, `r2-09`):
   - the top bar's icons sit on top of each other and over "Commands";
   - the Details / Changes / Files panel opens in the narrow screen and
     covers the chat;
   - with the keyboard up the whole page slides sideways (the terminal's text
     is cut on the left, ⋯ off the right edge) and the send button is hidden
     under the terminal pane;
   - the desktop voice row ("Choose an engine in Voice settings") shows;
   - the terminal opens docked under the chat and takes a third of the
     screen (`r2-03`), not full size as boards P24–P26 show.
   - After Back from the full-size terminal the chat page is empty: only
     "You … Message" (`r2-09`, `r2-17`).

   **The owner's direction (11 November, for a design board before code):**
   the same chat page, with the chat list as a drawer from the left and the
   details as a drawer from the right, both closed by default; the meeting bar
   small at the top; the conversation alone in the middle; the terminal on its
   own full page (opened from its button after Face ID, Back returns to chat),
   never docked inside the chat.
3. **"The meeting could not be updated. Try again."** shows above every chat
   (`r2-05`). The page's Meetings part asks for `/api/meetings`
   (`core-ui/src/Meetings.tsx:10`), which is not on the phone's list in
   `ui-bridge.ts` (`phoneMayCall`). Either the page must not ask on the phone
   or the list needs it (owner's call).
4. **The terminal loses its connection after about two minutes**
   ("Lost the connection to the terminal. Start again", `r2-18`). The audit log
   shows the stream re-attached at 09:18:07 and 09:18:57, then never again;
   at 09:20 the page showed the error. The first command (`echo hi; date`)
   now works (round 1 finding 5 is fixed for the first minutes).
5. **The chat page sometimes paints nothing** until the app re-renders: after
   one tap in the page the screen stayed empty while the page's own DOM had
   the composer and terminal laid out; after a lock and unlock it painted.
6. The keyboard closed by itself once while typing in the terminal
   (`sleep ` arrived, `30` and Return were lost).
7. Approvals, Deny and Approve: with a pending request added by hand to the
   test database, **both buttons did nothing and showed no message** (no Face
   ID, the row stayed pending). My row had no `params_hash`, so this may be my
   test data, not the app; it needs a real request from an agent tool call.
   If a real one also fails, the missing error notice is a finding.
8. The simulator's screen froze twice right after the terminal's Face ID
   sheet closed (clock stopped, taps ignored, the app still running
   underneath); pressing the side button twice brought it back. Probably the
   simulator, but watch for it on a real iPhone.

**Fixed since round 1 (checked):**

- Round 1 finding 1: the chat page loads, signed in, not blank; a message sent
  from the page reached the computer and the reply came back into the page
  (`r2-06`; `chat_messages` has both). Word-by-word streaming cannot be
  judged here: the harness's stubbed model answers in one piece.
- Finding 4: the terminal started after `npm ci` with no `chmod` by hand
  ("zsh on your computer").
- Finding 6: after more than 60 seconds away the app asks Face ID and shows
  nothing behind it, and the keyboard bar is not over the lock (`r2-19`).

**Worked as designed:**

- The terminal asks Face ID ("Open the terminal", in the system log) before
  it opens, from Tasks and from the chat page; the key row (Paste, ^C, ^D,
  Esc, Tab, Ctrl, arrows) shows above a lowercase keyboard (`r2-07`).
- Tasks: Now / Scheduled / Done, empty state, terminal and plus buttons (`r2-08`).
- Approvals: empty state with "See what the team is doing" (`r2-10`); a
  pending request opens with Deny and Approve, the tab shows the badge 1 (`r2-12`).
- Team: main agent first marked "Needs you", search and chips (`r2-11`).
- Dark mode on Approvals, Team, Tasks and the chat page (`r2-14` to `r2-17`).
- The app asks Face ID again only after 60 seconds in the background (the
  default `LockPolicy` delay); a shorter trip opens without asking, by design.

**Not tested this round:** the paste check, ⋯ menu of the terminal,
autocorrect on `ls`, "Waiting for you" opening Approvals, a real approval
decision, a cut-short approval, and the real desktop app with the owner's own
data (needs the owner's go to pair with the Girru running on this Mac).

**Tool note:** GET requests from the page are not logged anywhere, and the
page keeps its own `fetch`, so a wrapper cannot see them. To read the page I
used a small Python client for the simulator's `webinspectord_sim.socket`
(no TCP port, unlike `ios_webkit_debug_proxy`, which listens on every
interface). A request log in the harness (method, path, status of every
`api.call`) would make the next round's "missing request" check exact.

### Test 3, part 2: paired with the owner's real Girru (owner's go, 11 November)

The owner said yes to pairing the simulator with the Girru desktop app running
on this Mac (main checkout, `computers/simplify` at `e4378818`, which contains
`phone/app` up to `804678dd`). The QR came from the phone button next to the
owner's name ("Reaches this computer anywhere"); both screens showed 031 265
(`r2-20`) and **the owner pressed Allow himself**. Nothing was sent in his
chats.

- **The chat page shows the owner's data but the messages are invisible**
  (`r2-21`). They are in the page (for example the user's "Run git status
  --short …" and the agent's "The model did not answer"), but on the 402 pt
  screen `main.page-area` is 180 px wide, `.chat-thread` 96 px wide and
  **0 px high**, and `.chat-column` 0 px wide; the side panel (Details:
  "22.5k tokens", Main Agent · Claude Code, memory) takes the rest. Same root as
  finding 2, but with real chats the conversation cannot be read at all.
- A second refused request on the chat page: **"Could not finish this. Try
  again. Reload specialties"** (`core-ui/src/SpecialtyLibrary.tsx:224`; it reads
  `/api/specialty-templates`, which is not on the phone's list). The meeting
  error (finding 3) shows here too.
- The app's own screens show the real data correctly (`r2-22` to `r2-24`):
  Tasks (next scheduled "Agent review, every day at 03:00"), Approvals (empty
  state), Team (Main Agent, Ash, Cameron, Noel, Remy, Wren, with Support /
  Marketing / Sales chips).

**Owner's wish for the pairing screen (for the main computer):** a code to type
under the QR, for a phone without a camera. Today the QR holds a 368-character
`girru://pair` link, so this needs the typed-code proposal in
`PHONE_FEATURES.md` §5 (protocol change, owner's OK first). It is not the
6-digit check code, which only confirms the phone.

## Test: phone chat fit (e1d207fb)

PR Dpro-at/Girru#197 "Fit the chat page to the phone", branch `phone/chat-fit`.
First tested at `74c321ed`, then again at the new head `e1d207fb`
(styles.css and a test). The chat page comes from the computer, so the main
Mac ran the MacBook's Girru from a local merge of `computers/simplify` and
`phone/chat-fit` (`515a767e`, same profile and data), rebuilt core-ui and
restarted it; the app was reopened so the page loaded the new build. The
iPhone app is unchanged: same simulator build, still paired with the owner's
real Girru. iPhone 18 Pro simulator, iOS 27.2, 402 pt wide. Screenshots
`result/fit-*.png` are all from `e1d207fb`; sizes were measured in the page.

**Works (checked on the owner's real chats):**

- The page is exactly 402 px wide; the conversation is full width
  (`.chat-thread` 402×574) and the messages are readable (`fit-01`).
- The top bar fits: Chats, the chat's name, Terminal, ⋯, side panel, no
  overlap.
- The left drawer (chat list) is closed at start, opens over a dimmed chat
  with the owner's projects and chats, and closes on a tap outside (`fit-02`).
  The owner: "the left side bar is good".
- New in `e1d207fb`: the composer is full width (386 of 402 px, textarea
  362 px; it was 220 px at `74c321ed`).
- With the keyboard up nothing slides sideways (scroll width 402, scroll 0);
  the composer sits above the keyboard with Send visible (`fit-07`).
- The meetings and specialties errors are gone (the only alerts left are the
  chat's own "The model did not answer" messages).
- The terminal is its own page after Face ID ("Open the terminal" in the
  system log) and now starts on the restarted Girru: `echo hi; date` gives the
  real output (`fit-05`). Back returns to the same chat (10 messages, full
  width, `fit-06`).

**Findings (still open at `e1d207fb`):**

1. **The right drawer cannot be used or scrolled** (`fit-04`; the owner saw it
   too). `.chat-details` is `position: fixed; z-index: 12`, while
   `button.phone-scrim` is `position: fixed; z-index: 65`, so the dim layer
   lies over the drawer: the drawer looks greyed, every touch on it hits the
   scrim (which closes it), and its content (1006 px in a 729 px box,
   `overflow-y: auto`) never scrolls. The drawer must sit above the scrim.
2. **Text sizes are mixed and mostly desktop-small** (the owner: "some things
   small, some big"): message text 13.5 px, code 12.15 px, the task card in the
   chat 12–12.5 px with details at 10.4 px, meta lines 12.5 px, while the
   composer writes at 16 px. Phone body text should be about 16–17 px.
3. **The conversation keeps desktop margins:** the column is 306 px with 48 px
   on both sides, and assistant text starts at x 88, so a reply line is only
   266 px wide.
4. **^C on the key row still does not stop `sleep 30`** (round 2 finding 1;
   not part of this PR).
5. Seen at `74c321ed`, not retested: when Face ID for the terminal is
   cancelled, the page still switches to the terminal page with "The terminal
   could not start". No shell opens, but after a cancel it should stay in the
   chat.

**Not tested:** dark mode of the new layout, sending a message (not to start
the owner's agents).

## Test: phone chat fit (72cdccc5)

PR Dpro-at/Girru#197, branch `phone/chat-fit` at `72cdccc5`. The main Mac
merged it into the MacBook's test Girru (local merge `49ea6c0a`, same profile
and data), rebuilt core-ui and restarted it; the app was reopened so the page
loaded the new build. Same simulator build, still paired with the owner's real
Girru; iPhone 18 Pro simulator, iOS 27.2, 402 pt. Screenshots
`result/fit3-*.png`; sizes measured in the page.

**Fixed (all four claims checked):**

1. **Right drawer:** `.chat-details` is now z-index 70 over the scrim (65); it
   is no longer greyed, taps land inside it (`elementFromPoint` hits the
   drawer's own links), and a swipe scrolls it (scrollTop 0 → 277, the
   Results and memory parts come into view) (`fit3-02`, `fit3-03`). A tap on
   the dimmed strip left of it closes it.
2. **Text sizes:** user and assistant message text 16 px, code 14 px, the
   task card's lines and details 14 px, meta lines 14 px, composer 16 px
   (`fit3-01`). The 10.4 px text is gone.
3. **Width:** the column is 378 px with 12 px on each side (was 306 with 48);
   user text is 350 px wide, assistant paragraphs 338 px; the composer is 386
   of 402 px.
4. **Cancelled Face ID for the terminal:** "Face Not Recognized" then Cancel
   leaves the app in the chat, with no terminal page and no error
   (`fit3-04`).

**Still good:** page 402 px wide with no sideways scroll; with the keyboard up
the composer ends at 400 of the 416 px visible area, Send visible, no slide
(`fit3-05`); the meetings and specialties errors stay gone. **Dark mode:** the
chat, the right drawer and the left drawer are all dark and readable
(`fit3-06` to `fit3-08`).

**Sending a message (owner's OK, 11 November):** in a new chat on the phone,
"Reply with one short sentence: phone chat test." was typed on the simulator
keyboard and sent with Return (`fit3-09`). The phone side worked: the message
reached the computer at once, the reply's "Thinking 25s … 1m 26s" counter
updated live, second by second, through the session's stream, and the final
state appeared without a reload. **But no reply text came:** after about
1 min 26 s the run ended with "The model did not answer — the model or coding
app stopped before the reply was done" (`fit3-10`). The same error is already
in the owner's older chats on this computer (made before this test, from the
desktop and the Mac Mini), so it is the coding app (Main Agent · Claude Code)
on the MacBook, not the phone. Word-by-word streaming of reply text could not
be seen because no text arrived.

A second copy of the same message was sent about 1 min 53 s after the first,
right when the error showed, and failed the same way (about 1 min 10 s). The
build Mac sent only one (one Return). core-ui has no automatic resend
(`conversations.ts:681`: "never resend the user message"), so someone most
likely pressed send again in the watched panel. Worth confirming.

**Cause found and retested (11 November, owner's OK):** the missing reply was
the Main Agent's model setting (an API model with no key fell back to a local
ollama model that ran out of memory), not the phone and not the coding app;
with the owner's choice it is now "Claude Code · existing account". The same
message in a new chat: the reply **"Phone chat test received, and everything is
working."** appeared about 5 seconds after sending, one user message and one
reply (`fit3-11`). The sentence is short and appeared whole between two samples
0.4 s apart, so word-by-word streaming of a longer reply is still not shown.

Two small things on the way:
- The first attempt to type the message came out as "Hum with short."
  (characters lost and changed while typing fast on the simulator keyboard);
  typed again in three pieces it was exact. Probably the simulator's fast
  typing, but watch for it on a real iPhone.
- After sending, the keyboard closed but its toolbar (⌃ ⌄ ✓) stayed over the
  bottom bar (`fit3-11`).

**Still open:** the terminal key row (^C) was not part of this change and
still does not stop a command (see the `e1d207fb` section).

## Test: phone settings (696287fd)

Boards P33–P39 (approved by the owner). Code: `origin/phone/settings` at
`696287fd` (on `main` `76aa89e8`; `638f5a23` computer side `settings.read` /
`settings.change`, `696287fd` iPhone `App/Screens/SettingsScreens.swift` and
the drawer gear). The MacBook's test Girru runs a local merge of it
(`5e7e562d`, same profile and data). iPhone 18 Pro simulator, iOS 27.2,
paired with the owner's real Girru. Screenshots `result/set-*.png`. Nothing
was changed in the owner's settings: every change was cancelled.

**Checks:**

| Check | Result |
|---|---|
| backend `test/phone-*.test.mjs` (test worktree) | **48 pass**, 0 fail (expected 48) |
| iPhone build of `phone/settings` | **failed**, one error; after the fix **BUILD SUCCEEDED** |
| `swift run CoreChecks` | **375 passed, 0 failed** |

**Build fix (one commit, on a local branch `phone/settings-build-fix` on top
of `696287fd`, not pushed):** `4a2cc525` "Label the Team screen title so the
iPhone app compiles". `TeamScreen.swift:16` called `ScreenTitle("Team") { … }`;
with a trailing view `ScreenTitle` takes `text:` (as `TasksScreen` does), so it
is now `ScreenTitle(text: "Team") { … }`.

**Works:**

- The chat drawer has "Settings" at the bottom; it opens the native Settings
  sheet (`set-01`): This phone (the computer, "Ask Face ID again · After 1
  min") and Your computer (Account and general, Models and replies,
  Permissions 🔒, Approval rules, Computers, Phones 🔒).
- This phone (`set-02`, `set-03`): Anywhere ✓, "Only on this Wi-Fi" marked
  "Coming in a later version"; Face ID after leaving the app (Right away /
  15 s / 30 s / 1 min, 1 min chosen); two notification switches; "Forget this
  computer…" in red with a lock (not pressed).
- Account (`set-04`): two-step sign-in Off, one signed-in session with Sign
  out (not pressed), appearance and language.
- Models and replies (`set-05`): Main Agent answers with "Claude Code ·
  existing account" ✓ (left as is), local models listed.
- Permissions (`set-06`): per agent, Off / Ask / Allow for browser, internet,
  messages, delete, install, money. A change asks Face ID ("Change what Main
  Agent may do"); cancelled, the value stays (`set-07`). Allow on a risky one
  (Delete things) first asks "Allow without asking you?" before Face ID;
  Cancel leaves it on Ask with no Face ID asked (`set-08`).
- Phones (`set-11`): "iPhone 18 Pro · This phone".
- Dark mode of the sheet (`set-12`).

**Findings:**

1. **Approval rules shows "Something went wrong on your computer. Try
   again."** every time (`set-09`). `settings.ts` reads
   `GET /api/reviewer-policies`, which calls
   `reviewerRequestIdentity(request, true)`; the phone's owner request
   probably does not pass it, so `get()` throws `unavailable`.
2. **Computers shows "Nothing here yet"** (`set-10`), while the owner's Girru
   lists three computers (MacBook Pro, Mac Mini, Alarade). `settings.ts`
   takes `configuration.membership.devices`; the `/api/computers` answer
   carries the list at its top level (`devices`, from the coordinator's
   `view()`), so the phone gets an empty list.
3. **Account lists the signed-in session as "Unknown device"**: the owner
   cannot tell which device a Sign out would end.
4. After the new app was installed, the chat page stayed blank
   (`about:blank`) and did not retry, also after switching tabs; the relay
   connection had dropped once at that moment. Tasks worked. A restart of the
   app loaded it. The page should retry when the session comes back.
5. Small: the big title of the computer page is cut ("Mohameds-MacBook-…").

**Not tested on purpose:** actually changing a setting, Forget this computer
and Sign out (they change the owner's real setup; each needs his OK).

### Retest: phone settings (4430cd7e)

`origin/phone/settings` at `4430cd7e` "Phone Settings fixes from the
simulator test" (on `696287fd`); the MacBook's test Girru runs it merged
(backend phone tests 50/50 there, run by the MacBook session). The build Mac's
local fix `4a2cc525` was dropped (the branch is deleted, never pushed); this
build is from `4430cd7e` itself. Screenshots `result/set2-*.png`. Again no
real setting was changed.

| Fix | Result |
|---|---|
| 0. iPhone build | **BUILD SUCCEEDED** with no change (`ScreenTitle(text: "Team")`); CoreChecks **375 passed, 0 failed** |
| 1. Approval rules | **Fixed:** "Approval rules need two-step sign-in on your account. Turn it on in Girru on your computer." instead of the error (`set2-03`) |
| 2. Computers | **Partly:** lists "Mohamed's Mac Mini" and "Alarade", but not this MacBook Pro, which the owner's Girru shows as the third computer ("this one") (`set2-04`). If leaving out the computer the phone is paired with is meant, the page should say so |
| 3. Account | **Fixed:** the session shows "Last used 1 min, 33 sec ago" (`set2-02`). Its name is still "Unknown device" |
| 4. Chat page retry after a failed load | **Not tested:** making the load fail needs the relay cut for a moment, which here would mean changing the Mac's network settings. The page loaded normally on the first launch of this build |
| 5. This phone's title | **Fixed:** one line, "Mohameds-MacBook-Pro" (`set2-01`) |

### Retest: phone settings (98ccdf02)

`origin/phone/settings` at `98ccdf02` "Phone Settings: the paired computer in
Computers, this phone's name in Account" (contains `main` `bb5cd88d`, with
#197 and #198). The MacBook's Girru runs from it directly (backend phone tests
50/50, run by the MacBook session). iPhone build from `98ccdf02`: **BUILD
SUCCEEDED** with no change; CoreChecks **375 passed, 0 failed**. Screenshots
`result/set3-*.png`. No real setting was changed.

| Check | Result |
|---|---|
| Computers | **Fixed:** "Mohamed's MacBook Pro · This phone's computer" first, then "Mohamed's Mac Mini" and "Alarade" (`set3-01`) |
| Account | **Not fixed:** the session is still "Unknown device · Last used 1 min, 36 sec ago", with no "This phone" tag (`set3-02`). The change renames only a session marked `current`, and this one is not. It is most likely Girru's own sign-in on the MacBook (the phone does not sign in; it uses its pairing), so naming it after the phone would be wrong too. Suggest: name the desktop session after its computer (for example "Girru on Mohamed's MacBook Pro"), and show the phone, if at all, under Phones |
| Approval rules | still the two-step sign-in message (`set3-03`) |
| This phone | title on one line (`set3-04`) |
| Permissions | a change asks Face ID ("Change what Main Agent may do"); cancelled, "Send messages" stays Ask (`set3-05`) |
| Chat page | loaded by itself on first launch |

Small: the same computer is "Mohameds-MacBook-Pro" (its host name) under This
phone and "Mohamed's MacBook Pro" under Computers.

### Retest: phone settings (d82a2bad)

`origin/phone/settings` at `d82a2bad` "Phone Settings: name the computer's own
sign-in, one name for the paired computer" (one commit on `98ccdf02`). The
MacBook's Girru runs it (backend phone tests 51/51, run by the MacBook
session). iPhone build from `d82a2bad`: **BUILD SUCCEEDED** with no change;
CoreChecks **375 passed, 0 failed**. Screenshots `result/set4-*.png`. No real
setting was changed.

| Check | Result |
|---|---|
| Account | **Fixed:** the session is "Girru on Mohamed's MacBook Pro · Last used 1 min, 16 sec ago"; no "Unknown device", no "This phone" tag (`set4-03`) |
| One name for the paired computer | **Fixed:** "Mohamed's MacBook Pro" in the Settings row, the This phone title and its card (`set4-01`, `set4-02`), the same as under Computers |
| Computers | "Mohamed's MacBook Pro · This phone's computer" first, then Mac Mini and Alarade (`set4-04`) |
| Approval rules | the two-step sign-in message (`set4-05`) |
| Permissions | a change asks Face ID ("Change what Main Agent may do"); cancelled, "Send messages" stays Ask (`set4-06`) |
| Chat page | loaded by itself on first launch |

Phone Settings has no open finding left from these tests. Still untested: the
chat page's automatic retry after a failed load (needs the relay cut briefly).

### Test: phone meetings (413f423a)

`origin/phone/meetings` at `413f423a` (zoom fix `f424c30e`, wording fix
`413f423a`), merged with `phone/settings` `d82a2bad` in the MacBook's test
Girru (`482d97ac`). The phone is paired with the owner's real Girru. Mohamed
OK'd one small live meeting in this session: "Phone meeting test", Sales only
(Remy plus the Main Agent), with the decision field "Nothing real to decide.
This only tests the phone." No decision was approved and no setting was
changed. Screenshots are `result/meet-*.png`.

| # | Check | Result |
|---|---|---|
| 6 | "New meeting" in the chat ⋯ menu | **Pass** (`meet-01`) |
| 7 | No zoom on the fields | **Pass:** topic, find-department and decide fields are 16 px; `visualViewport.scale` stays 1 while typing (`meet-05`, `meet-07`) |
| – | Wording | **Pass:** "1 agent · 1 head", "1 agent selected · plus you" (`meet-06`) |
| 1 | Start with Face ID | **Pass:** Start meeting asks Face ID (`meet-08`); "no match" then Cancel keeps the filled form and starts nothing (`meet-09`); a match opens the meeting: "2 present · Main Agent coordinates · 0 of 2 initial turns" (`meet-10`) |
| 2 | Turns stream in | **Partly.** Remy's turn (Sales) shows "Thinking" counting up live, then after 1m 37s "The model did not answer". Remy runs on the local model qwen3.5:9b ("No Claude key is set"), which did not answer, and the meeting pauses itself (`meet-11`). The Main Agent's turn (Claude Code) arrived after about 30 s (`meet-13`). I could not see it come in word by word: right after Next speaker the page showed "Loading the chat…" and the inspector lost the page for about 20 s |
| 3 | Mic turn stops at 40 s | **Not testable here.** The call opens (`meet-14`), but the mic button is disabled with "Set up local speech-to-text to speak; typed chat still works." Setting up speech-to-text is a computer setting, so it was left alone. Leave call works |
| 5 | End the meeting with Face ID | **Pass for the Face ID step:** Finish meeting asks Face ID, then sends "Finish the meeting and prepare its decisions for review." (`meet-15`). **But** that went to Remy's local model, which failed again after 1m 21s, and the meeting paused with no summary (`meet-16`) |
| 4 | Approve decisions with Face ID | **Not reached:** no decisions sheet appeared, because the finish turn failed (see 5). Nothing was approved |

Findings for the author:

1. **Remy's local model blocks the meeting.** Both Remy turns failed on
   qwen3.5:9b, and Finish was sent to Remy rather than the coordinating Main
   Agent, so the meeting cannot be finished. The model choice is the owner's
   setting, but it may help if Finish goes to the coordinator, or if the
   meeting skips a participant whose model failed.
2. **Try again does nothing while the meeting is paused.** It puts the message
   back in the box with "The message was not sent. It is back in the box."
   (`meet-12`). Either resume by itself, or say "Resume the meeting first".
3. **Wrong status line:** during the finish turn the header said "Remy is
   answering" while the Main Agent's bubble showed "Thinking" (`meet-15`).
4. **Count after start:** with only Sales chosen (1 agent), the meeting header
   showed "Invite remaining speakers (2)" (`meet-10`).
5. **Call view:** the small "You · Camera" tile covers the end of the caption
   line ("Choose a voice in …") (`meet-14`).
6. **The keyboard bar stays** over the tab bar after the form closes
   (`meet-10`), the same as in chat.

The meeting "Phone meeting test" is left **paused** on the owner's Girru. It
was not ended, and no decisions were approved.
