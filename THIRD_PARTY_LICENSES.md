# Third-Party Licenses

This document lists all third-party open-source packages used in Girru,
grouped by layer (Frontend, Backend, Python).

---

## Frontend (`package.json`)

| Package | License | Usage |
|---------|---------|-------|
| `next` | MIT | React framework |
| `react`, `react-dom` | MIT | UI library |
| `typescript` | Apache 2.0 | Type system |
| `tailwindcss` | MIT | CSS utility framework |
| `shadcn/ui` (via `radix-ui` + `@radix-ui/*`) | MIT | UI components (Button, Card, Dialog, etc.) |
| `lucide-react` | ISC | Icon library |
| `clsx`, `tailwind-merge`, `class-variance-authority` | MIT / Apache 2.0 | CSS utilities |
| `zod` | MIT | Schema validation |
| `sonner` | MIT | Toast notifications |
| `gray-matter` | MIT | YAML/Markdown frontmatter parsing |
| `recharts` | MIT | Charts (BarChart, LineChart, PieChart) |
| `three` (THREE.js) | MIT | 3D rendering engine |
| `@react-three/fiber` | MIT | React renderer for THREE.js |
| `@react-three/drei` | MIT | THREE.js helpers |
| `@xyflow/react`, `reactflow` | MIT | Flow/diagram editor |
| `@dagrejs/dagre` | MIT | Graph layout algorithm |
| `@readyplayerme/react-avatar-creator` | Custom (ReadyPlayerMe ToS) | 3D avatar creation widget |
| `@readyplayerme/visage` | Custom (ReadyPlayerMe ToS) | 3D avatar rendering |
| `@ricky0123/vad-react`, `@ricky0123/vad-web` | MIT | Voice activity detection |
| `bcryptjs` | MIT | Password hashing |
| `cron` | MIT | Cron scheduling |
| `ai` (Vercel AI SDK) | Apache 2.0 | AI streaming helpers |
| `@ai-sdk/openai`, `@ai-sdk/react` | Apache 2.0 | AI SDK adapters |
| `react-markdown` | MIT | Markdown rendering (MarkdownBlock component) |
| `remark-gfm` | MIT | GitHub Flavored Markdown plugin |

---

## Backend (`packages/backend/package.json`)

| Package | License | Usage |
|---------|---------|-------|
| `fastify` | MIT | HTTP server framework |
| `@fastify/cors` | MIT | CORS plugin |
| `@fastify/multipart` | MIT | File upload plugin |
| `@fastify/swagger`, `@fastify/swagger-ui` | MIT | API documentation |
| `better-sqlite3` | MIT | SQLite database driver |
| `puppeteer` | Apache 2.0 | Browser automation (browser tools) |
| `openai` | Apache 2.0 | OpenAI-compatible API client |
| `jsonwebtoken` | MIT | JWT authentication |
| `bcryptjs` | MIT | Password hashing |
| `js-yaml` | MIT | YAML parsing (skills) |
| `node-cron` | ISC | Cron scheduling (agent tasks) |
| `uuid` | MIT | UUID generation |
| `chalk` | MIT | Terminal colors |
| `ora` | MIT | Terminal spinners |
| `commander` | MIT | CLI argument parsing |
| `@clack/prompts` | MIT | CLI interactive prompts |
| `chokidar` | MIT | File watching |
| `pino-pretty` | MIT | Log formatting |
| `grammy` | MIT | Telegram Bot API client |
| `@whiskeysockets/baileys` | **GPL-3.0** | WhatsApp Web API client |
| `usearch` | Apache 2.0 | In-process HNSW vector index for memory recall (MEM-SPEED-01); bundles NumKong (Apache 2.0 / BSD-3-Clause); prebuilt for Windows, macOS and Linux |
| `bindings`, `node-addon-api`, `node-gyp-build` | MIT | Native addon loading (dependencies of `usearch`) |

> ⚠️ **GPL-3.0 Note**: `@whiskeysockets/baileys` is GPL-3.0. If you distribute this software, the combined work must comply with GPL-3.0 terms. Since Girru is open-source, this is compatible.

---

## Python (`python-scripts/requirements.txt`)

| Package | License | Usage |
|---------|---------|-------|
| `edge-tts` | **GPL-3.0** | Text-to-speech (Microsoft Edge neural TTS) |
| `faster-whisper` | MIT | Speech-to-text (local Whisper model) |
| `pydub` | MIT | Audio editing (merge, trim, convert) |
| `moviepy` | MIT | Video editing (trim, extract audio) |
| `Pillow` | HPND (open source) | Image processing (thumbnail frames) |
| `pyautogui` | BSD-3-Clause | Desktop control automation |

> ⚠️ **GPL-3.0 Note**: `edge-tts` is GPL-3.0. Same compatibility note as above.

> 📌 **ffmpeg** must be installed separately for audio/video features. It is LGPL-2.1+ (dynamic linking) or GPL-2.0+ depending on build configuration.

---

## License Summary

| License | Packages | Key Requirement |
|---------|----------|-----------------|
| **MIT** | Most packages | Keep copyright notice |
| **Apache 2.0** | puppeteer, openai, Vercel AI SDK, TypeScript, usearch | Keep copyright notice + state changes |
| **ISC** | lucide-react, node-cron, @clack/prompts | Keep copyright notice |
| **GPL-3.0** | edge-tts, @whiskeysockets/baileys | Distribute source under GPL-3.0 |
| **HPND** | Pillow | Keep copyright notice |
| **Custom ToS** | @readyplayerme/* | ReadyPlayerMe Terms of Service apply |

---

## Apache 2.0 Attribution Notice (Required)

The following packages require attribution under Apache License 2.0:

- **puppeteer** — Copyright Google LLC
- **openai** — Copyright OpenAI
- **ai, @ai-sdk/openai, @ai-sdk/react** — Copyright Vercel Inc.
- **typescript** — Copyright Microsoft Corporation
- **usearch** (with NumKong) — Copyright Unum Cloud

Full Apache 2.0 license text: https://www.apache.org/licenses/LICENSE-2.0
