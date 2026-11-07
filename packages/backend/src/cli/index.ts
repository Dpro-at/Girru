#!/usr/bin/env node
/**
 * Girru CLI
 * Command-line interface for Girru
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import readline from 'readline';
import { randomUUID } from 'node:crypto';
import { requestChat } from './chat-client.js';

import { OLLAMA_URL } from '../llm/ollama.js';


const program = new Command();

program
  .name('agent')
  .description('Girru CLI - AI Assistant')
  .version('0.1.0');

// ============================================
// agent serve - Start API server
// ============================================
program
  .command('serve')
  .description('Start the API server')
  .option('-p, --port <port>', 'Port number', '3001')
  .action(async (options) => {
    process.env.PORT = options.port;
    console.log(chalk.blue('Starting Girru Backend...'));
    await import('../api/server.js');
  });

// ============================================
// agent models - List available models
// ============================================
program
  .command('models')
  .description('List available AI models')
  .action(async () => {
    const spinner = ora('Fetching models from Ollama...').start();

    try {
      const res = await fetch(`${OLLAMA_URL}/api/tags`);

      if (!res.ok) {
        spinner.fail('Cannot connect to Ollama');
        console.log(chalk.yellow('\nMake sure Ollama is running: ollama serve'));
        process.exit(1);
      }

      const data = await res.json() as { models: any[] };
      spinner.succeed(`Found ${data.models.length} models\n`);

      console.log(chalk.bold('Available Models:\n'));

      for (const model of data.models) {
        const size = (model.size / (1024 * 1024 * 1024)).toFixed(1);
        console.log(`  ${chalk.green('●')} ${chalk.bold(model.name)}`);
        console.log(`    Size: ${size}GB`);
        if (model.details?.parameter_size) {
          console.log(`    Parameters: ${model.details.parameter_size}`);
        }
        console.log();
      }
    } catch (error) {
      spinner.fail('Failed to connect to Ollama');
      console.log(chalk.red('\nMake sure Ollama is running: ollama serve'));
      process.exit(1);
    }
  });

// ============================================
// agent chat - Interactive chat
// ============================================
program
  .command('chat [message]')
  .description('Start interactive chat or send a single message')
  .option('-m, --model <model>', 'Model intent (validated by the backend)')
  .option('--url <url>', 'Loopback backend URL')
  .action(async (message, options) => {
    const model = options.model;

    const sessionId = randomUUID();
    const connection = { sessionId, url: options.url ?? process.env.AGENT_PLAYER_URL, token: process.env.AGENT_PLAYER_TOKEN };

    console.log(chalk.blue(`\nGirru Chat (model: ${model ?? 'backend default'})`));
    console.log(chalk.gray('Type "exit" or Ctrl+C to quit\n'));

    const messages: { role: string; content: string }[] = [];

    // Single message mode
    if (message) {
      await sendMessage(model, [{ role: 'user', content: message }], connection);
      return;
    }

    // Interactive mode
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const prompt = () => {
      rl.question(chalk.cyan('You: '), async (input) => {
        const text = input.trim();

        if (text.toLowerCase() === 'exit' || text.toLowerCase() === 'quit') {
          console.log(chalk.gray('\nGoodbye!'));
          rl.close();
          process.exit(0);
        }

        if (!text) {
          prompt();
          return;
        }

        messages.push({ role: 'user', content: text });

        process.stdout.write(chalk.green('Agent: '));
        const response = await sendMessage(model, messages, connection, true);
        messages.push({ role: 'assistant', content: response });
        console.log();

        prompt();
      });
    };

    prompt();
  });

// Send intent to the governed backend; terminal owns display and input only.
async function sendMessage(
  model: string | undefined,
  messages: { role: string; content: string }[],
  connection: { sessionId: string; url?: string; token?: string },
  returnContent = false
): Promise<string> {
  try {
    const content = await requestChat({ model, messages, ...connection });
    process.stdout.write(content);
    if (!returnContent) console.log();
    return content;
  } catch (error) {
    console.log(chalk.red(`\n${error instanceof Error ? error.message : 'Chat failed.'}`));
    process.exitCode = 1;
    return '';
  }
}

// Parse and run
program.parse();
