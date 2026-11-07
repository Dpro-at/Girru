import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { OLLAMA_URL } from '../../llm/ollama.js';

export interface ToolDefinition {
  id: string;
  name: string;
  icon: string;
  description: string;
  /** Paths to check for existence (first match wins) */
  detectPaths: string[];
  /** Install command (npm/pip — runs in backend shell) */
  installCmd?: string;
  /** Install type: 'npm' | 'pip' | 'manual' */
  installType?: 'npm' | 'pip' | 'manual';
  /** Optional: function to extract safe metadata after detection */
  extractMeta?: (basePath: string) => Promise<Record<string, any>>;
}

export function home(...parts: string[]): string {
  return path.join(os.homedir(), ...parts);
}

export function appdata(...parts: string[]): string {
  // Windows: %APPDATA%, Mac: ~/Library/Application Support, Linux: ~/.config
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? home('AppData', 'Roaming'), ...parts);
  }
  if (process.platform === 'darwin') {
    return home('Library', 'Application Support', ...parts);
  }
  return home('.config', ...parts);
}

export async function readJsonSafe(filePath: string): Promise<any | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function extractCursorMeta(basePath: string): Promise<Record<string, any>> {
  const meta: Record<string, any> = {};

  // Count projects
  try {
    const projects = await fs.readdir(path.join(basePath, 'projects'));
    meta.projectCount = projects.filter((p) => !p.startsWith('.')).length;
  } catch { /* skip */ }

  // MCP server names only (no credentials)
  const mcpJson = await readJsonSafe(path.join(basePath, 'mcp.json'));
  if (mcpJson?.mcpServers) {
    meta.mcpServers = Object.keys(mcpJson.mcpServers);
  }

  // AI tracking DB size
  try {
    const dbStat = await fs.stat(path.join(basePath, 'ai-tracking', 'ai-code-tracking.db'));
    meta.aiTrackingDbSize = dbStat.size;
  } catch { /* skip */ }

  return meta;
}

export async function extractGeminiMeta(basePath: string): Promise<Record<string, any>> {
  const meta: Record<string, any> = {};

  // Active account email (safe to show)
  const accounts = await readJsonSafe(path.join(basePath, 'google_accounts.json'));
  if (accounts?.active) {
    meta.activeEmail = accounts.active;
  }

  // GEMINI.md content (safe)
  try {
    const geminiMd = await fs.readFile(path.join(basePath, 'GEMINI.md'), 'utf-8');
    meta.hasGeminiMd = true;
    meta.geminiMdPreview = geminiMd.slice(0, 200);
  } catch { /* skip */ }

  return meta;
}

export async function extractVsCodeMeta(settingsPath: string): Promise<Record<string, any>> {
  const meta: Record<string, any> = {};
  const settings = await readJsonSafe(settingsPath);
  if (!settings) return meta;

  // Copilot status (safe)
  const copilotEnabled = settings['github.copilot.enable'];
  if (copilotEnabled !== undefined) {
    meta.copilotEnabled = Object.values(copilotEnabled).some(Boolean);
  }

  // Python path (safe, useful)
  const python = settings['python.defaultInterpreterPath'] ?? settings['python.pythonPath'];
  if (python) meta.pythonPath = python;

  // Active theme (safe)
  if (settings['workbench.colorTheme']) meta.colorTheme = settings['workbench.colorTheme'];

  return meta;
}

export async function extractContinueMeta(basePath: string): Promise<Record<string, any>> {
  const meta: Record<string, any> = {};

  // Try config.yaml or config.json
  for (const name of ['config.yaml', 'config.json']) {
    try {
      const content = await fs.readFile(path.join(basePath, name), 'utf-8');
      meta.configFile = name;
      meta.configPreview = content.slice(0, 200);
      break;
    } catch { /* skip */ }
  }

  return meta;
}

