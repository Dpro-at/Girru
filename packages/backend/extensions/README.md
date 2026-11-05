# Girru Extensions

This directory contains extensions that add functionality to Girru.

## Quick Start

### Creating a New Extension

```bash
# 1. Create extension directory
mkdir extensions/my-extension

# 2. Create manifest
cat > extensions/my-extension/agentplayer.plugin.json << 'EOF'
{
  "id": "my-extension",
  "name": "My Extension",
  "description": "What it does",
  "version": "1.0.0",
  "type": "tool",
  "author": "Your Name",
  "main": "index.js",
  "permissions": ["network", "database", "tools"]
}
EOF

# 3. Create entry point
cat > extensions/my-extension/index.js << 'EOF'
export default {
  id: 'my-extension',
  name: 'My Extension',
  version: '1.0.0',

  async register(api) {
    api.log('info', 'Extension loaded');
  },

  async onDisable(api) {
    api.log('info', 'Extension disabled');
  },
};
EOF
```

## Installed Extensions

| Extension | Type | Status | Description |
|-----------|------|--------|-------------|
| **Agent Connect** | channel | ✅ Active | Every chat channel (Telegram, Discord, Slack, WhatsApp and the rest of the catalog), set up in Settings › Channels |
| **Call Center** | integration | ✅ Active | Phone call handling system |

Email, Calendar, Team and Public Chat were removed from the core. Each will be rebuilt as a Store app.

## What You Can Build

### ✅ Backend Only Extensions
No frontend needed - perfect for:
- **Tools** - Add AI agent capabilities (e.g., code analyzer, file converter)
- **Integrations** - Connect external services (e.g., GitHub, Stripe, SendGrid)
- **Channels** - Add messaging platforms (e.g., Discord, Telegram)
- **Background Services** - Scheduled tasks, data processing

Example: the WAF Security scanner (a Girru Store app now)

### ✅ Full-Stack Extensions
Backend + frontend UI:
- **Dashboards** - Visual interfaces for your extension
- **Settings Pages** - Configuration UIs
- **Data Viewers** - Display extension data

Example: Database Management page

## Core Concepts

### 1. Extension Types

- **`tool`** - Adds AI agent tools
- **`channel`** - Messaging integrations
- **`integration`** - External services
- **`custom`** - Other functionality

### 2. Required Files

```
my-extension/
├── agentplayer.plugin.json   # ✅ Required - Manifest
└── index.js                  # ✅ Required - Entry point
```

### 3. Optional Files

```
my-extension/
├── migrations/               # Database migrations
│   └── 001_init.sql
├── src/                      # Source code
│   ├── routes.js            # API routes
│   └── tool.js              # AI tools
└── README.md                # Documentation
```

### 4. Frontend Integration (Optional)

**🆕 Dynamic Routing (Recommended)** - Routes auto-appear/disappear in sidebar:

Add `frontendRoutes` to your manifest:
```json
{
  "frontendRoutes": [
    {
      "path": "/dashboard/my-extension",
      "name": "My Extension",
      "icon": "Puzzle",
      "position": "main"
    }
  ]
}
```

Then create the page:
```
src/app/(dashboard)/dashboard/my-extension/page.tsx
```

**How it works:**
- ✅ Enable extension → route appears in sidebar automatically
- ✅ Disable extension → route disappears from sidebar
- ✅ No manual sidebar editing needed
- ✅ Works exactly like the bundled extensions

**Available icons:** Any lucide-react icon name (Calendar, Users, MessagesSquare, Puzzle, etc.)

**Positions:**
- `"main"` - Main navigation section
- `"settings"` - Settings submenu
- `"developer"` - Developer submenu (requires dev mode)

**Legacy Method (Not Recommended):**
Manually update sidebar:
```typescript
// src/components/dashboard/sidebar.tsx
{ name: 'My Extension', href: '/dashboard/my-extension', icon: Puzzle }
```

## Extension Capabilities

| Capability | Permission | What It Does |
|------------|-----------|--------------|
| **API Routes** | `network` | Add endpoints at `/api/ext/{id}/` |
| **AI Tools** | `tools` | Register tools for agents |
| **Database** | `database` | Run migrations, store data |
| **Cron Jobs** | `scheduler` | Schedule recurring tasks |
| **HTTP Requests** | `network` | Call external APIs |
| **Config Storage** | `database` | Persist extension settings |

## Example: Minimal Extension

**File:** `extensions/hello/agentplayer.plugin.json`
```json
{
  "id": "hello",
  "name": "Hello Extension",
  "description": "Simple example extension",
  "version": "1.0.0",
  "type": "custom",
  "author": "Dpro",
  "main": "index.js",
  "permissions": []
}
```

**File:** `extensions/hello/index.js`
```javascript
export default {
  id: 'hello',
  name: 'Hello Extension',
  version: '1.0.0',

  async register(api) {
    // Register route
    api.registerRoutes(async (fastify) => {
      fastify.get('/hello', async () => {
        return { message: 'Hello from extension!' };
      });
    });

    api.log('info', 'Hello Extension loaded');
  },

  async onDisable(api) {
    api.log('info', 'Hello Extension disabled');
  },
};
```

**Access:** `http://localhost:41522/api/ext/hello/hello`

## Enable/Disable Extensions

### Via Dashboard (Recommended)
1. Visit `http://localhost:41521/dashboard/extensions`
2. Click "Enable" or "Disable" button
3. Restart backend for routes to load

### Via Database
```sql
-- Enable extension
INSERT OR REPLACE INTO extension_configs (extension_id, enabled)
VALUES ('my-extension', 1);

-- Disable extension
UPDATE extension_configs SET enabled = 0
WHERE extension_id = 'my-extension';
```

## ⚠️ CRITICAL: Pure JavaScript Only

Extensions MUST be written in **pure JavaScript** - NO TypeScript syntax!

❌ **WRONG:**
```javascript
import type { FastifyInstance } from 'fastify';
function foo(param: string): Promise<void> { }
interface Config { apiKey: string; }
```

✅ **CORRECT:**
```javascript
// No type imports
// No type annotations
// No interfaces
function foo(param) { }
```

## Full Documentation

See [EXTENSION_DEVELOPMENT.md](./EXTENSION_DEVELOPMENT.md) for:
- Complete API reference
- Code patterns
- Frontend integration
- Publishing guidelines
- Testing checklist

## Need Help?

- **Inspect Extension:** Dashboard → Extensions → Click "Database" icon
- **View Logs:** Backend console output
- **Documentation:** [EXTENSION_DEVELOPMENT.md](./EXTENSION_DEVELOPMENT.md)
- **Memory:** `memory/extension-sdk.md` (system architecture)
- **Example:** `extensions/waf-security/` (complete working extension)

---

**Next Steps:**
1. Read [EXTENSION_DEVELOPMENT.md](./EXTENSION_DEVELOPMENT.md)
2. Check `extensions/waf-security/` example
3. Create your first extension!
