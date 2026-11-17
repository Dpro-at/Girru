/**
 * SEC-GATE-02: structural argv-prefix approval gates.
 *
 * A gate that matches a command with a string or a regular expression is
 * trivially evaded: `sh -c 'git push'`, backticks, `;`, `|` all slip past a
 * pattern written for `git push`. This module matches the *structure* of a
 * command instead.
 *
 * An "argv-prefix" rule is a short list of 1–8 tokens, e.g. ["git", "push"].
 * It matches ONLY a single simple command whose parsed human prefix equals the
 * pattern exactly. A command that uses any shell feature — a pipe, a list
 * (`;`, `&&`, `||`), a redirection, a subshell, a background job, or command /
 * parameter substitution — never matches, because such a command is not a
 * single simple command at all. A wrapper program (`sh -c …`, `env …`,
 * `sudo …`, `xargs …`) never matches a rule written for the program it wraps,
 * because the parsed program is the wrapper, not the wrapped command.
 *
 * Flags are ignored by construction: ["git", "push"] covers `git push --force`
 * and `git push -f`, but NOT `git -C /repo push` (the global option shifts the
 * subcommand out of the human prefix) and NOT `git pull`.
 *
 * The "human prefix" is the first N non-flag tokens of the command, where N is
 * the program's arity — how many leading words name the action a person would
 * recognise: `git push` is two words, `npm run build` is three, `cat` is one.
 * The arity table below is small and explicit; an unlisted program has arity 1
 * (only the bare program name can be gated), which fails closed: a rule cannot
 * silently cover more than it names.
 *
 * This is our own code. No shell is ever spawned here; parsing is pure.
 */

import { splitCommand } from './shell-split.js';

/** Who decided a gate outcome, recorded on the approval. */
export type DeciderKind = 'human' | 'rule' | 'model' | 'system';

export const DECIDER_KINDS: readonly DeciderKind[] = ['human', 'rule', 'model', 'system'];

export function isDeciderKind(value: unknown): value is DeciderKind {
  return typeof value === 'string' && (DECIDER_KINDS as readonly string[]).includes(value);
}

/** What a matched rule asks the gate to do (same three outcomes a gate layer has). */
export type GateAction = 'allow' | 'deny' | 'ask';

/** A structural argv-prefix rule. `pattern` is the exact human prefix to match. */
export interface ArgvRule {
  /** 1–8 tokens; must equal the program's arity (see isValidArgvPattern). */
  pattern: string[];
  action: GateAction;
  /** Optional opaque id for logging / referencing the matched rule. */
  id?: string;
}

/** Longest pattern a rule may hold. */
export const MAX_PREFIX_TOKENS = 8;

/**
 * Programs whose human prefix is longer than one token: program + subcommand(s).
 * Anything not listed has arity 1. Package runners (`npm run build`) are a
 * special case handled in arityOfWords.
 */
const ARITY_TABLE: Readonly<Record<string, number>> = Object.freeze({
  git: 2,
  docker: 2,
  kubectl: 2,
  cargo: 2,
  go: 2,
  pip: 2,
  pip3: 2,
  apt: 2,
  'apt-get': 2,
  brew: 2,
  systemctl: 2,
  dotnet: 2,
  gh: 2,
  terraform: 2,
  npm: 2,
  pnpm: 2,
  yarn: 2,
  bun: 2,
});

/** Package runners whose `run <script>` form adds a third token. */
const PACKAGE_RUNNERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'bun']);

/**
 * The arity (human-prefix length) of a command, from its NON-FLAG words.
 * `npm run build` = 3; `npm install` = 2; `git push` = 2; `cat file` = 1.
 */
export function arityOfWords(words: readonly string[]): number {
  const program = words[0];
  if (program === undefined) return 1;
  if (PACKAGE_RUNNERS.has(program)) return words[1] === 'run' ? 3 : 2;
  return ARITY_TABLE[program] ?? 1;
}

const FLAG = (token: string): boolean => token.startsWith('-') && token !== '-';

/**
 * Parse `command` into the argv of a single simple command, or null when it is
 * not one. Reuses the shell-feature-rejecting splitter the command allowlist
 * uses, so a pipe / list / redirection / subshell / background job / command or
 * parameter substitution all yield null (they contain shell metacharacters).
 * Quoted text stays a single literal token: `sh -c 'git push'` parses to
 * ['sh', '-c', 'git push'] — the wrapped command is inert data, never re-parsed.
 */
export function parseSimpleCommand(command: string): string[] | null {
  if (typeof command !== 'string') return null;
  return splitCommand(command);
}

/**
 * The human prefix of a parsed argv: its first `arity` non-flag tokens, with
 * flags removed. Returns fewer tokens only when the command is shorter than its
 * own arity. Never spawns or resolves anything.
 */
export function humanPrefix(argv: readonly string[]): string[] {
  const words = argv.filter((t) => !FLAG(t));
  const n = arityOfWords(words);
  return words.slice(0, n);
}

/**
 * The human prefix of a command string, or null when it is not a single simple
 * command. This is the value an argv-prefix rule is compared against.
 */
export function commandPrefix(command: string): string[] | null {
  const argv = parseSimpleCommand(command);
  if (!argv || argv.length === 0) return null;
  return humanPrefix(argv);
}

/**
 * A rule's pattern is valid when it is 1–8 non-empty, flag-free tokens AND its
 * length equals the arity of its own program — so a rule always names a program's
 * complete human prefix and can neither under-specify (["git"] matching every
 * git command) nor over-specify it.
 */
export function isValidArgvPattern(pattern: unknown): pattern is string[] {
  if (!Array.isArray(pattern) || pattern.length < 1 || pattern.length > MAX_PREFIX_TOKENS) return false;
  for (const token of pattern) {
    if (typeof token !== 'string' || token.length === 0 || token.length > 256) return false;
    if (/\s/.test(token) || FLAG(token)) return false;
  }
  return pattern.length === arityOfWords(pattern);
}

function sameTokens(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

/**
 * True when `command` is a single simple command whose human prefix equals
 * `pattern` exactly. Invalid patterns, compound commands and wrapper-fronted
 * commands all return false.
 */
export function matchesArgvPrefix(pattern: readonly string[], command: string): boolean {
  if (!isValidArgvPattern(pattern)) return false;
  const prefix = commandPrefix(command);
  if (!prefix) return false;
  return sameTokens(prefix, pattern);
}

/** The outcome of evaluating argv rules against a command. */
export interface GateDecision {
  action: GateAction;
  /** Who decided: a matched rule → 'rule'; no match → left for a human. */
  decider: DeciderKind;
  /** The rule that matched, when one did. */
  rule?: ArgvRule;
}

/**
 * Evaluate owner-configured argv rules against a command, highest priority
 * first (rules earlier in the list win). The first valid rule whose pattern
 * matches decides the outcome and is recorded as decided by 'rule'. When no
 * rule matches, the command is not auto-decided: the caller falls back to the
 * existing owner-approval flow (a human decides, recorded as 'human').
 *
 * A command that is not a single simple command never matches any rule, so it
 * can never be auto-allowed by a rule — it always reaches the human gate.
 */
export function evaluateArgvRules(command: string, rules: readonly ArgvRule[]): GateDecision {
  const prefix = commandPrefix(command);
  if (prefix) {
    for (const rule of rules) {
      if (isValidArgvPattern(rule.pattern) && sameTokens(prefix, rule.pattern)) {
        return { action: rule.action, decider: 'rule', rule };
      }
    }
  }
  return { action: 'ask', decider: 'human' };
}
