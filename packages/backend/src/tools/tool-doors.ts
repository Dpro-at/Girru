/**
 * One tool definition, three doors (STORE-MAP-01 XP1, P2b).
 *
 * A ToolDef is the one shape every Girru tool is written in (name,
 * description, JSON schema). Each door renders it the way its models read it:
 *
 *   native     API and local models: { name, description, input_schema }
 *              (Ollama / LM Studio / OpenAI-compatible: { type: 'function', function: … })
 *   protocol   the subscription JSON tool protocol: the same object as JSON text
 *   mcp        coding apps and editors over MCP: { name, description, inputSchema }
 *
 * The short index line (tools on demand) and the simpler form for small
 * models are made here too, so a tool reads the same whichever door it goes
 * through, and the doors cannot drift apart.
 */

export interface ToolDef { name: string; description: string; input_schema: any }

export const asNative = (d: ToolDef) => ({ name: d.name, description: d.description, input_schema: d.input_schema });
export const asFunction = (d: ToolDef) => ({ type: 'function' as const, function: { name: d.name, description: d.description, parameters: d.input_schema } });
export const asMcp = (d: ToolDef) => ({ name: d.name, description: d.description, inputSchema: d.input_schema });
export const asProtocol = (defs: readonly ToolDef[]) => JSON.stringify(defs.map(asNative));
export const fromMcp = (t: { name: string; description: string; inputSchema: any }): ToolDef => ({ name: t.name, description: t.description, input_schema: t.inputSchema });

/** The first sentence of a description, on one line, at most `max` characters. */
export function shortLine(description: string, max = 90): string {
  const flat = String(description ?? '').replace(/\s+/g, ' ').trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(flat);
  const first = (m ? m[1] : flat).replace(/[.!?]$/, '');
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}

/** A schema without examples and with short property texts (small models; same arguments, fewer words). */
export function simpleSchema(schema: any, propChars = 60): any {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'examples' || k === 'example') continue;
    if (k === 'description' && typeof v === 'string') { out[k] = shortLine(v, propChars); continue; }
    if (k === 'properties' && v && typeof v === 'object') { out[k] = Object.fromEntries(Object.entries(v).map(([p, s]) => [p, simpleSchema(s, propChars)])); continue; }
    if ((k === 'items' || k === 'additionalProperties') && v && typeof v === 'object') { out[k] = simpleSchema(v, propChars); continue; }
    if ((k === 'oneOf' || k === 'anyOf') && Array.isArray(v)) { out[k] = v.map((s) => simpleSchema(s, propChars)); continue; }
    out[k] = v;
  }
  return out;
}

/** The simpler form of a tool for a small model: its first sentence and a schema without examples. */
export const simpleDef = (d: ToolDef): ToolDef => ({ name: d.name, description: shortLine(d.description, 160), input_schema: simpleSchema(d.input_schema) });

/** The group a tool belongs to (the word before its first "_"; MCP tools are "mcp"). */
export const groupOf = (name: string): string => (name.startsWith('mcp__') ? 'mcp' : name.split('_')[0] || name);
