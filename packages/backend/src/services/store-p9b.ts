/**
 * STORE-MAP-01 P9b switch (memory quality engine, MD1, MD3, MD5–MD8). On:
 * every source of a memory (chat, agent tool, MCP or coding tool, import,
 * channel, owner) ends in one write pipeline that stores provenance and a
 * trust record at once and enriches it in the background
 * (memory/quality/pipeline.ts); confidence comes from corroboration
 * (memory/quality/trust.ts); reply recall is routed by intent, re-ranked
 * locally within a 300 ms budget and says "no reliable memory" instead of
 * guessing (memory/quality/recall.ts); use teaches the ranking, verified facts
 * only (memory/quality/usage.ts). Off (the default), nothing changes.
 *
 *   GIRRU_STORE_P9B=1
 */

export const STORE_P9B_ENV = 'GIRRU_STORE_P9B';

export function storeP9bEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(String(env[STORE_P9B_ENV] ?? '').trim());
}
