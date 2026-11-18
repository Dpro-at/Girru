# Agent Connect — Girru Integration

## Girru integration

The Fastify extension host is in `channel-host.js`. The Agent Connect app from the Girru Store passes its SDK API to it for every channel in the catalog: Telegram and Discord on the library's Node transports (picked by name in a `switch`), every other channel on its Python worker. All settings live in the one `agent-connect` row of `extension_configs`, under `channels.<id>`. The separate Telegram, Discord, Slack and WhatsApp extensions were removed (CHANNELS-01); at the first start after the update their settings move to `channels.telegram` / `channels.discord` once, after a backup, and their old tables are dropped when empty (kept when they hold rows, and no longer read). Messages are stored in `channel_events`. The existing legacy `/api/channels` registry is separate and is not the administration endpoint for these channels.

Other helpers here: `webhook-verify.js` (provider signature checks, used by the call center), `internal-auth.js` (a short-lived token for a tool calling its own routes) and `agent-reply.js` (the chat reply as text).

The core keeps only channel metadata and the Girru integration/security host. Agent Connect is a separate Store app using the existing `agent-connect-dpro@0.2.0` npm package and its locked dependencies. Get it from the Store, restart when asked, then configure channels. Downloads are pinned by name, version, size and SHA-256 and unpacked into the app's own `node_modules`; Girru does not invoke npm or package install scripts. The library remains a development-only dependency for the host regression tests.

Removing Agent Connect stops its hosts and removes its program files. `extension_configs`, `channel_events`, saved credentials and the separate provider state folder are retained. Re-adding preserves settings and disabled-channel choices, but leaves the app disabled until the owner enables it and restarts Girru. Turning a channel on also enables the app; previously enabled channels may resume after restart. Adding alone never signs in to a new account. Additional Python adapters retain their separate, explicit provider setup documented by the package. No Python environment or provider dependencies are installed automatically. `GIRRU_CHANNELS_RUNTIME_DIR` is an absolute server-operator/test override for the app root, never an HTTP setting. It deliberately trusts an operator-selected runtime and is not a substitute for Store receipt validation; leave it unset in normal use. The installed app folder is under the protected data root.

Desktop updates replace the program folder. For a manual overlay deployment, remove the obsolete program-only `extensions/agent-connect` folder before starting the updated version: the extension runner gives shipped folders precedence over Store folders with the same id. Keep the separate data folder and provider state intact.

1. Sign in to Girru with an active owner or admin account.
2. Open Settings › Channels. If Agent Connect is missing, Get Agent Connect opens its Store page. Add it, restart when asked, then choose a channel.
3. Turning a channel on also turns the agent-connect extension on; if it was off, restart the backend when asked. Re-enabling after disable also requires a restart under the existing extension lifecycle.
4. Save a bot token and allowed sender IDs. For Discord, also save allowed channel IDs. An empty sender list blocks all incoming messages; an empty Discord channel list also blocks incoming messages.
5. Automatic agent replies are off by default. Enable them explicitly to route authorized messages through Girru's configured primary agent and real `/api/chat` provider/tool path. The account saving settings becomes the channel owner; only trusted external IDs should act under that account. Multi-user account bindings and selecting different agents per channel are future extensions.
6. Use the test message form and check the connection and recent messages. Confirm actual receipt in the provider before considering live setup complete.

Telegram uses grammY long polling. It checks for an existing webhook and refuses to start instead of deleting it. Remove the webhook in your bot's existing deployment before migrating. Start a conversation with the bot to obtain a usable private chat ID. In groups, Telegram's privacy settings determine which messages reach the bot. See the [grammY guide](https://grammy.dev/guide/getting-started).

Discord uses discord.js Gateway events for guild text messages. Enable Message Content Intent in the Developer Portal and invite the bot with View Channel and Send Messages permissions. Direct messages, attachments, reactions, custom slash commands, and rich embeds are outside this first release. See the [discord.js Client documentation](https://discord.js.org/docs/packages/discord.js/main/Client:Class).

The reusable React panel is `../../../../src/components/channels/ChannelPanel.tsx`; its props supply the backend URL, channel ID and token accessor. Thin Next.js page wrappers provide Girru's authentication token. This panel has no Next.js dependency and can be extracted into a separate React package later.

## Host API

All endpoints below use `/api/ext/agent-connect/{channel id}` and require a Bearer JWT belonging to an active owner/admin. Browser calls also follow Girru's existing CORS and CSRF origin policy.

| Method | Endpoint | Behavior |
| --- | --- | --- |
| GET | `/status` | Credential presence, actual connector state and message counts; no token |
| GET | `/config` | Redacted settings and `hasToken` |
| PUT | `/config` | Save `{ "config": { ... } }`; blank token preserves the saved token |
| POST | `/connect` | Retry the configured connection |
| POST | `/send` | Telegram `{chatId,text}` or Discord `{channelId,content}`; provider-acknowledged ID |
| GET | `/messages?limit=30` | Up to 100 persisted events and processing states |
| POST | `/webhook` | Returns 410; inbound messages arrive through provider connections |

Config fields: `bot_token`, `allowed_users` (comma-separated IDs or string array), `allowed_channels` (Discord), `guild_id` (Discord, optional), and `auto_reply` (boolean). The host sets `owner_user_id` from the authenticated administrator. Tokens are stored under the application's existing SQLite configuration storage policy; this module does not introduce encryption at rest. Protect the database and backups. Config and inspect APIs redact bot tokens; do not export the database into a public repository.

## Delivery and processing semantics

- Provider acknowledgement is required before an outgoing event is stored as delivered. Failed requests do not return a success result. A provider may accept a request before the connection fails, so retries cannot guarantee exactly-once outbound delivery.
- Incoming identity is `(channel, conversationId, providerMessageId, direction)`. SQLite claims each event once before agent execution. Duplicates and bot-authored messages are ignored. Conversation history is isolated by provider, conversation and sender.
- Incoming processing is serialized per conversation/sender. Access, enablement and configuration are checked before execution and before replying. Disabling stops the provider transport and blocks queued execution and replies; work already executing in the existing chat runtime cannot be cancelled by this module.
- `pending`, `processed`, `failed` and `delivered` events distinguish processing from delivery. Pending or failed events are not retried automatically after restart, to avoid repeating agent side effects. A durable retry/outbox worker is a future extension.
- Text sends are limited to 4096 characters on Telegram and 2000 on Discord. Agent responses are split into smaller plain-text chunks. Discord outbound mentions are disabled.
- Connection failures are visible as an error/disconnected state. Explicit reconnect or saving changed settings retries setup. The module does not remove Telegram webhooks, alter Discord portal settings, or activate missing credentials.

## Validation boundaries

Run `node --import tsx --import ../../scripts/test-temp-root.mjs --test test/agent-connect*.test.mjs test/channel-runtime-store.test.mjs test/store-channels-install.test.mjs test/store-package-runtime.test.mjs` from `packages/backend` for the application adapter, runtime and Store lifecycle tests. The existing library is a development-only dependency for regression fixtures; its provider code is absent from the shipped core.

Automated tests use fake provider clients and an isolated in-memory SQLite/Fastify host. They cover transport normalization, startup/shutdown, credential redaction, authentication, incoming access lists, deduplication, delivery failure, disablement and JSON/SSE agent response parsing. They do not send external messages or call a paid model. Live verification requires configured bot accounts and a configured Girru model/provider.
