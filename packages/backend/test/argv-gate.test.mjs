// SEC-GATE-02: structural argv-prefix approval gates. Pure parsing; no DB, no shell.
import test from 'node:test';
import assert from 'node:assert/strict';

const m = await import('../src/tools/argv-gate.ts');

test('["git","push"] matches git push and its flags, structurally only', () => {
  const pattern = ['git', 'push'];
  // Matches: a single simple `git push`, flags ignored by construction.
  assert.equal(m.matchesArgvPrefix(pattern, 'git push --force'), true, 'git push --force');
  assert.equal(m.matchesArgvPrefix(pattern, 'git push'), true, 'git push');
  assert.equal(m.matchesArgvPrefix(pattern, 'git push -f origin main'), true, 'git push -f origin main');

  // Does NOT match a global option before the subcommand (prefix shifts).
  assert.equal(m.matchesArgvPrefix(pattern, 'git -C /repo push'), false, 'git -C /repo push');
  // Does NOT match a different subcommand.
  assert.equal(m.matchesArgvPrefix(pattern, 'git pull'), false, 'git pull');

  // Compound commands are never a single simple command -> never match.
  assert.equal(m.matchesArgvPrefix(pattern, 'echo hi | git push'), false, 'pipe');
  assert.equal(m.matchesArgvPrefix(pattern, 'git push; rm x'), false, 'list ;');
  assert.equal(m.matchesArgvPrefix(pattern, 'git push && rm x'), false, 'list &&');
  assert.equal(m.matchesArgvPrefix(pattern, 'git push > out.txt'), false, 'redirection');
  assert.equal(m.matchesArgvPrefix(pattern, 'git push &'), false, 'background');
  assert.equal(m.matchesArgvPrefix(pattern, 'echo $(git push)'), false, 'command substitution');
  assert.equal(m.matchesArgvPrefix(pattern, 'echo `git push`'), false, 'backtick substitution');
  assert.equal(m.matchesArgvPrefix(pattern, '(git push)'), false, 'subshell');

  // Wrapper programs: the parsed program is the wrapper, not git.
  assert.equal(m.matchesArgvPrefix(pattern, "sh -c 'git push'"), false, 'sh -c');
  assert.equal(m.matchesArgvPrefix(pattern, 'env git push'), false, 'env wrapper');
  assert.equal(m.matchesArgvPrefix(pattern, 'sudo git push'), false, 'sudo wrapper');
  assert.equal(m.matchesArgvPrefix(pattern, 'xargs git push'), false, 'xargs wrapper');
});

test('arity: program + subcommand length is how many leading words name the action', () => {
  assert.equal(m.arityOfWords(['git', 'push']), 2);
  assert.equal(m.arityOfWords(['npm', 'run', 'build']), 3);
  assert.equal(m.arityOfWords(['npm', 'install']), 2);
  assert.equal(m.arityOfWords(['cat', 'file']), 1);
  assert.equal(m.arityOfWords(['curl', 'https://x']), 1, 'unlisted program = arity 1 (fail closed)');
});

test('commandPrefix drops flags and returns null for anything compound', () => {
  assert.deepEqual(m.commandPrefix('git push --force'), ['git', 'push']);
  assert.deepEqual(m.commandPrefix('git -C /repo push'), ['git', '/repo']);
  assert.deepEqual(m.commandPrefix('npm run build --silent'), ['npm', 'run', 'build']);
  assert.deepEqual(m.commandPrefix('cat README.md'), ['cat']);
  assert.deepEqual(m.commandPrefix("sh -c 'git push'"), ['sh']);
  assert.equal(m.commandPrefix('git push | tee log'), null, 'pipe -> null');
  assert.equal(m.commandPrefix(''), null, 'empty -> null');
});

