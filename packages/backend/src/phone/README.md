# Phone link (computer side)

Pairs the Girru phone app with this computer and serves it over an end-to-end
encrypted link. The contract is `packages/relay/PROTOCOL.md`; this folder is
the computer's half of it. No UI here.

| File | What it does |
|---|---|
| `protocol/e2e.ts`, `protocol/encoding.ts`, `protocol/websocket.ts` | Copies of `packages/relay/src`, unchanged. `test/phone-protocol.test.mjs` fails when they drift: copy them again, never edit them here. |
| `protocol/pairing.ts` | QR code, pairing key, `g1.preq`, check challenge `g1.pchal`, check code, `g1.pwel` (wrapped notification key), `g1.ntf` (both sides). |
| `store.ts` | Migration 164 tables: paired phones, the computer identity, settings, approvals shown to each phone. Private key, notification keys and push tokens are encrypted with the app's `ENCRYPTION_KEY`. |
| `service.ts` | `phoneLink()`: pairing sessions, relay connection, sessions, the command gate. |
| `relay-connector.ts` | Outbound WebSocket to the relay: signed hello, allow list, open pairing ids, backoff with jitter. |
| `commands.ts` | What a phone may ask, run as the owner through the same code as the computer's pages. |
| `ui-bridge.ts` | The desktop chat page on the phone: `ui.get` (files of the verified core-ui build), `api.call` (one page request run as the owner), `api.stream` (a run's live events). |
| `lan-listener.ts` | Wi-Fi path. **Off by default** (see below). |

Owner API: `src/api/routes/phone.ts` (`/api/phone/*`, owner only). Agent
tool: `phone_devices` (read only). No tool pairs, allows or forgets a phone.

## Rules kept here

- The relay connection opens only while a paired anywhere-phone or an open
  pairing needs it, and only after `startPhoneLink()` (server.ts, background
  on). With `AGENT_PLAYER_BACKGROUND=off` nothing dials out.
- A shown QR code renews every 2 minutes; the old pairing id closes on the
  relay at once. One request per pairing id; a second, different one cancels
  the pairing with the warning `second_request`. A pairing screen lasts 10
  minutes in all; a request does not restart that time.
- The check code mixes in a challenge (`g1.pchal`) made only after the
  request arrived, so a key cannot be ground to match it.
- Nothing is paired without the owner's Allow. While Allow runs, the screen
  cannot be closed or replaced (`allowing`); a cancel that still lands (a
  second request, expiry) undoes it. Every other phone then gets a signed
  notice.
- A forgotten phone stays out of the command gate: refreshes run one after
  another and never bring it back; only a new Allow does. A phone paired
  again starts its counter over. A queued command of a phone forgotten
  meanwhile never runs.
- Every command is signed and sealed and passes the counter, time, nonce and
  lifetime checks. The counter is stored before the command runs.
- Each hs1 is answered once; a replay never swaps a session.
- Relay frames with an envelope over 1 MiB or with other characters are
  dropped unread. Run frames give way when the link is backed up (the run
  ends with `slow_link`). Failures inside the computer reply `internal_error`.
- A phone may approve a cut-short preview only after `approval.detail`
  returned the full view of that same hash (kept in memory per phone).
- A phone may decide only approvals it was shown (`approval.pending`). An
  owner with a second factor gets `verification_required`: the phone never
  skips it.
- A `wifi` phone is never on the relay allow list, and relay frames from it
  are ignored.
- Audit rows carry the phone's device id.
- The chat page on the phone passes two gates: the phone's short list in
  `ui-bridge.ts` (chat only; never phones, terminal, project files or
  variables, credentials, sign-in, users, backups, extensions, MCP, deletes
  or uploads) and the desktop bridge's own allow list and answer projection
  (`core-ui/scripts/application-server.cjs`). `test/phone-ui-bridge.test.mjs`
  pins the short list. The request runs through Fastify inject with a
  60-second owner token made for that one request; it never reaches the
  phone. `ui.get` serves only files named in the verified build's manifest.
  Limits per phone: 120 `api.call` and 600 `ui.get` a minute, 4 open streams.

## Wi-Fi listener (needs the owner's decision)

Every service binds to 127.0.0.1. A listener the phone can reach on the local
network must bind to a local network address, so it is built but **not
switched on**: it starts only when the `phone.lanListen` setting holds
`{"host","port"}`, and there is no API that sets it. Until it is on, a `wifi`
phone can be paired and stored but is reached only once the listener runs.
When on, it binds one private, link-local or loopback address (never
`0.0.0.0` or `::`: Wi-Fi shows `failed`), caps only connections that have not
proven an id, drops a phone let in for a pairing once that pairing closes, and
drops peers that miss a ping.

## Not done yet

Push notifications (APNs / FCM through the relay), the direct internet path,
file chunks, the pairing screens, and the second-factor flow on the phone.
