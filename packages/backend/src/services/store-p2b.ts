/**
 * STORE-MAP-01 P2b switch (LOCAL-ONLY-01: local models only, from day one).
 * On:
 *  - tools on demand: a turn sends the memory verbs in full plus a short
 *    index of the other tools (name and one line); a tool's full form comes
 *    with `tool_load`, or when it is called (tools/on-demand.ts). One
 *    definition feeds the native door, the subscription JSON protocol and MCP
 *    (tools/tool-doors.ts, XP1);
 *  - an adaptive context budget from the model's real window (Ollama
 *    /api/show, LM Studio, a generic OpenAI-compatible endpoint), so a turn
 *    fits an 8k model with room for the reply (llm/model-window.ts,
 *    memory/context/local-budget.ts);
 *  - weak tool calling: the server checks every argument (XP2), small models
 *    get fewer and simpler tools, many calls in one reply run one at a time
 *    with a cap, memory is never invented (AG8);
 *  - the memory helper and the chat model share the computer: background
 *    local model work waits while a local reply runs, the chat model stays
 *    warm (llm/local-scheduler.ts, LAT);
 *  - a generic OpenAI-compatible endpoint on this computer
 *    (llama.cpp / vLLM style; llm/openai-local.ts).
 * On by default; GIRRU_STORE_P2B=0 turns it off, and then nothing changes.
 *
 *   GIRRU_STORE_P2B=0   turns it off (on by default; services/memory-switches.ts)
 */

import { memorySwitchOn } from './memory-switches.js';

export const STORE_P2B_ENV = 'GIRRU_STORE_P2B';

export function storeP2bEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return memorySwitchOn(STORE_P2B_ENV, env);
}
