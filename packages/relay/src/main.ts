#!/usr/bin/env node
/**
 * girru-relay: runs the relay with settings from the environment.
 *
 *   GIRRU_RELAY_URL    this relay's public name, signed by devices in their hello
 *                      (e.g. wss://relay.example.org/v1; default ws://<host>:<port>/v1)
 *   GIRRU_RELAY_HOST   interface to bind (default 127.0.0.1)
 *   GIRRU_RELAY_PORT   port to bind (default 41540, 0 = any free port)
 *   GIRRU_RELAY_MAX_ENVELOPE_BYTES, GIRRU_RELAY_MESSAGES_PER_SECOND,
 *   GIRRU_RELAY_BYTES_PER_SECOND, GIRRU_RELAY_MAX_CONNECTIONS   optional limits
 *
 * The only output is one line when it starts listening and one when it stops.
 * Message contents, device ids and addresses are never printed.
 */

import { RELAY_NAME_PATTERN } from './encoding.js';
import { createRelay } from './relay.js';

function numberFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    process.stderr.write(`girru-relay: ${name} must be a whole number\n`);
    process.exit(2);
  }
  return value;
}

const relayUrl = process.env.GIRRU_RELAY_URL || undefined;
if (relayUrl !== undefined && !RELAY_NAME_PATTERN.test(relayUrl)) {
  process.stderr.write('girru-relay: GIRRU_RELAY_URL must look like wss://relay.example.org/v1\n');
  process.exit(2);
}

const relay = createRelay({
  relayUrl,
  host: process.env.GIRRU_RELAY_HOST || undefined,
  port: numberFromEnv('GIRRU_RELAY_PORT'),
  maxEnvelopeBytes: numberFromEnv('GIRRU_RELAY_MAX_ENVELOPE_BYTES'),
  messagesPerSecond: numberFromEnv('GIRRU_RELAY_MESSAGES_PER_SECOND'),
  bytesPerSecond: numberFromEnv('GIRRU_RELAY_BYTES_PER_SECOND'),
  maxConnections: numberFromEnv('GIRRU_RELAY_MAX_CONNECTIONS'),
});

relay.listen().then(
  ({ host, port }) => {
    process.stderr.write(`girru-relay: listening on ${host}:${port}\n`);
  },
  (err: NodeJS.ErrnoException) => {
    process.stderr.write(`girru-relay: failed to start (${err.code ?? 'unknown error'})\n`);
    process.exit(1);
  },
);

let stopping = false;
function stop(): void {
  if (stopping) return;
  stopping = true;
  relay.close().then(() => {
    process.stderr.write('girru-relay: stopped\n');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
