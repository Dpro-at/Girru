/**
 * Minimal terminal prompts (no extra dependencies).
 * `askHidden` never echoes what is typed (used for passwords).
 */

import readline from 'readline';

export function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export function askHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  process.stdout.write(question);

  if (!stdin.isTTY) {
    // Piped input: read one line without echoing it.
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: stdin, terminal: false });
      rl.once('line', (line) => {
        // close emits synchronously; settle the entered line before the EOF fallback.
        resolve(line);
        rl.close();
        process.stdout.write('\n');
      });
      rl.once('close', () => resolve(''));
    });
  }

  return new Promise((resolve, reject) => {
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new Error('Cancelled'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}
