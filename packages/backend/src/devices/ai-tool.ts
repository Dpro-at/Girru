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
/** Coding apps that are installed AND signed in on this computer (checked at most every 30 s). */
let signedCache: { at: number; ids: Set<string> } | null = null;
export async function signedInCodingApps(check: () => Promise<{ id: string; signedIn: boolean }[]> = async () => (await import('../onboarding/first-run.js')).aiTools()): Promise<Set<string>> {
  if (signedCache && Date.now() - signedCache.at < 30_000) return signedCache.ids;
  let ids = new Set<string>();
  try { ids = new Set((await check()).filter(t => t.signedIn).map(t => 'subscription:' + t.id)); } catch { /* none known */ }
  signedCache = { at: Date.now(), ids };
  return ids;
}
export async function computerTools(load: Catalogue = loadModelCatalogue as Catalogue, signed: () => Promise<Set<string>> = () => signedInCodingApps()): Promise<ComputerTool[]> {
  // A coding app that is installed but not signed in would only fail: it is not offered (P15 test, 2026-11-11).
  const ok = await signed();
  const models = ((await load()).models as { id: string; label?: string; name?: string; provider?: string; available?: boolean }[]).filter(m => m.available !== false && typeof m.id === 'string' && (m.provider !== 'subscription' || ok.has(m.id)));
  const first = models.filter(m => m.provider === 'subscription'), rest = models.filter(m => m.provider !== 'subscription');
  return [...first, ...rest].map(m => ({ id: m.id, label: m.label ?? m.name ?? m.id }));
}

/** The tool received work runs with: the owner's choice while it still runs here, else the first one; null when none is signed in. */
export async function computerTool(ownerId: string, load?: Catalogue): Promise<ComputerTool | null> {
  const [tools, rules] = await Promise.all([computerTools(load), readTaskRules(ownerId)]);
  return tools.find(t => t.id === rules.tool) ?? tools[0] ?? null;
}
