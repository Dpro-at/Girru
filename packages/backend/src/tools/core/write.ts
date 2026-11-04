/**
 * Write Tool
 *
 * Write a file inside the agent's own workspace `.data/workspaces/<agentId>/`
 * (S1.6). Writing outside it is not possible at all (Q-17).
 */

import type { Tool, ToolResult } from '../types.js';
import { FileSandboxError, MAX_WRITE_BYTES, sandboxedWriteFile, writeRootFor } from './file-sandbox.js';

export const writeTool: Tool = {
  name: 'write',
  description: `Save a text file in your own private drafts folder (paths are relative to it; parent folders are created; max ${MAX_WRITE_BYTES} bytes). It never changes a project's files: in a project chat, change project files with the edit tool when you have it; otherwise say the change is not made.`,
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file to write (relative to your workspace)',
      },
      content: {
        type: 'string',
        description: 'Content to write to the file',
      },
    },
    required: ['path', 'content'],
    examples: [
      {
        path: 'notes/meeting-2024.md',
        content: '# Meeting Notes\n\n## Attendees\n- John\n- Jane\n\n## Topics\n...',
        description: 'Create a new markdown file with meeting notes',
      },
      {
        path: 'drafts/announcement.txt',
        content: 'Hello team, the release moves to Friday.',
        description: 'Save a draft text in the workspace',
      },
    ],
  },

  async execute(params, context): Promise<ToolResult> {
    const { path: filePath, content } = params ?? {};
    try {
      const root = writeRootFor(context);
      const r = sandboxedWriteFile(root, filePath, content);
      // CHAT-LIVE-01: in a project chat the read root is the project; say plainly that this is not the project file.
      const project = !!context?.fileReadRoot;
      const text = project
        ? `Saved a private draft "${r.rel}" (${r.size} bytes) in your own drafts folder. The project's files are NOT changed; the project file "${r.rel}", if any, still has its old text. Do not tell the owner the project was changed.`
        : `✅ File written: ${r.rel} (${r.size} bytes)`;
      return {
        content: [{ type: 'text', text }],
        details: { path: r.rel, size: r.size, modified: r.modified, ...(project ? { privateDraft: true } : {}) },
      };
    } catch (error: any) {
      const message = error instanceof FileSandboxError ? error.message : 'Failed to write file';
      if (!(error instanceof FileSandboxError)) console.error('[WriteTool] write failed:', error?.code ?? 'error');
      return {
        content: [{ type: 'text', text: `❌ ${message}` }],
        error: message,
      };
    }
  },
};
