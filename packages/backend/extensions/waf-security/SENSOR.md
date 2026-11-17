# Server sensor — design and protocol

The sensor is a small, optional program the owner installs on a server **they own**. It watches a
few local signals and pushes alerts to Girru. It is the only part of this app that touches the
server, and it is built so Girru can never touch the server back.

## Hard shape (why it is safe)

- **Outbound-only.** The sensor opens connections *to* Girru's public API. Girru never connects to
  the server, never opens a port on it, never logs in, and never runs anything on it. There is no
  inbound control channel — none exists in the protocol.
- **No secrets in Girru.** Pairing produces one token. Girru stores only its **sha256 hash** and a
  short prefix (see migration `008_waf_sensor.sql`, `token_hash` / `token_prefix`). The token lives
  only on the server. No server password, key, or config is ever sent to or stored by Girru.
- **Alerts are data.** What the sensor sends is recorded and shown as data, never run as a command.
  The app frames it as untrusted input (same rule as the rest of Dpro).
- **Owner-gated.** Only an active owner/admin can pair or revoke a sensor (the pairing route is
  owner-admin; the push route is public but authenticated solely by the token).
- **Least privilege on the server.** The reference sensor reads only: the list of listening sockets,
  a certificate's expiry, counts of failed logins from the auth log, and hashes of a few watched
  config files. It needs no root for the network/cert checks; log/config reads need only read access
  to those files. It changes nothing.

## Pairing

1. In the app → Settings (or Servers → a server → **Pair sensor**), the owner creates a sensor.
   `POST /api/ext/waf-security/sensors` → `{ sensor, token }`. The token (`gss_…`) is shown **once**.
2. The owner puts the token on their server (env var `GIRRU_SENSOR_TOKEN`) with Girru's base URL
   (`GIRRU_URL`) and the pushes begin. Revoke at any time: `DELETE /sensors/:id` (the token stops
   working immediately; status becomes `revoked`).

## Push protocol

`POST {GIRRU_URL}/api/ext/waf-security/sensor/push`
Header: `Authorization: Bearer <token>`  ·  Body (JSON):

```json
{
  "kind": "open-port-change | cert-expiry | failed-login-spike | config-drift | new-listener | heartbeat",
  "severity": "info | low | medium | high | critical",
  "title": "short human line",
  "detail": { "any": "structured context the sensor observed" }
}
```

- `kind: "heartbeat"` just marks the sensor alive (`last_seen_at`), creates no alert.
- Any other kind stores one alert row and raises one Girru notification for the owner, with an
  `actionUrl` back to the app. Unknown kinds/severities fall back to safe defaults; oversized detail
  is truncated. The response is `{ ok: true, stored: true, id }` or `401` for a bad/revoked token.
- Recommended cadence: a heartbeat every few minutes; an alert only on a real change. The sensor
  should back off and retry on a network error; it never needs Girru to be reachable to keep working.

## What each signal means

| kind | the sensor observed | Girru shows |
|---|---|---|
| `new-listener` / `open-port-change` | a port started/stopped listening since last check | which port, old/new state |
| `cert-expiry` | a watched certificate is near or past expiry | days left, which cert |
| `failed-login-spike` | failed-auth count over a window crossed a threshold | count, window, source if known |
| `config-drift` | a watched config file's hash changed | which file, old→new hash |

## Status of this stage

- **Girru side: implemented** in this app — pairing, token hashing, the authenticated push route,
  alert storage, and notification fan-out (`src/sensor.js`, `src/routes.js`, migration 008). Tested
  on localhost (pair → token-auth → alert → notification → revoke).
- **Sensor side: reference only.** `sensor/girru-sensor.mjs` is a dependency-free reference
  implementation of the protocol above (our own code, Node built-ins only). Packaging it as a signed,
  installable binary/service for macOS/Linux/Windows, and distributing it through the Store, needs
  Mohamed's approval (it is a new installable artifact and a release step) — so it stops at the
  reference script and this design.
