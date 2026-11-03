# Next: the phone app, from 3 November 2026 on

Tasks for the computer that builds and tests the phone app. Work on the
branch below and report back as described at the end. Background,
decisions and the build guide: [`packages/mobile/BUILDING.md`](../../packages/mobile/BUILDING.md).
What the build Mac found and built so far: [`RESULT.md`](RESULT.md). The
owner's feature list and the typed-code proposal: [`PHONE_FEATURES.md`](PHONE_FEATURES.md).
Phone design boards (P1–P23, D1–D8): the owner's "Girru phone app" design
canvas (ask the owner for the link).

- **Branch:** `phone/app`. Pull before you start: Part 1 below was added on the main computer.
- **Do not** push to `main`, merge, tag or release. Commit on `phone/app` only.
- **Never commit** signing teams, `google-services.json`, keys, tokens or `.env` files.
- **The owner's rule:** the phone shows the **same core-ui chat screens** as the
  desktop, so a chat change is written once, on the computer, and the phone
  shows it without an app update. Only native parts (lock, pairing, push,
  widget, share, permissions) live in the apps.

## Now: test only (owner's decision, 3 November 2026)

**All the code is written on the main computer. This computer builds, runs and
reports; it does not write features.** Fix only what stops a build, with the
smallest change, one commit per fix, and say so in `RESULT.md`.

What was added for you to test (pull `phone/app` first):

| Commit | What |
|---|---|
| `d6ed4aaf`, `79949bf9` | Computer side: `ui.get`, `api.call`, `api.stream` (the chat page through the session), with audit rows. |
| `ca0dacde` | iPhone: the four places (Chat, Tasks, Approvals, Team) after pairing; Chat loads the computer's chat page through the session; Tasks, Approvals, Team are the app's own screens (boards Tasks, Approvals, ApprovalsDark, Team, Empty). Commands are signed in counter order. |
| `97d0bf1a` | Computer's chat page: on `girru-app://computer` with the app's shell object it starts signed in and sends no token. |
| `e46fd990` | Android: the relay session (`RelaySessionClient`), the same four places, the chat page through the session; requests with a body go through the bridge (`api.call`). |

**Never compiled:** the new iPhone screens were type-checked against macOS
SwiftUI only (no iOS SDK on the main computer), and the Android code was not
compiled at all (no JDK there). Expect small build fixes.

### Test 1: shared checks

```bash
cd packages/relay && node --import tsx --test test/*.test.mjs                 # 29
cd ../backend && node --import tsx --test test/phone-*.test.mjs                # 42
cd ../core-ui && node --test tests/phone-shell.test.cjs                        # 3
cd ../mobile/ios && swift run CoreChecks                                       # 359
```

### Test 2: builds

```bash
cd packages/mobile/ios && xcodegen generate && xcodebuild -scheme Girru -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' build
cd packages/mobile/android && ./gradlew :app:testDebugUnitTest :app:assembleDebug   # new: PageBridgeTest, PhoneScreensTest
```

### Test 3: the simulator (and an Android phone or emulator), paired through the real relay

