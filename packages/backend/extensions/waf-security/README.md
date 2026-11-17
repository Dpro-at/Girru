# Server & Web Security Scanner

A defensive security app for Girru: watch and test the security of the servers and sites you own —
see what's open, what's weak, and what changed. It only ever checks targets you have confirmed you
own or may test, it never attacks or exploits anything, and every finding is informational with a
fix hint.

## The seven places (one window)

- **Overview** — what needs you now (new critical findings, a certificate expiring, a sensor
  offline). A to-do list, not a dashboard.
- **Servers** — servers you watch. Select one to see open ports, services/versions, TLS/cert and
  coverage. Main action: **Scan now**.
- **Sites** — sites you test. Select one to see security headers, CORS, firewall (WAF) behaviour,
  TLS and coverage.
- **Findings** — everything found, newest first. Select one to see its **evidence** (the exact
  request/response or banner that proves it, stored by content hash) and **Retest** it
  (reproduced / fixed / inconclusive).
- **Campaigns** — a saved test repeated on a schedule, with a score trend and regression flag.
- **This Girru** — self-audit of Girru's own headers, CORS, sign-in and rate limits.
- **Settings** — advanced only: allow private/owned targets (owner-gated, logged), scan pacing
  (quiet / balanced / aggressive), sensor pairing, the payload library, and the `waf_scan` agent
  permission.

## What it checks (all defensive)

- **Ports & services**: a TCP connect inventory of common ports on a server you own, with
  service/version/banner detection. No attack, no login, just what answers.
- **TLS / certificate**: expiry, chain trust, name, and weak protocol/cipher.
- **Security headers / CORS / cookies**: what the site already returns.
- **WAF behaviour**: detects the firewall vendor and runs the 100-pattern test library (11 groups)
  as attack-*shaped* requests to see what the firewall blocks. These are tests of the firewall, not
  attacks on the app behind it.
- **CVE hint**: an offline, advisory heads-up from a banner ("check this product for known issues")
  — never a confirmed vulnerability, never an exploit.

## Ideas that make findings trustworthy

- **Evidence-bound, tamper-evident**: each finding points to the exact bytes that prove it, stored
  by their sha256; a read re-checks the hash. Evidence is tagged by role (baseline / proof /
  supporting / verification).
- **Retest / verdict loop**: a finding can be retested to reproduced / fixed / inconclusive, with an
  "argue the opposite" note recorded for the verdict; original evidence is always kept.
- **Coverage ledger**: every check that ran is recorded, including clean results, so "no issue" is
  always shown next to "and here's what was actually checked".
- **Scope / target gate**: a check only runs against an asset you declared and confirmed you own;
  declarations, confirmations, removals and private-address allowances are logged.
- **Noise governor**: quiet/balanced/aggressive pacing with per-host backoff, so checks stay polite.

## Server sensor (optional, outbound-only)

Install the sensor on a server you own; it pushes alerts to Girru (new open port, cert near expiry,
failed-login spike, config drift). Girru stores only the hash of the pairing token and can never
connect to, log in to, or control the server. See `SENSOR.md` for the design and protocol and
`sensor/girru-sensor.mjs` for a reference implementation.

## Limits & gates

- Local/private network addresses are refused unless the owner turns on private targets (logged).
- 10 scans at once and 100 scans/day per user; at most 50 campaigns per user.
- All routes are for an active owner or admin; the one public route is the token-authenticated
  sensor push. The `waf_scan` agent tool works only for an owner/admin and is never auto-granted.
- Model help ("explain a finding") routes through Girru's provider/subscription path — no API key.

## Its data

Its own tables only, all named `app_waf_security__…`: scans, rate limits, payload library,
campaigns (+ stages/scans/comparisons/notifications), assets, scope log, evidence, findings
(+ evidence bindings, retests), coverage, sensors and sensor alerts.

## Test

`node test/smoke.mjs` — runs the engine and data model end to end against a localhost fixture only
(no package install needed; uses Node's built-in `node:sqlite`).

## Licence

MIT.