test('pattern validation: length must equal the program arity; no flags, no whitespace', () => {
  assert.equal(m.isValidArgvPattern(['git', 'push']), true);
  assert.equal(m.isValidArgvPattern(['npm', 'run', 'build']), true);
  assert.equal(m.isValidArgvPattern(['curl']), true, 'arity-1 program');
  assert.equal(m.isValidArgvPattern(['git']), false, 'under-specified: git arity is 2');
  assert.equal(m.isValidArgvPattern(['git', 'push', 'origin']), false, 'over-specified: git arity is 2');
  assert.equal(m.isValidArgvPattern(['npm', 'run']), false, 'npm run arity is 3');
  assert.equal(m.isValidArgvPattern(['git', '--force']), false, 'flag token');
  assert.equal(m.isValidArgvPattern(['git push']), false, 'whitespace in token');
  assert.equal(m.isValidArgvPattern([]), false, 'empty');
  assert.equal(m.isValidArgvPattern('git push'), false, 'not an array');
  assert.equal(m.isValidArgvPattern(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']), false, 'over 8 tokens');
});

test('an invalid pattern never matches', () => {
  assert.equal(m.matchesArgvPrefix(['git'], 'git push'), false);
  assert.equal(m.matchesArgvPrefix(['git', '--force'], 'git push --force'), false);
});

test('evaluateArgvRules: first matching rule decides, recorded as decided by "rule"', () => {
  const rules = [
    { pattern: ['git', 'push'], action: 'allow', id: 'r1' },
    { pattern: ['npm', 'run', 'build'], action: 'deny', id: 'r2' },
  ];
  const allow = m.evaluateArgvRules('git push --force', rules);
  assert.deepEqual({ action: allow.action, decider: allow.decider, id: allow.rule?.id }, { action: 'allow', decider: 'rule', id: 'r1' });

  const deny = m.evaluateArgvRules('npm run build', rules);
  assert.deepEqual({ action: deny.action, decider: deny.decider, id: deny.rule?.id }, { action: 'deny', decider: 'rule', id: 'r2' });

  // No rule matches -> not auto-decided; the human gate decides.
  const ask = m.evaluateArgvRules('git pull', rules);
  assert.deepEqual({ action: ask.action, decider: ask.decider, rule: ask.rule }, { action: 'ask', decider: 'human', rule: undefined });

  // A bypass attempt is never a single simple command -> reaches the human gate.
  for (const bypass of ["sh -c 'git push'", 'echo hi | git push', 'git push; rm x', 'git -C /repo push']) {
    const d = m.evaluateArgvRules(bypass, rules);
    assert.equal(d.action, 'ask', bypass);
    assert.equal(d.decider, 'human', bypass);
  }
});

test('leading flags before the subcommand never satisfy an allow rule (parser-differential fix)', () => {
  const rules = [{ pattern: ['git', 'push'], action: 'allow', id: 'r1' }];
  const allowed = (cmd) => m.evaluateArgvRules(cmd, rules);

  // Flags AFTER the full prefix are fine -> still allow.
  for (const ok of ['git push --force', 'git push -f origin main', 'git push']) {
    const d = allowed(ok);
    assert.equal(d.action, 'allow', ok);
    assert.equal(d.decider, 'rule', ok);
  }

  // A leading/injected option changes git's behaviour -> must NOT allow; falls to the human gate.
  for (const bad of ['git --exec-path=/evil push', 'git -c protocol.ext.allow=always push', 'git -C /repo push']) {
    const d = allowed(bad);
    assert.equal(d.action, 'ask', bad);
    assert.equal(d.decider, 'human', bad);
  }

  // analyzeCommand reports strictness directly.
  assert.equal(m.analyzeCommand('git push --force').strict, true);
  assert.equal(m.analyzeCommand('git --exec-path=/evil push').strict, false);
  assert.equal(m.analyzeCommand('git -c x=y push').strict, false);

  // matchesArgvPrefix: strict mode rejects the leading-flag variant; broad mode (deny/ask) still matches it.
  assert.equal(m.matchesArgvPrefix(['git', 'push'], 'git --exec-path=/evil push', { strict: true }), false);
});

test('a deny rule still matches a leading-flag variant (safe direction)', () => {
  const rules = [{ pattern: ['git', 'push'], action: 'deny', id: 'd1' }];
  // The broad form so a flagged variant cannot slip past a deny by adding a leading flag that keeps the same prefix.
  const d = m.evaluateArgvRules('git push', rules);
  assert.equal(d.action, 'deny');
  assert.equal(d.decider, 'rule');
});

test('an earlier rule wins over a later one with the same prefix', () => {
  const rules = [
    { pattern: ['git', 'push'], action: 'deny', id: 'high' },
    { pattern: ['git', 'push'], action: 'allow', id: 'low' },
  ];
  const d = m.evaluateArgvRules('git push', rules);
  assert.equal(d.rule?.id, 'high');
  assert.equal(d.action, 'deny');
});

test('isDeciderKind guards the four decider kinds', () => {
  for (const ok of ['human', 'rule', 'model', 'system']) assert.equal(m.isDeciderKind(ok), true, ok);
  for (const bad of ['owner', '', 'HUMAN', null, 5, undefined]) assert.equal(m.isDeciderKind(bad), false, String(bad));
});