Start the test computer with `pair-harness.mjs --manual` (see "Things the next
agent must know"), pair, then check and write down each:

1. **Chat**: the computer's chat page opens inside the app (no sign-in screen),
   the chat list shows, a chat opens, a message sends and the reply streams in
   word by word. Note every part of the page that shows an error or stays empty:
   the computer answers only the chat page's requests (`ui-bridge.ts` list), so
   a missing request is a finding, not a fix for you.
2. **Tasks**: Now / Scheduled / Done; "Waiting for you" opens Approvals; the
   plus button opens Chat. There is no terminal button on purpose.
3. **Approvals**: the first request is open with Deny and Approve; Approve asks
   Face ID (Android: the confirm screen); a cut-short request opens the full
   view first; the badge on the tab shows the count; the empty state appears
   when nothing waits.
4. **Team**: main agent first, then who needs you, who works, who is free;
   search and the chips filter; tapping an agent opens Chat.
5. **Terminal** (owner's decision: it is on the phone, behind the fingerprint):
   the terminal button in Tasks asks Face ID / Touch ID / fingerprint, then
   Chat opens the computer's terminal full size; type `echo hi; date` and see
   the real output. Without the check nothing opens. After locking and
   unlocking the app, the next terminal use asks again. The computer needs
   `AGENT_TERMINAL=true`.
6. Dark mode on each screen; locking the app hides everything and nothing
   loads until the unlock.

Report as before in `RESULT.md`, with screenshots of each place.

## Where things stand

| Part | State |
|---|---|
| Relay, computer side of the link, pairing screens on the computer | Done (see BUILDING.md). |
| Task 1 (shared checks) | Done: relay 29, backend phone 33, `CoreChecks` 301 → now **309**. |
| Task 2 (iPhone build) | Builds for the simulator and the device with no compile fixes. Lock, Face ID, pairing screens and icon checked on the simulator. **Not checked on a real iPhone yet** (Secure Enclave key). |
| Task 3 (Android build) | 85 unit tests → now **90**, APK builds. **Not checked on a real phone yet.** |
| Task 4, pairing | **Done in both apps**: real relay connection (challenge, hello signed by the identity key and bound to the QR code's relay, the computer as the only allowed sender), `g1.preq` → `g1.pchal` → `g1.pwel`. Tested end to end against the backend's real phone link (`pair-harness.mjs`). |
| Task 4, session (iPhone) | **Done**: `GirruCore/SessionLink.swift`, a fresh signed hs1 per session, sealed commands in order, replies by `ref`/nonce, run frames until `run.end`. The app's `ComputerLink` is `App/SessionComputerLink.swift`. Tested end to end: `chat.list`, `team.list`, a streamed `chat.send`, a refused replay. |
| Task 4, session (Android) | **Not started.** `CommandSender` in `link/Link.kt` is still `NotConnectedYet`. |
| Simulator pairing over the real relay | **Done**: the iOS Simulator paired with the backend through `wss://relay.girru.net/v1`, the same check code (964 901) on both screens. |
| Task 5 Part 1, the computer serves the chat page | **Done** (3 November 2026): `ui.get`, `api.call`, `api.stream` in `packages/backend/src/phone/ui-bridge.ts`, written in `PROTOCOL.md` › "The computer's pages on the phone". Backend phone tests 42 pass (new: `test/phone-ui-bridge.test.mjs` 8, one more in `phone-link-e2e`). |
| Chat screens in the app | **Not started.** After pairing the app shows "Cannot reach your computer yet" (`UnavailableCoreUISource`). |

### Things the next agent must know

- **Simulator and keys.** The iOS Simulator cannot make keys or keychain items
  bound to user presence (`LocalAuthentication -1020`, "not supported on iOS
  Simulator"), and it can report a Secure Enclave that does not work. So in
  `Storage/DeviceIdentity.swift`, **only under `targetEnvironment(simulator)`**,
  the identity is a software key readable while unlocked. A real iPhone
  always uses the Secure Enclave key. Do not widen this.
- **Development builds only (`#if DEBUG`):** the pairing link can come from the
  launch argument `-GirruPairLink "<girru://pair?…>"` or be pasted whole into
  the "Type the code" field (the simulator has no camera). Release builds never use either.
- **Test computer:** `packages/mobile/tools/pair-harness.mjs` runs the
  backend's phone link on a throwaway database. Automatic mode runs a phone
  command (Swift `PairCheck`, Android `android-pair-check.sh`) against a local
  TLS relay. `--manual` with `GIRRU_RELAY_URL=wss://relay.girru.net/v1` and
  `GIRRU_QR_OUT=<file>` is for the simulator or a phone: it writes the QR text,
  prints the check code, and chooses Allow once `<file>.allow` exists.
- **Android uses OkHttp 4.12.0** for the WebSocket (pinned in `libs.versions.toml`).
- **Tools on the build Mac:** Node 24 (`/opt/homebrew/opt/node@24/bin`;
  Homebrew's Node 25 is broken there), JDK 17 (`/opt/homebrew/opt/openjdk@17`),
  Xcode 27.2, XcodeGen, Gradle wrapper 8.9 (not committed).
- **Relay tests need `tsx` in `packages/relay`.** It is not in its
  `package.json`; the root `npm install` fails with ERESOLVE
  (`@readyplayerme/visage` wants `@react-three/drei@9.108.4`). Workaround:
  `npm install --no-save tsx@^4.21.0` in `packages/relay`.
- **Real iPhone:** the owner's iPhone 14 is seen by the Mac but has no
  developer disk image yet, and Xcode has **no Apple ID** signed in. A free
  account cannot sign push notifications (`aps-environment`): for a test build
  on a free account, leave push out of a local, uncommitted build.

## Task 5: the desktop chat page in the phone app (written on the main computer; test it with the list above)

The phone's web host already exists (`ios/Web/WebHostView.swift`,
`CoreUISchemeHandler.swift`: `girru-app://computer/…` requests go to a
`CoreUISource`, never to the network; Android `web/WebHost.kt`,
`link/Link.kt` › `ContentSource`). What is missing is the computer serving
core-ui and its API calls **through the encrypted session**.

### Facts from the code (read before designing; line numbers as of `ae8b3c62`)

- **The backend does not serve core-ui.** The desktop runs a Node **UI bridge**,
  `packages/core-ui/scripts/application-server.cjs` (`createApplicationServer`,
  :314), on `127.0.0.1:<random port>`. It holds the built files in memory
  (`readCurrent`, :328; `build-artifacts.cjs:93`), serves `index.html` for `/`,
  `/chat`, `/agents`, `/memory`, `/tasks`, `/settings`, `/channels` and
  `assets/*` (:368-374), and proxies `/api/*` to the backend (:429-439). The
  proxy adds the per-launch header `x-agent-player-launch`
  (`backend/src/api/launch-token.ts:18`) and `Authorization`.
- **The bridge already has the gate the phone needs.** It passes only
  allow-listed requests (`allowed()`, :108, :404) and projects every response
  to approved fields (`project()`, :195, :516). It also checks Host, Origin
  and sec-fetch (:351, :358, :380). **Reuse `allowed()` and `project()` for
  the phone**, made narrower for the phone (the threat model list below).
  Don't write a second, different allow list.
- **Build output:** `packages/core-ui/dist/<buildId>/{index.html, assets/…}`
  with a channel pointer `dist/<channel>.json` (`scripts/build.cjs:41-51`).
  Vite `base: '/'`, so assets are absolute `/assets/…`. That is fine under
  `girru-app://computer/`. The desktop loads `http://127.0.0.1:<port>/`
  (`desktop/src/main.cjs:164,175`), never `file://`.
- **The page refuses other origins.** `createSameOriginTransport`
  (`core-ui/src/session.ts:293-343`) uses `location.origin + path`, and
  `isAppOrigin` accepts only `http://127.0.0.1:<port>` (`session.ts:286`,
  `entry-client.ts:6-12`). It must also accept `girru-app://computer` when
  `window.girruShell` is set. Keep its own allow list (`allowedRequest`,
  `session.ts:107`) and header rule (only `Authorization` and `Idempotency-Key`).
- **Auth today:** a JWT from `/api/auth/login` kept in memory
  (`session.ts:351,394`). With "remember me", the bridge swaps the placeholder
  `Bearer dpro-remembered-session` for an HttpOnly cookie (`:386-390`,
  `:527-528`). On the phone the page must not log in or hold a token: the
  computer runs `api.call` as the owner (as `chat.send` does today with
  `role: 'owner'`). The page can get a placeholder session from the shell.
  There is **no helper yet** that runs a route internally as the owner. An
  internal call must satisfy the launch-token hook and the auth gate
  (`auth/auth-gate.ts:347-402`, Bearer only). Nearby examples:
  `plugins/sdk.ts:192-200`, `api/routes/email-compose.ts:253`.
- **Streaming is fetch + SSE format** (`response.body.getReader()`), never
  EventSource or WebSocket. Chat sends with `POST /api/chat` (`text/event-stream`,
  headers `X-Run-Id`, `X-Message-Id`) or `POST /api/chat/conversations/:id/runs`.
  It reads `GET /api/chat/runs/:runId/events?after=N`, and the bridge ends a
  reader after 5 min or 45 s idle, then the page re-attaches
  (`conversation-contract.js:19-23`). This fits the session well: `run`
  frames with `seq` already work as `after=N`.
  `GET /api/terminal/sessions/:id/stream` is owner only and **must stay off the phone**.
- **Chat routes core-ui uses** (`core-ui/src/conversation-contract.js:62-105`):
  conversations list/create/rename/delete (`chat-conversations.ts:610,623,636,655`),
  messages (`:675`), send run (`:704`), run events (`:905`), stop and steer
  (`:958,949`), `GET /api/agents` (`agents-config.ts:104`), `GET /api/models` (`models.ts:17`).
- **Phone command layer:** `runCommand(ctx, body)` in `phone/commands.ts:100`
  switches on `body.type`. Each handler is `async (ctx, body) => data`,
  `only(body, keys)` rejects extra keys, and errors are `CommandError(code)`.
  `ctx = {deviceId, ownerId, push(frame), now()}`. `service.ts` › `onCommand`
  (:481-516) verifies, persists the counter, checks the owner, runs commands
  one at a time per device, and sends bulk frames first-to-drop. A reply over
  `MAX_ENVELOPE - 4096` (1 MiB) becomes `too_large` (`service.ts:543`).
  `chat.send` streams with `followRun` (:164-186).

### Part 1: the computer serves core-ui through the session (protocol addition)

Write it in `packages/relay/PROTOCOL.md` (a new section next to "Inside a
session"), then build it in `packages/backend/src/phone/commands.ts`, with
tests next to `test/phone-link-e2e.test.mjs`.

- **`ui.get {path}`**: one file of the built core-ui (the same build the
  desktop loads), answered `{status, type, body}` with `body` base64 and at
  most about 700 KiB per reply. Bigger files come back in parts or are
  refused. Paths are normalised and must stay inside the build folder: no
  `..`, no absolute paths, no symlinks out, no source maps. Unknown paths get 404.
- **`api.call {method, path, query?, body?}`**: one REST call of core-ui, run
  inside the computer **as the owner** (for example with `app.inject` and the
  owner's identity, never a token sent to the phone), answered
  `{status, headers (content-type only), body}`.
  **Only an allow list of routes**, and nothing else, so an unlocked phone in
  someone else's hands still cannot (PROTOCOL.md threat model):
  - pair, forget or list phones (`/api/phone/*`), or change the relay;
  - open the terminal, run shell or file tools directly, or read credentials,
    API keys, secrets, backups, exports or audit logs;
  - change sign-in, users, roles, two-step sign-in or security settings;
  - install extensions, plugins or MCP servers.

  Start the allow list from what the chat boards need (P3 chat, P4 chat list,
  P5 side panel, P9 new chat with agent and model, P18 ⋯ menu, P6 tasks, P7
  approvals, P8 team) and the board P16 "where every desktop control goes".
  Put the list in one file with a test that fails when a route outside it answers.
- **Streaming chat output:** core-ui's live chat stream (find whether it is
  SSE, WebSocket or a streamed fetch) cannot go through a request-and-answer
  command. Either core-ui uses the session's `run` frames on the phone (the
  bridge hands them to the page), or add `api.stream` that sends the stream's
  events as `run`-like frames until the end. Pick one, write it in PROTOCOL.md, test it.
- Both commands are **signed commands** like the others (counter, time, nonce),
  count as authenticated use, and are refused for an expired or revoked phone.
  Rate-limit them per phone.
- The owner reviews the protocol text before release (PROTOCOL.md says an
  external security review happens before any public release).

### Part 1 result (done; read before Part 3)

- `ui.get {path, part?}` → `{status, type, size, parts, part, build, body}`
  (base64, 600 KiB of the file per answer; fetch every part, and never mix
  two `build` values). Unknown paths answer `{status:404}`.
- `api.call {method, path, body?}` → `{status, body}`; outside the phone's
  list the error is `not_allowed`. The page must never send a token: the
  computer runs the request as the owner.
- `api.stream {path}` for `/api/chat/runs/<runId>/events?after=N` → reply
  `{ok:true}`, then `{type:"stream", ref, data}` frames and one
  `{type:"stream.end", ref, status}`. Give the page an event stream of
  `id: <seq>` / `data: <json of data>` lines; on `dropped` the page
  re-attaches with `after`.
- Errors the app must handle: `not_allowed`, `rate_limited`, `too_large`,
  `ui_unavailable` (no verified build on the computer), `owner_changed`.

### Part 2: the chat page on the phone (owner's decision, 3 November 2026)

- **Only the chat is the desktop page itself**, made to fit a narrow screen.
  The owner makes the desktop pages responsive himself; do not build a
  separate phone layout in core-ui.
- **Every other phone screen is the app's own** and follows its design board:
  unlock, pairing (waiting, check code), lock notice, tasks, approvals (full
  view, too large), team. They use the existing signed commands
  (`tasks.list`, `approval.*`, `team.list`), not `api.call`. Proposed split
  of the boards, to confirm with the owner: chat page (web) = Chat, Chats,
  Details, NewChat, AddMenu, LongPress, Tools, ChatMenu; app's own =
  Main (bottom bar), Unlock, Tasks, Approvals, Team, LockNotice,
  PairWaiting, PairCheck, ApprovalFull, ApprovalTooLarge.
- Still needed in core-ui for the shell (small, not layout):
  `createSameOriginTransport` and `isAppOrigin` (`core-ui/src/session.ts`,
  `entry-client.ts`) must accept `girru-app://computer` when
  `window.girruShell` is set, and the page must start signed in as the owner
  without a login (a placeholder session from the shell). This is done on the
  main computer next; pull `phone/app` before Part 3.

### Part 3: the apps load core-ui through the session

- **iPhone:** a `CoreUISource` built on `SessionLink`: `GET` of a page file →
  `ui.get`; the page's API calls → `api.call` (and the stream, Part 1).
  Replace `UnavailableCoreUISource`. Keep: no `http` fallback, the bridge
  answers `locked` while the app is locked, and nothing is loaded before the unlock.
- **Android:** first the session connector (a `CommandSender` on the
  relay, like the iPhone's `SessionLink`: hs1/hs2 with `crypto/G1Session.kt`,
  sealed commands in order, replies by ref, run frames, `approval.pending`),
  tested with `PairCheckTest` the way PairCheck tests the iPhone. Then a
  `ContentSource` on it.
- Test: the simulator, paired through the real relay (`pair-harness.mjs
  --manual`), opens the chat list, opens a chat, sends a message and sees the
  reply stream in.

## Later tasks (after Task 5)

1. Real iPhone and Android checks from Tasks 2 and 3 (Secure Enclave key,
   StrongBox / TEE, lock, blocked screenshots, icons), once the owner has an
   Apple ID in Xcode and the phones in developer mode.
2. The owner's features in `PHONE_FEATURES.md`: voice to text, quick actions,
   widget with agent chips, typed-code pairing (protocol proposal there, needs
   the owner's OK), files on the link (photos, camera, files, paste, voice
   messages, share into Girru), store review access.
3. The "Only on this Wi-Fi" path in both apps (the computer's listener is
   built but off; turning it on is an open decision).
4. Push notifications (Firebase, APNs key on the relay only).

## How to report back

Add to `docs/handoff/RESULT.md` on `phone/app`, for each task: what ran,
pass/fail counts, the device and OS version, every commit (hash + one line),
screenshots if possible, and anything that blocked you. Commit as the
repository owner, push `phone/app`, and stop.

## Open questions (do not decide them; list anything new you find)

- May the "Only on this Wi-Fi" path listen on the home network address of the
  computer (today everything listens on 127.0.0.1 only)?
- An owner with two-step sign-in approving from the phone: phone biometric
  plus a computer receipt, or always on the computer (today: on the computer)?
- Should "Forget this phone" in the new-phone notice ask for confirmation (today: no)?
- Real App Store and Google Play links (today both point to `https://girru.dev/app`).
- The typed-code pairing proposal and the store review access (`PHONE_FEATURES.md` §5, §6).
- The `api.call` allow list: which desktop controls the phone may use (board P16 is the starting point).
- iPhone device build warning: support all orientations, or set `UIRequiresFullScreen`?
