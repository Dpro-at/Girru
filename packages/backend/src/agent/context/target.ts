/** Canonical explicit @name matching. Extracted from saved group routing.
 * Position ordering and longest match at the same position are preserved;
 * identical names are ambiguous, never resolved by client list order.
 * This matches intent only and grants no access to the selected agents.
 */
export type MentionAgent = { id: string; name: string };
export function mentionedAgents(message: string, agents: readonly MentionAgent[]): { id: string; name: string; at: number }[] {
    const text = message.toLowerCase();
    const named = agents.flatMap(a => {
      const name = a.name?.trim().toLowerCase(); if (!name) return [];
      const needle = `@${name}`; let from = 0;
      while (from < text.length) {
        const at = text.indexOf(needle, from); if (at < 0) break;
        const next = text[at + needle.length];
        if ((at === 0 || /\s/.test(text[at - 1])) && (!next || !/[\p{L}\p{N}_]/u.test(next))) return [{ id: a.id, name, at }];
        from = at + needle.length;
      }
      return [];
    }).sort((a, b) => a.at - b.at || b.name.length - a.name.length);
    const unambiguous = named.filter(a => !named.some(b => b.at === a.at && b.name.length > a.name.length));
    if (unambiguous.some((a, index) => unambiguous.some((b, other) => other !== index && b.at === a.at && b.name === a.name))) throw Error('ambiguous_group_mentions');
    return unambiguous;

}

/** Initial conversation default follows the former UI longest-name choice.
 * Explicit intent is the fallback when no known mention occurs.
 */
export function preferredMention(message: string, agents: readonly MentionAgent[]): string | undefined {
  return [...mentionedAgents(message, agents)].sort((a, b) => b.name.length - a.name.length)[0]?.id;
}
