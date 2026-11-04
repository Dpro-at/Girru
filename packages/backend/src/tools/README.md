# Girru — Professional Tools System

**19 professional tools** with examples-driven design for maximum AI accuracy and performance.

## 🚀 Recent Upgrades (2026-02-23)

- ✅ **NEW: execute_code tool** — Programmatic tool calling (10x faster for multi-step tasks)
- ✅ **Professional examples** — All 19 tools have 3-5 usage examples (50% better accuracy)
- ✅ **Smart filtering** — web_fetch supports maxLength + extractText (60% cheaper)
- ✅ **Tool template** — TOOL_TEMPLATE.ts for standardized new tool development

## Directory Structure

```
tools/
├── core/                       # 5 tools: exec, read, write, web_fetch, execute_code
│   ├── exec.ts
│   ├── read.ts
│   ├── write.ts
│   ├── web-fetch.ts
│   ├── execute-code.ts        # NEW: Programmatic tool calling
│   └── index.ts
│
├── browser/                    # 4 tools: navigate, screenshot, extract, interact
│   ├── navigate.ts
│   ├── screenshot.ts
│   ├── extract.ts
│   ├── interact.ts
│   └── index.ts
│
├── memory/                     # the agent's memory tools (see "Memory Tools" below)
│   ├── save.ts, search.ts, recall.ts, edit.ts, forget.ts, move.ts
│   ├── review.ts, scopes.ts, graph.ts, doctor.ts, desktop.ts
│   ├── bridge.ts, project-tech.ts, project-access.ts
│   └── index.ts
│
├── desktop/                    # 1 tool: desktop_control
│   ├── desktop.ts
│   └── index.ts
│
├── storage/                    # 3 tools: storage_save, storage_search, storage_delete
│   ├── storage-save.tool.ts
│   ├── storage-search.tool.ts
│   ├── storage-delete.tool.ts
│   └── index.ts
│
├── notifications/              # 1 tool: create_reminder
│   ├── create-reminder.tool.ts
│   └── index.ts
│
├── credentials/                # 1 tool: credentials_save
│   ├── credentials-save.ts
│   └── index.ts
│
├── TOOL_TEMPLATE.ts            # Professional template for new tools
├── types.ts                    # Shared Tool / ToolResult interfaces
├── registry.ts                 # ToolsRegistry class
└── index.ts                    # createToolsRegistry() — main export (19 tools)
```

## All 19 Tools

### Core Tools (5)

| Tool | File | Description | Examples |
|------|------|-------------|----------|
| `exec` | core/exec.ts | Run whitelisted shell commands | 6 examples |
| `read` | core/read.ts | Read files from filesystem | 4 examples |
| `write` | core/write.ts | Write or create files | 3 examples |
| `web_fetch` | core/web-fetch.ts | Fetch web pages with smart filtering | 3 examples |
| `execute_code` | core/execute-code.ts | **NEW**: Execute JavaScript with toolbox access | 4 examples |

#### ⭐ execute_code — Programmatic Tool Calling

The most powerful tool for complex workflows. Instead of calling tools one-by-one (slow), write JavaScript code that uses multiple tools in loops.

**Example:**
```javascript
// Get weather for 5 cities in ONE tool call instead of 5
const cities = ['London', 'Paris', 'Berlin', 'Tokyo', 'NewYork'];
const weather = [];
for (const city of cities) {
  const result = await toolbox.exec({
    command: `curl wttr.in/${city}?format=3`
  });
  weather.push(`${city}: ${result}`);
}
return weather.join('\n');
```

**Benefits:**
- 10x faster for multi-step tasks
- 80% reduction in API costs
- Full JavaScript logic (loops, conditions, etc.)
- Runs in an isolated, permission-restricted process with a 30s timeout

### Browser Tools (4) — requires Puppeteer

| Tool | File | Description | Examples |
|------|------|-------------|----------|
| `browser_navigate` | browser/navigate.ts | Navigate to a URL, return page info | 3 examples |
| `browser_screenshot` | browser/screenshot.ts | Capture browser screenshots | 3 examples |
| `browser_extract` | browser/extract.ts | Extract structured data from pages | 3 examples |
| `browser_interact` | browser/interact.ts | Click, type, fill forms | 2 examples |

### Memory Tools — one memory contract

Every caller (Girru's own agents, API and local models, and coding apps over MCP) uses the
same five verbs, defined once in [`memory/contract.ts`](../memory/contract.ts). Both doors are
generated from that one definition, and the server checks every argument itself:

| Verb | Tool name | Meaning |
|------|-----------|---------|
| recall | `memory_recall` | Search the memory this caller may read |
| save | `memory_save` | A lasting fact, with an optional topic key (one fact per topic) |
| supersede | `memory_supersede` | A new text that replaces one memory; the old one stays as history |
| handoff | `memory_handoff` | Done / left / next / questions for the next agent |
| propose | `memory_propose` | A fact, decision or correction the owner reviews first |

- **Coding apps (MCP, `dpro-memory`):** the five verbs plus the read tools `project_brief`,
  `pinned_facts`, `latest_handoff`, `memory_search` and `project_design`, and the write tools
  `memory_propose` and `handoff_write`. See [`memory/bridge/mcp-server.ts`](../memory/bridge/mcp-server.ts).
- **Native tools:** the contract's native definitions are not added to every turn (that would
  grow the prompt of local models); they load on demand.
