# Changelog

All notable changes to Dpro Bot.

---

## Unreleased — optional app payload

- Move Call Center, Trading practice and the existing Puppeteer engine into reviewed Store apps. Keep core authorization, browser URL guards and paper proof/ledger checks. Removal keeps saved data; activation and host replacement may require a restart.
- Reject portable package path aliases and execute the exact checked migration bytes.
- Store renderer code is trusted same-origin application code. Browser installation includes no Chrome download or existing profile import.

Payload measurements below use the same local Node, dependency tree and native-pruning inputs. They exclude Electron shell and installer compression; they are not download or installer sizes.

| Local checkpoint | Payload bytes | Decimal MB |
| --- | ---: | ---: |
| Compiled production payload (A) | 631,480,905 | 631.5 |
| GenVR moved (B1) | 381,634,551 | 381.6 |
| Channels moved (B2) | 295,762,413 | 295.8 |
| Call Center, Trading and Browser moved (B3–B5) | 255,043,286 | 255.0 |

The final payload is 40,719,127 bytes smaller than B2 and 59.6% smaller than A. These are local measurements, pending published CI and native platform acceptance.

## [1.3.0] - 2026-02-22

### 🎉 Complete System Redesign

**Development resumed after 7-month break (personal reasons - new child).**

This is a **complete rewrite** from the ground up.

### Major Features (Latest)

#### 🎉 Professional Desktop Installer System (2026-03-10)
**Complete transformation from manual installation to one-click desktop application!**

- **Rust-Based Installer** (Tauri v2 framework):
  - Windows (.msi): ~90 MB installer
  - Linux (.AppImage): ~95 MB installer
  - macOS (.dmg): ~92 MB installer
  - Total code: ~7,700 lines (Rust + documentation)

- **Enhanced 8-Step Setup Wizard**:
  1. Welcome & License Agreement
  2. System Requirements Check (disk/RAM/ports/Docker)
  3. Installation Directory Selection
  4. **Deployment Mode Selection** (Docker/Direct/Server)
  5. Configuration (ports, API key, auto-start)
  6. Admin Account Creation
  7. Real-Time Installation Progress
  8. Completion & Launch

- **Three Deployment Modes**:
  - **Docker Mode**: Containerized deployment with docker-compose
  - **Direct Mode**: Native localhost installation as system service
  - **Server Mode**: Remote SSH deployment to VPS/cloud with nginx + SSL

- **Post-Install Management**:
  - System tray application (12-item menu)
  - Real-time logs viewer (multi-platform)
  - Auto-updater (GitHub Releases)
  - Professional uninstaller with backup options

- **Complete Documentation** (5 comprehensive guides):
  - INSTALLATION.md (~650 lines) - All platforms installation
  - DEPLOYMENT.md (~800 lines) - Production deployment
  - UPGRADING.md (~450 lines) - Migration from v1.2.x
  - TESTING_CHECKLIST.md (~600 lines) - 234 test scenarios
  - RELEASE_CHECKLIST.md (~500 lines) - Release workflow

- **30 Tauri Commands** across 5 categories:
  - Setup (4): system check, bundle resources, npm install, database init
  - Docker (6): check, build, start, stop, health, logs
  - Direct (6): install deps, build, install service, start, stop, status
  - Server (11): SSH connection, upload, remote build, nginx, SSL, firewall
  - Management (13): tray, logs, updater, uninstaller controls

- **Cross-Platform Service Management**:
  - Linux: systemd units
  - macOS: launchd plists
  - Windows: Windows Service (WinSW)

**Implementation Timeline**: 8 phases completed in ~10 days (Phases 1-8)

**Status**: ✅ Ready for release - All development complete, pending builds & code signing

---

### Refactoring
- **Agentic Chat Engine Rename**: `chat-claude.ts` → `agentic-chat.ts`
  - More professional, provider-agnostic naming
  - Describes functionality (tool loop) not specific LLM provider
  - Future-proof for multi-provider support (Gemini, GPT, etc.)
  - Updated all import references and documentation

### Architecture Overhaul
- Complete backend rewrite (Fastify 5, TypeScript)
- Complete frontend rewrite (Next.js 15, React 19, TailwindCSS)
- New database structure (SQLite with auto-migrations)
- Professional extension system (VSCode-style plugins)
- Agent personality system (PERSONALITY.md, MEMORY.md per agent)

### Major Features Added
- Multi-agent system with cron scheduling
- 3D avatar viewer (Ready Player Me integration)
- Interactive 3D worlds with physics (WASD controls)
- 18 built-in agentic tools (browser, memory, storage, CLI)
- Extension SDK with JSON render support
- Skills system (Skill Hub integration - thousands of skills)
- Calendar integration (Google Calendar, iCal)
- WebRTC video calls with AI vision
- Notification system (in-app, email, push, WhatsApp)
- Storage management system
- Database management UI (backup/restore/cleanup)
- Security hardening (42/45 vulnerabilities fixed)
- Credentials vault (AES-256-GCM encryption)
- Audit logging system

### Documentation
- Complete documentation rewrite (11 files)
- CONTRIBUTING.md for developers
- Extension development guide
- Skills system guide
- API reference (50+ endpoints)
- Database schema documentation
- Agent personality system docs

### Credits
Built by: **9mtm** (Creator), **Claude Code** (AI Assistant), **Google Antigravity** (AI Partner)

---

## [1.2.0] - 2026-02-20 [OLDER VERSION]

### Added
- Agent Files System (PERSONALITY.md, MEMORY.md per agent)
- Calendar System (Google Calendar sync, iCal import)
- Database Management UI (backup/restore/cleanup)
- Security Hardening (42/45 vulnerabilities fixed)
- Extension SDK System (plugin architecture)
- Interactive Worlds (physics-based 3D environments)
- Skills System (install from Skill Hub)
- Notification System (in-app, email, push, WhatsApp)
- WebRTC Video Calls with AI vision
- Camera recording and playback

### Changed
- Email Client moved to extension (from core)
- Documentation simplified (7 essential files only)
- Improved security (JWT tokens, account lockout, audit logs)

### Fixed
- Login authentication (database migration paths)
- Avatar ownership bug (hardcoded user ID)
- THREE.js skinned mesh cloning issue

---

## [1.2.0] - 2026-02-20

### Added
- Multi-Agent System with cron scheduling
- 18 Agentic Tools (browser, memory, storage, CLI)
- 3D Avatar Viewer with effects
- Task Kanban Board
- Storage Management
- Credentials Vault (AES-256-GCM)

---

## [1.1.0] - 2026-02-18

### Added
- Agent management
- Chat sessions
- Database migrations
- Authentication system

---

## [1.0.0] - 2026-02-15

### Added
- Initial release
- Basic agent functionality
- SQLite database
- Fastify backend
- Next.js frontend

---

**Version Format:** [Major.Minor.Patch]
- **Major**: Breaking changes
- **Minor**: New features (backward compatible)
- **Patch**: Bug fixes
