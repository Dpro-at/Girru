/**
 * MODELS-01-INSTALL switch. On: Girru makes sure the memory helper (the local
 * runtime plus the embedding model) is ready, in the background, after
 * start-up; it never blocks start-up or setup (OPS3), talks to 127.0.0.1
 * only, re-embeds rows saved with the offline hash model afterwards, and the
 * memory health view shows a "Memory helper" row (memory/helper.ts). Off (the
 * default), nothing changes: the embedding model is used only when it is
 * already installed, otherwise the hash fallback.
 *
 *   GIRRU_MEMORY_HELPER=1
 */

export const MEMORY_HELPER_ENV = 'GIRRU_MEMORY_HELPER';

export function memoryHelperEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(String(env[MEMORY_HELPER_ENV] ?? '').trim());
}
