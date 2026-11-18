# Extension Development Guide

## Overview

Girru extensions are self-contained plugins that add new functionality to the system. They can:
- Register new API routes
- Add AI agent tools
- Run database migrations
- Schedule cron jobs
- Extend the frontend UI

## Extension Structure

```
extensions/
└── my-extension/
    ├── agentplayer.plugin.json    # Manifest (required)
    ├── index.js                   # Entry point (required)
    ├── migrations/                # Database migrations (optional)
    │   └── 001_init.sql
    └── src/                       # Source code (optional)
        ├── routes.js              # API routes
        └── tool.js                # AI tools
```

## 1. Extension Manifest (`agentplayer.plugin.json`)

**Required fields:**
```json
{
  "id": "my-extension",                  // Unique identifier (kebab-case)
  "name": "My Extension",                // Display name
  "description": "What it does",         // Short description
  "version": "1.0.0",                    // Semantic version
  "type": "tool",                        // Extension type (see below)
  "author": "Your Name",                 // Author name
  "main": "index.js",                    // Entry point file
  "permissions": ["network", "database"] // Required permissions (see below)
}
```

### Extension Types

- **`tool`** - Adds new AI agent tools (e.g., WAF scanner, code analyzer)
- **`channel`** - Adds messaging channels (e.g., Discord, Slack)
- **`integration`** - External service integrations (e.g., GitHub, Stripe)
- **`custom`** - Other functionality

### Permissions

- **`network`** - Make HTTP requests
- **`database`** - Access database
- **`tools`** - Register AI agent tools
- **`scheduler`** - Register cron jobs

## 2. Entry Point (`index.js`)

**CRITICAL: Extensions MUST be pure JavaScript - NO TypeScript syntax!**

❌ **DO NOT USE:**
- `import type { ... }`
- `function foo(param: Type)`
- `interface Foo { ... }`
- Type annotations anywhere

✅ **Correct pattern:**

```javascript
/**
 * Entry point - Pure JavaScript ONLY
 */

import { myRoutes } from './src/routes.js';
import { myTool } from './src/tool.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default {
  id: 'my-extension',
  name: 'My Extension',
  version: '1.0.0',

  /**
   * Called when extension is enabled
   * @param {ExtensionApi} api - Extension SDK
   */
  async register(api) {
    // 1. Run database migrations (idempotent)
    await api.runMigrations([
      join(__dirname, 'migrations', '001_init.sql'),
    ]);

    // 2. Register API routes (mounted at /api/ext/my-extension/)
    api.registerRoutes(myRoutes);

    // 3. Register AI agent tool
    api.registerTool(myTool);

    // 4. Register cron job (optional)
    api.registerCronJob('0 * * * *', async () => {
      // Runs every hour
      api.log('info', 'Hourly task executed');
    }, 'hourly-task');

    api.log('info', 'My Extension ready');
  },

  /**
   * Called when extension is disabled
   * @param {ExtensionApi} api - Extension SDK
   */
  async onDisable(api) {
    api.unregisterTool('my_tool');
    api.unregisterCronJob('hourly-task');
    api.log('info', 'My Extension disabled');
  },
};
```

## 3. Extension SDK API

Extensions receive an `api` object with these methods:

### Route Registration

```javascript
/**
 * Register API routes
 * Routes are mounted at /api/ext/{extensionId}/
 */
api.registerRoutes(async (fastify) => {
  fastify.get('/hello', async (request, reply) => {
    return { message: 'Hello from extension!' };
  });

  fastify.post('/data', async (request, reply) => {
    const { name } = request.body;
    return { received: name };
  });
});

// Routes are now available at:
// GET  http://localhost:41522/api/ext/my-extension/hello
// POST http://localhost:41522/api/ext/my-extension/data
```

### Tool Registration

```javascript
/**
 * Register AI agent tool
 * Tools become available to all AI agents
 */
api.registerTool({
  name: 'my_tool',
  description: 'What this tool does',
  input_schema: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'Input parameter' },
    },
    required: ['input'],
  },
  async execute(params) {
    // Tool logic here
    const result = doSomething(params.input);

    return {
      content: [{
        type: 'text',
        text: `Result: ${result}`,
      }],
    };
  },
});

/**
 * Unregister tool (in onDisable)
 */
api.unregisterTool('my_tool');
```

### Database Migrations

```javascript
/**
 * Run SQL migrations (idempotent)
 * Migrations are tracked in extension_migrations table
 * Same migration won't run twice
 */
await api.runMigrations([
  join(__dirname, 'migrations', '001_init.sql'),
  join(__dirname, 'migrations', '002_add_index.sql'),
]);
```

