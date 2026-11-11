/**
 * KNOW-INDEX-01 switch (document memory). On: Girru indexes the documents
 * (.md, .txt, .pdf) of the projects the owner marked as his own (and any
 * other project he turns on in Settings › Memory › Documents) and of each
 * agent's knowledge folder, in the background, and reply recall and the
 * memory_search tool find the answer inside them with the file and page
 * (memory/docs/*). Off: nothing is scanned, nothing is recalled from
 * documents, and the routes answer 404.
 *
 * On by default with the other memory switches (services/memory-switches.ts):
 *
 *   GIRRU_DOC_INDEX=0   turns it off
 */

import { memorySwitchOn } from './memory-switches.js';

export const DOC_INDEX_ENV = 'GIRRU_DOC_INDEX';

export function docIndexEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return memorySwitchOn(DOC_INDEX_ENV, env);
}
