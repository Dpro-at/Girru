# Girru phone link protocol (v1, draft)

This document describes how the Girru phone app talks to Girru on your
computer: how a phone is paired, how messages are encrypted, how commands are
signed, what our relay server can and cannot see, and what happens if the relay
is hacked.

Status: **draft for review.** The relay and the reference code in this package
follow it. The pairing screens, the phone apps and push notifications are
built later on top of it. An external security review of this protocol and the
relay happens before any public release of the phone app.

## The short version

- Your phone and your computer hold the only keys. Keys are exchanged
  directly between the two devices when you pair, using a QR code shown on
  your computer. The relay never sees a private key or a message key.
- Every message is encrypted end to end. The relay passes sealed envelopes it
  cannot open.
- Every command from the phone is signed by the phone's own key and carries a
  counter and a time, so it cannot be forged or played again.
- A new phone is added only when you click Approve **on the computer**.
- The relay keeps only a live, in-memory list of who is connected. It writes
  nothing to disk and keeps no message, ever.
- If the relay were fully taken over by an attacker, the worst they could do is
  stop the service and see metadata (which devices are online, when and how
  much they send). They could not read anything or run anything on your
  computer.

## Words used here

| Word | Meaning |
|---|---|
| Computer | Girru running on your Mac, Windows or Linux machine. It is the authority: it decides which phones are paired. |
| Phone | The Girru phone app (iOS or Android). |
| Device | A computer or a phone. Each has its own identity key. |
| Device id | The SHA-256 hash of a device's identity public key, written as 43 characters of base64url. |
| Relay | A small server that passes envelopes between devices that cannot reach each other directly. Anyone can run their own. |
| Envelope | One encrypted message, as an opaque text string. |
| Owner | You: the person who owns the computer and approves phones. |

## Building blocks

Only well-known primitives that ship with each platform are used. There is no
home-made cryptography and no extra crypto library.

| Purpose | Primitive | Computer | iPhone | Android |
|---|---|---|---|---|
| Identity signatures | ECDSA P-256 with SHA-256 (DER signatures) | Node `crypto` | CryptoKit, Secure Enclave | Android Keystore (StrongBox when present) |
| Key agreement | ECDH P-256 with fresh keys per session | Node `crypto` | CryptoKit | Android Keystore / JCA |
| Key derivation | HKDF-SHA-256 | Node `crypto` | CryptoKit | HMAC-SHA-256 (RFC 5869) |
| Encryption | AES-256-GCM | Node `crypto` | CryptoKit | JCA `AES/GCM/NoPadding` |
| Hashing | SHA-256 | Node `crypto` | CryptoKit | JCA |
| Randomness | The platform's secure random source | `crypto.randomBytes` | `SecRandomCopyBytes` | `SecureRandom` |

This set is called suite **g1**. Every envelope starts with `g1.` so a later
suite can be added without confusion.

Why P-256 and not Curve25519: the iPhone Secure Enclave and most Android
hardware key stores only hold P-256 keys. Using P-256 everywhere lets the
phone's identity key live in hardware, where it cannot be copied out.

All public keys travel as SPKI DER bytes, written in unpadded base64url.

## Device identity keys

Each device creates one identity key pair the first time it runs the phone
link. The private key never leaves the device.

- **Phone.** The key is created inside the Secure Enclave (iPhone) or Android
  Keystore, marked non-exportable, and can be used only while the app is
  unlocked (Face ID, Touch ID, fingerprint, face or the phone passcode; the app
  lock cannot be turned off). Sensitive actions, such as opening the terminal
  or approving a high-risk request, ask for a fresh biometric check before the
  key signs. Uninstalling the app destroys the key; the phone must then be
  paired again.
- **Computer.** The key is kept in the computer's protected key store (macOS
  Keychain, Windows Credential Manager / DPAPI, or the Girru data folder
  encrypted at rest on Linux). It is never sent anywhere.
- **Device id.** `base64url(SHA-256(SPKI DER of the public key))`. Because the
  id is derived from the key, nobody can claim a device id without holding its
  private key.

## Pairing

Pairing introduces a phone to a computer and exchanges their identity public
keys. It happens once per phone.

