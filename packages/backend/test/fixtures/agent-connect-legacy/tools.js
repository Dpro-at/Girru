import { sendChannel } from '../../../extensions/shared/channel-host.js';

// Send tools for the channels with a native transport. Their names, destination parameters and
// approval category are known to the core (tools/channel-policy.ts, approvals.ts, grants.ts): in a
// channel turn they may only answer the conversation the message came from.
function sendTool(api, { name, channel, label, destination, destinationLabel }) {
  return {
    name,
    description: `Send a plain text message through the configured ${label} bot.`,
    input_schema: {
      type: 'object',
      properties: { [destination]: { type: 'string', description: destinationLabel }, text: { type: 'string', description: 'Message text' } },
      required: [destination, 'text'],
    },
    async execute(params, context) {
      try {
        api.authorizeChannelUser(context?.userId);
        const result = await sendChannel(channel, params[destination], params.text);
        return { content: [{ type: 'text', text: `Message delivered. ID: ${result.id}` }] };
      } catch {
        return { error: `${label} delivery failed or access denied`, content: [{ type: 'text', text: 'Message was not delivered. Check channel access and connection.' }] };
      }
    },
  };
}

export const SEND_TOOL_NAMES = ['telegram_send', 'discord_send'];

export function channelSendTools(api) {
  return [
    sendTool(api, { name: 'telegram_send', channel: 'telegram', label: 'Telegram', destination: 'chatId', destinationLabel: 'Telegram chat ID' }),
    sendTool(api, { name: 'discord_send', channel: 'discord', label: 'Discord', destination: 'channelId', destinationLabel: 'Discord channel ID' }),
  ];
}