**Migration file example (`migrations/001_init.sql`):**

```sql
-- Create tables for your extension
CREATE TABLE IF NOT EXISTS my_extension_data (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  value          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_my_extension_created
  ON my_extension_data(created_at DESC);
```

### Cron Jobs

```javascript
/**
 * Register scheduled job
 * @param {string} cronExpression - Standard cron format
 * @param {function} handler - Async function to execute
 * @param {string} jobId - Unique job identifier
 */
api.registerCronJob('0 */6 * * *', async () => {
  // Runs every 6 hours
  const data = await fetchData();
  await processData(data);
}, 'data-sync-job');

/**
 * Unregister cron job (in onDisable)
 */
api.unregisterCronJob('data-sync-job');
```

### Database Access

```javascript
/**
 * Direct database access (better-sqlite3)
 */
const db = api.db;

// SELECT
const users = db.prepare('SELECT * FROM users WHERE active = ?').all(1);

// INSERT
db.prepare('INSERT INTO my_table (name) VALUES (?)').run('value');

// UPDATE
db.prepare('UPDATE my_table SET name = ? WHERE id = ?').run('new', '123');

// DELETE
db.prepare('DELETE FROM my_table WHERE id = ?').run('123');
```

### Configuration Storage

```javascript
/**
 * Get extension config (persisted in database)
 */
const config = api.getConfig();
// Returns: { apiKey: 'xxx', enabled: true } or null

/**
 * Set extension config (saves to database)
 */
api.setConfig({
  apiKey: 'my-api-key',
  endpoint: 'https://api.example.com',
  enabled: true,
});
```

### Logging

```javascript
/**
 * Log messages (appear in backend console)
 */
api.log('info', 'Extension initialized');
api.log('warn', 'Configuration missing');
api.log('error', 'Request failed', { error: err.message });
```

## 4. API Routes Pattern

```javascript
// src/routes.js
export async function myRoutes(fastify) {
  /**
   * GET /api/ext/my-extension/status
   */
  fastify.get('/status', {
    schema: {
      tags: ['My Extension'],
      description: 'Check extension status',
    },
  }, async (request, reply) => {
    return {
      status: 'active',
      version: '1.0.0',
    };
  });

  /**
   * POST /api/ext/my-extension/process
   */
  fastify.post('/process', {
    schema: {
      tags: ['My Extension'],
      description: 'Process data',
      body: {
        type: 'object',
        properties: {
          data: { type: 'string' },
        },
        required: ['data'],
      },
    },
  }, async (request, reply) => {
    const { data } = request.body;
    const db = fastify.db || request.server.db;

    // Process data
    const result = await processData(data, db);

    return { result };
  });
}
```

## 5. AI Tool Pattern

```javascript
// src/tool.js
export const myTool = {
  name: 'my_tool',
  description: 'What the tool does - be specific!',
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['analyze', 'process', 'validate'],
        description: 'Action to perform',
      },
      target: {
        type: 'string',
        description: 'Target to process',
      },
    },
    required: ['action', 'target'],
  },

  async execute(params) {
    const { action, target } = params;

    try {
      let result;

      switch (action) {
        case 'analyze':
          result = await analyzeTarget(target);
          break;
        case 'process':
          result = await processTarget(target);
          break;
        case 'validate':
          result = await validateTarget(target);
          break;
      }

      return {
        content: [{
          type: 'text',
          text: `Action "${action}" completed.\n\nResult: ${result}`,
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `Error: ${error.message}`,
        }],
      };
    }
  },
};
```

## 6. Frontend Integration (Optional)

Extensions can have frontend pages, but it's **optional**.

### Without Frontend
Extension works purely as backend service (API + tools). Perfect for:
- Data processing tools
- External integrations
- Background services

### With Frontend
Add a dashboard page in the main app:

**File:** `src/app/(dashboard)/dashboard/my-extension/page.tsx`

```typescript
'use client';

import { useState } from 'react';
import { Button } from "@/components/ui/button";
import { config } from '@/lib/config';

const BACKEND_URL = config.backendUrl;

export default function MyExtensionPage() {
  const [data, setData] = useState(null);

  const fetchData = async () => {
    const response = await fetch(`${BACKEND_URL}/api/ext/my-extension/status`);
    const result = await response.json();
    setData(result);
  };

  return (
    <div className="space-y-6">
      <h2 className="text-3xl font-bold">My Extension</h2>
      <Button onClick={fetchData}>Fetch Status</Button>
      {data && <pre>{JSON.stringify(data, null, 2)}</pre>}
    </div>
  );
}
```

**Add to sidebar** (`src/components/dashboard/sidebar.tsx`):