1. **The owner opens Settings › Phone on the computer** and chooses to add a
   phone. The computer creates a one-time pairing secret and shows a QR code
   (text form under "QR code" below) with:
   - protocol version (`1`),
   - the computer's device id and identity public key,
   - a fresh pairing id (`p_` followed by 32 random bytes in base64url; the
     prefix keeps it apart from device ids) used only as a temporary mailbox on
     the relay,
   - the pairing secret (32 random bytes),
   - the relay address and, when known, the computer's local network
     addresses,
   - an expiry time (at most 10 minutes).

   The QR code is only shown on the computer's screen. It never passes through
   the relay.
2. **The phone scans the QR code.** It now knows the computer's real public key
   from a channel the relay cannot touch (the screen). It creates its identity
   key if it has none.
3. **The phone sends a pairing request** (`g1.preq`, below) to the pairing id,
   over the local network if it can, else through the relay. The request
   carries the phone's public key, a name for the phone ("Work iPhone"), its
   platform, its push token when notifications are allowed, and optionally
   the lifetime the owner would like (see Pairing lifetime). It is signed by
   the phone's identity key, which proves the phone holds the key it sends, and
   it is encrypted and authenticated under the pairing key, so only someone who
   saw the QR code can produce or read it.
4. **Both screens show the same 6-digit check code** (formula below). The owner
   checks the codes match.
5. **The owner confirms or changes the pairing lifetime and clicks Approve on
   the computer.** Nothing is paired without this click; the phone cannot
   approve itself, and the relay cannot approve anything.
6. **The computer sends a signed welcome** (`g1.pwel`, below), encrypted under
   the pairing key and signed with the computer's identity key. It carries the
   per-phone notification key (see Notifications) and the final pairing
   lifetime. The phone checks the signature against the public key it got from
   the QR code before it reads anything inside.
7. **The pairing secret and pairing id are thrown away** on both sides. The
   computer stores the phone's public key, name, push token, pairing
   lifetime, last use time and a command counter of 0.
   The phone stores the computer's public key, the notification key and the
   lifetime from the welcome.
8. **Every other paired device is told** that a new phone was added, so a
   pairing you did not make is noticed at once.

A pairing id opens on the relay for at most 10 minutes and passes at most 16
messages, then closes. A QR code works for one phone only.

Rules on the computer while a QR code is open:

- It accepts **one** pairing request per pairing id. If a second, different
  request arrives for the same pairing id, it cancels this pairing, shows a
  warning (someone else may have seen the QR code) and asks the owner to start
  again. This matters because the check code is short: someone who
  photographed the QR code could search for a key whose check code matches
  the real phone's. With one request per QR code, such a request either
  replaces nothing (it is refused) or is the only one, and then the owner's
  phone shows a different code or none.
- The phone's device id as seen on the way in (the `from` the relay stamps, or
  the local session's peer) must equal SHA-256 of the `key` in the request.
- An expired QR code (`exp` passed) accepts nothing.

### QR code

The QR code holds one URI:

```
girru://pair?v=1&cid=<computer device id>&ck=<computer public key>
            &pid=<pairing id>&ps=<pairing secret>&exp=<unix seconds>
            &relay=<relay url>&lan=<host:port>[,<host:port>…]&name=<computer name>
```

| Field | Meaning | Rule |
|---|---|---|
| `v` | protocol version | `1` |
| `cid` | computer device id | 43 characters base64url; must equal SHA-256 of `ck` |
| `ck` | computer identity public key | P-256 SPKI DER, base64url |
| `pid` | pairing id | `p_` + 43 characters base64url (32 bytes) |
| `ps` | pairing secret | 32 bytes, base64url |
| `exp` | expiry, in seconds since 1970 | in the future and at most 10 minutes ahead |
| `relay` | relay name | exactly the name the relay sends in its challenge, `wss://<host>/v1`; optional |
| `lan` | the computer's local addresses | up to 4 `host:port`, private address ranges, link-local or `.local` names only; optional |
| `name` | computer name for display | up to 64 characters, no control characters; optional |

Values are URL-encoded. At least one of `relay` and `lan` is required. The whole
text is at most 1024 bytes. Unknown fields are ignored; a repeated field makes
the code invalid. The phone checks `cid` against `ck` before it trusts either.

### Pairing key

```
pairing key = HKDF-SHA-256(pairing secret, salt = UTF-8 bytes of the pairing id text, info = "girru/v1/pair", 32 bytes)
```

The salt is the pairing id exactly as written in the QR code, `p_` included.

### Pairing request (`g1.preq`)