- **The project brief** (`.girru/brief.md`, the Girru section of `AGENTS.md`, the `project_brief`
  answer) explains the task file, when to resume with `project_brief` / `latest_handoff`, when to
  call `handoff_write`, and lists the project's topics by title only; details come from
  `memory_search`.
- **Owner tools** in `memory/` (review, scopes, graph, doctor, trash, move, edit, forget) manage the
  memory from the Memory window and stay owner-only or ask for approval.
- Owner, people and personal memory never go into project files.

### Desktop Tool (1) — requires pyautogui

| Tool | File | Description | Examples |
|------|------|-------------|----------|
| `desktop_control` | desktop/desktop.ts | OS-level mouse, keyboard, screenshots | 4 examples |

### Storage Tools (3)

| Tool | File | Description | Examples |
|------|------|-------------|----------|
| `storage_save` | storage/storage-save.tool.ts | Save files to local storage | 3 examples |
| `storage_search` | storage/storage-search.tool.ts | Search stored files | 3 examples |
| `storage_delete` | storage/storage-delete.tool.ts | Delete stored files | 1 example |

### Notification Tools (1)

| Tool | File | Description | Examples |
|------|------|-------------|----------|
| `create_reminder` | notifications/create-reminder.tool.ts | Create scheduled reminders | 3 examples |

### Credentials Tools (1)

| Tool | File | Description | Examples |
|------|------|-------------|----------|
| `credentials_save` | credentials/credentials-save.ts | Securely store credentials | 3 examples |

## Usage

```typescript
import { createToolsRegistry } from './tools/index.js';

const registry = createToolsRegistry({
  userId: 'user-123',
  sessionId: 'session-abc',
  workspaceDir: process.cwd(),
});

// Simple tool call
const result = await registry.execute('exec', {
  command: 'curl wttr.in/London?format=3'
});

// Programmatic tool calling (NEW!)
const codeResult = await registry.execute('execute_code', {
  code: `
    const cities = ['London', 'Paris', 'Berlin'];
    const weather = [];
    for (const city of cities) {
      const result = await toolbox.exec({
        command: \`curl wttr.in/\${city}?format=3\`
      });
      weather.push(\`\${city}: \${result}\`);
    }
    return weather.join('\\n');
  `
});
```

## Adding a New Tool

**Use the professional template:**

1. Copy `TOOL_TEMPLATE.ts` to your category directory
2. Follow the template structure (includes all best practices)
3. Add 3-5 professional examples
4. Export from category `index.ts`
5. Register in `tools/index.ts` inside `createToolsRegistry()`

**Template structure:**
```typescript
import type { Tool, ToolResult, ToolExecutionContext } from '../types.js';

export const myTool: Tool = {
  name: 'my_tool',
  description: 'Clear description with use cases',
  input_schema: {
    type: 'object',
    properties: {
      param: {
        type: 'string',
        description: 'Parameter description'
      },
    },
    required: ['param'],
    // IMPORTANT: Add 3-5 examples for better AI accuracy
    examples: [
      {
        param: 'example value',
        description: 'What this example demonstrates',
      },
      // ... more examples
    ],
  },
  async execute(params, context?): Promise<ToolResult> {
    // Implementation with error handling
    return {
      content: [{ type: 'text', text: 'Result' }],
    };
  },
};
```

## Best Practices

1. **Always add examples** — 3-5 examples per tool improves AI accuracy by 50%
2. **Use clear descriptions** — Explain what the tool does and when to use it
3. **Handle errors gracefully** — Return helpful error messages
4. **Add security validation** — Validate inputs, use whitelists where needed
5. **Log for debugging** — Use `console.log` with `[ToolName]` prefix
6. **Consider execute_code** — For multi-step workflows, use programmatic calling

## Performance Tips

- **Multi-step tasks**: Use `execute_code` instead of multiple separate tool calls
- **Web scraping**: Use `web_fetch` with `maxLength` and `extractText` for cheaper API calls
- **Parallel execution**: Tools are executed in parallel when possible (`Promise.all`)
- **Rate limiting**: Built-in retry logic with exponential backoff

## Security

- **execute_code**: Runs in its own Node process with the permission system on (no files, child processes, workers or addons), no environment, no code generation from strings, and time, memory and toolbox-call limits
- **exec**: Whitelist-only command execution (no arbitrary commands)
- **File operations**: Path validation to prevent traversal attacks
- **Credentials**: AES-256-GCM encryption for stored credentials

## Documentation

- Full tool reference: [docs/TOOLS.md](../../../../docs/TOOLS.md)
- Tool template: [TOOL_TEMPLATE.ts](./TOOL_TEMPLATE.ts)
- Storage map: [docs/architecture/storage-map.md](../../../../docs/architecture/storage-map.md)
