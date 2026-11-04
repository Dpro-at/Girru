/**
 * KNOW-INDEX-01 switch (document memory). On: Girru indexes the documents
 * (.md, .txt, .pdf) of the project folders the owner turned on and of each
 * agent's knowledge folder, in the background, and reply recall finds the
 * answer inside them with the file and page (memory/docs/*). Off: nothing is
 * scanned, nothing is recalled from documents, and the routes answer 404.
 *
 * OFF by default until the owner approves the board; then it joins the
 * memory switches (services/memory-switches.ts) and goes on by default.
 *
 *   GIRRU_DOC_INDEX=1   turns it on (1 / true / yes / on)
 */

export const DOC_INDEX_ENV = 'GIRRU_DOC_INDEX';

const ON = /^(1|true|yes|on)$/i;

export function docIndexEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ON.test(String(env[DOC_INDEX_ENV] ?? '').trim());
}
