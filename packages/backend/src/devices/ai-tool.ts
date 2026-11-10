/**
 * CP13 “AI tool here”: the AI tool this computer uses for tasks from the owner's other computers
 * and for agents copied with “Same as”. It is the tool signed in on this computer (Claude Code,
 * Codex …, the owner's own account), never an API key the computer does not have.
 * The owner may pick one in Settings › Computers; otherwise the first signed-in tool is used.
 */
import { loadModelCatalogue } from '../services/model-catalogue.js';
import { readTaskRules } from './task-rules.js';

export interface ComputerTool { id: string; label: string }

/** Every AI tool that can run on this computer now, signed-in accounts first. */
type Catalogue = () => Promise<{ models: { id: string; label?: string; name?: string; provider?: string; available?: boolean }[] }>;
export async function computerTools(load: Catalogue = loadModelCatalogue as Catalogue): Promise<ComputerTool[]> {
  const models = ((await load()).models as { id: string; label?: string; name?: string; provider?: string; available?: boolean }[]).filter(m => m.available !== false && typeof m.id === 'string');
  const first = models.filter(m => m.provider === 'subscription'), rest = models.filter(m => m.provider !== 'subscription');
  return [...first, ...rest].map(m => ({ id: m.id, label: m.label ?? m.name ?? m.id }));
}

/** The tool received work runs with: the owner's choice while it still runs here, else the first one; null when none is signed in. */
export async function computerTool(ownerId: string, load?: Catalogue): Promise<ComputerTool | null> {
  const [tools, rules] = await Promise.all([computerTools(load), readTaskRules(ownerId)]);
  return tools.find(t => t.id === rules.tool) ?? tools[0] ?? null;
}
