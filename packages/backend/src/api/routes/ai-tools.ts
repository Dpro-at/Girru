import type { FastifyInstance } from 'fastify';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { OLLAMA_URL } from '../../llm/ollama.js';
import { sendInternalError } from '../error-handler.js';
import { ToolDefinition, home, appdata, readJsonSafe, extractCursorMeta, extractGeminiMeta, extractVsCodeMeta, extractContinueMeta, extractClaudeCodeMeta, extractOllamaMeta, buildToolRegistry, DetectedTool, scanTool, buildAiToolsContext } from '../../agent/context/installed-tools.js';
export * from '../../agent/context/installed-tools.js';

export async function aiToolsRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/ai-tools — scan all known AI tools
  fastify.get('/api/ai-tools', async (_req, reply) => {
    const registry = buildToolRegistry();
    const results = await Promise.all(registry.map(scanTool));
    const detected = results.filter((r) => r.detected);

    return reply.send({
      tools: results,
      detectedCount: detected.length,
      totalCount: results.length,
      platform: process.platform,
      homeDir: os.homedir(),
    });
  });

  // GET /api/ai-tools/:id — scan a specific tool
  fastify.get<{ Params: { id: string } }>(
    '/api/ai-tools/:id',
    async (req, reply) => {
      const registry = buildToolRegistry();
      const tool = registry.find((t) => t.id === req.params.id);
      if (!tool) return reply.status(404).send({ error: 'Unknown tool' });

      const result = await scanTool(tool);
      return reply.send(result);
    }
  );

  // POST /api/ai-tools/:id/install — run npm/pip install command
  fastify.post<{ Params: { id: string } }>(
    '/api/ai-tools/:id/install',
    async (req, reply) => {
      const registry = buildToolRegistry();
      const tool = registry.find((t) => t.id === req.params.id);
      if (!tool) return reply.status(404).send({ error: 'Unknown tool' });
      if (!tool.installCmd || tool.installType === 'manual') {
        return reply.status(400).send({ error: 'No auto-install available. Visit the download URL manually.' });
      }

      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);

      try {
        if (tool.installType === 'npm') {
          const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
          const { stdout, stderr } = await execFileAsync(npm, ['install', '-g', tool.installCmd.replace('npm install -g ', '')], { timeout: 120_000 });
          return reply.send({ success: true, output: stdout || stderr });
        }

        if (tool.installType === 'pip') {
          const pkg = tool.installCmd.replace('pip install ', '');
          const pythonPaths = [
            `${process.env.LOCALAPPDATA}\\Programs\\Python\\Python312\\python.exe`,
            `${process.env.LOCALAPPDATA}\\Programs\\Python\\Python311\\python.exe`,
            'python3', 'python',
          ];
          for (const python of pythonPaths) {
            try {
              const { stdout, stderr } = await execFileAsync(python, ['-m', 'pip', 'install', pkg], { timeout: 120_000 });
              return reply.send({ success: true, output: stdout || stderr });
            } catch { /* try next python */ }
          }
          return reply.status(500).send({ error: 'Python not found. Install Python first.' });
        }
      } catch (err: any) {
        return sendInternalError(reply, '[AiTools] POST /api/ai-tools/:id/install', err);
      }
    }
  );

  // GET /api/ai-tools/ollama/models — list Ollama models via local API
  fastify.get('/api/ai-tools/ollama/models', async (_req, reply) => {
    try {
      const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return reply.status(503).send({ error: 'Ollama not running' });
      const data: any = await res.json();
      return reply.send({ models: data.models ?? [] });
    } catch {
      return reply.status(503).send({ error: 'Ollama not running or not accessible' });
    }
  });
}
