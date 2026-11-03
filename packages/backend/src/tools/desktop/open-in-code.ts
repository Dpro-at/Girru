/**
 * CODE-OPEN-01: an agent's "Open in Code" (board C3). The same check as the
 * window (services/code-open.ts): a regular file inside one of the owner's
 * projects or Girru's data folder, real path checked, no links. Every call
 * needs the owner's approval ('other'), only in the owner's own turn and never
 * when answering someone else. The answer is the checked file (root folder,
 * relative file, line, whether Girru writes it), the same target the window's
 * "Open in Code" sends to the Code page.
 */

import type { Tool, ToolResult, ToolExecutionContext } from '../types.js';
import { reviewOwner } from '../memory/review.js';
import { auditTool } from '../memory/scopes.js';
import { CodeOpenError, codeTarget } from '../../services/code-open.js';

const fail = (msg: string): ToolResult => ({ content: [{ type: 'text', text: `open_in_code refused: ${msg}` }], error: msg });

export const openInCodeTool: Tool = {
  name: 'open_in_code',
  description: `Open a file in Girru's own Code app at a line, for the owner, after the owner approves this call. Give the full
path of a file inside one of the owner's projects or Girru's data folder, and optionally the line. Files outside, links,
keys, environment files and databases are refused.`,
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Full path of the file' }, line: { type: 'integer', minimum: 1, description: 'Line to open at' } },
    required: ['path'],
  },
  async execute(params: { path?: unknown; line?: unknown }, context?: ToolExecutionContext): Promise<ToolResult> {
    const owner = await reviewOwner(context);
    if (typeof owner !== 'string') return fail(owner.refused);
    try {
      const t = await codeTarget(owner, { path: params?.path, line: params?.line });
      auditTool(context, 'code.open', 'file', t.file.slice(0, 200), { where: t.where, line: t.line, generated: t.generated });
      return { content: [{ type: 'text', text: `Ready to open ${t.file}${t.line ? ` at line ${t.line}` : ''} in Code${t.generated ? ' (Girru writes this file: saved edits come back as a review)' : ''}.` }], data: { success: true, openInCode: t } } as ToolResult;
    } catch (err) {
      if (err instanceof CodeOpenError) return fail(err.message);
      throw err;
    }
  },
};
