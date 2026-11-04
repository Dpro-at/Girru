# Contributing to Girru

Thank you for your interest in contributing to Girru! This document provides guidelines and instructions for contributing.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Development Guidelines](#development-guidelines)
- [Extension Development](#extension-development)
- [Pull Request Process](#pull-request-process)
- [Reporting Bugs](#reporting-bugs)
- [Suggesting Features](#suggesting-features)

---

## Code of Conduct

- Be respectful and inclusive
- Welcome newcomers and help them learn
- Focus on constructive feedback
- Respect different viewpoints and experiences

---

## Getting Started

### Prerequisites

- **Node.js** 18+ (recommended: 20.x)
- **pnpm** 8+
- **Python** 3.12+ (for TTS/STT features)
- **Git** for version control

### Quick Start

1. **Fork the repository**
   ```bash
   # Click "Fork" on GitHub
   git clone https://github.com/YOUR_USERNAME/Agent-Player.git
   cd Agent-Player
   ```

2. **Install dependencies**
   ```bash
   pnpm install
   ```

3. **Set up environment**
   ```bash
   # Backend
   cd packages/backend
   cp .env.example .env
   # Edit .env and add your API keys
   ```

4. **Run development servers**
   ```bash
   # Terminal 1 - Frontend (port 41521)
   pnpm dev

   # Terminal 2 - Backend (port 41522)
   cd packages/backend
   pnpm dev
   ```

5. **Access the app**
   - Frontend: http://localhost:41521
   - Backend: http://localhost:41522

---

## Development Setup

### Required API Keys

1. **Anthropic Claude API** (required)
   - Get from: https://console.anthropic.com/
   - Set `ANTHROPIC_API_KEY` in `.env`

2. **OpenAI API** (optional)
   - Get from: https://platform.openai.com/
   - Set `OPENAI_API_KEY` in `.env`

### Database

- SQLite database auto-creates on first run
- Location: `packages/backend/.data/database.db`
- Migrations auto-run on startup
- **NEVER commit `.data/` folder**

### Python Setup (Optional)

For TTS/STT features:
```bash
pip install edge-tts faster-whisper
```

---

## Project Structure

```
agent-player/
├── packages/
│   └── backend/              # Backend server (Fastify)
│       ├── src/
│       │   ├── api/          # API routes
│       │   ├── services/     # Business logic
│       │   ├── tools/        # AI agent tools
│       │   └── db/           # Database & migrations
│       └── extensions/       # Extension system
├── src/                      # Frontend (Next.js 15)
│   ├── app/                  # App router pages
│   ├── components/           # React components
│   └── lib/                  # Utilities & ui-web4
├── public/                   # Static assets
└── scripts/                  # Development tools
```

---

## Development Guidelines

### Code Style

1. **Language**
   - ✅ All code, comments, commits in **English**
   - ✅ Conversations with users can be in any language

2. **UI Components**
   - ✅ **NO emojis in UI code** - use lucide-react icons
   - ✅ Use Sonner toast (NOT browser alerts)
   - ❌ Don't use `alert()`, `confirm()` for notifications

3. **TypeScript/JavaScript**
   - Use TypeScript for new frontend code
   - Use pure JavaScript (.js) for extensions
   - NO TypeScript syntax in extensions (no `import type`, no `: Type`)

4. **Database**
   - Always use `getDatabase()` (not direct import)
   - Use prepared statements (never string concatenation)
   - All tables indexed on foreign keys

5. **Authentication**
   - Use `getUserId(request)` to get user from JWT
   - NEVER hardcode `userId = '1'`
   - All user-scoped routes must validate JWT

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add notification system for extensions
fix: resolve avatar animation freeze
docs: update extension development guide
refactor: extract notification service
test: add tests for memory deduplication
```

### Testing

```bash
# Run tests
pnpm test

# Run linter
pnpm lint

# Type check
pnpm type-check
```

---

### Data and privacy docs

If your change adds a store, a copy of existing data, a new kind of data, or anything that leaves the computer, update the [storage map](docs/architecture/storage-map.md) in the same pull request. It is also the draft of the privacy page, so it must stay true.

- Mark each row as built today, built behind a switch (name the `GIRRU_STORE_…` switch), or planned. Never describe planned work as built.
- Quote only numbers you measured, and say where and how they were measured.
- A new memory switch goes into the switch table in the storage map and the switch table in [docs/UPGRADING.md](docs/UPGRADING.md), together with what start-up does with existing data.
- Public docs are in English only and name no other products as competitors.

## Extension Development

**Create a new extension:**

```bash
# Interactive CLI
node scripts/create-extension.js

# Choose template:
# - app-template: Full-featured app extension
# - tool-template: Minimal AI tool extension
```

**Documentation:**
- [Extension Creator Guide](packages/backend/extensions/EXTENSION_CREATOR_GUIDE.md)
- [Extension Development](packages/backend/extensions/EXTENSION_DEVELOPMENT.md)
- [Migration Guide](packages/backend/extensions/MIGRATION_GUIDE.md)

**Key Rules:**
- Pure JavaScript only (no TypeScript syntax)
- Use JSON Render for UI (61 components available)
- Auto-tag notifications with extension ID
- Follow SDK API patterns

---

## Pull Request Process

### Before Submitting

1. ✅ Code follows style guidelines
2. ✅ All tests pass
3. ✅ No console errors
4. ✅ Documentation updated (if needed)
5. ✅ Commit messages follow conventions
6. ✅ No hardcoded secrets or API keys

### PR Guidelines

1. **One feature per PR**
   - Don't mix multiple features
   - Keep changes focused

2. **Write clear description**
   ```markdown
   ## What does this PR do?
   Brief description of changes

   ## Why?
   Explain the motivation

   ## How to test?
   Step-by-step testing instructions

   ## Screenshots (if UI changes)
   [Add screenshots]
   ```

3. **Link related issues**
   ```
   Closes #123
   Fixes #456
   ```

4. **Wait for review**
   - Address feedback promptly
   - Don't force-push after review starts
   - Keep discussions respectful

### Review Process

1. Automated checks run (CI/CD)
2. Maintainer reviews code
3. Changes requested (if needed)
4. Approved and merged

---

## Reporting Bugs

**Before reporting:**
1. Check existing issues
2. Test on latest version
3. Verify it's reproducible

**Bug report template:**

```markdown
**Describe the bug**
Clear description of what's wrong

**To Reproduce**
Steps to reproduce:
1. Go to '...'
2. Click on '...'
3. See error

**Expected behavior**
What should happen

**Screenshots**
[Add screenshots if applicable]

**Environment:**
- OS: [e.g., Windows 11, macOS 14]
- Browser: [e.g., Chrome 120]
- Version: [e.g., v1.3.0]

**Additional context**
Any other relevant information
```

---

## Suggesting Features

**Feature request template:**

```markdown
**Is your feature related to a problem?**
Describe the problem

**Describe the solution**
Clear description of what you want

**Describe alternatives**
Other solutions you've considered

**Additional context**
Mockups, examples, or references
```

---

## Getting Help

- **Documentation**: Check `/docs` folder
- **Extension Guide**: `packages/backend/extensions/EXTENSION_CREATOR_GUIDE.md`
- **Issues**: Search existing issues first
- **Discussions**: Ask questions in GitHub Discussions

---

## Recognition

Contributors will be:
- Listed in CONTRIBUTORS.md
- Credited in release notes
- Mentioned in project README

Thank you for contributing! 🎉
