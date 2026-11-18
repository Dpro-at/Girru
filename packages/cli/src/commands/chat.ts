/**
 * Chat Command
 *
 * Quick chat with the agent
 */

import ora from 'ora';
import chalk from 'chalk';
import { ask } from '../utils/prompt.js';
import { getApiClient } from '../utils/api-client.js';
import { error, success } from '../utils/formatting.js';

export async function chatCommand(initialMessage?: string): Promise<void> {
  const client = getApiClient();

  // Check if backend is running
  const isRunning = await client.isBackendRunning();
  if (!isRunning) {
    error('Backend is not running');
    console.log(chalk.gray('Run "agent-player start" to start the backend\n'));
    process.exitCode = 1;
    return;
  }

  let message = initialMessage;

  // If no message provided, prompt for it
  if (!message) {
    message = await ask('What would you like to ask? ');
  }

  if (!message || message.trim().length === 0) {
    error('Please provide a message');
    process.exitCode = 1;
    return;
  }

  // Send message
  const spinner = ora('Thinking...').start();

  try {
    const reply = await client.sendMessage(message);
    spinner.stop();

    console.log(chalk.bold.cyan('\n🤖 Agent:'));
    console.log(chalk.white(reply || 'No response'));
    console.log();

  } catch (err: any) {
    spinner.fail('Failed to send message');
    error(err.message);
    process.exitCode = 1;
  }
}
