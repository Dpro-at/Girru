/**
 * STORE-MAP-01 P2 (AG1): an agent's specialties and skills, loaded step by
 * step. The prompt carries only each guide's name and one line; the agent
 * reads a guide's full text with the guide_read tool when its work needs it.
 * Only the agent's own linked specialties and assigned skills are listed or
 * readable. A guide is instructions about how to work: it never grants tools,
 * connectors, memory access or permission to act.
 */

import { q } from '../../repositories/sql-steps.js';
import { SpecialtyTemplates } from '../../services/specialty-templates.js';
import { centralSkills } from '../../skills/central-store.js';

export interface Guide {
  kind: 'specialty' | 'skill';
  id: string;
  name: string;
  /** The guide's own one-line description: what agents see before they read it. */
  line: string;
  revision: number;
}

/** First line of a description, at most 160 characters. */
export function oneLine(text: string | null | undefined): string {
  const first = String(text ?? '').replace(/\r/g, '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return first.length > 160 ? `${first.slice(0, 157).trimEnd()}…` : first;
}

/** The agent's linked specialties, then its skills (from those specialties and assigned directly). */
export async function agentGuides(agentId: string): Promise<Guide[]> {
  const out: Guide[] = [];
  const skillIds = new Set<string>();
  const store = new SpecialtyTemplates();
  const links = await q.all<{ template_id: string }>('SELECT template_id FROM agent_specialties WHERE agent_id = ? ORDER BY template_id', agentId);
  for (const link of links) {
    try {
      const t = await store.get(link.template_id);
      out.push({ kind: 'specialty', id: t.id, name: t.name, line: oneLine(t.description), revision: Number(t.revision) });
      for (const id of [t.config.primarySkill, ...t.config.skills]) if (id) skillIds.add(id);
    } catch { /* a removed specialty is not listed */ }
  }
  for (const s of (await centralSkills().assignments(agentId)).selected) skillIds.add(s);
  if (skillIds.size) {
    const ids = [...skillIds];
    const rows = await q.all<{ id: string; name: string; description: string; revision: number }>(
      `SELECT id, name, description, revision FROM central_skills WHERE id IN (${ids.map(() => '?').join(', ')}) ORDER BY name`, ...ids);
    for (const r of rows) out.push({ kind: 'skill', id: r.id, name: r.name, line: oneLine(r.description), revision: Number(r.revision) });
  }
  return out;
}

/** The prompt block: names and one line each, plus how to read one. '' when the agent has none. */
export async function guidesIndex(agentId: string): Promise<string> {
  const guides = await agentGuides(agentId).catch(() => []);
  if (!guides.length) return '';
  const rows = guides.map((g) => `- ${g.kind === 'specialty' ? 'Specialty' : 'Skill'}: ${g.name}${g.line ? ` — ${g.line}` : ''}`);
  return 'Only the name and one line of each guide is here. Before work that a guide covers, call guide_read with its name to load its full instructions, and follow them. Guides never grant tools, connector access or permission to act; use only the tools you are offered.\n'
    + rows.join('\n');
}

/** Full text of one of the agent's own guides by name (case-insensitive), or null. */
export async function readGuide(agentId: string, name: string): Promise<{ kind: Guide['kind']; name: string; revision: number; text: string } | null> {
  const want = String(name ?? '').trim().toLowerCase();
  if (!want) return null;
  const g = (await agentGuides(agentId)).find((x) => x.name.toLowerCase() === want);
  if (!g) return null;
  if (g.kind === 'specialty') {
    const t = await new SpecialtyTemplates().get(g.id);
    const tools = (t.config.requirements?.map((x) => x.name) ?? t.config.tools.map((x) => x.name)).join(', ') || 'None specified';
    return { kind: g.kind, name: t.name, revision: Number(t.revision), text: `${t.description}\n\n${t.instructions}\n\nRequired tools: ${tools}.` };
  }
  const bundle = await centralSkills().read(g.id);
  const main = bundle.files.find((f: { path: string }) => f.path === 'SKILL.md')?.content ?? '';
  const others = bundle.files.filter((f: { path: string }) => f.path !== 'SKILL.md').map((f: { path: string }) => f.path);
  return {
    kind: g.kind, name: g.name, revision: g.revision,
    text: main.replace(/^---\n[\s\S]*?\n---\n/, '').trim() + (others.length ? `\n\nOther files of this skill: ${others.join(', ')}.` : ''),
  };
}