```
g1.preq.<nonce>.<box>
nonce = base64url(12 random bytes)
box   = base64url(AES-256-GCM(pairing key, nonce, JSON request) ciphertext || 16-byte tag)
AAD   = "girru/v1/preq\n" + pairing id
```

The JSON request:

| Field | Meaning |
|---|---|
| `key` | the phone's identity public key, SPKI DER, base64url |
| `name` | a name for the phone, e.g. "Work iPhone" |
| `platform` | e.g. `ios` or `android` |
| `push` | optional: the push token (APNs device token as hex on iPhone; the FCM registration token on Android). Left out until the owner allows notifications |
| `lifetimeDays` | optional: the lifetime the owner would like, 30, 60, 90 or 120. Left out = no wish; the computer offers its default |
| `sig` | the phone's signature, below. Required |

The request is sent with `{t:"send", pairing, env}` on the relay, so it arrives
with the phone's proven device id in `from`.

**Request signature.** `sig` proves the phone holds the private key of the
`key` it sends:

```
signed text = "girru/v1/preq-sig\n" + pairing id + "\n" + phone device id + "\n" + nonce
sig         = base64url(ECDSA-P256-SHA256, DER, by the phone's identity key over the signed text)
```

- The pairing id is exactly as in the QR code, `p_` included.
- The phone device id is base64url(SHA-256(phone SPKI DER)): the 43-character
  id of the `key` in the same request.
- `nonce` is the base64url text of this request's nonce, exactly as it appears
  in the `g1.preq` envelope.
- Every part is UTF-8, `\n` is the single byte 0x0A, and there is no newline
  at the end.

The computer opens the box, then verifies `sig` against `key`, and refuses the
request when `sig` is missing or does not verify. Binding the nonce stops a
signature being lifted into another request; binding the pairing id stops it
being used for another QR code.

### Check code

```
digest = SHA-256("girru/v1/check\n" || pairing secret || computer SPKI DER || phone SPKI DER)
code   = (first 4 bytes of digest as a big-endian unsigned number) mod 1 000 000,
         written as 6 digits with leading zeros
```

`||` joins raw bytes. Both public keys are P-256 SPKI DER (fixed length), so
the joined bytes cannot be read two ways.

### Welcome (`g1.pwel`)

```
g1.pwel.<payload>.<sig>
payload = base64url(nonce(12 random bytes) || AES-256-GCM ciphertext || 16-byte tag)
          under the pairing key, AAD = "girru/v1/pwel\n" + pairing id
sig     = base64url(ECDSA-P256-SHA256 by the computer's identity key over "girru/v1/pwel\n" + payload)
```

The JSON welcome inside:

| Field | Meaning |
|---|---|
| `computer` | the computer's device id; must equal `cid` from the QR code |
| `phone` | the phone's device id; must be this phone |
| `notifyKey` | the per-phone notification key, 32 random bytes, base64url |
| `lifetimeDays` | the final pairing lifetime: 30, 60, 90 or 120. Left out (or `null`) = never expires. Any other value makes the welcome invalid |
| `name` | optional: the computer's display name |

The phone checks the signature first (against `ck` from the QR code), then
decrypts, then checks `computer`, `phone`, the notification key length and the
lifetime. Anything wrong and the welcome is refused.

### Pairing lifetime: scan once, stay paired

A pairing lasts, without use, **30, 60, 90 or 120 days, or never expires**.
"Never expires" is allowed and shown with a warning.

- **Who decides.** The phone may propose a lifetime in its pairing request.
  The owner confirms or changes it on the computer at Approve; the computer's
  default is 90 days when the phone proposes none. The value in the
  computer's signed welcome is the final one, and the phone uses that value.
  The owner can change it later on the computer.
- The time counts from the **last use**, not from the pairing day. Every
  authenticated use (an accepted signed command or a finished session
  handshake) starts the time again. A phone in regular use never has to scan
  again.
- A phone not used for its whole lifetime is forgotten by the computer and must
  pair again with a new QR code and the owner's approval.
- The **computer is the only authority** on this. It stores, per phone, the
  last use time, the lifetime and the last command counter, and refuses an
  expired phone even when its signature is valid. The phone's own copy of the
  lifetime is only for showing it. The relay stores nothing about pairings or
  their lifetime.
- Revoke one and revoke all (below) work at any time, whatever the lifetime.
- The app lock (biometrics or passcode on every open) is separate and is not
  affected by the pairing lifetime.

