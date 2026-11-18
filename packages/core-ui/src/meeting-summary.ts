// A meeting's summary reply is JSON on purpose (the decisions review reads it). In the chat it shows as
// readable text: the summary, then the proposed decisions that wait for the owner's approval.
type Decision = { title?: unknown; assigneeName?: unknown; department?: unknown };

export function meetingSummaryText(text: string): string | null {
  const raw = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (!raw.startsWith('{') || raw.length > 400_000) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { summary, decisions } = value as { summary?: unknown; decisions?: unknown };
  if (typeof summary !== 'string' || !Array.isArray(decisions)) return null;
  const lines = decisions.slice(0, 30).flatMap((d: Decision) => {
    if (!d || typeof d !== 'object' || typeof d.title !== 'string' || !d.title.trim()) return [];
    const who = [typeof d.assigneeName === 'string' ? d.assigneeName : '', typeof d.department === 'string' ? d.department : ''].filter(Boolean).join(' · ');
    return [`- ${d.title.trim()}${who ? ` — ${who}` : ''}`];
  });
  return ['**Meeting summary**', summary.trim(), lines.length ? `**Proposed decisions** (they wait for your approval)\n${lines.join('\n')}` : '_No decisions proposed._'].filter(Boolean).join('\n\n');
}
