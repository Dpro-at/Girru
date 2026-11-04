/**
 * Write Tool
 *
 * Write a file inside the agent's own workspace `.data/workspaces/<agentId>/`
 * (S1.6). Writing outside it is not possible at all (Q-17).
 */

import type { Tool, ToolResult } from '../types.js';
import { projectRoot } from './edit.js';
import { FileSandboxError, MAX_WRITE_BYTES, sandboxedWriteFile, writeRootFor } from './file-sandbox.js';

export const writeTool: Tool = {
  name: 'write',
  description: `Write a whole text file (a new file, or replace one). In the owner's chat with a folder it writes that folder's real file (paths relative to it; parent folders are created; max ${MAX_WRITE_BYTES} bytes; the owner approves it unless the chat is in "Accept edits"); to change part of an existing file prefer edit. Elsewhere it saves in your own private drafts folder. Protected files (keys, environment files, databases, .git) are never written.`,
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
      // CHAT-LIVE-01 (LW6): in the owner's chat with a folder, the real file in that folder (same owner and folder check as edit).
      // Only where the registry offers it as a chat-folder file tool (owner's own chat turn, not a channel,
      // a hand-off or a task run), so it always went through that gate and its approval rule.
      const chatFolder = !!context?.fileReadRoot && context.chatPlan === true && !context.toolPolicy && !context.delegatedFrom?.length && !context.taskId;
      const folder = chatFolder ? await projectRoot(context!).catch(() => null) : null;
      const root = folder ?? writeRootFor(context);
      const r = sandboxedWriteFile(root, filePath, content);
      if (folder) return { content: [{ type: 'text', text: `Wrote ${r.rel} in the project folder (${r.size} bytes).` }], details: { path: r.rel, size: r.size, modified: r.modified, projectFile: true } };
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