What the relay sees during pairing: a random pairing id, the phone's device id,
the computer's device id, sizes and times. Nothing else.

## Connecting: three paths

The phone always tries the paths in this order and uses the first one that
works. The app shows which path is active.

1. **Local network.** When phone and computer are on the same network, the
   phone connects to the computer directly, using the local addresses learned
   at pairing or announced on the local network.
2. **Direct over the internet.** The two devices try to reach each other
   directly through their routers (NAT traversal, as in video calls). The
   connection details they swap for this are themselves sent as encrypted
   envelopes through the relay.
3. **Relay.** As the last resort, envelopes go through the relay.

The same end-to-end encryption and the same signed commands are used on every
path. The computer only dials out (to the relay and for the direct path), so it
never needs an open port to the internet. Local network listening is limited
to the local network and only accepts paired devices.

## Session handshake

Each time two paired devices start talking (after a reconnect or a path
change) they run a short handshake to make fresh session keys. This gives
forward secrecy: a key stolen later does not open old traffic.

Both handshake messages are signed with the sender's identity key. The receiver
checks the signature against the public key it stored at pairing.

**hs1** (from the side that opens the session, usually the phone):

```
g1.hs1.<payload>.<signature>
payload = base64url(JSON {from, to, eph, ts, nonce})
signature = ECDSA-P256-SHA256 over the text "girru/v1/hs1\n" + payload
```

- `from`, `to`: device ids.
- `eph`: a fresh ECDH P-256 public key for this session only.
- `ts`: the sender's clock in milliseconds; refused if more than 2 minutes off.
- `nonce`: 16 random bytes.

**hs2** (the answer):

```
g1.hs2.<payload>.<signature>
payload = base64url(JSON {from, to, eph, ts, h1})
signature = ECDSA-P256-SHA256 over "girru/v1/hs2\n" + payload
h1 = base64url(SHA-256(the whole hs1 text))
```

**Keys.** Both sides compute:

```
shared     = ECDH(own eph private key, peer eph public key)
transcript = SHA-256(hs1 text + "\n" + hs2 payload)
okm        = HKDF-SHA-256(shared, salt = transcript, info = "girru/v1/session", 64 bytes)
key opener→answerer = okm[0..32],  key answerer→opener = okm[32..64]
session id = base64url(transcript[0..16])
```

Signatures are always made over the exact base64url text that was sent, so no
side ever has to re-encode JSON the same way as the other.

## Envelope

Every message after the handshake is one envelope:

```
g1.msg.<header>.<body>
header = base64url(JSON {sid, seq, from, to})
body   = base64url(AES-256-GCM ciphertext || 16-byte tag)
```

- The key is the session key for this direction.
- The 12-byte GCM nonce is 4 zero bytes followed by `seq` as an 8-byte
  big-endian number. Each direction has its own key, and `seq` starts at 1 and
  only grows, so a nonce is never used twice with the same key.
- The header text is the additional authenticated data: changing any header
  field breaks the tag.
- The receiver refuses an envelope whose session id or device ids do not match,
  whose tag does not check, or whose `seq` is not above the last accepted one
  (replay or reorder). The counter moves only after the tag checks.

The header is readable by the relay but carries nothing it does not already
know (it routes by device id anyway). Message type, text, file names and every
other detail are inside the encrypted body.

### Files

Large content (photos, video, files) is cut into chunks; each chunk is one
envelope of at most 1 MiB, and transfers can resume after a dropped connection.
Previews are sent first, full files only when opened. The relay never stores a
chunk: if the phone is offline, the computer keeps the file and sends it later.

## Signed commands

Every command from a phone to the computer (send a chat message, approve,
deny, start a task, open the terminal) is signed by the phone's identity key,
on top of the session encryption. The computer's gate checks the signature
itself, so a command is accepted only if the phone's own key made it, whatever
path it came by.

A signed command is a JSON object inside an envelope:

```
{ device, to, ctr, ts, nonce, body, sig }
signed text = "girru/v1/cmd\n" + device + "\n" + to + "\n" + ctr + "\n" + ts
              + "\n" + nonce + "\n" + base64url(SHA-256(body))
sig = ECDSA-P256-SHA256 over the signed text
```

- `device`: the phone's device id. `to`: the computer's device id, so a command
  meant for one computer cannot be replayed to another.
