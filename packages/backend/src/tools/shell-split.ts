/**
 * Pure shell-word splitter, with no dependencies (not even the DB layer), so it
 * can be shared by the command allowlist (tools/core/run-command.ts) and the
 * structural argv gate (tools/argv-gate.ts).
 *
 * Splits a command into words with plain single/double quotes honoured, and
 * returns null the moment it sees ANY shell feature — a pipe, a list, a
 * redirection, a subshell, a background job, or command / parameter
 * substitution. A null result means "not a single simple command"; the caller
 * must never run it directly or match it against a structural rule.
 */
export function splitCommand(command: string): string[] | null {
  const out: string[] = []; let cur = '', quote: string | null = null, has = false;
  for (const ch of command) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (has || cur) out.push(cur); cur = ''; has = false; continue; }
    if (/[|;&<>$`(){}\n\r]/.test(ch)) return null;
    cur += ch; has = true;
  }
  if (quote) return null;
  if (has || cur) out.push(cur);
  return out.length ? out : null;
}