export async function extractClaudeCodeMeta(basePath: string): Promise<Record<string, any>> {
  const meta: Record<string, any> = {};

  // Count projects
  try {
    const projects = await fs.readdir(path.join(basePath, 'projects'));
    meta.projectCount = projects.filter((p) => !p.startsWith('.')).length;
  } catch { /* skip */ }

  // Stats
  const stats = await readJsonSafe(path.join(basePath, 'stats-cache.json'));
  if (stats?.dailyActivity) {
    const totals = stats.dailyActivity.reduce(
      (acc: any, d: any) => ({
        messages: acc.messages + (d.messageCount ?? 0),
        sessions: acc.sessions + (d.sessionCount ?? 0),
      }),
      { messages: 0, sessions: 0 }
    );
    meta.totalMessages = totals.messages;
    meta.totalSessions = totals.sessions;
    meta.lastActive = stats.lastComputedDate;
  }

  // Subscription info (safe — no token)
  try {
    const creds = await readJsonSafe(path.join(basePath, '.credentials.json'));
    if (creds?.claudeAiOauth?.subscriptionType) {
      meta.subscription = creds.claudeAiOauth.subscriptionType;
    }
  } catch { /* skip */ }

  // Enabled plugins count
  const settings = await readJsonSafe(path.join(basePath, 'settings.json'));
  if (settings?.enabledPlugins) {
    meta.enabledPlugins = Object.keys(settings.enabledPlugins).filter(
      (k) => settings.enabledPlugins[k]
    ).length;
  }

  return meta;
}

export async function extractOllamaMeta(_basePath: string): Promise<Record<string, any>> {
  const meta: Record<string, any> = {};
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const data: any = await res.json();
      const models: string[] = (data.models ?? []).map((m: any) => m.name as string);
      meta.models = models;
      meta.modelCount = models.length;
    }
  } catch { /* Ollama not running or not accessible */ }
  return meta;
}

export function buildToolRegistry(): ToolDefinition[] {
  return [
    {
      id: 'claude-code',
      name: 'Claude Code',
      icon: '🤖',
      description: 'Anthropic Claude Code CLI',
      detectPaths: [home('.claude')],
      installCmd: 'npm install -g @anthropic-ai/claude-code',
      installType: 'npm',
      extractMeta: extractClaudeCodeMeta,
    },
    {
      id: 'gemini',
      name: 'Google Gemini',
      icon: '✨',
      description: 'Google Gemini CLI',
      detectPaths: [home('.gemini')],
      installCmd: 'npm install -g @google/gemini-cli',
      installType: 'npm',
      extractMeta: extractGeminiMeta,
    },
    {
      id: 'cursor',
      name: 'Cursor',
      icon: '⚡',
      description: 'AI-powered code editor',
      detectPaths: [
        home('.cursor'),
        appdata('Cursor'),
      ],
      installType: 'manual',
      installCmd: 'https://www.cursor.com/download',
      extractMeta: extractCursorMeta,
    },
    {
      id: 'vscode',
      name: 'VS Code',
      icon: '💙',
      description: 'Visual Studio Code editor',
      detectPaths: [
        appdata('Code', 'User', 'settings.json'),
        home('.config', 'Code', 'User', 'settings.json'),
      ],
      installType: 'manual',
      installCmd: 'https://code.visualstudio.com/download',
      extractMeta: async (p) => extractVsCodeMeta(p),
    },
    {
      id: 'ollama',
      name: 'Ollama',
      icon: '🦙',
      description: 'Local LLM runtime',
      detectPaths: [
        home('.ollama'),
        home('Library', 'Application Support', 'Ollama'),
        appdata('Ollama'),
      ],
      installType: 'manual',
      installCmd: 'https://ollama.com/download',
      extractMeta: extractOllamaMeta,
    },
    {
      id: 'aider',
      name: 'Aider',
      icon: '🛠️',
      description: 'AI pair programming in terminal',
      detectPaths: [home('.aider'), home('.aider.conf.yml')],
      installCmd: 'pip install aider-chat',
      installType: 'pip',
    },
    {
      id: 'windsurf',
      name: 'Windsurf (Codeium)',
      icon: '🌊',
      description: 'Codeium Windsurf IDE',
      detectPaths: [
        home('.codeium'),
        home('.codeium', 'windsurf'),
        appdata('Windsurf'),
      ],
      installType: 'manual',
      installCmd: 'https://windsurf.com/download',
    },
    {
      id: 'continue',
      name: 'Continue',
      icon: '🔄',
      description: 'Open-source AI code assistant',
      detectPaths: [
        home('.continue'),
        appdata('continue'),
      ],
      installType: 'manual',
      installCmd: 'VS Code extension: Continue',
      extractMeta: extractContinueMeta,
    },
    {
      id: 'copilot',
      name: 'GitHub Copilot',
      icon: '🐙',
      description: 'GitHub AI code assistant',
      detectPaths: [
        home('.config', 'github-copilot'),
        appdata('GitHub Copilot'),
        home('Library', 'Application Support', 'GitHub Copilot'),
      ],
      installType: 'manual',
      installCmd: 'VS Code extension: GitHub Copilot',
    },
    {
      id: 'openai',
      name: 'OpenAI CLI',
      icon: '🌐',
      description: 'OpenAI command line tools',
      detectPaths: [
        home('.openai'),
        home('.config', 'openai'),
      ],
      installCmd: 'pip install openai',
      installType: 'pip',
    },
  ];
}