- `ctr`: a counter the phone keeps in its secure storage and raises by at least
  one for every command.
- `ts`: the phone's clock in milliseconds. `nonce`: 16 random bytes.
- `body`: the command itself, as the exact text that was signed.

The computer accepts a command only when all of these hold, and refuses it
otherwise:

1. the phone is paired with this computer and not revoked;
2. `to` is this computer;
3. the signature checks against that phone's stored public key;
4. the pairing has not expired (see Pairing lifetime); an accepted command
   renews it;
5. `ts` is within 2 minutes of the computer's clock;
6. `ctr` is above the last counter accepted from that phone (the computer
   stores it, so this holds across restarts);
7. the nonce was not seen in the time window.

After the check, the normal Girru permission rules still apply: a paired phone
can only do what the owner can do on the computer, and each agent's off / ask /
allow permissions stay in force.

### Approvals from the phone

An approval or denial is the signed command

```
body = {"approve": true | false, "id": "<approval id>", "type": "approval.decide"}
```

(the iPhone app writes the keys in sorted order; the computer reads the body as
JSON and must not depend on key order, since the signature covers the exact
text either way). `id` is the approval id from the approval notice or the
Approvals list.

The computer acts on it only when, besides every check above:

1. an approval with this id exists and is still **pending** (not decided, not
   expired, not withdrawn);
2. that approval was **sent to this phone** (the computer records which paired
   phones it notified or showed it to); a phone cannot decide an approval it
   was never given;
3. for a sensitive approval, the computer's own record says it is sensitive;
   whatever the phone claims about the kind does not lower the bar.

The first decision wins: once decided, the approval is no longer pending and any
later `approval.decide` for it is refused.

**"Is this approval still pending?"** Before it asks for the owner's
biometrics and signs, the phone asks the computer:

```
query  = {"type": "approval.pending", "id": "<approval id>"}
answer = {"type": "approval.pending", "id": "<approval id>", "pending": true | false}
```

Both travel as envelopes inside the phone's session, so only the paired
computer can answer and only the paired phone can ask. The query changes
nothing and needs no command signature. The computer answers `pending: true`
only under rules 1 and 2 above, so the answer tells a phone nothing about
approvals it was not given. The answer is a hint for the phone's screen, not a
permission: the computer checks again when the signed `approval.decide`
arrives.

## Relay wire protocol

The relay speaks WebSocket at the path `/v1`. In production it sits behind
TLS (`wss://`). Every frame is one JSON text message.

| Direction | Frame | Meaning |
|---|---|---|
| relay → device | `{t:"challenge", v:1, relay, nonce}` | Sent on connect. `relay` is this relay's name, the URL devices dial (for example `wss://relay.example.org/v1`). `nonce` is 32 random bytes, new for each connection. The device refuses a challenge whose `relay` is not the relay it was configured to reach. |
| device → relay | `{t:"hello", v:1, key, sig, allow, pairing}` | `key` = identity public key, `sig` = signature over `"girru/relay/v1/hello\n" + relay + "\n" + nonce`, so a hello is good for one relay and one connection only. `allow` = device ids that may send to this device (up to 64). `pairing` = pairing ids to open (computer only, up to 4). |
| relay → device | `{t:"ready", id}` | The hello checked out; `id` is the proven device id. |
| device → relay | `{t:"send", to, env, ref?}` | Pass `env` to the device `to`. `ref` is an optional short tag for drop reports. |
| device → relay | `{t:"send", pairing, env, ref?}` | Pass `env` to whoever holds the open pairing id `pairing`. A frame with both `to` and `pairing`, or neither, is refused. |
| relay → device | `{t:"msg", from, env, via?}` | An envelope. `from` is the sender's proven id, set by the relay. `via` is the pairing id when it came through one. |
| relay → device | `{t:"drop", reason, ref?}` | The envelope was not delivered: `offline` (receiver not connected, unknown, or not allowing the sender: these look the same so nobody can probe who is online) or `busy` (receiver too slow). |
| device → relay | `{t:"allow", allow}` → `{t:"allowed", count}` | Replace the allow list (for example after a revoke). |
| device → relay | `{t:"pairing", open}` → `{t:"paired", open, refused?}` | Replace the open pairing ids. |
| relay → device | `{t:"error", code, ref?}` | `rate_limited`, `too_large` or `bad_frame`. |

Rules the relay enforces:

