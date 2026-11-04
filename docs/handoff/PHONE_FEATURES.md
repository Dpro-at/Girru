# Phone app: features the owner asked for (plan, not built)

The owner's list from 3 November 2026, worked out per platform: what each
feature needs, which permission it asks for, and what is missing on the
computer or in `packages/relay/PROTOCOL.md`. Nothing here is built yet.
Decisions for the owner are marked **Decide**.

The rules that hold for every item:

- The app lock stays on. A shortcut, a widget or a share opens the app behind
  the lock, and nothing is sent before the unlock.
- Nothing readable leaves the app outside it. Home screen surfaces (shortcuts,
  widgets) show only what the owner chose, and chat content never.
- Everything goes to the computer through the end-to-end session (signed
  commands, sealed envelopes). The relay sees nothing new.
- Ask for a permission at the moment it is needed (the first tap on the
  microphone), never at the first launch.

## 1. Inside the chat: microphone, camera, photos, files, paste

| Feature | iPhone | Android | Permission |
|---|---|---|---|
| **Voice → text** (talk instead of typing) | `SFSpeechRecognizer`, on-device only (`requiresOnDeviceRecognition`) | `SpeechRecognizer` (on-device when offered, `EXTRA_PREFER_OFFLINE`) | iPhone: `NSMicrophoneUsageDescription` + `NSSpeechRecognitionUsageDescription`. Android: `RECORD_AUDIO` |
| **Voice message** (send the recording itself) | `AVAudioRecorder`, AAC | `MediaRecorder`, AAC | Microphone, as above |
| **Take a photo** | `UIImagePickerController` (camera) | `ActivityResultContracts.TakePicture` | Camera (`NSCameraUsageDescription` must change: today it says "only to scan the pairing code") |
| **Pick photos / videos** | `PHPickerViewController` | Photo Picker (`PickVisualMedia`) | **None**: both pickers run outside the app and give only what the owner picks |
| **Pick any file** | `UIDocumentPickerViewController` (Files, iCloud Drive, …) | Storage Access Framework (`OpenDocument`) | **None** |
| **Paste** text, images or files | `UIPasteControl` / `PasteButton` (no "Allow Paste" prompt when the owner taps it) | Clipboard; Android 12+ shows its own notice | None |

**Voice → text needs no computer change:** the phone sends the words with the
existing `chat.send {message, agentId}`. Proposed as the first step.

**Everything else needs files on the link, which v1 does not have yet.**
PROTOCOL.md › Files describes chunks (at most 1 MiB per envelope, previews
first, resume after a drop), but no command carries them. To add:

- the commands `file.put` (start, chunk, finish; with a size limit and a hash),
  and `chat.send` with `attachments: [fileId…]`;
