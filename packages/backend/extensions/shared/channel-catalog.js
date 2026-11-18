// Public channel metadata from agent-connect-dpro 0.2.0; transports stay in that package.
export const CHANNEL_CATALOG = [
  {
    "id": "a2a",
    "label": "A2A",
    "module": "plugins.platforms.a2a",
    "factory": "register",
    "runtime": "python",
    "requiredEnv": [],
    "maxTextLength": 4096,
    "prerequisites": "No extra packages needed (stdlib only)",
    "validation": "not-live-tested"
  },
  {
    "id": "api_server",
    "label": "API Server",
    "module": "gateway.platforms.api_server",
    "factory": "APIServerAdapter",
    "runtime": "python",
    "requiredEnv": [],
    "maxTextLength": 4096,
    "prerequisites": "Requires platform-specific account, SDK or bridge configuration.",
    "validation": "not-live-tested"
  },
  {
    "id": "bluebubbles",
    "label": "iMessage via BlueBubbles",
    "module": "gateway.platforms.bluebubbles",
    "factory": "BlueBubblesAdapter",
    "runtime": "python",
    "requiredEnv": [],
    "maxTextLength": 4096,
    "prerequisites": "Requires platform-specific account, SDK or bridge configuration.",
    "validation": "not-live-tested"
  },
  {
    "id": "buzz",
    "label": "Buzz",
    "module": "plugins.platforms.buzz.adapter",
    "factory": "register",
    "runtime": "python",
    "requiredEnv": [
      "BUZZ_RELAY_URL",
      "BUZZ_PRIVATE_KEY"
    ],
    "maxTextLength": 4096,
    "prerequisites": "Requires the buzz CLI binary (https://github.com/block/buzz) on PATH or at BUZZ_CLI_PATH",
    "validation": "not-live-tested"
  },
  {
    "id": "dingtalk",
    "label": "DingTalk",
    "module": "plugins.platforms.dingtalk.adapter",
    "factory": "register",
    "runtime": "python",
    "requiredEnv": [
      "DINGTALK_CLIENT_ID",
      "DINGTALK_CLIENT_SECRET"
    ],
    "maxTextLength": 4096,
    "prerequisites": "pip install 'dingtalk-stream>=0.20' httpx",
    "validation": "not-live-tested"
  },
  {
    "id": "discord",
    "label": "Discord",
    "module": "plugins.platforms.discord.adapter",
    "factory": "register",
    "runtime": "node-or-python",
    "requiredEnv": [
      "DISCORD_BOT_TOKEN"
    ],
    "maxTextLength": 2000,
    "prerequisites": "Install the provider SDKs for Discord; see docs/CHANNELS.md.",
    "validation": "not-live-tested"
  },
  {
    "id": "email",
    "label": "Email",
    "module": "plugins.platforms.email.adapter",
    "factory": "register",
    "runtime": "python",
    "requiredEnv": [
      "EMAIL_ADDRESS",
      "EMAIL_PASSWORD",
      "EMAIL_SMTP_HOST"
    ],
    "maxTextLength": 50000,
    "prerequisites": "Email uses the Python stdlib (smtplib/imaplib) — no extra deps",
    "validation": "not-live-tested"
  },
  {
    "id": "feishu",
    "label": "Feishu / Lark",
    "module": "plugins.platforms.feishu.adapter",
    "factory": "register",
    "runtime": "python",
    "requiredEnv": [
      "FEISHU_APP_ID",
      "FEISHU_APP_SECRET"
    ],
    "maxTextLength": 8000,
    "prerequisites": "Install the provider SDKs for Feishu; see docs/CHANNELS.md.",
    "validation": "not-live-tested"
  },
  {
    "id": "google_chat",
    "label": "Google Chat",
    "module": "plugins.platforms.google_chat.adapter",
    "factory": "register",
    "runtime": "python",
    "requiredEnv": [
      "GOOGLE_CHAT_SERVICE_ACCOUNT_JSON"
    ],
    "maxTextLength": 4000,
    "prerequisites": "Install the provider SDKs for Google Chat; see docs/CHANNELS.md.",
    "validation": "not-live-tested"
  },
  {
    "id": "homeassistant",
    "label": "Home Assistant",
    "module": "plugins.platforms.homeassistant.adapter",
    "factory": "register",
    "runtime": "python",
    "requiredEnv": [
      "HASS_TOKEN"
    ],
    "maxTextLength": 4096,
    "prerequisites": "pip install aiohttp",
    "validation": "not-live-tested"
  },
  {
    "id": "irc",
    "label": "IRC",
    "module": "plugins.platforms.irc.adapter",
    "factory": "register",
    "runtime": "python",
    "requiredEnv": [
      "IRC_SERVER",
      "IRC_CHANNEL",
      "IRC_NICKNAME"
    ],
    "maxTextLength": 450,
    "prerequisites": "No extra packages needed (stdlib only)",
    "validation": "not-live-tested"
  },
  {
    "id": "line",
    "label": "LINE",
    "module": "plugins.platforms.line.adapter",
    "factory": "register",
    "runtime": "python",
    "requiredEnv": [
      "LINE_CHANNEL_ACCESS_TOKEN",
      "LINE_CHANNEL_SECRET"
    ],
    "maxTextLength": 4500,
    "prerequisites": "pip install aiohttp",
    "validation": "not-live-tested"
  },
  {
    "id": "matrix",
    "label": "Matrix",
    "module": "plugins.platforms.matrix.adapter",
    "factory": "register",
    "runtime": "python",
    "requiredEnv": [
      "MATRIX_HOMESERVER",
      "MATRIX_ACCESS_TOKEN"
    ],
    "maxTextLength": 16000,
    "prerequisites": "pip install 'mautrix[encryption]'",
    "validation": "not-live-tested"
  },
  {
    "id": "mattermost",
    "label": "Mattermost",
    "module": "plugins.platforms.mattermost.adapter",
    "factory": "register",
    "runtime": "python",
    "requiredEnv": [
      "MATTERMOST_URL",
      "MATTERMOST_TOKEN"
    ],
    "maxTextLength": 4000,
    "prerequisites": "pip install aiohttp",
    "validation": "not-live-tested"
  },
  {
    "id": "msgraph_webhook",
    "label": "Microsoft Graph Webhook",
    "module": "gateway.platforms.msgraph_webhook",
    "factory": "MSGraphWebhookAdapter",
    "runtime": "python",
    "requiredEnv": [],
    "maxTextLength": 4096,
    "prerequisites": "Requires platform-specific account, SDK or bridge configuration.",
    "validation": "not-live-tested"
  },
  {
    "id": "ntfy",
    "label": "ntfy",
    "module": "plugins.platforms.ntfy.adapter",
    "factory": "register",
    "runtime": "python",
    "requiredEnv": [
      "NTFY_TOPIC"
    ],
    "maxTextLength": 4096,
    "prerequisites": "pip install httpx",
    "validation": "not-live-tested"
  },
  {
    "id": "photon",
    "label": "iMessage via Photon",
    "module": "plugins.platforms.photon.adapter",
    "factory": "register",
    "runtime": "python",
    "requiredEnv": [
      "PHOTON_PROJECT_ID",
      "PHOTON_PROJECT_SECRET"
    ],
    "maxTextLength": 8000,
    "prerequisites": "Requires a Photon Spectrum project and configured spectrum-ts sidecar.",
    "validation": "not-live-tested"
  },
  {
    "id": "qqbot",
    "label": "QQ Bot",
    "module": "gateway.platforms.qqbot",
    "factory": "QQAdapter",
    "runtime": "python",
    "requiredEnv": [],
    "maxTextLength": 4096,
    "prerequisites": "Requires platform-specific account, SDK or bridge configuration.",
    "validation": "not-live-tested"
  },
  {
    "id": "raft",
    "label": "Raft",
    "module": "plugins.platforms.raft.adapter",
    "factory": "register",
    "runtime": "python",
    "requiredEnv": [
      "RAFT_PROFILE"
    ],
    "maxTextLength": 4096,
    "prerequisites": "Install the Raft CLI from https://raft.build",
    "validation": "not-live-tested"
  },
  {
    "id": "relay",
    "label": "Connector Relay",
    "module": "gateway.relay.adapter",
    "factory": "RelayAdapter",
    "runtime": "python",
    "requiredEnv": [],
    "maxTextLength": 4096,
    "prerequisites": "Requires platform-specific account, SDK or bridge configuration.",
    "validation": "not-live-tested"
  },
  {
    "id": "signal",
    "label": "Signal",
    "module": "gateway.platforms.signal",
    "factory": "SignalAdapter",
    "runtime": "python",
    "requiredEnv": [],
    "maxTextLength": 4096,
    "prerequisites": "Requires platform-specific account, SDK or bridge configuration.",
    "validation": "not-live-tested"
  },
  {
    "id": "simplex",
    "label": "SimpleX Chat",
    "module": "plugins.platforms.simplex.adapter",
    "factory": "register",
    "runtime": "python",
    "requiredEnv": [
      "SIMPLEX_WS_URL"
    ],
    "maxTextLength": 8000,
    "prerequisites": "pip install websockets   # SimpleX adapter requires the websockets package",
    "validation": "not-live-tested"
  },
  {
    "id": "slack",
    "label": "Slack",
    "module": "plugins.platforms.slack.adapter",
    "factory": "register",
    "runtime": "python",
    "requiredEnv": [
      "SLACK_BOT_TOKEN",
      "SLACK_APP_TOKEN"
    ],
    "maxTextLength": 39000,
    "prerequisites": "Install the provider SDKs for Slack; see docs/CHANNELS.md.",
    "validation": "not-live-tested"
  },
  {
    "id": "sms",
    "label": "SMS (Twilio)",
    "module": "plugins.platforms.sms.adapter",
    "factory": "register",
    "runtime": "python",
    "requiredEnv": [
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "TWILIO_PHONE_NUMBER"
    ],
    "maxTextLength": 1600,
    "prerequisites": "pip install aiohttp",
    "validation": "not-live-tested"
  },
  {
    "id": "teams",
    "label": "Microsoft Teams",
    "module": "plugins.platforms.teams.adapter",
    "factory": "register",
    "runtime": "python",
    "requiredEnv": [
      "TEAMS_CLIENT_ID",
      "TEAMS_CLIENT_SECRET",
      "TEAMS_TENANT_ID"
    ],
    "maxTextLength": 28000,
    "prerequisites": "Configure the provider SDK and account.",
    "validation": "not-live-tested"
  },
  {
    "id": "telegram",
    "label": "Telegram",
    "module": "plugins.platforms.telegram.adapter",
    "factory": "register",
    "runtime": "node-or-python",
    "requiredEnv": [
      "TELEGRAM_BOT_TOKEN"
    ],
    "maxTextLength": 4096,
    "prerequisites": "Install the provider SDKs for Telegram; see docs/CHANNELS.md.",
    "validation": "not-live-tested"
  },
  {
    "id": "webhook",
    "label": "Webhook",
    "module": "gateway.platforms.webhook",
    "factory": "WebhookAdapter",
    "runtime": "python",
    "requiredEnv": [],
    "maxTextLength": 4096,
    "prerequisites": "Requires platform-specific account, SDK or bridge configuration.",
    "validation": "not-live-tested"
  },
  {
    "id": "wecom",
    "label": "WeCom (Enterprise WeChat)",
    "module": "plugins.platforms.wecom.adapter",
    "factory": "register",
    "runtime": "python",
    "requiredEnv": [
      "WECOM_BOT_ID",
      "WECOM_SECRET"
    ],
    "maxTextLength": 4000,
    "prerequisites": "Configure the provider SDK and account.",
    "validation": "not-live-tested"
  },
  {
    "id": "wecom_callback",
    "label": "WeCom Callback (self-built apps)",
    "module": "plugins.platforms.wecom.adapter",
    "factory": "register",
    "runtime": "python",
    "requiredEnv": [
      "WECOM_CALLBACK_CORP_ID",
      "WECOM_CALLBACK_CORP_SECRET"
    ],
    "maxTextLength": 4096,
    "prerequisites": "Configure the provider SDK and account.",
    "validation": "not-live-tested"
  },
  {
    "id": "weixin",
    "label": "Weixin",
    "module": "gateway.platforms.weixin",
    "factory": "WeixinAdapter",
    "runtime": "python",
    "requiredEnv": [],
    "maxTextLength": 4096,
    "prerequisites": "Requires platform-specific account, SDK or bridge configuration.",
    "validation": "not-live-tested"
  },
  {
    "id": "whatsapp",
    "label": "WhatsApp",
    "module": "plugins.platforms.whatsapp.adapter",
    "factory": "register",
    "runtime": "python",
    "requiredEnv": [
      "WHATSAPP_ENABLED"
    ],
    "maxTextLength": 4096,
    "prerequisites": "WhatsApp requires a Node.js bridge — see the WhatsApp messaging docs",
    "validation": "not-live-tested"
  },
  {
    "id": "whatsapp_cloud",
    "label": "WhatsApp Cloud API",
    "module": "gateway.platforms.whatsapp_cloud",
    "factory": "WhatsAppCloudAdapter",
    "runtime": "python",
    "requiredEnv": [],
    "maxTextLength": 4096,
    "prerequisites": "Requires platform-specific account, SDK or bridge configuration.",
    "validation": "not-live-tested"
  },
  {
    "id": "yuanbao",
    "label": "Yuanbao",
    "module": "gateway.platforms.yuanbao",
    "factory": "YuanbaoAdapter",
    "runtime": "python",
    "requiredEnv": [],
    "maxTextLength": 4096,
    "prerequisites": "Requires platform-specific account, SDK or bridge configuration.",
    "validation": "not-live-tested"
  }
];
export function channelInfo(id){const item=CHANNEL_CATALOG.find(c=>c.id===id);if(!item)throw Error("Unknown channel");return item;}