- **Two separate address spaces.** Device ids (43 characters) and pairing ids
  (`p_` + 43 characters) have different formats and travel in different
  fields. The relay never looks a device id up as a pairing id or the other
  way round, so a pairing id can never catch traffic meant for a device.
- **Proof of id.** A connection gets a device id only by signing the challenge
  with that id's key. Until then nothing is forwarded. A device that
  reconnects replaces its older connection (close code 4001).
- **Allow lists.** An envelope reaches a device only if that device listed the
  sender. The computer's list holds its paired phones; a phone's list holds its
  computer. Allow lists live only for the life of the connection; devices send
  them again on every connect.
- **No store-and-forward.** Envelopes for a device that is not connected are
  dropped and reported. The sender keeps and resends.
- **Limits.** Envelopes up to 1 MiB; a larger frame closes the connection
  before it is read (close code 1009). Per connection: 50 messages per second
  (burst 200) and 4 MiB per second (burst 8 MiB). Refused frames count as
  strikes; 50 strikes close the connection (close code 1008). A connection
  that does not finish the hello within 10 seconds is closed. Peers that miss a
  ping are dropped. At the WebSocket level: a message may have at most 1024
  fragments (close code 1009); ping, pong, close and continuation frames are
  limited to 100 per second with a burst of 200 (close code 1008); and a
  peer that stops reading is dropped once 8 MiB are waiting for it, even if
  that queue holds only pongs or error frames. All limits are settings.
- **No content handling.** The relay checks only that `env` is a string of
  plain base64url characters and dots, and of allowed size. It never decodes
  it.

## What the relay sees and keeps

| Item | Sees | Keeps |
|---|---|---|
| Device ids and identity **public** keys | Yes, at hello | In memory while connected |
| Allow lists and open pairing ids | Yes | In memory while connected (pairing ids at most 10 minutes) |
| Which phones are paired, pairing lifetimes, last use | No | Never: only the computer keeps these |
| Push tokens | Yes, when the computer asks it to send a notification | Never written to disk; see Notifications |
| IP addresses | Yes, as any server does | Not kept, not logged |
| Times and sizes of envelopes | Yes | Not kept, not logged |
| Message content, file content, file names, chat titles | **No**: encrypted | Never |
| Private keys, session keys, pairing secrets | **No** | Never |

The relay has no database and opens no files. It prints one line when it
starts and one when it stops, and never prints device ids, addresses or
content. The test suite in this package fails if the relay ever writes message
content to disk or to its output.

Because the relay holds nothing that outlives the process, any relay node can
serve any device, and nodes can be added behind one name to grow.

## Notifications

Push notifications go through Apple (APNs) and Google (FCM), which need a
server-held key. The path is:

computer → encrypted, signed payload → relay → APNs / FCM → phone decrypts and
shows it.

- At pairing the phone gives the computer its push token, inside the
  encrypted pairing request. The computer keeps it. To notify, the computer
  hands the relay the token and a sealed payload; the relay passes them to
  APNs or FCM and forgets them.
- The payload is encrypted with a per-phone notification key (32 random bytes
  sent in the signed welcome at pairing) using AES-256-GCM, and signed by the
  computer's identity key. The phone (iOS Notification Service Extension, or
  the Android app) checks the signature and decrypts before showing anything.
  A notification without a valid signature is never shown with its content.
- Apple and Google see only that a notification was sent to a token, and an
  encrypted blob. The APNs key and the Firebase key live only on the relay
  server, never in the apps or in this repository.

### Notice format (`g1.ntf`)

```
g1.ntf.<payload>.<sig>
payload = base64url(JSON {from, to, ctr, ts, box})
box     = base64url(nonce(12 random bytes) || AES-256-GCM ciphertext || 16-byte tag)
          under the notification key, AAD = "girru/v1/ntf\n" + from + "\n" + to + "\n" + ctr
sig     = base64url(ECDSA-P256-SHA256 by the computer's identity key over "girru/v1/ntf\n" + payload)
```

- `from`: the computer's device id. `to`: the phone's device id.
- `ctr`: a counter the computer keeps per phone and raises by at least one for
  every notice.
- `ts`: the computer's clock in milliseconds.
- The whole text is at most 3500 bytes. On iPhone it travels in the `g` key of
  the push payload, with `mutable-content` set so the Notification Service
  Extension can open it; the visible alert text Apple carries is only a
  neutral line with no content.

