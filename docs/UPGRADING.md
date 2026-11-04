# Girru Upgrade Guide

Guide for upgrading from manual installation (v1.2.x or earlier) to the installer-based system (v1.3.0+).

## Table of Contents

- [Overview](#overview)
- [Before You Upgrade](#before-you-upgrade)
- [Backup Your Data](#backup-your-data)
- [Migration Options](#migration-options)
  - [Option A: Fresh Install (Recommended)](#option-a-fresh-install-recommended)
  - [Option B: In-Place Upgrade](#option-b-in-place-upgrade)
- [Data Migration](#data-migration)
- [Rollback Plan](#rollback-plan)
- [Troubleshooting](#troubleshooting)

---

## Overview

**What's New in v1.3.0:**

- ✅ **One-click installer** (.msi, .AppImage, .dmg)
- ✅ **System tray application** (Start/Stop/Restart services)
- ✅ **Auto-updater** (GitHub Releases integration)
- ✅ **Professional uninstaller** (data cleanup options)
- ✅ **Three deployment modes** (Docker, Direct, Server)
- ✅ **Automatic service management** (systemd, launchd, Windows Service)

**Breaking Changes:**

- ⚠️ Installation location changed:
  - Windows: `C:\Program Files\AgentPlayer\` (was: custom location)
  - Linux: `/opt/agent-player` (was: `/home/user/agent_player`)
  - macOS: `/Applications/Girru.app/Contents/Resources` (was: custom location)

- ⚠️ Service management changed:
  - Was: Manual `pnpm dev` in two terminals
  - Now: Auto-started system services

---

## Before You Upgrade

### Check Current Version

```bash
cd /path/to/agent_player
cat package.json | grep version
```

If version is < 1.3.0, follow this upgrade guide.

### System Requirements

Ensure your system meets the requirements:

- **Disk Space:** 2 GB free (for new installation)
- **RAM:** 4 GB minimum
- **Ports:** 41521 and 41522 available (or different if you changed defaults)
- **Permissions:** Administrator/root access

### Stop Existing Services

**If you're running Girru manually:**

```bash
# Stop frontend (Ctrl+C in terminal)
# Stop backend (Ctrl+C in terminal)
```

**If you set up services manually:**

```bash
# Linux
sudo systemctl stop agent-player
sudo systemctl stop agent-player-frontend

# macOS
sudo launchctl unload /Library/LaunchDaemons/com.agentplayer.*.plist

# Windows
sc stop AgentPlayerBackend
sc stop AgentPlayerFrontend
```

---

## Backup Your Data

⚠️ **CRITICAL:** Always backup before upgrading!

### What to Backup

1. **Database:** `.data/agent-player.db`
2. **Environment:** `.env` files (both frontend and backend)
3. **User Files:** `public/storage/` directory
4. **Agent Memories:** `.data/memory/` directory (with `GIRRU_STORE_P4` on, the old `.data/memory/memory.db` index is retired after a verified backup; see [Storage map switches](#storage-map-switches))
5. **Agent Files:** `.data/agents/` directory
6. **Extensions:** `packages/backend/extensions/` (custom extensions only)

### Backup Script

**Linux/macOS:**

```bash
#!/bin/bash
# backup-agent-player.sh

BACKUP_DIR="$HOME/agent-player-backup-$(date +%Y%m%d-%H%M%S)"
SOURCE_DIR="/path/to/agent_player"

mkdir -p "$BACKUP_DIR"

echo "Backing up to: $BACKUP_DIR"

# Database
cp -v "$SOURCE_DIR/.data/agent-player.db" "$BACKUP_DIR/"

# Environment files
cp -v "$SOURCE_DIR/.env" "$BACKUP_DIR/root.env"
cp -v "$SOURCE_DIR/packages/backend/.env" "$BACKUP_DIR/backend.env"
cp -v "$SOURCE_DIR/packages/frontend/.env.local" "$BACKUP_DIR/frontend.env" 2>/dev/null

# User files
cp -r "$SOURCE_DIR/public/storage" "$BACKUP_DIR/storage"

# Memory and agents
cp -r "$SOURCE_DIR/.data/memory" "$BACKUP_DIR/memory"
cp -r "$SOURCE_DIR/.data/agents" "$BACKUP_DIR/agents"

# Custom extensions (if any)
if [ -d "$SOURCE_DIR/packages/backend/extensions" ]; then
    mkdir -p "$BACKUP_DIR/extensions"
    # Only backup custom extensions, not built-in ones
    # List your custom extensions here
    # cp -r "$SOURCE_DIR/packages/backend/extensions/my-extension" "$BACKUP_DIR/extensions/"
fi

# Create archive
tar -czf "$BACKUP_DIR.tar.gz" -C "$HOME" "$(basename $BACKUP_DIR)"

echo "Backup completed: $BACKUP_DIR.tar.gz"
echo "Backup size: $(du -sh $BACKUP_DIR.tar.gz | cut -f1)"
```

**Windows PowerShell:**

```powershell
# backup-agent-player.ps1

$BackupDir = "$env:USERPROFILE\agent-player-backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
$SourceDir = "C:\MAMP\htdocs\agent\agent_player"

New-Item -ItemType Directory -Path $BackupDir -Force

Write-Host "Backing up to: $BackupDir"

# Database
Copy-Item "$SourceDir\.data\agent-player.db" "$BackupDir\" -Verbose

# Environment files
Copy-Item "$SourceDir\.env" "$BackupDir\root.env" -Verbose -ErrorAction SilentlyContinue
Copy-Item "$SourceDir\packages\backend\.env" "$BackupDir\backend.env" -Verbose -ErrorAction SilentlyContinue

# User files
Copy-Item "$SourceDir\public\storage" "$BackupDir\storage" -Recurse -Verbose

# Memory and agents
Copy-Item "$SourceDir\.data\memory" "$BackupDir\memory" -Recurse -Verbose
Copy-Item "$SourceDir\.data\agents" "$BackupDir\agents" -Recurse -Verbose

# Create ZIP archive
Compress-Archive -Path $BackupDir -DestinationPath "$BackupDir.zip"

Write-Host "Backup completed: $BackupDir.zip"
Write-Host "Backup size: $((Get-Item "$BackupDir.zip").Length / 1MB) MB"
```

### Verify Backup

```bash
# Linux/macOS
tar -tzf ~/agent-player-backup-*.tar.gz | head -20

# Windows
Expand-Archive -Path $env:USERPROFILE\agent-player-backup-*.zip -DestinationPath $env:TEMP\verify-backup -Force
ls $env:TEMP\verify-backup
```

---

## Migration Options

### Option A: Fresh Install (Recommended)

**Pros:**
- ✅ Clean slate, no leftover files
- ✅ Proper service setup
- ✅ Latest configuration

**Cons:**
- ⚠️ Requires manual data migration
- ⚠️ ~30 minutes process

**Steps:**

#### 1. Backup Data (see above)

#### 2. Download Installer

Download from [GitHub Releases](https://github.com/your-org/agent-player/releases):

- Windows: `agent-player-installer-1.3.0-win-x64.msi`
- Linux: `agent-player-installer-1.3.0-linux-x86_64.AppImage`
- macOS: `agent-player-installer-1.3.0-macos-universal.dmg`

#### 3. Run Installer

**Important:** During installation:

- **Step 4 (Deployment Mode):** Choose **Direct Mode** for easiest migration
- **Step 5 (Configuration):**
  - Use **same ports** as before (41521, 41522)
  - Enter your **existing Claude API key**
- **Step 6 (Admin Account):**
  - Use **different credentials** (you'll merge data later)

Complete the installation.

#### 4. Stop New Services

```bash
# Windows
sc stop AgentPlayerBackend
sc stop AgentPlayerFrontend

# Linux
sudo systemctl stop agent-player
sudo systemctl stop agent-player-frontend

# macOS
sudo launchctl unload /Library/LaunchDaemons/com.agentplayer.*.plist
```

#### 5. Restore Database

**Windows:**
```powershell
Copy-Item "$env:USERPROFILE\agent-player-backup-*\agent-player.db" "C:\Program Files\AgentPlayer\app\.data\" -Force
```

**Linux:**
```bash
sudo cp ~/agent-player-backup-*/agent-player.db /opt/agent-player/app/.data/
sudo chown agentplayer:agentplayer /opt/agent-player/app/.data/agent-player.db
sudo chmod 600 /opt/agent-player/app/.data/agent-player.db
```

**macOS:**
```bash
sudo cp ~/agent-player-backup-*/agent-player.db "/Applications/Girru.app/Contents/Resources/app/.data/"
sudo chown root:wheel "/Applications/Girru.app/Contents/Resources/app/.data/agent-player.db"
```

#### 6. Restore User Files

**Windows:**
```powershell
Copy-Item "$env:USERPROFILE\agent-player-backup-*\storage\*" "C:\Program Files\AgentPlayer\app\public\storage\" -Recurse -Force
```

**Linux:**
```bash
sudo cp -r ~/agent-player-backup-*/storage/* /opt/agent-player/app/public/storage/
sudo chown -R agentplayer:agentplayer /opt/agent-player/app/public/storage
```

**macOS:**
```bash
sudo cp -r ~/agent-player-backup-*/storage/* "/Applications/Girru.app/Contents/Resources/app/public/storage/"
```

#### 7. Restore Memory & Agents

**Windows:**
```powershell
Copy-Item "$env:USERPROFILE\agent-player-backup-*\memory" "C:\Program Files\AgentPlayer\app\.data\memory" -Recurse -Force
Copy-Item "$env:USERPROFILE\agent-player-backup-*\agents" "C:\Program Files\AgentPlayer\app\.data\agents" -Recurse -Force
```

**Linux:**
```bash
sudo cp -r ~/agent-player-backup-*/memory /opt/agent-player/app/.data/
sudo cp -r ~/agent-player-backup-*/agents /opt/agent-player/app/.data/
sudo chown -R agentplayer:agentplayer /opt/agent-player/app/.data/memory
sudo chown -R agentplayer:agentplayer /opt/agent-player/app/.data/agents
```

**macOS:**
```bash
sudo cp -r ~/agent-player-backup-*/memory "/Applications/Girru.app/Contents/Resources/app/.data/"
sudo cp -r ~/agent-player-backup-*/agents "/Applications/Girru.app/Contents/Resources/app/.data/"
```

#### 8. Merge Environment Variables

Compare your old `.env` files with the new ones and update any custom values:

```bash
# Linux
sudo nano /opt/agent-player/app/.env
sudo nano /opt/agent-player/app/packages/backend/.env

# Copy any custom settings from backup
```

#### 9. Start Services

```bash
# Windows
sc start AgentPlayerBackend
sc start AgentPlayerFrontend

# Linux
sudo systemctl start agent-player
sudo systemctl start agent-player-frontend

# macOS
sudo launchctl load /Library/LaunchDaemons/com.agentplayer.backend.plist
sudo launchctl load /Library/LaunchDaemons/com.agentplayer.frontend.plist
```

#### 10. Verify Migration

1. Open browser: http://localhost:41521
2. Login with your **original credentials** (from old database)
3. Check:
   - ✅ All agents present
   - ✅ Agent memories intact
   - ✅ Uploaded files accessible
   - ✅ Extensions working

#### 11. Cleanup Old Installation (Optional)

After verifying everything works:

```bash
# Remove old installation directory
rm -rf /path/to/old/agent_player

# Or keep as backup for 1 week, then delete
```

---

### Option B: In-Place Upgrade

**Pros:**
- ✅ Faster (no data migration needed)
- ✅ Keeps existing location

**Cons:**
- ⚠️ No system service integration
- ⚠️ No installer benefits (system tray, auto-update)
- ⚠️ Manual updates required

**Steps:**

#### 1. Backup Data (see above)

#### 2. Stop Services

```bash
# Stop running processes
# Ctrl+C in both terminals
```

#### 3. Pull Latest Code

```bash
cd /path/to/agent_player
git fetch origin
git checkout v1.3.0
```

#### 4. Update Dependencies

```bash
# Clean install
rm -rf node_modules
rm -rf packages/*/node_modules
pnpm install
```

#### 5. Run Database Migrations

```bash
cd packages/backend
pnpm run migrate

# Or start backend once (migrations run automatically)
pnpm dev
```

#### 6. Rebuild Frontend

```bash
cd ../..
pnpm build
```

#### 7. Update Configuration

Check for new environment variables:

```bash
# Compare with .env.example
diff .env packages/backend/.env.example
```

Add any missing variables.

#### 8. Restart Services

```bash
# Terminal 1 - Frontend
cd /path/to/agent_player
pnpm dev

# Terminal 2 - Backend
cd /path/to/agent_player/packages/backend
pnpm dev
```

#### 9. Verify Upgrade

1. Open: http://localhost:41521
2. Check version in footer or settings
3. Test key features

---

## Data Migration

### Database Schema Changes

Version 1.3.0 includes new tables and columns. Migrations run automatically on first backend start.

**New tables (v1.3.0):**
- `extension_analytics` (Phase 3)
- `extension_marketplace` (Phase 3)
- `extension_versions` (Phase 3)
- `extension_installations` (Phase 3)
- `extension_reviews` (Phase 3)
- `extension_update_queue` (Phase 3)
- `extension_dependencies` (Phase 3)

**Migration script:**

```bash
# Check current schema version
sqlite3 .data/agent-player.db "SELECT * FROM schema_migrations ORDER BY version DESC LIMIT 1;"

# Should show: 045 (or higher)

# If stuck, run migrations manually:
cd packages/backend
npx node dist/db/migrate.js
```

### Storage map switches

Some data moves happen only when their switch is on (all are off by default).
Each one runs at start-up, is safe to run again, and keeps the old data.

| Switch | What start-up does | What stays |
|---|---|---|
| `GIRRU_STORE_P3=1` | Fills department ids, memory source and trust, project ids, packed vectors (background jobs) | Old columns, until a later release |
| `GIRRU_STORE_P4=1` | Makes a full backup and checks it, then retires `.data/memory/memory.db`; copies coding-app handoff notes into the one handoff table; copies each agent's `PERSONALITY.md` text into its personality record once, then rewrites `PERSONALITY.md` from the record | The backup with `memory.db`; `memory_bridge_handoffs` (dropped one release later); older personality versions |
| `GIRRU_STORE_P6=1` | Nothing is copied: new columns start off. Coding apps started outside Girru lose memory access (every memory call needs a session Girru issued); projects with memory files on get a change log and a debounced `.girru/brief.md`; linked tasks in `.girru/tasks.md` get a hidden id line | Everything; turning the switch off again leaves the hidden id lines, which still read |
| `GIRRU_STORE_P7=1` | Migration 176 rebuilds `memory_bridge_clients` so Cursor and GitHub Copilot CLI can be switched on (rows kept). Migration 175 adds `task_file_cards.from_file` (existing tasks count as from the file) and `task_file_approvals` (empty: tasks from a project's file wait for the owner's approval once). Every file Girru writes into a project folder goes through the safe file writer, which refuses links, junctions, hard links, case collisions, paths outside the folder and non-text content | Everything; the earlier writers take over again |
| `GIRRU_STORE_P9=1` | Migration 179 (always, with or without the switch) adds an index on the drawer of each memory, and migration 180 adds the empty `memory_health_events` table; nothing is copied. With the switch on, a nightly read-only memory doctor job is added for each owner. With the switch on, recall keeps an in-memory index (never on disk), each new backup is restored into a scratch folder and checked before it is signed, and each forget is written to `forget-ledger.jsonl` in the data folder (ids and keyed hashes only), which a restore keeps and applies again on the next start. "Stays on this computer" is enforced (People on by default), so an online model or coding app no longer gets People memories; turning People's switch off restores the earlier behaviour | Everything; with the switch off the ledger file stays, and a restore still keeps it and applies it again |

After the first start with `GIRRU_STORE_P4` on:

- `PERSONALITY.md` is a view. A change made to it outside Girru is not used;
  it waits in the agent's Personality review.
- The start-up log line `[Store P4] personality texts imported: N, still
  without a text: 0` confirms the import. A number above 0 means an agent's
  file could not be read safely; it is tried again at the next start.

### Custom Extensions

If you have custom extensions in `packages/backend/extensions/`:

1. **Backup extensions:**
   ```bash
   cp -r packages/backend/extensions/my-extension ~/backup/
   ```

2. **After upgrade, restore:**
   ```bash
   cp -r ~/backup/my-extension packages/backend/extensions/
   ```

3. **Enable in dashboard:**
   - Go to http://localhost:41521/dashboard/extensions
   - Click **Enable** on your custom extension

---

## Rollback Plan

If upgrade fails, you can rollback:

### Rollback Steps

#### 1. Stop New Services

```bash
# See "Stop Services" commands above
```

#### 2. Restore Backup

```bash
# Extract backup
tar -xzf ~/agent-player-backup-*.tar.gz -C ~/

# Linux
sudo rm -rf /opt/agent-player/app/.data
sudo cp -r ~/agent-player-backup-*/* /opt/agent-player/app/.data/
```

#### 3. Restart Services

```bash
# See "Start Services" commands above
```

### Rollback to Manual Installation

If you want to return to manual `pnpm dev` setup:

1. **Uninstall v1.3.0:**
   - Windows: Control Panel → Programs → Uninstall Girru
   - Linux: Run uninstaller from system tray
   - macOS: Drag "Girru.app" to Trash

2. **Restore old installation:**
   ```bash
   cd /path/to/old/agent_player
   pnpm install
   ```

3. **Restore database:**
   ```bash
   cp ~/agent-player-backup-*/agent-player.db .data/
   ```

4. **Start manually:**
   ```bash
   # Terminal 1
   pnpm dev

   # Terminal 2
   cd packages/backend && pnpm dev
   ```

---

## Troubleshooting

### Database Locked After Migration

**Symptom:** "Database is locked" error on startup

**Solution:**
```bash
# Stop all services
# Windows: sc stop AgentPlayerBackend
# Linux: sudo systemctl stop agent-player

# Check processes
# Linux: lsof .data/agent-player.db
# Windows: handle64.exe agent-player.db

# Kill any lingering processes
# Linux: kill <PID>
# Windows: taskkill /F /PID <PID>

# Fix permissions
# Linux: sudo chmod 600 /opt/agent-player/app/.data/agent-player.db
# Windows: Right-click .data folder → Properties → Security → Full Control

# Restart services
```

### Missing Files After Migration

**Symptom:** Avatars, backgrounds, or uploads not appearing

**Solution:**
```bash
# Check storage directory exists
ls /opt/agent-player/app/public/storage

# Restore from backup
cp -r ~/agent-player-backup-*/storage/* /opt/agent-player/app/public/storage/

# Fix permissions
sudo chown -R agentplayer:agentplayer /opt/agent-player/app/public/storage
```

### Extensions Not Loading

**Symptom:** "Extension failed to load" errors

**Solution:**
```bash
# Check extensions directory
ls /opt/agent-player/app/packages/backend/extensions

# Restart backend
sudo systemctl restart agent-player

# Check logs
sudo journalctl -u agent-player -f | grep extension
```

### API Key Not Working

**Symptom:** "Invalid API key" errors

**Solution:**
```bash
# Check environment file
cat /opt/agent-player/app/packages/backend/.env | grep ANTHROPIC_API_KEY

# Update if needed
sudo nano /opt/agent-player/app/packages/backend/.env

# Add or update:
# ANTHROPIC_API_KEY=your_key_here

# Restart backend
sudo systemctl restart agent-player
```

### Port Already in Use

**Symptom:** "Port 41521 already in use"

**Solution:**
```bash
# Find process using port
# Linux: lsof -i :41521
# Windows: netstat -ano | findstr :41521

# Kill process
# Linux: kill <PID>
# Windows: taskkill /F /PID <PID>

# Or change port in configuration
sudo nano /opt/agent-player/app/.env
# Update: FRONTEND_PORT=41531

# Restart services
```

---

## Post-Upgrade Tasks

### 1. Update Bookmarks

Old URL: `http://localhost:41521`
New URL: Same (unless you changed ports)

### 2. Reconfigure IDE/Editor

If you have Girru open in VS Code or other IDE:

- **Close old workspace**
- **Open new location:**
  - Windows: `C:\Program Files\AgentPlayer\app`
  - Linux: `/opt/agent-player/app`
  - macOS: `/Applications/Girru.app/Contents/Resources/app`

### 3. Update Scripts/Aliases

If you have custom scripts that reference the old path, update them:

```bash
# Old
alias agent='cd ~/projects/agent_player && pnpm dev'

# New
alias agent='sudo systemctl start agent-player'
```

### 4. Verify Auto-Start

```bash
# Check services are enabled
# Linux
sudo systemctl is-enabled agent-player
# Should output: enabled

# Windows
sc query AgentPlayerBackend | findstr START_TYPE
# Should output: AUTO_START

# macOS
sudo launchctl list | grep agentplayer
# Should show both services
```

---

## Getting Help

If you encounter issues during upgrade:

1. **Check Logs:**
   - Linux: `sudo journalctl -u agent-player -n 100`
   - Windows: Event Viewer → Application logs
   - macOS: `sudo tail -f /var/log/system.log | grep agentplayer`

2. **GitHub Issues:**
   https://github.com/your-org/agent-player/issues
   - Search for similar issues
   - Create new issue with:
     - Migration method used (Fresh Install / In-Place)
     - Error messages from logs
     - Steps to reproduce

3. **Discord Community:**
   https://discord.gg/agentplayer
   - #upgrade-help channel
   - Experienced community members

4. **Professional Support:**
   support@agentplayer.com
   - For urgent production issues

---

**Upgrade complete! 🎉**

Welcome to Girru v1.3.0 with installer, system tray, and auto-updates!
