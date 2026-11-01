import fs from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { q } from '../../repositories/sql-steps.js';
import { findConversation, findProject } from '../../repositories/chat-conversations.js';
import { chatWorkspace } from '../../services/subscription-chat.js';
import { FileSandboxError, realPath, resolveReadPath } from './file-sandbox.js';
import type { Tool, ToolExecutionContext } from '../types.js';

export const MAX_EDIT_BYTES = 24_000;

/** The existing file grants do not imply this separately granted project-edit capability. */
async function projectRoot(context: ToolExecutionContext): Promise<string> {
  if (!context.userId || !context.sessionId || !context.fileReadRoot || context.toolPolicy) throw Error('An owner project chat is required');
  const user = await q.one<{ role: string; status: string }>('SELECT role,status FROM users WHERE id=?', context.userId);
  if (user?.role !== 'owner' || user.status !== 'active') throw Error('An active owner is required');
  const chat = await findConversation(context.userId, context.sessionId);
  if (!chat) throw Error('The conversation is unavailable');
  const project = chat.projectId ? await findProject(context.userId, chat.projectId) : null;
  const root = realPath(project?.folder ?? await chatWorkspace(chat.id));
  if (root !== realPath(context.fileReadRoot)) throw Error('The selected project changed; ask again');
  return root;
}

export function checkedFileEdit(root: string, input: unknown, before: unknown, after: unknown) {
  if (typeof before !== 'string' || typeof after !== 'string' || [before, after].some(text => text.includes('\0') || Buffer.byteLength(text) > MAX_EDIT_BYTES || text.split('\n').length > 1000)) throw Error('Use text files up to 24 KB and 1000 lines');
  const { real, rel } = resolveReadPath(root, input);
  const fd = fs.openSync(real, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_EDIT_BYTES) throw Error('A small, regular, unlinked text file is required');
    const bytes = Buffer.alloc(stat.size + 1); let size = 0;
    while (size < bytes.length) { const n = fs.readSync(fd, bytes, size, bytes.length - size, size); if (!n) break; size += n; }
    if (!isUtf8(bytes.subarray(0, size))) throw Error('Only valid UTF-8 text files can be edited');
    if (size !== stat.size || bytes.subarray(0, size).toString('utf8') !== before) throw Error('The file changed after the proposal; read it and propose the edit again');
    const fresh = fs.fstatSync(fd);
    if (fresh.mtimeMs !== stat.mtimeMs || fresh.size !== stat.size || fresh.ctimeMs !== stat.ctimeMs) throw Error('The file changed during review; ask again');
    const output = Buffer.from(after, 'utf8'); let written = 0;
    while (written < output.length) { const n = fs.writeSync(fd, output, written, output.length - written, written); if (!n) throw Error('The file could not be written completely'); written += n; }
    fs.ftruncateSync(fd, output.length); fs.fsyncSync(fd);
    return { path: rel, size: output.length };
  } finally { fs.closeSync(fd); }
}

export const editTool: Tool = {
  name: 'edit',
  description: 'Replace the exact current text of an existing file in the owner-selected chat project. Read it first and provide its complete before and after text (24 KB, 1000 lines maximum each). A changed file is refused. Ask/Plan mode waits for review before writing; Auto follows this separately granted capability. No paths outside the selected project or protected files.',
  input_schema: { type: 'object', properties: { path: { type: 'string' }, before: { type: 'string' }, after: { type: 'string' } }, required: ['path', 'before', 'after'] },
  async execute(params, context) {
    try {
      if (!context) throw Error('An owner project chat is required');
      if (!params || Object.keys(params).sort().join(',') !== 'after,before,path') throw Error('Send path, before and after only');
      const result = checkedFileEdit(await projectRoot(context), params.path, params.before, params.after);
      return { content: [{ type: 'text', text: `Updated ${result.path}` }], details: result };
    } catch (error) {
      const message = error instanceof FileSandboxError ? error.message : error instanceof Error ? error.message : 'The edit was refused';
      return { content: [{ type: 'text', text: message }], error: message };
    }
  },
};
