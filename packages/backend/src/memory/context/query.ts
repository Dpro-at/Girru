/**
 * The recall query of a chat turn, built from the conversation (MEM-ACC-02, mode B). No model.
 *
 * A chat recalled memory with the owner's last message alone, so "do you remember why we
 * changed it?" searched for those words only, and a question without the project's name
 * could not tell ten projects' facts apart. This adds what the conversation is about:
 *
 *   entity   the project or person the last message names; else the one the conversation
 *            named most recently (a switch to another project, or back, follows the latest
 *            mention); else the chat's open project.
 *   names    every name of that entity (e.g. "Falcon" and "فالكون"), so a question in one
 *            language finds a fact written in another.
 *   topic    content words of the message that named the entity (when the last message did
 *            not), e.g. "server database", at most MAX_TOPIC_WORDS.
 *
 * The result is ONE query (the last message, then the context in brackets), embedded once
 * like before, so the cost is the string work here (well under a millisecond). Pure.
 */

import { lexicalTokens, normalizeMemoryText } from '../text-normalize.js';

export interface KnownEntity {
  /** Every name of the entity (any script); the first is used first. */
  names: readonly string[];
}

export interface ContextQueryInput {
  /** The owner's last message. */
  message: string;
  /** Earlier messages of the conversation, oldest first (owner and agent). */
  history?: readonly string[];
  /** The names of the chat's open project, when it has one. */
  openProject?: KnownEntity | null;
  /** Projects and people the owner has, with their names. */
  entities?: readonly KnownEntity[];
  /** False: the entity's names only, no topic words. */
  topic?: boolean;
}

export interface ContextQuery {
  query: string;
  /**
   * Extra queries for a question with a relative clause ("the contact at the client of the project
   * whose server runs on X"): its head ("the contact at the client of the project") with the same
   * context, so the answer is searched for and not only the clause that points to it (multi-hop).
   */
  parts: string[];
  /** The entity the context came from, or null. */
  entity: KnownEntity | null;
  /** How it was chosen. */
  source: 'message' | 'conversation' | 'open-project' | 'none';
  topic: string[];
}

export const MAX_TOPIC_WORDS = 4;
/** Words that open a relative clause (English, Arabic, Iraqi, German). */
const CLAUSE = /\s(?:whose|which|where|الذي|التي|اللي|الي|dessen|deren)\s/iu;

/** The head of a question with a relative clause, when both sides say something (two content words each). */
export function questionHead(message: string): string | null {
  const m = CLAUSE.exec(message);
  if (!m) return null;
  const head = message.slice(0, m.index).trim();
  const rest = message.slice(m.index + m[0].length).trim();
  return lexicalTokens(head).length >= 2 && lexicalTokens(rest).length >= 2 ? head : null;
}
/** How far back the conversation is read for the latest mention. */
export const MAX_HISTORY = 60;

const norm = (s: string) => normalizeMemoryText(s).toLowerCase();

function mentions(text: string, entity: KnownEntity): boolean {
  const t = ` ${norm(text).replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  return entity.names.some((name) => {
    const n = norm(name).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (n.length < 3) return false;
    // A whole word, or an Arabic name with a one-letter prefix (لـ / بـ / و / ف / ك / ال).
    return t.includes(` ${n} `) || new RegExp(` (?:[لبوفك]|ال)${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `, 'u').test(t);
  });
}

function latestMention(texts: readonly string[], entities: readonly KnownEntity[]): { entity: KnownEntity; index: number } | null {
  for (let i = texts.length - 1; i >= 0; i--) {
    // The last-named entity in a message wins ("first X, now Y" -> Y): by position in the text.
    let best: { entity: KnownEntity; at: number } | null = null;
    for (const e of entities) {
      if (!mentions(texts[i], e)) continue;
      const lower = norm(texts[i]);
      const at = Math.max(...e.names.map((n) => lower.lastIndexOf(norm(n))));
      if (!best || at > best.at) best = { entity: e, at };
    }
    if (best) return { entity: best.entity, index: i };
  }
  return null;
}

/** Content words of `text` that the message does not already have and that are not names. */
function topicWords(text: string, message: string, entity: KnownEntity): string[] {
  const have = new Set(lexicalTokens(message));
  const nameTokens = new Set(entity.names.flatMap((n) => lexicalTokens(n)));
  const out: string[] = [];
  for (const word of text.split(/[\s,.;:!?؟،()"'«»]+/u)) {
    const toks = lexicalTokens(word);
    if (toks.length === 0 || toks.every((t) => have.has(t) || nameTokens.has(t) || t.length < 3)) continue;
    if (!out.includes(word)) out.push(word);
    if (out.length >= MAX_TOPIC_WORDS) break;
  }
  return out;
}

export function buildContextQuery(input: ContextQueryInput): ContextQuery {
  const message = String(input.message ?? '').trim();
  const entities = [...(input.entities ?? []), ...(input.openProject ? [input.openProject] : [])].filter((e) => e.names.length > 0);
  const history = (input.history ?? []).slice(-MAX_HISTORY);
  let entity: KnownEntity | null = null;
  let source: ContextQuery['source'] = 'none';
  let topic: string[] = [];
  const inMessage = latestMention([message], entities);
  if (inMessage) {
    entity = inMessage.entity; source = 'message';
  } else {
    const inHistory = latestMention(history, entities);
    if (inHistory) {
      entity = inHistory.entity; source = 'conversation';
      if (input.topic !== false) topic = topicWords(history[inHistory.index], message, entity);
    } else if (input.openProject && input.openProject.names.length) {
      entity = input.openProject; source = 'open-project';
    }
  }
  const head = questionHead(message);
  if (!entity) return { query: message, parts: head ? [head] : [], entity: null, source, topic };
  const names = entity.names.filter((n, k, all) => all.indexOf(n) === k).slice(0, 3);
  const context = [names.join(' / '), ...(topic.length ? [topic.join(' ')] : [])].join(': ');
  return { query: `${message}\n(${context})`, parts: head ? [`${head}\n(${context})`] : [], entity, source, topic };
}