```typescript
const developerMenu = [
  // ... existing items
  { name: 'My Extension', href: '/dashboard/my-extension', icon: Puzzle },
];
```

## 7. Testing Extension

### 1. Install Extension

```bash
# Copy extension to extensions directory
cp -r my-extension packages/backend/extensions/

# Or clone from git
cd packages/backend/extensions
git clone https://github.com/user/my-extension.git
```

### 2. Enable Extension

Visit: `http://localhost:41521/dashboard/extensions`

- Click "Enable" button on your extension
- Extension will show up in the list
- Backend restart required for routes to load

### 3. Verify Extension

```bash
# Check extension loaded
curl http://localhost:41522/api/ext/my-extension/status

# Test tool (via AI agent)
# Ask the agent: "Use my_tool to analyze example.com"
```

### 4. View Extension Data

Visit: `http://localhost:41521/dashboard/extensions`

- Click "Database" icon (Inspector)
- See: migrations run, config, tables created, tools registered

## 8. Common Patterns

### HTTP Requests

```javascript
// In route handler or tool
const response = await fetch('https://api.example.com/data', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${config.apiKey}`,
  },
  body: JSON.stringify({ query: 'test' }),
});

const data = await response.json();
```

### Background Processing

```javascript
// Start long-running task in background
async function processInBackground(taskId, db) {
  // Don't await this - runs async
  (async () => {
    try {
      const result = await longRunningOperation();

      db.prepare('UPDATE tasks SET status = ?, result = ? WHERE id = ?')
        .run('completed', JSON.stringify(result), taskId);
    } catch (error) {
      db.prepare('UPDATE tasks SET status = ?, error = ? WHERE id = ?')
        .run('failed', error.message, taskId);
    }
  })();
}
```

### SSE Streaming

```javascript
// Server-sent events for real-time updates
fastify.get('/stream/:taskId', async (request, reply) => {
  const { taskId } = request.params;

  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Cache-Control', 'no-cache');
  reply.raw.setHeader('Connection', 'keep-alive');

  const interval = setInterval(() => {
    const status = getTaskStatus(taskId);
    reply.raw.write(`data: ${JSON.stringify(status)}\n\n`);

    if (status.completed) {
      clearInterval(interval);
      reply.raw.end();
    }
  }, 1000);

  request.raw.on('close', () => clearInterval(interval));
});
```

## 9. Publishing Extension

### Package Structure

```
my-extension/
├── agentplayer.plugin.json
├── index.js
├── README.md              # Extension documentation
├── LICENSE               # License file
├── migrations/
│   └── *.sql
└── src/
    ├── routes.js
    └── tool.js
```

### README.md Template

```markdown
# My Extension

Description of what your extension does.

## Installation

1. Copy to extensions directory
2. Enable from Dashboard → Extensions
3. Restart backend

## Configuration

Set these in extension settings:
- `apiKey`: Your API key
- `endpoint`: API endpoint URL

## Usage

### API Endpoints

- `GET /api/ext/my-extension/status` - Get status
- `POST /api/ext/my-extension/process` - Process data

### AI Tool

Use `my_tool` in agent conversations:
"Use my_tool to analyze example.com"

## License

MIT
```

## 10. Extension Checklist

Before publishing, verify:

- [ ] **Manifest complete** - All required fields filled
- [ ] **Pure JavaScript** - No TypeScript syntax in .js files
- [ ] **Entry point works** - register() and onDisable() hooks present
- [ ] **Migrations idempotent** - Can run multiple times safely
- [ ] **Routes namespaced** - Don't conflict with core routes
- [ ] **Tools documented** - Clear descriptions and examples
- [ ] **Error handling** - Graceful failures, helpful error messages
- [ ] **Logging added** - Info/warn/error logs for debugging
- [ ] **README included** - Installation and usage instructions
- [ ] **Tested enabled** - Extension loads without errors
- [ ] **Tested disabled** - Cleanup works, no orphaned data
- [ ] **License added** - MIT or compatible license

## 11. Examples

See these extensions for reference:

- **WAF Security** (`extensions/waf-security/`) - Full example with routes, tool, migrations, frontend
- **Agent Connect** (Girru Store app `agent-connect`) - Channel integration: every chat channel on one shared host (`extensions/shared/channel-host.js`)

## 12. Support

- GitHub Issues: https://github.com/anthropics/claude-code/issues
- Docs: `/dashboard/extensions` (Inspector dialog)
- Memory: `memory/extension-sdk.md` (detailed architecture)

---

**Remember:** Extensions MUST be pure JavaScript - NO TypeScript syntax in .js files!