The encrypted content is JSON `{kind, title, body, approvalId?, group?}`:
`kind` is `approval`, `approval.sensitive` (Approve asks for Face ID / Touch ID
first), `task.failed`, `summary` or `security`; `title` is at most 120
characters and `body` at most 600, with no control characters other than line
breaks; `approvalId` (1 to 64 letters, digits, `-` or `_`) is required for
approvals and comes back in the signed Approve / Deny command; notices with the
same `group` are shown as one thread ("3 tasks finished").

The phone checks, in this order: the signature against the stored computer key;
`from` and `to`; `ts` within **1 hour** of its clock (push can arrive late);
the tag; the content rules; and last the counter. Because Apple and Google may
deliver out of order, the counter uses a **sliding replay window of 64**: a
counter is accepted once, and only if it is above, or among the 64 below, the
highest one seen. The window moves only after everything else checked out, so
a forged or broken notice changes no state. A notice that fails any check is
never shown with its content; the phone shows only the neutral line.

Session envelopes keep the stricter "above the last one" rule; the window is
only for notices.

## Revoke

- **Revoke one phone.** On the computer, Settings › Phone › Remove. The
  computer deletes that phone's public key, ends its sessions and sends the
  relay a new allow list. From that moment its commands fail the signature
  gate (unknown device), whatever path they use.
- **Revoke all phones.** One click on the computer removes every paired phone
  at once, for example after a phone is lost. Pairing again needs a new QR code
  and the owner's approval.
- **From the phone.** The phone can remove itself; this deletes its keys.
- A lost phone cannot be used without its unlock (biometrics or passcode), and
  the owner can revoke it from the computer at any time.

## Updates

The largest real risk is not the relay but the code you install. So:

- Desktop updates and phone app builds are signed with keys kept offline,
  apart from every server. A hacked relay or website cannot ship code.
- Phone apps are also signed by the app stores.
- Later: reproducible Android builds, so anyone can check the store app was
  built from this source.

## Threat model

**Goal:** a fully compromised relay can cause an outage and see metadata. It
can never read content, add a device or run anything on any computer.

### What we protect

Chat messages, files, approvals, task content, terminal sessions, and the power
to give commands to the agents on your computer.

### What happens when something is compromised

| Compromised | What the attacker can do | What they cannot do |
|---|---|---|
| **The relay, fully** (code, memory, network) | Stop or slow the service. Drop, delay or reorder envelopes. See which device ids are online, their IP addresses, when and how much they send. Hand out the push tokens it passes. | Read any message or file (end-to-end encrypted, no keys on the relay). Forge or replay a command (signed by the phone's hardware key, counter and time checked by the computer). Pose as your computer or phone in a handshake (signed by keys exchanged through the QR code). Add a device (only the owner's click on the computer does that, and every device is alerted). Push a fake notification (signed by the computer). Ship code (updates are signed offline). |
| **Our push keys** (APNs / FCM) | Send notifications to tokens. | Show readable content or make a phone act: unsigned notifications are dropped. |
| **The local network** | See that the phone and computer talk, and how much. | Read, change or replay anything: the same encryption and signatures apply. |
| **A phone, stolen while locked** | Nothing useful. | Use the keys: they unlock only with the owner's biometrics or passcode. The owner revokes it from the computer; a forgotten phone also stops working once its pairing lifetime runs out unused. |
| **A phone, unlocked and in someone else's hands** | Act as the owner within the app until it re-locks; sensitive actions still ask for biometrics. | Pair new devices or turn on the terminal from the phone. |
| **The computer itself** | Everything Girru can do on it. | This is outside what the phone link can protect; it relies on the computer's own security. |

### What is not hidden

- Metadata: which devices talk, when, how often, and roughly how much.
  Padding and cover traffic are not part of v1.
- The fact that you use Girru, to anyone watching your network.

### Not in v1

- Message content is not padded, so sizes are visible to the relay.
- Post-compromise recovery inside one session: a new session is made at each
  reconnect and path change, but there is no ratchet inside a session.

## Running your own relay

Companies and advanced users can run their own relay from this package (see
README.md). Devices then point to that address; nothing else changes, and our
servers are not involved at all.

## Versions

This is protocol version 1, suite g1. A new version gets a new relay path
(`/v2`) and a new envelope prefix, and devices state the versions they speak in
the handshake, so old and new can run side by side during an update.
