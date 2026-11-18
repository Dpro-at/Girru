# Girru Deployment Guide

Advanced deployment guide for production environments, remote servers, and cloud platforms.

## Table of Contents

- [Deployment Modes Overview](#deployment-modes-overview)
- [Docker Deployment](#docker-deployment)
- [Server Deployment (SSH)](#server-deployment-ssh)
  - [DigitalOcean](#digitalocean-deployment)
  - [AWS EC2](#aws-ec2-deployment)
  - [Linode](#linode-deployment)
  - [Custom VPS](#custom-vps-deployment)
- [Advanced Configuration](#advanced-configuration)
- [Load Balancing](#load-balancing)
- [High Availability](#high-availability)
- [Monitoring](#monitoring)
- [Security Best Practices](#security-best-practices)

---

## Deployment Modes Overview

Girru supports 3 deployment modes:

| Mode | Best For | Pros | Cons | Complexity |
|------|----------|------|------|------------|
| **Docker** | Local workspace, CI | One workspace for Electron and browser | Requires Docker | Medium |
| **Direct** | Development, maximum performance | Fastest, native OS | Manual updates | Low |
| **Server** | Remote hosting, cloud deployment | Accessible anywhere, auto SSL | Network dependency | High |

---

## Docker Deployment

Girru runs its SQLite backend and verified Core UI in one Linux container.
The installed Girru Electron app and a browser can sign in to the same Docker
workspace. Compose publishes only `127.0.0.1:41522`. Use that exact address.

### Open the installed app on Windows

Start Docker Desktop and double-click **Start-Girru-Docker.cmd** in this checkout.
It builds and starts Compose, waits for the backend, and opens the installed Girru
in a separate Electron profile. On first run, choose your workspace type and paste
the private setup link from the launcher into the setup field. Subsequent launches
open the same Docker workspace. Your usual Girru shortcut keeps its own profile.

### Open in Electron or a browser on any host

From the repository root with Docker Engine and Compose v2:

```sh
docker compose up -d --build --wait
docker compose ps
```

- **Girru Electron**. Open **File → Connect to an Existing Girru…** and enter
  `http://127.0.0.1:41522`. Use **File → Use Girru on This Computer** to
  switch back to the desktop-managed workspace.
- **Browser**. Open `http://127.0.0.1:41522`.
- **First owner**. Run the following command on the Docker host. Open its private
  link in a browser, or choose a workspace type in Electron and paste the link
  into **Private setup link or code**. A new link replaces the previous one.
  After setup, both clients use the ordinary sign-in at the same address.

```sh
docker compose exec -T backend node /app/scripts/docker/setup.cjs
```

The bridge verifies the host and origin and forwards permitted requests to a
private backend on a random container-loopback port. The health probe at
`http://127.0.0.1:41522/api/health` checks that backend. Host filesystem access
and native workspace key custody belong to the locally managed desktop workspace.
Docker uses its own files, keys and settings.

### Data and configuration

Compose reuses the named volumes `agent-player-data` (SQLite, settings, secrets
and memory under `/app/.data`) and `agent-player-public` (storage under
`/app/public/storage`). Use `GIRRU_DATA_VOLUME` and `GIRRU_STORAGE_VOLUME`
to select a separate pair for testing. The recall index is in memory.
Use `docker compose down` to stop and remove the container while preserving
data. Run the startup command again after an update. View logs with
`docker compose logs backend`.

The backend accepts `JWT_SECRET` and `ENCRYPTION_KEY` from the runtime environment.
If supplying your own, use a stable random JWT secret of at least 32 characters
and a 64-character hex encryption key. With neither supplied, first boot generates
private values in the data volume and reuses them on restart. Keep that volume
and externally supplied keys together when backing up the instance.

For host Ollama on Docker Desktop, set `OLLAMA_URL=http://host.docker.internal:11434`
before starting Compose and configure Ollama to accept connections from Docker.
Model downloads and GPU/display access require separate host setup. Compose uses SQLite.

## Server Deployment (SSH)

Deploy Girru to a remote server with automatic nginx + SSL configuration.

### Prerequisites

- Remote server running Ubuntu 22.04+, Debian 11+, or CentOS 8+
- SSH access (password or private key)
- Domain name pointed to server IP (optional, for SSL)
- Minimum 2 GB RAM, 2 CPU cores, 10 GB disk

### Deployment Process

#### Step 1: Prepare Server

**Create a new user (recommended):**

```bash
# SSH into server as root
ssh root@your-server-ip

# Create agentplayer user
useradd -m -s /bin/bash agentplayer
usermod -aG sudo agentplayer

# Set password
passwd agentplayer

# Switch to new user
su - agentplayer
```

**Update system:**

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install curl wget git -y
```

#### Step 2: Configure Firewall

```bash
# Install ufw (if not installed)
sudo apt install ufw

# Allow SSH (IMPORTANT: do this first!)
sudo ufw allow 22/tcp

# Allow HTTP and HTTPS
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Allow Girru ports (if direct access needed)
sudo ufw allow 41521/tcp
sudo ufw allow 41522/tcp

# Enable firewall
sudo ufw enable

# Check status
sudo ufw status
```

#### Step 3: Configure DNS (For SSL)

Point your domain to the server:

```
Type: A
Name: agent (or @)
Value: your-server-ip
TTL: 3600
```

Wait for DNS propagation (5-15 minutes). Verify:

```bash
# Check DNS resolution
dig agent.yourdomain.com +short
# Should return: your-server-ip
```

#### Step 4: Run Girru Installer

On your **local machine**, run the installer:

1. **Select Server Mode** (Step 4)
2. **Enter server details:**
   - Host: `your-server-ip` or `agent.yourdomain.com`
   - Port: `22`
   - Username: `agentplayer` (or `root`)
   - Authentication: Password or Private Key
   - Installation Path: `/var/www/agent-player`
   - Domain: `agent.yourdomain.com` (optional)

3. **The installer will:**
   - ✅ Test SSH connection
   - ✅ Check server requirements (Node.js, Python, disk space)
   - ✅ Install Node.js 20 LTS
   - ✅ Install Python 3.12
   - ✅ Upload application files (~800 MB)
   - ✅ Run `pnpm install --prod` (~3-5 minutes)
   - ✅ Build production assets (~2-3 minutes)
   - ✅ Configure systemd services
   - ✅ Install and configure nginx
   - ✅ Setup Let's Encrypt SSL (if domain provided)
   - ✅ Configure firewall
   - ✅ Start services

**Total deployment time:** 10-15 minutes

#### Step 5: Verify Deployment

```bash
# SSH into server
ssh agentplayer@your-server-ip

# Check services
sudo systemctl status agent-player
sudo systemctl status agent-player-frontend
sudo systemctl status nginx

# Test backend
curl http://localhost:41522/health
# Expected: {"status":"ok"}

# Test frontend
curl http://localhost:41521
# Expected: HTML content
```

#### Step 6: Access Dashboard

- **With domain + SSL:** https://agent.yourdomain.com
- **Without domain:** http://your-server-ip:41521

---

### DigitalOcean Deployment

#### Create Droplet

1. Go to: https://cloud.digitalocean.com/droplets/new
2. **Choose Image:** Ubuntu 22.04 LTS
3. **Choose Size:** Basic, $12/month (2 GB RAM, 1 CPU)
4. **Choose Region:** Closest to your users
5. **Authentication:** SSH Key (recommended)
6. **Hostname:** agent-player
7. Click **Create Droplet**

#### Configure Domain

1. Go to **Networking** → **Domains**
2. Add domain: `yourdomain.com`
3. Create A record:
   - **Hostname:** agent
   - **Will Direct To:** your-droplet-ip
   - **TTL:** 3600

#### Deploy Girru

1. Run installer on local machine
2. Select **Server Mode**
3. Enter:
   - Host: `agent.yourdomain.com`
   - Port: `22`
   - Username: `root`
   - Authentication: Private key (`~/.ssh/id_rsa`)
   - Domain: `agent.yourdomain.com`

4. Wait for deployment (10-15 minutes)
5. Access: https://agent.yourdomain.com

---

### AWS EC2 Deployment

#### Launch Instance

1. Go to: https://console.aws.amazon.com/ec2/
2. Click **Launch Instance**
3. **Name:** agent-player
4. **AMI:** Ubuntu Server 22.04 LTS
5. **Instance Type:** t3.small (2 GB RAM, 2 vCPUs)
6. **Key Pair:** Select or create SSH key pair
7. **Network Settings:**
   - Allow SSH (port 22) from your IP
   - Allow HTTP (port 80)
   - Allow HTTPS (port 443)
   - Allow custom TCP 41521-41522
8. **Storage:** 20 GB gp3
9. Click **Launch Instance**

#### Elastic IP (Recommended)

1. Go to **Elastic IPs**
2. **Allocate Elastic IP Address**
3. **Associate** with your instance

#### Configure Route 53

1. Go to **Route 53** → **Hosted Zones**
2. Create hosted zone: `yourdomain.com`
3. Create A record:
   - **Name:** agent
   - **Type:** A
   - **Value:** your-elastic-ip

#### Deploy Girru

1. Get instance public IP:
   ```bash
   aws ec2 describe-instances \
     --instance-ids i-1234567890abcdef0 \
     --query 'Reservations[0].Instances[0].PublicIpAddress'
   ```

2. Run installer:
   - Host: `agent.yourdomain.com` or elastic IP
   - Username: `ubuntu` (default for Ubuntu AMI)
   - Authentication: Private key (`.pem` file)

3. Access: https://agent.yourdomain.com

---

### Linode Deployment

#### Create Linode

1. Go to: https://cloud.linode.com/linodes/create
2. **Image:** Ubuntu 22.04 LTS
3. **Region:** Closest to your users
4. **Plan:** Shared CPU, Nanode 2GB ($12/month)
5. **Root Password:** Set strong password
6. **SSH Keys:** Add your public key
7. **Label:** agent-player
8. Click **Create Linode**

#### Configure Domain

1. Go to **Domains** → **Create Domain**
2. **Domain:** yourdomain.com
3. **SOA Email:** your@email.com
4. Add A/AAAA Record:
   - **Hostname:** agent
   - **IP Address:** your-linode-ip

#### Deploy Girru

1. Wait for Linode to boot (~30 seconds)
2. Run installer:
   - Host: `agent.yourdomain.com`
   - Username: `root`
   - Authentication: Password or SSH key

3. Access: https://agent.yourdomain.com

---

### Custom VPS Deployment

For any VPS provider (Vultr, Hetzner, OVH, etc.):

#### Minimum Specs

- **RAM:** 2 GB
- **CPU:** 1 core (2+ recommended)
- **Disk:** 20 GB SSD
- **OS:** Ubuntu 22.04 LTS, Debian 11, or CentOS 8+

#### Manual Setup

If the installer fails, you can deploy manually:

```bash
# 1. Install dependencies
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs python3.12 python3-pip nginx certbot python3-certbot-nginx

# 2. Create installation directory
sudo mkdir -p /var/www/agent-player
sudo chown $USER:$USER /var/www/agent-player

# 3. Upload files (from local machine)
rsync -avz --progress \
  /path/to/agent_player/ \
  user@your-server:/var/www/agent-player/

# 4. Install dependencies
cd /var/www/agent-player
npm install -g pnpm
pnpm install --prod

# 5. Build production
pnpm build

# 6. Create systemd service
sudo nano /etc/systemd/system/agent-player.service
```

**agent-player.service:**

```ini
[Unit]
Description=Girru Backend
After=network.target

[Service]
Type=simple
User=agentplayer
WorkingDirectory=/var/www/agent-player/packages/backend
Environment="NODE_ENV=production"
Environment="PORT=41522"
ExecStart=/usr/bin/node dist/api/server.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
# 7. Enable and start service
sudo systemctl daemon-reload
sudo systemctl enable agent-player
sudo systemctl start agent-player

# 8. Configure nginx
sudo nano /etc/nginx/sites-available/agent-player
```

**nginx configuration:**

```nginx
server {
    listen 80;
    server_name agent.yourdomain.com;

    location / {
        proxy_pass http://localhost:41521;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    location /api {
        proxy_pass http://localhost:41522;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
    }
}
```

```bash
# 9. Enable site
sudo ln -s /etc/nginx/sites-available/agent-player /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# 10. Setup SSL
sudo certbot --nginx -d agent.yourdomain.com
```

---

## Advanced Configuration

### Reverse Proxy with nginx

**Load balancing multiple backends:**

```nginx
upstream backend_pool {
    least_conn;
    server localhost:41522 max_fails=3 fail_timeout=30s;
    server localhost:41523 max_fails=3 fail_timeout=30s;
    server localhost:41524 max_fails=3 fail_timeout=30s;
}

server {
    listen 443 ssl http2;
    server_name agent.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/agent.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/agent.yourdomain.com/privkey.pem;

    location /api {
        proxy_pass http://backend_pool;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Environment-Specific Configuration

**Development:**
```bash
NODE_ENV=development
LOG_LEVEL=debug
ENABLE_CORS=true
```

**Staging:**
```bash
NODE_ENV=staging
LOG_LEVEL=info
ENABLE_ANALYTICS=true
```

**Production:**
```bash
NODE_ENV=production
LOG_LEVEL=warn
RATE_LIMIT_ENABLED=true
ENABLE_COMPRESSION=true
```

---

## Load Balancing

### nginx Load Balancing

**Round-robin (default):**
```nginx
upstream backend {
    server backend1:41522;
    server backend2:41522;
    server backend3:41522;
}
```

**Weighted:**
```nginx
upstream backend {
    server backend1:41522 weight=3;
    server backend2:41522 weight=2;
    server backend3:41522 weight=1;
}
```

**IP Hash (sticky sessions):**
```nginx
upstream backend {
    ip_hash;
    server backend1:41522;
    server backend2:41522;
}
```

---

## High Availability

### Database Replication

**Primary-Replica Setup:**

```bash
# Primary node
sqlite3 .data/agent-player.db ".backup '/backup/db-$(date +%Y%m%d-%H%M%S).db'"

# Sync to replica
rsync -avz .data/agent-player.db replica:/var/www/agent-player/.data/
```

### Health Checks

```bash
# Backend health endpoint
curl http://localhost:41522/health

# Expected response:
{
  "status": "ok",
  "uptime": 3600,
  "database": "connected",
  "memory": {
    "used": 150000000,
    "total": 2000000000
  }
}
```

---

## Monitoring

### System Monitoring

**Install Prometheus + Grafana:**

```bash
# Prometheus
sudo apt install prometheus
# Edit /etc/prometheus/prometheus.yml
# Add job for Girru

# Grafana
sudo apt install grafana
sudo systemctl enable grafana-server
sudo systemctl start grafana-server
```

### Log Monitoring

**Centralized logging with Loki:**

```bash
# Install Promtail
wget https://github.com/grafana/loki/releases/download/v2.8.0/promtail-linux-amd64.zip
unzip promtail-linux-amd64.zip
sudo mv promtail-linux-amd64 /usr/local/bin/promtail

# Configure to tail Girru logs
sudo nano /etc/promtail/config.yml
```

---

## Security Best Practices

### 1. Firewall Configuration

```bash
# Allow only necessary ports
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

### 2. SSL/TLS Configuration

**Strong SSL ciphers:**
```nginx
ssl_protocols TLSv1.2 TLSv1.3;
ssl_ciphers 'ECDHE-RSA-AES256-GCM-SHA384:ECDHE-RSA-AES128-GCM-SHA256';
ssl_prefer_server_ciphers on;
ssl_session_cache shared:SSL:10m;
```

### 3. Rate Limiting

**nginx rate limiting:**
```nginx
limit_req_zone $binary_remote_addr zone=api_limit:10m rate=10r/s;

server {
    location /api {
        limit_req zone=api_limit burst=20 nodelay;
        proxy_pass http://backend;
    }
}
```

### 4. Database Security

```bash
# Restrict database file permissions
chmod 600 /var/www/agent-player/.data/agent-player.db
chown agentplayer:agentplayer /var/www/agent-player/.data/agent-player.db
```

### 5. Regular Updates

```bash
# Auto-update system packages
sudo apt install unattended-upgrades
sudo dpkg-reconfigure --priority=low unattended-upgrades
```

---

## Troubleshooting

### Common Issues

**1. nginx 502 Bad Gateway**
- Check backend is running: `systemctl status agent-player`
- Check logs: `journalctl -u agent-player -f`

**2. SSL Certificate Renewal Failed**
- Manual renewal: `sudo certbot renew --force-renewal`
- Check nginx config: `sudo nginx -t`

**3. Database Locked**
- Stop services: `sudo systemctl stop agent-player`
- Check processes: `lsof .data/agent-player.db`
- Restart: `sudo systemctl start agent-player`

---

**Deployment complete! 🚀**

Your Girru instance is now running in production.