- on the computer: where uploads are kept (the chat's files), size limits, and
  a virus and type check before an agent opens them;
- photos are shrunk on the phone before sending (**Decide**: always, or ask).

## 2. Quick actions on the app icon (long press)

| | iPhone | Android |
|---|---|---|
| API | Home screen quick actions (`UIApplicationShortcutItem`, dynamic, up to 4 shown) | App shortcuts (`ShortcutManagerCompat`, dynamic, up to 4) |
| Proposed items | "Message <main agent>", "Voice message", the last one or two chats | Same |
| Opens | the app behind the lock, then that chat with the keyboard or microphone ready | same |

**Decide:** show the **titles** of recent chats on the home screen? They can be
seen without unlocking the phone app. Proposed: agent names only by default,
chat titles behind a setting that is off.

## 3. Share into Girru from any app

Share a photo, file, link or text from Photos, Files, Safari, WhatsApp, … into
Girru, then choose the agent or chat.

| | iPhone | Android |
|---|---|---|
| API | Share Extension (a new target, like the notification extension) | `ACTION_SEND` / `ACTION_SEND_MULTIPLE` intent filters on a share activity |
| How it sends | The extension is small and short-lived (about 120 MB of memory). It keeps the shared item in the app group's protected folder and opens Girru, which asks for the unlock, shows the agent and chat picker, and sends. | The share activity is part of the app: unlock, pick the agent or chat, send. |
| Needs | Files on the link (section 1) for anything but text and links | same |

Android 10+ can also show **direct share** targets (the main agent, recent
chats) in the share sheet, with the same privacy rule as the quick actions.

## 4. Widget: talk to an agent from the home screen

A home screen widget with buttons: microphone, "Message", and the owner's
agents as chips (name and colour). The owner chooses which agents appear.

| | iPhone | Android |
|---|---|---|
| API | WidgetKit, interactive buttons with App Intents (iOS 17); configurable widget (`AppIntentConfiguration`) to pick the agents; also on the lock screen | App widget (Jetpack Glance) with a configure screen to pick the agents |
| A tap | opens the app behind the lock on that agent: keyboard ready, or recording started for the microphone (a widget itself cannot record) | same |
| Data the widget sees | agent ids, names and colours only, copied by the app after `team.list` into the app group / app storage. No chat content, no keys. | same |
| Extras | Control Center button (iOS 18) and Siri / Shortcuts: "Ask Girru" with App Intents | Quick Settings tile |

`team.list` already returns the agents, and `chat.send` already takes an
`agentId`, so the widget needs no computer change.

## 5. Pairing by typing the code (proposal for the protocol)

Today "Type the code instead" checks the code's form only: a 12-character code
cannot carry the computer's key and the pairing secret that the QR code
carries. It matters for phones that cannot scan (a broken camera, a computer
in another room) and for **store review**: Apple's and Google's reviewers
cannot scan a QR code on our review computer, but they can type a code from
the review notes.

**Proposal (draft, for the owner and the external security review):**

1. Next to the QR code, the computer shows the 12-character code `c` (60 bits,
   Crockford base32, the `ABCD-EFGH-JKMN` form the apps already accept). It
   renews with the QR code every 2 minutes and works once.
2. Both sides derive from `c` a lookup id and a key:
   `lookup = "p_" + base64url(HKDF(c, info "girru/v1/code-id", 32))` and
   `codeKey = HKDF(c, info "girru/v1/code-key", 32)`.
   The computer opens `lookup` on its relay like a pairing id.
3. The phone connects to its configured relay (default
   `wss://relay.girru.net/v1`), sends `g1.pcode` (empty, sealed under `codeKey`)
   to `lookup`, and the computer answers with the full QR text sealed under
   `codeKey` and signed by its identity key.
4. From there pairing goes on exactly as after a scan: `g1.preq`, `g1.pchal`,
   **the 6-digit check code on both screens**, Allow on the computer, `g1.pwel`.

Why it holds: the relay sees only `lookup`. Opening the offer needs `c`, which
is only on the computer's screen. Guessing 60 bits within 2 minutes is not
possible online (one request per lookup id, the relay's rate limits), and the
check code still binds the phone's key before the owner clicks Allow. The
cost: the phone must already know the relay (a code does not carry it), and a
typed code is weaker than a scanned one against someone who reads the screen.
That is the same risk as a photo of the QR code, and the check code covers it.

**Decide:** accept this direction, so it can go into PROTOCOL.md and be built
on the computer and in both apps.

## 6. Store review access

The reviewers must be able to use the app without our help. Proposed: a
**review computer** that stays online with demo agents (no real data). The
review notes give a typed code (section 5), refreshed by a small helper the
owner starts before each submission. Alternative: a built-in demo mode that
talks to a fake computer inside the app. It is simpler for review but shows
less of the real app. **Decide.**

## Proposed order

0. The rest of Task 4 first: the session connector in both apps (handshake,
   signed commands, replies, live run frames). Everything below sends through it.
1. Voice → text in the chat (no computer change).
2. Quick actions and the widget with agent chips (no computer change).
3. Typed-code pairing (protocol addition; needed for store review).
4. Files on the link, then photos, camera, files, paste, voice messages and
   share into Girru.
5. Store review setup (section 6), store listings.