export interface DetectedTool {
  id: string;
  name: string;
  icon: string;
  description: string;
  detected: boolean;
  detectedPath: string | null;
  meta: Record<string, any>;
  installCmd: string | null;
  installType: 'npm' | 'pip' | 'manual' | null;
}

export async function scanTool(tool: ToolDefinition): Promise<DetectedTool> {
  const installCmd = tool.installCmd ?? null;
  const installType = tool.installType ?? null;

  for (const p of tool.detectPaths) {
    try {
      await fs.access(p);
      // Path exists — extract metadata
      const meta = tool.extractMeta ? await tool.extractMeta(p).catch(() => ({})) : {};
      return {
        id: tool.id,
        name: tool.name,
        icon: tool.icon,
        description: tool.description,
        detected: true,
        detectedPath: p,
        meta,
        installCmd,
        installType,
      };
    } catch { /* not found at this path */ }
  }

  return {
    id: tool.id,
    name: tool.name,
    icon: tool.icon,
    description: tool.description,
    detected: false,
    detectedPath: null,
    meta: {},
    installCmd,
    installType,
  };
}

export async function buildAiToolsContext(): Promise<string> {
  try {
    const registry = buildToolRegistry();
    const results = await Promise.all(registry.map(scanTool));
    const detected = results.filter((r) => r.detected);
    if (detected.length === 0) return '';

    const lines = detected.map((t) => {
      const details: string[] = [];
      if (t.meta.projectCount) details.push(`${t.meta.projectCount} projects`);
      if (t.meta.mcpServers?.length) details.push(`MCP: ${t.meta.mcpServers.join(', ')}`);
      if (t.meta.activeEmail) details.push(`logged in: ${t.meta.activeEmail}`);
      if (t.meta.copilotEnabled) details.push('Copilot enabled');
      if (t.meta.totalMessages) details.push(`${t.meta.totalMessages} messages`);
      if (t.meta.subscription) details.push(`subscription: ${t.meta.subscription}`);
      if (t.meta.models?.length) details.push(`models: ${(t.meta.models as string[]).slice(0, 5).join(', ')}`);
      const detail = details.length ? ` (${details.join(', ')})` : '';
      return `- ${t.icon} ${t.name}${detail}`;
    });

    return `## Detected AI Tools (installed on this machine)\n${lines.join('\n')}\n`;
  } catch {
    return '';
  }
}
