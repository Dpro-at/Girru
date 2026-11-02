# Girru relay

A small, stateless server that passes end-to-end encrypted messages between
Girru on your computer and the Girru phone app when the two cannot reach each
other directly. It is the last path the phone tries: local network first, then
a direct connection, then the relay.

The relay is open source so anyone can check what it does: **it passes sealed
envelopes and stores nothing.** The full protocol and threat model are in
[PROTOCOL.md](PROTOCOL.md).

## What it sees and keeps

- **Sees:** device ids and their public keys (to check who is connecting), the
  allow lists devices send, IP addresses, and the size and time of each
  envelope.
- **Keeps:** only an in-memory list of live connections. When a device
  disconnects, its entry is gone. When the process stops, everything is gone.
- **Never:** message content, files, private keys or session keys. No database,
  no files written, no message logs. Envelopes for a device that is offline are
  dropped and the sender is told; the computer keeps and resends.

The test `test/no-content-written.test.mjs` runs the relay in empty folders,
pushes marked messages through it and fails if any of them shows up on disk or
in its output.

## Run it locally

Needs Node.js 20 or newer. No extra packages: the relay uses only Node's
built-in modules.

```bash
cd packages/relay
npm run build
npm start                       # listens on 127.0.0.1:41540
```

Settings (environment variables):

| Variable | Default | Meaning |
|---|---|---|
| `GIRRU_RELAY_URL` | `ws://<host>:<port>/v1` | This relay's public name, as devices dial it (for example `wss://relay.example.org/v1`). Devices sign it in their hello, so it must match their configured address |
| `GIRRU_RELAY_HOST` | `127.0.0.1` | Interface to bind |
| `GIRRU_RELAY_PORT` | `41540` | Port (`0` = any free port) |
| `GIRRU_RELAY_MAX_ENVELOPE_BYTES` | `1048576` | Largest envelope |
| `GIRRU_RELAY_MESSAGES_PER_SECOND` | `50` | Steady message rate per connection |
| `GIRRU_RELAY_BYTES_PER_SECOND` | `4194304` | Steady byte rate per connection |
| `GIRRU_RELAY_MAX_CONNECTIONS` | `10000` | Live connections in total |

`GET /health` answers `ok`. Devices connect with WebSocket at `/v1`.

## Self-hosting

Companies and advanced users can run their own relay; our servers are then not
involved at all.

- Keep the relay bound to `127.0.0.1` and put a TLS reverse proxy in front of
  it (so devices connect with `wss://`). Forward WebSocket upgrades for `/v1`.
- Turn off access logs in the proxy, or keep them free of request bodies (the
  relay itself logs nothing).
- The relay holds no state, so you can run several copies behind one name.
- Set `GIRRU_RELAY_URL` to the public `wss://` address and point Girru on
  the computer and the phone app to that same address.

## Tests

```bash
cd packages/relay
npm test          # node:test, everything on 127.0.0.1
npm run typecheck
```

## Package layout

| File | What it is |
|---|---|
| `src/relay.ts` | The relay: hello check, allow lists, pairing ids, forwarding, limits |
| `src/websocket.ts` | Minimal WebSocket server framing on Node built-ins |
| `src/main.ts` | Command-line entry point |
| `src/e2e.ts` | Device-side reference code: identity keys, session handshake, envelope seal/open, signed commands with replay rejection and pairing lifetime. Used by the computer; the phone apps match its bytes |
| `PROTOCOL.md` | Protocol and threat model |
