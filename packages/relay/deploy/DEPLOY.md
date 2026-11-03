# Deploying the Girru relay

A step-by-step guide to run the relay on a small Linux server (VPS) behind its
own name, with TLS. The relay keeps no data, so the server needs no database,
no backups of user data and very little disk.

Shared web hosting (cPanel and similar) is not suitable: it cannot keep
WebSocket connections open for hours. Use a VPS or any machine where you can
run a long-lived process.

## What you need

- A Linux server. These steps use Ubuntu 24.04 LTS. 1 vCPU and 1–2 GB of
  memory are enough to start; the relay holds only live connections in memory.
- A name for it, for example `relay.example.org`, with a DNS `A` (and `AAAA`
  if the server has IPv6) record pointing to the server.
- Open ports: 22 (SSH), 80 (certificate check) and 443 (devices).

Files in this folder:

| File | Goes to |
|---|---|
| `girru-relay.service` | `/etc/systemd/system/girru-relay.service` |
| `relay.env.example` | `/etc/girru-relay/relay.env` (edit the name) |
| `Caddyfile` | `/etc/caddy/Caddyfile` (edit the name) |
| `nginx.conf.example` | Only if you use nginx instead of Caddy |

## 1. Build on your own computer

The relay has no runtime packages; the server needs only Node.js and the
built `dist/` folder.

```bash
cd packages/relay
npm run build
npm test
tar czf girru-relay.tgz dist package.json deploy
scp girru-relay.tgz root@relay.example.org:/tmp/
```

## 2. Prepare the server

```bash
ssh root@relay.example.org

apt update && apt upgrade -y
apt install -y ufw ca-certificates curl

ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

Install Node.js 22 LTS (the Ubuntu package is too old). Use the official
NodeSource repository or the official tarball from nodejs.org, then check:

```bash
node --version   # v22.x or newer (v20 is the minimum)
```

## 3. Install the relay

```bash
useradd --system --no-create-home --shell /usr/sbin/nologin girru-relay

mkdir -p /opt/girru-relay /etc/girru-relay
tar xzf /tmp/girru-relay.tgz -C /opt/girru-relay
chown -R root:root /opt/girru-relay

cp /opt/girru-relay/deploy/relay.env.example /etc/girru-relay/relay.env
nano /etc/girru-relay/relay.env     # set GIRRU_RELAY_URL=wss://relay.example.org/v1

cp /opt/girru-relay/deploy/girru-relay.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now girru-relay
systemctl status girru-relay        # "girru-relay: listening on 127.0.0.1:41540"
curl http://127.0.0.1:41540/health  # ok
```

The relay listens only on `127.0.0.1`. Nothing reaches it except through the
proxy in the next step.

## 4. Put TLS in front (Caddy)

Caddy gets and renews the certificate on its own. Install it from the official
Caddy package repository (see caddyserver.com/docs/install), then:

```bash
cp /opt/girru-relay/deploy/Caddyfile /etc/caddy/Caddyfile
nano /etc/caddy/Caddyfile           # replace relay.example.org with your name
systemctl reload caddy
```

Check from your own computer:

```bash
curl https://relay.example.org/health    # ok
```

Prefer nginx? Use `nginx.conf.example` and a certificate from certbot instead.

## 5. Point Girru at it

Set the same address, `wss://relay.example.org/v1`, in Girru on the computer
and in the phone app. Devices sign this exact address when they connect, so a
different spelling (another port, a missing `/v1`) is refused.

## Updating

Build a new `girru-relay.tgz` as in step 1, copy it to the server, then:

```bash
tar xzf /tmp/girru-relay.tgz -C /opt/girru-relay
systemctl restart girru-relay
```

Restarting drops live connections; devices reconnect on their own within
seconds. Nothing is lost, because the relay holds nothing.

## Keeping it private

- The relay prints one line on start and one on stop, never message contents,
  device ids or addresses. `journalctl -u girru-relay` shows only those lines.
- The Caddyfile has no `log` directive and the nginx example sets
  `access_log off`, so the proxy writes no access log either.
- Do not add analytics, request logging or a crash reporter that captures
  traffic.

## Growing

- Every relay is stateless, but both devices of a pair must reach the **same**
  relay process. Until the relays share a routing layer, run one relay per name
  and move to a bigger server by pointing the name at it.
- Raise `LimitNOFILE` in the service file and `GIRRU_RELAY_MAX_CONNECTIONS` in
  `relay.env` together when you expect more than about 10 000 live devices.
